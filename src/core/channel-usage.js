/**
 * 渠道用量（`token-ledger.json`）→ 看板统计行的**读时合并层**。
 *
 * ## 为什么需要它
 *
 * 插件看板的 `/stats` 只读 `$DSH_HOME/our-free-model/stats.json`，而那份文档
 * **只由自有车道的 `recordUsage` 写入**（`src/adapter.js`）。20 个渠道
 * （raccoon / workbuddy / codearts / orcaterm / qoder …）走的是
 * `vendor/channel-pack` 的适配器，它们**只写** `$DSH_HOME/channel-pack/
 * token-ledger.json`，一处都不写 stats。
 *
 * 后果（2026-10-25 实测）：看板累计 Token 只有 763,994，渠道台账同期
 * 57,651,344 —— 差 5,690 万，且最近三天渠道有量而看板整天为 0。
 *
 * ## 为什么在读取侧合并，而不是给 20 个适配器加钩子
 *
 * 渠道台账本来就是按「天 / 渠道 / 账号 / 模型」聚合的权威记录（且重启保留
 * 90 天）。读时合并只有一处代码，不动 `vendor/channel-pack` 的 20 个适配器，
 * 回归面最小；两份数据的 provider 集天然不相交（台账是渠道名，stats 是
 * 免费车道模型名），不会重复计数。
 *
 * ## 口径
 *
 * 合计 = 输入 + 输出 + **缓存读**。缓存读是模型真实处理过的 token（只是
 * 计费打折），不是虚构量；`stats.json` 原本也按模型记了 `cacheRead` 字段，
 * 只是历史口径把它排除在总计之外，这里一并纠正。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { MIN_DECODE_MS, MAX_CREDIBLE_TPS } from '../store.js'

/** 台账文件名（与 `vendor/channel-pack/src/token-ledger-store.ts` 一致）。 */
export const CHANNEL_LEDGER_FILE = 'token-ledger.json'

/**
 * 台账路径。必须与渠道自己的解析保持一致，优先级：
 * `DSH_CHANNEL_PACK_STATE_DIR` → `<home>`，再拼 `channel-pack/<file>`。
 */
export function resolveChannelLedgerPath(home) {
  const override = process.env.DSH_CHANNEL_PACK_STATE_DIR
  const base = typeof override === 'string' && override.trim() !== '' ? override.trim() : home
  return path.join(base, 'channel-pack', CHANNEL_LEDGER_FILE)
}

const int = (value) => (Number.isFinite(value) ? Math.round(value) : 0)

/** 台账键 `direct|<provider>|<accountId>|<model>` → `{ provider, model }`。 */
function parseLedgerKey(key) {
  const parts = String(key).split('|')
  if (parts.length < 4) return undefined
  const provider = parts[1]?.trim()
  const model = parts.slice(3).join('|').trim()
  if (!provider || !model) return undefined
  return { provider, model }
}

/**
 * 读台账并把「每账号一行」压成「每渠道+模型一行」。
 *
 * 返回 `undefined` 表示没有可合并的数据（文件不存在 / 解析失败 / 空表）——
 * 调用方应当原样返回未合并的统计，绝不能让看板因为台账异常而空掉。
 */
export function readChannelUsage(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const days = parsed?.days
  if (days === null || typeof days !== 'object') return undefined

  const out = { days: {}, models: {}, requests: 0, failures: 0 }
  let touched = false
  for (const [day, bucket] of Object.entries(days)) {
    if (bucket === null || typeof bucket !== 'object') continue
    const rows = new Map()
    for (const [key, value] of Object.entries(bucket)) {
      if (value === null || typeof value !== 'object') continue
      const parsedKey = parseLedgerKey(key)
      if (parsedKey === undefined) continue
      const id = `${parsedKey.provider}/${parsedKey.model}`
      const row = rows.get(id) ?? {
        model: id, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
        ttftMs: 0, ttftSamples: 0, tpsSum: 0, tpsCount: 0,
      }
      row.input += int(value.inputTokens)
      row.output += int(value.outputTokens)
      row.reasoning += int(value.reasoningTokens)
      row.cacheRead += int(value.cacheReadTokens)
      row.calls += int(value.requests)
      row.failed += int(value.errors)
      row.ttftMs += int(value.ttftSumMs)
      row.ttftSamples += int(value.ttftCount)
      row.tpsSum += Number.isFinite(value.tpsSum) ? value.tpsSum : 0
      row.tpsCount += int(value.tpsCount)
      rows.set(id, row)
    }
    if (rows.size === 0) continue
    touched = true
    const modelRows = []
    for (const row of rows.values()) {
      // 台账只有「每调用平均速度」(tpsSum/tpsCount)。折算成一个自洽的解码窗口，
      // 让 buildStats 的 tps 公式（decodeTokens / decodeMs）还原出同一个均值，
      // 而不是另开一套字段。无法可信折算时留 0 ⇒ tps 为 null，不虚报。
      const avgTps = row.tpsCount > 0 ? row.tpsSum / row.tpsCount : 0
      const credible = avgTps > 0 && avgTps <= MAX_CREDIBLE_TPS && row.output > 0
      const decodeTokens = credible ? row.output : 0
      const decodeMs = credible ? Math.max(0, Math.round((decodeTokens / avgTps) * 1000)) : 0
      const { tpsSum, tpsCount, ...rest } = row
      modelRows.push({ ...rest, decodeMs, decodeTokens })
      out.requests += row.calls
      out.failures += row.failed
      const lifetime = out.models[row.model] ?? {
        model: row.model, input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0,
      }
      out.models[row.model] = {
        ...lifetime,
        input: lifetime.input + row.input,
        output: lifetime.output + row.output,
        reasoning: lifetime.reasoning + row.reasoning,
        cacheRead: lifetime.cacheRead + row.cacheRead,
        calls: lifetime.calls + row.calls,
        failed: lifetime.failed + row.failed,
      }
    }
    out.days[day] = { models: modelRows }
  }
  return touched ? out : undefined
}

