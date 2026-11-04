import { MAX_CREDIBLE_TPS, MIN_DECODE_MS } from '../store.js'
import { describeSavingsTotal, emptySavings, savingsPercent } from '../token-saver/index.js'

export function buildStats(stats, catalog, options = {}) {
  const includeCacheRead = options.includeCacheRead === true
  const days = stats.days ?? {}
  const series = Object.keys(days).sort().map(day => {
    const rows = Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value }))
    // 历史口径 `total` 只累加 input+output。缓存读同样是模型真实处理过的
    // token（只是计费打折），按需并进来——否则看板会系统性低估（实测缺口
    // 见 `channel-usage.js` 文件头）。
    const total = includeCacheRead
      ? rows.reduce((sum, row) => sum + (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0), 0)
      : days[day].total ?? 0
    return { day, total, models: rows }
  })
  const totals = {}
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      cacheRead: previous.cacheRead + (row.cacheRead ?? 0),
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
    }
  }
  const logical = stats.logical ?? {}
  const logicalModels = logical.models ?? {}
  const logicalReady = Number.isSafeInteger(logical.turns)
  const lifetimeModels = stats.models ?? {}
  const empty = model => ({
    model, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
    ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
  })
  // The logical map is part of the row set, not just a lookup table: a combo
  // records its turn under the chain's own id and its physical calls under each
  // link's, so a chain that never appears here would show its links in the panel
  // and be invisible itself — the one row a user configuring a chain looks for.
  const modelIds = new Set([...Object.keys(totals), ...Object.keys(lifetimeModels), ...Object.keys(logicalModels)])
  const named = [...modelIds].map(model => {
    const row = totals[model] ?? empty(model)
    const lifetime = lifetimeModels[model] ?? {}
    // ⚠️ 判据是「生命周期字段存在且有限」，不是 isSafeInteger：
    // isSafeInteger(0) === true，会让「生命周期为 0」**覆盖** days 里有真实
    // 记账的值（实测：days 有 input:100/calls:3、lifetime 为 0 → 输出全 0，
    // 整天数据被抹掉）。正常写入路径里 lifetime ≥ days 累计恒成立；lifetime
    // 比 days 小只可能是字段缺失（旧数据迁移）或损坏 —— 所以取
    // max(lifetime, days聚合)：缺字段回退到 days，0 不会抹掉真实值，正常
    // 情况（lifetime 更大，跨天累计）也不受影响。
    const largerOr = (value, fallback) => {
      const lifetimeValue = Number.isFinite(value) ? value : 0
      return lifetimeValue > fallback ? lifetimeValue : fallback
    }
    const physical = {
      ...row,
      input: largerOr(lifetime.input, row.input),
      output: largerOr(lifetime.output, row.output),
      reasoning: largerOr(lifetime.reasoning, row.reasoning),
      cacheRead: largerOr(lifetime.cacheRead, row.cacheRead),
      calls: largerOr(lifetime.calls, row.calls),
      failed: largerOr(lifetime.failed, row.failed),
      // ⚠ 计时量必须**与 token 同源**取大（2026-11-04 审查）：下面 `tps` 若仍按
      // 原始 `row` 算，就会出现「输出 tokens 用 lifetime 上限（更大）、速度却按
      // 本次运行的分母算」—— 分子分母不是同一次统计，算出来的 tok/s 与旁边那列
      // tokens 互相对不上。首字延迟同理（`avgTtftMs` 也吃 ttftMs/ttftSamples）。
      ttftMs: largerOr(lifetime.ttftMs, row.ttftMs),
      ttftSamples: largerOr(lifetime.ttftSamples, row.ttftSamples),
      decodeMs: largerOr(lifetime.decodeMs, row.decodeMs),
      decodeTokens: largerOr(lifetime.decodeTokens, row.decodeTokens),
    }
    return {
      ...physical,
      turns: logicalModels[model]?.turns ?? (logicalReady ? 0 : row.calls),
      failedTurns: logicalModels[model]?.failed ?? (logicalReady ? 0 : row.failed),
      recoveredTurns: logicalModels[model]?.recovered ?? 0,
      name: catalog.find(entry => entry.id === model)?.name ?? model,
      // A rate over too few measurable calls is a rounding error with a unit on it.
      // ⚠ 与 `channel-usage.js` 的 `rowTps()` 保持**同一套判据**（2026-11-04 审查）：
      // 除了 `MIN_DECODE_MS` 下限，还要挡掉 `MAX_CREDIBLE_TPS` 以上的离谱值
      //（时钟跳变 / 上游 usage 回包错乱都会产生），否则同一份数据在 /stats 与
      // 渠道合并行上会给出两个不同的 tok/s。
      tps: (() => {
        if (!(physical.decodeMs >= MIN_DECODE_MS) || !(physical.decodeTokens > 0)) return null
        const value = Math.round(physical.decodeTokens / (physical.decodeMs / 1000))
        return Number.isFinite(value) && value <= MAX_CREDIBLE_TPS ? value : null
      })(),
      avgTtftMs: physical.ttftSamples > 0 ? Math.round(physical.ttftMs / physical.ttftSamples) : null,
    }
  })
  const physicalFailed = named.reduce((sum, row) => sum + row.failed, 0)
  const turns = logicalReady ? logical.turns : named.reduce((sum, row) => sum + row.turns, 0)
  const failedTurns = Number.isSafeInteger(logical.failed) ? logical.failed : named.reduce((sum, row) => sum + row.failedTurns, 0)
  const recoveredTurns = Number.isSafeInteger(logical.recovered) ? logical.recovered : named.reduce((sum, row) => sum + row.recoveredTurns, 0)
  const hasLifetimeFailures = Number.isSafeInteger(stats.failedRequests)
  const savings = { ...emptySavings(), ...(stats.savings ?? {}) }
  return {
    requests: stats.requests ?? 0,
    requestFailures: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
    requestFailuresEstimated: stats.failedRequestsEstimated === true || !hasLifetimeFailures,
    logicalEstimated: logical.estimated === true,
    turns,
    failedTurns,
    recoveredTurns,
    days: series,
    models: named,
    samples: (stats.samples ?? []).slice(-200),
    // What the token savers measured. The percentage is computed here, from the
    // same bytes the rows above counted, so the panel never has to derive a rate
    // from two numbers that were rounded separately.
    savings: { ...savings, percent: savingsPercent(savings), summary: describeSavingsTotal(savings) },
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      // 缓存读单列出来：合计（输入+输出+缓存读）由调用方决定要不要并，
      // 但分量必须一直可用，否则前端只能靠猜。
      cacheRead: named.reduce((sum, row) => sum + (row.cacheRead ?? 0), 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: hasLifetimeFailures ? stats.failedRequests : physicalFailed,
      turns,
      failedTurns,
      recoveredTurns,
    },
  }
}