const rowTps = (row) => {
  if (!(row.decodeMs >= MIN_DECODE_MS) || !(row.decodeTokens > 0)) return null
  const tps = Math.round(row.decodeTokens / (row.decodeMs / 1000))
  return Number.isFinite(tps) && tps <= MAX_CREDIBLE_TPS ? tps : null
}

/**
 * 把渠道用量并入 `buildStats` 的结果（原地构造新对象，返回新载荷）。
 *
 * - `days` / `models` 追加渠道行；渠道天的 `total` 按 `includeCacheRead` 重算。
 * - `requests` / `requestFailures` 累加渠道的物理请求与错误。
 * - `grand` 重新求和；`turns` / `failedTurns` / `recoveredTurns` **保持原样**
 *   —— 渠道不回报逻辑回合（台账没有该字段），凭空补会变成另一种不准。
 */
export function mergeChannelStats(payload, usage, { includeCacheRead = false } = {}) {
  if (usage === undefined) return payload
  const nameOf = (id) => payload.models.find((row) => row.model === id)?.name ?? id
  const dayTotal = (rows) => rows.reduce(
    (sum, row) => sum + (row.input ?? 0) + (row.output ?? 0) + (includeCacheRead ? (row.cacheRead ?? 0) : 0),
    0,
  )

  const days = payload.days.map((row) => ({ ...row, models: [...row.models] }))
  const byDay = new Map(days.map((row) => [row.day, row]))
  for (const [day, bucket] of Object.entries(usage.days)) {
    let target = byDay.get(day)
    if (target === undefined) {
      target = { day, total: 0, models: [] }
      days.push(target)
      byDay.set(day, target)
    }
    for (const row of bucket.models) {
      const existing = target.models.findIndex((item) => item.model === row.model)
      const merged = existing === -1
        ? { ...row, name: nameOf(row.model), tps: rowTps(row), avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null }
        : (() => {
            const previous = target.models[existing]
            const combined = {
              ...previous,
              input: (previous.input ?? 0) + row.input,
              output: (previous.output ?? 0) + row.output,
              reasoning: (previous.reasoning ?? 0) + row.reasoning,
              cacheRead: (previous.cacheRead ?? 0) + row.cacheRead,
              calls: (previous.calls ?? 0) + row.calls,
              failed: (previous.failed ?? 0) + row.failed,
              ttftMs: (previous.ttftMs ?? 0) + row.ttftMs,
              ttftSamples: (previous.ttftSamples ?? 0) + row.ttftSamples,
              decodeMs: (previous.decodeMs ?? 0) + row.decodeMs,
              decodeTokens: (previous.decodeTokens ?? 0) + row.decodeTokens,
            }
            return { ...combined, tps: rowTps(combined), avgTtftMs: combined.ttftSamples > 0 ? Math.round(combined.ttftMs / combined.ttftSamples) : null }
          })()
      if (existing === -1) target.models.push(merged)
      else target.models[existing] = merged
    }
    target.total = dayTotal(target.models)
  }
  days.sort((a, b) => a.day.localeCompare(b.day))

  const models = [...payload.models]
  for (const row of Object.values(usage.models)) {
    const existing = models.findIndex((item) => item.model === row.model)
    if (existing === -1) {
      models.push({ ...row, name: nameOf(row.model), tps: null, avgTtftMs: null })
    } else {
      const previous = models[existing]
      models[existing] = {
        ...previous,
        input: (previous.input ?? 0) + row.input,
        output: (previous.output ?? 0) + row.output,
        reasoning: (previous.reasoning ?? 0) + row.reasoning,
        cacheRead: (previous.cacheRead ?? 0) + row.cacheRead,
        calls: (previous.calls ?? 0) + row.calls,
        failed: (previous.failed ?? 0) + row.failed,
      }
    }
  }

  const sum = (key) => models.reduce((total, row) => total + (row[key] ?? 0), 0)
  const grand = {
    ...payload.grand,
    input: sum('input'),
    output: sum('output'),
    reasoning: sum('reasoning'),
    cacheRead: sum('cacheRead'),
    calls: sum('calls'),
    failed: sum('failed'),
  }
  return {
    ...payload,
    days,
    models,
    requests: (payload.requests ?? 0) + usage.requests,
    requestFailures: (payload.requestFailures ?? 0) + usage.failures,
    grand,
  }
}
