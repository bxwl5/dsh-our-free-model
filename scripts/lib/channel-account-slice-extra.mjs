/**
 * ========================================
 * 纵切差分守卫 · 扩展集（阶段 2-3 全部已迁组合）
 * ========================================
 *
 * 与 scripts/channel-account-slice-test.mjs（阶段 1 的 6 项 R0 守卫）配套：
 * 本文件把**阶段 2-3 迁入的全部 (provider, method) 组合**纳入
 * 「注册表方法返回 = 源码逐字期望」的断言集，供船长接线后一次跑全验收。
 *
 * ★ 本模块是**纯函数库**：只导出 verifyExtraSlice，无顶层副作用、不自发执行。
 *   船长接线（index.ts 合并 3 个独立实现文件）后，把合并后的 registry 传进来调一次即可。
 *
 * ★ **绝不 import 现有 index.ts 注册表 / 任何被测实现模块**（避免与船长接线耦合）：
 *   所有待验组合都经 registry 参数注入；期望值全部在本文件内按源码逐字独立构造，
 *   不复用被测函数（只把 nullStatusAccounts / toStatusEnvelope 当参数用于「翻信封」
 *   与「校验注入函数本身」）。唯一 import 是 node:assert/strict。
 *
 * ── 参数契约 ──────────────────────────────────────────────────────────
 *  { registry, env, nullStatusAccounts, toStatusEnvelope }
 *  - registry          : 只读 Map<string, ChannelAccount>（船长合并后的成品表）。
 *  - env               : 一份合规的 ChannelAccountEnv 基础模板；本守卫基于它派生
 *                        每个组合的**离线** env（总是覆盖 provider/accounts/resolve/
 *                        fetcher/warn/force，故不会误用模板里的真实 fetcher 发网络）。
 *  - nullStatusAccounts: channel-account.ts 的纯函数，用于构造 R0 status 逐字期望。
 *  - toStatusEnvelope  : channel-account.ts 的 outcome→信封转换；status 方法只回
 *                        CreditsStatusOutcome，须经它翻成线上信封后断言。
 *
 * ── 运行前提（由船长的接线测试脚本保证，非本模块职责）────────────────
 *  需具备与 channel-account-slice-test.mjs 相同的 TS 模块加载能力：
 *  .js→.ts 的 resolve/load hook + @deepseek-ai/* 内核桩。因为部分实现文件
 *  （autoclaw / officeace）在方法体内含 `await import('../xxx.js')` 动态加载，
 *  且队友实现文件从 ../channel-pack-rpc.js 取 collect* 编排 helper。
 *
 * ── 离线 fixture 设计（确定性、零真实网络）──────────────────────────
 *  除 antigravity 的 extra.accountTier 专项外，一律令 env.resolve ≡ undefined。
 *  这样 collectCreditBalances / collectCreditsStatus / collectClaimResults 都在
 *  凭据解析处短路，产出**源码逐字、可预测**的确定性结果，且不触发任何 fetch：
 *    · balances 行  → { accountId, nickname, balance:null, error:'凭据未配置' }
 *                     （collectCreditBalances :705 / :727-733）
 *    · status 行    → { accountId, nickname, status:null }
 *                     （collectCreditsStatus :569 / :581，无 error 字段）
 *    · claim 行     → { accountId, nickname, outcome:{kind:'failed',code:-1,message:'凭据未配置'} }
 *                     （collectClaimResults :635-636），summary 见 computeClaimSummary :424-463
 *  默认 fetcher 是「抛错哨兵」NO_NETWORK：任何本不该发网络的组合一旦误发请求，
 *  守卫立即失败 —— 这同时验证了 opencode 的「零网络」设计决定。
 *  唯一例外 antigravity.extra.accountTier 专项用一份受控 fetcher 返回 quota +
 *  loadCodeAssist 两个离线响应，真实驱动出 extra 产物（见 extraAccountTier 检查）。
 *
 * ── 覆盖组合清单（阶段 1 + 阶段 2-3 合并后的最终矩阵）────────────────
 *  ① R0（6 项，保留原断言、并验证合并没把它们冲掉）:
 *     status  no-status-capability : codearts, trae, cline
 *     claim   bad-request 文案      : cline, workbuddy, raccoon
 *  ② balances（16 个 provider，离线期望 accounts 形状）:
 *     · 普通「凭据未配置」行: loomy, raccoon, minimax, cline, qoder, qodercn,
 *       codearts, commandcode, autoclaw, officeace, antigravity, zcode
 *     · 顶层 windowDays       : trae, buddy, workbuddy
 *     · opencode 零网络本地 map（可用 / 已停用 / 限额中 三类账号）
 *     · extra.accountTier     : antigravity（受控离线响应专项）
 *  ③ status 真查组 + claim 组（信封形状）:
 *     status queried : minimax, buddy, workbuddy（outcome.kind + toStatusEnvelope）
 *     status bad-request : buddy 兜底对白名单外 provider（kind/文案/信封）
 *     claim {ok:true,value:{results,summary}} : minimax, buddy, autoclaw,
 *       officeace, qoder, qodercn, codearts, trae
 *     claim/balances bad-request 文案 : buddy 兜底对未知 provider
 *  ④ 未迁移组合必须缺席（逐项断言 method === undefined）:
 *     zcode.claim（★ 阶段 4 明确不迁）, zcode.status,
 *     loomy.status/claim, opencode.status/claim,
 *     commandcode.status/claim, antigravity.status/claim,
 *     raccoon.status, qoder.status, qodercn.status,
 *     autoclaw.status, officeace.status
 *  另：「应存在」的 (provider, method) 全部先断言为 function —— 防止 registry
 *  为空时「缺席」检查假阳性通过（present + absent 形成完整矩阵）。
 *
 * ★ workbuddy 是同一 provider 两方法分属两阶段：status 已迁（真查）、claim 必须
 *   保留 R0 bad-request；codearts / trae 反过来：status 保留 R0、claim 已迁。
 *   本矩阵按合并后 ({...prev, ...account}) 的**最终形态**断言，正好验接线没串味。
 */
import assert from 'node:assert/strict'

// ── 源码逐字常量 ──────────────────────────────────────────────────────

/** 阶段 1 R0：渠道无独立签到状态端点（status 返回 no-status-capability）。 */
const R0_STATUS = ['codearts', 'trae', 'cline']

/** 阶段 1 R0：渠道不支持每日签到，bad-request 文案逐字照抄原分支。 */
const R0_CLAIM_MESSAGES = Object.freeze({
  cline: 'Cline 不支持每日签到（其后端没有签到接口）',
  workbuddy: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
  raccoon: 'Raccoon Work 不支持每日签到（积分由服务端自动发放，奖励见「新手任务」）',
})

/** 阶段 2-3 status 真查组（buddy/workbuddy 经 productById 白名单兜底）。 */
const STATUS_QUERIED = ['minimax', 'buddy', 'workbuddy']

/** 阶段 2-3 claim 组（workbuddy/cline/raccoon 的 claim 仍是 R0，不在此列）。 */
const CLAIM_MIGRATED = [
  'minimax', 'buddy', 'autoclaw', 'officeace', 'qoder', 'qodercn', 'codearts', 'trae',
]

/** balances：走 collectCreditBalances、resolve 短路后产出「凭据未配置」行、不带 windowDays。 */
const BALANCES_PLAIN = [
  // simple 组
  'loomy', 'raccoon', 'minimax', 'cline', 'qoder', 'qodercn',
  // complex 组（trae / buddy / workbuddy 另归 WINDOW 组；opencode 另归零网络专项）
  'codearts', 'commandcode', 'autoclaw', 'officeace', 'antigravity', 'zcode',
]

/** balances：信封额外带顶层 windowDays: buddyExpiringWindowDays()。 */
const BALANCES_WITH_WINDOW = ['trae', 'buddy', 'workbuddy']

/** balances：零网络本地 map（不发任何请求）。 */
const BALANCES_OPENCODE = 'opencode'

/** 全部已迁 balances provider（用于 present 矩阵）。 */
const ALL_BALANCES = [...BALANCES_PLAIN, ...BALANCES_WITH_WINDOW, BALANCES_OPENCODE]

/** 未迁移组合 [provider, method] —— 这些方法必须缺席，分派层落原 switch 分支。 */
const ABSENT_COMBOS = [
  ['zcode', 'claim'], ['zcode', 'status'], // ★ 阶段 4 明确不迁 zcode.claim
  ['loomy', 'status'], ['loomy', 'claim'],
  ['opencode', 'status'], ['opencode', 'claim'],
  ['commandcode', 'status'], ['commandcode', 'claim'],
  ['antigravity', 'status'], ['antigravity', 'claim'],
  ['raccoon', 'status'],
  ['qoder', 'status'], ['qodercn', 'status'],
  ['autoclaw', 'status'], ['officeace', 'status'],
]

/** 应存在的 (provider, method) 全集（防缺席检查假阳性）。 */
const PRESENT_COMBOS = [
  ...R0_STATUS.map((p) => [p, 'status']),
  ...Object.keys(R0_CLAIM_MESSAGES).map((p) => [p, 'claim']),
  ...STATUS_QUERIED.map((p) => [p, 'status']),
  ...CLAIM_MIGRATED.map((p) => [p, 'claim']),
  ...ALL_BALANCES.map((p) => [p, 'balances']),
]

/** 与原 slice-test 一致的假账号（credentialRef 用已被证明合法的 REF_* 形态）。 */
const FAKE_ACCOUNTS = Object.freeze([
  { id: 'acct-a', nickname: '账号一', credentialRef: 'REF_A' },
  { id: 'acct-b', nickname: '账号二', credentialRef: 'REF_B' },
])

/** 「未知 provider」用于触发 buddy 兜底的 bad-request 分支。 */
const UNKNOWN_PROVIDER = '__slice_extra_unknown__'

/** 默认 fetcher 哨兵：任何意外发网络的组合都会在这里抛错。 */
const NO_NETWORK = async () => {
  throw new Error('离线 fixture：该组合不得发网络请求')
}

// ── 源码逐字期望构造器（独立复刻，不调用被测函数）────────────────────

/** buddyExpiringWindowDays() 逐字复刻（buddy-balance-rank.ts:94-100，默认 15）。 */
function expectedWindowDays(envVars = process.env) {
  const raw = envVars['DSH_BUDDY_EXPIRING_WINDOW_DAYS']
  if (typeof raw !== 'string' || raw.trim().length === 0) return 15
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return 15
  return parsed
}

/** collectCreditBalances 在 resolve≡undefined 时的逐账号产物（:705 / :727-733）。 */
function expectedPlainBalanceRows(accounts) {
  return accounts.map((a) => ({
    accountId: a.id, nickname: a.nickname, balance: null, error: '凭据未配置',
  }))
}

/** collectCreditsStatus 在 resolve≡undefined 时的逐账号产物（:569 / :581，无 error）。 */
function expectedQueriedStatusRows(accounts) {
  return accounts.map((a) => ({ accountId: a.id, nickname: a.nickname, status: null }))
}

/** collectClaimResults 在 resolve≡undefined 时的逐账号 outcome（:635-636）。 */
function expectedClaimResultRows(accounts) {
  return accounts.map((a) => ({
    accountId: a.id, nickname: a.nickname,
    outcome: { kind: 'failed', code: -1, message: '凭据未配置' },
  }))
}

/** computeClaimSummary() 对 N 条 failed outcome 的逐字汇总（:424-463）。 */
function expectedFailedSummary(n) {
  return {
    claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: n,
    coversToday: 0, totalByUnit: { token: 0, credit: 0 },
  }
}

/** nullStatusAccounts() 的逐字等价构造（用于独立校验注入参数没被改坏）。 */
function expectedNullStatusRows(accounts) {
  return accounts.map((a) => ({ accountId: a.id, nickname: a.nickname, status: null }))
}

/**
 * 基于 base env 派生一份确定性离线 env。
 * 总是覆盖 provider / accounts / resolve / fetcher / warn / force，故 base 里
 * 的真实 fetcher / accounts 不会泄漏进来造成网络请求。
 */
function offlineEnv(base, provider, accounts, options = {}) {
  const { resolve, fetcher, force = false } = options
  return {
    ...base,
    provider,
    accounts,
    resolve: resolve ?? (async () => undefined),
    warn: () => {},
    fetcher: fetcher ?? NO_NETWORK,
    force,
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────

/**
 * 对阶段 1-3 全部已迁 (provider, method) 组合跑「注册表方法返回 = 源码逐字期望」。
 *
 * @returns {{ ok:true, count:number, checks:string[], groups:Record<string,number> }}
 *          通过时返回检查清单与分组计数；任一断言失败直接抛 AssertionError（带组合名）。
 */
export async function verifyExtraSlice({ registry, env, nullStatusAccounts, toStatusEnvelope }) {
  assert.ok(registry && typeof registry.get === 'function', 'registry 必须是可读 Map')
  assert.ok(env && typeof env === 'object', 'env 必须是 ChannelAccountEnv 基础模板')
  assert.equal(typeof nullStatusAccounts, 'function', 'nullStatusAccounts 必须是函数')
  assert.equal(typeof toStatusEnvelope, 'function', 'toStatusEnvelope 必须是函数')

  const checks = []
  const groups = { presence: 0, r0: 0, matrix: 0, balances: 0, statusClaim: 0, absent: 0 }
  const check = async (name, group, run) => {
    try {
      await run()
    } catch (error) {
      // 把组合名钉进错误信息，便于船长一次跑全后直接定位。
      throw new Error(`[channel-account-slice-extra] ${name} 失败: ${error?.message ?? String(error)}`, { cause: error })
    }
    checks.push(name)
    groups[group] += 1
  }

  /** 取一个「应存在」的方法；缺失时给出清晰报错而不是 undefined is not a function。 */
  const methodOf = (provider, method) => {
    const fn = registry.get(provider)?.[method]
    assert.equal(typeof fn, 'function', `注册表缺少已迁组合 ${provider}.${method}`)
    return fn
  }

  // ── 0. present 矩阵：所有应存在的组合都必须是 function ──────────────
  await check('presence/已迁组合齐备', 'presence', async () => {
    for (const [provider, method] of PRESENT_COMBOS) {
      assert.equal(
        typeof registry.get(provider)?.[method], 'function',
        `${provider}.${method} 应已迁入注册表`,
      )
    }
  })

  // ── ① 阶段 1 R0（6 项，保留原断言）─────────────────────────────────
  for (const provider of R0_STATUS) {
    await check(`r0/status/${provider}`, 'r0', async () => {
      const outcome = await methodOf(provider, 'status')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      // 原断言：outcome.kind 为 no-status-capability
      assert.equal(outcome.kind, 'no-status-capability', `${provider} status 应保持 R0 no-status-capability`)
      // 期望逐字构造 + 用注入参数 nullStatusAccounts 交叉校验
      const expected = expectedNullStatusRows(FAKE_ACCOUNTS)
      assert.deepEqual(nullStatusAccounts(FAKE_ACCOUNTS), expected, '注入的 nullStatusAccounts 行为异常')
      assert.deepEqual(outcome.accounts, expected, `${provider} 逐账号 status:null 不符`)
      // 原断言：toStatusEnvelope(outcome) 的线上信封逐字
      assert.deepEqual(toStatusEnvelope(outcome), {
        ok: true, value: { accounts: expected },
      })
    })
  }
  for (const [provider, message] of Object.entries(R0_CLAIM_MESSAGES)) {
    await check(`r0/claim/${provider}`, 'r0', async () => {
      const result = await methodOf(provider, 'claim')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      // 原断言：bad-request 文案逐字（含 workbuddy 合并后不得被阶段 2 覆盖）
      assert.deepEqual(result, {
        ok: false, error: { code: 'bad-request', message },
      })
    })
  }

  // ── ①-bis 合并后「每 provider × 三方法」真值表（接线完整性）────────
  // index.ts 的 add() 按 id 做 {...prev, ...account} 合并；本表把合并后的
  // **最终形态**逐格钉死，能一次抓出「合并顺序错 / 多带方法 / 少接一家」。
  // ★ workbuddy：status 来自阶段 3、claim 来自阶段 1 R0 —— 合并后**两个都在**
  //   （队长说的「无 claim」指新文件不带 claim，不是成品表没有 claim）。
  // ★ codearts / trae：status 来自阶段 1 R0、claim 来自阶段 3、balances 来自
  //   复杂组 —— 三个方法由三处合并而成，任一处漏 add 都会被本表抓到。
  // [provider, wantStatus, wantClaim, wantBalances]
  const MATRIX = [
    ['codearts',     true,  true,  true ],
    ['trae',         true,  true,  true ],
    ['cline',        true,  true,  true ],
    ['workbuddy',    true,  true,  true ],
    ['minimax',      true,  true,  true ],
    ['buddy',        true,  true,  true ],
    ['raccoon',      false, true,  true ],
    ['qoder',        false, true,  true ],
    ['qodercn',      false, true,  true ],
    ['autoclaw',     false, true,  true ],
    ['officeace',    false, true,  true ],
    ['opencode',     false, false, true ],
    ['loomy',        false, false, true ],
    ['commandcode',  false, false, true ],
    ['antigravity',  false, false, true ],
    ['zcode',        false, false, true ], // ★ claim/status 必须缺席（阶段 4 不迁）
  ]
  await check('matrix/合并后三方法真值表', 'matrix', async () => {
    for (const [provider, wantStatus, wantClaim, wantBalances] of MATRIX) {
      const account = registry.get(provider)
      assert.ok(account, `注册表缺少 provider ${provider}`)
      for (const [method, want] of [['status', wantStatus], ['claim', wantClaim], ['balances', wantBalances]]) {
        assert.equal(
          typeof account[method] === 'function', want,
          `${provider}.${method} 合并后应${want ? '存在' : '缺席'}`,
        )
      }
    }
  })

  // ── ② balances：各 provider 用离线 fixture 的期望 accounts 形状 ────

  // ②-a 普通「凭据未配置」行（带原因 error）：12 个 provider
  for (const provider of BALANCES_PLAIN) {
    await check(`balances/plain/${provider}`, 'balances', async () => {
      const result = await methodOf(provider, 'balances')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      assert.deepEqual(result, {
        ok: true,
        value: { accounts: expectedPlainBalanceRows(FAKE_ACCOUNTS) },
      }, `${provider} balances 逐账号「带原因 error」形状不符`)
    })
  }

  // ②-b 顶层 windowDays：trae / buddy / workbuddy
  for (const provider of BALANCES_WITH_WINDOW) {
    await check(`balances/windowDays/${provider}`, 'balances', async () => {
      const result = await methodOf(provider, 'balances')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      assert.deepEqual(result, {
        ok: true,
        value: {
          accounts: expectedPlainBalanceRows(FAKE_ACCOUNTS),
          windowDays: expectedWindowDays(),
        },
      }, `${provider} balances 必须带回逐字 windowDays`)
    })
  }

  // ②-c opencode 零网络本地 map：三类账号（可用 / 已停用 / 限额中）
  await check('balances/opencode/零网络本地map', 'balances', async () => {
    const future = Date.now() + 86_400_000 // 一天后，远离 Date.now() 抖动
    const accounts = Object.freeze([
      { id: 'oc-a', nickname: '可用', credentialRef: 'REF_OC_A', enabled: true, modelRateLimits: {} },
      { id: 'oc-b', nickname: '停用', credentialRef: 'REF_OC_B', enabled: false, modelRateLimits: {} },
      { id: 'oc-c', nickname: '限额', credentialRef: 'REF_OC_C', enabled: true, modelRateLimits: { 'model-x': future } },
    ])
    const neutralPkg = (name, available) => ({
      name, unit: '通道', remaining: available, total: available, used: 0,
      active: true, cycleStartTime: '', cycleEndTime: '', expiredTime: '',
    })
    const expected = [
      { // 可用：available=1、无 error
        accountId: 'oc-a', nickname: '可用',
        balance: { total: 1, packages: [neutralPkg('可用通道', 1)], expiredTotal: 0 },
      },
      { // 停用：available=0、error='已停用'
        accountId: 'oc-b', nickname: '停用',
        balance: { total: 0, packages: [neutralPkg('可用通道', 0)], expiredTotal: 0 },
        error: '已停用',
      },
      { // 限额：available=0、expiredTotal=1、包名带限额数、error 带恢复时间
        accountId: 'oc-c', nickname: '限额',
        balance: { total: 0, packages: [neutralPkg('1 个模型限额中', 0)], expiredTotal: 1 },
        error: `限额中，${new Date(future).toLocaleString('zh-CN')} 恢复`,
      },
    ]
    // fetcher 用抛错哨兵：opencode 一旦误发网络请求，这里立即失败（零网络设计决定）。
    const result = await methodOf(BALANCES_OPENCODE, 'balances')(
      offlineEnv(env, BALANCES_OPENCODE, accounts),
    )
    assert.deepEqual(result, { ok: true, value: { accounts: expected } })
  })

  // ②-d extra.accountTier：antigravity 受控离线响应（唯一真·驱动 fetcher 的专项）
  await check('balances/antigravity/extra.accountTier', 'balances', async () => {
    const RESET = '2026-01-01T00:00:00.000Z'
    const QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
    const TIER_PATH = '/v1internal:loadCodeAssist'
    const accounts = Object.freeze([
      { id: 'ag-a', nickname: 'Pro 账号', credentialRef: 'REF_AG_A' },
    ])
    // 唯一 token + force:true，跳过 60s 缓存，保证本次响应确定。
    const credential = { access_token: 'fixture-slice-extra-antigravity-token' }
    const fixtureFetcher = async (input) => {
      const url = String(input)
      let body
      if (url.includes(QUOTA_PATH)) {
        body = { groups: [{ buckets: [
          { bucketId: 'gemini-5h', window: '5h', resetTime: RESET, remainingFraction: 0.99 },
          { bucketId: 'gemini-weekly', window: 'weekly', resetTime: RESET, remainingFraction: 0.5 },
        ] }] }
      } else if (url.includes(TIER_PATH)) {
        body = { paidTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } }
      } else {
        throw new Error(`离线 fixture 未预期的请求: ${url}`)
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    // toGeminiCreditBalance 逐字产物：5h=99%、weekly=50%、total=roundCredits((99+50)/2)=74.5
    const expectedBalance = {
      total: 74.5,
      packages: [
        { name: '5 小时窗口', unit: '%', remaining: 99, total: 100, used: 1,
          active: true, cycleStartTime: '', cycleEndTime: RESET, expiredTime: '' },
        { name: '周窗口', unit: '%', remaining: 50, total: 100, used: 50,
          active: true, cycleStartTime: '', cycleEndTime: RESET, expiredTime: '' },
      ],
      expiredTotal: 0,
    }
    // fetchBalanceDetailed 把 tier 翻成 extra.accountTier（label 短标签 / title 上游原文）
    const expectedExtra = {
      accountTier: { label: 'Pro', title: 'Google AI Pro（g1-pro-tier）' },
    }
    const result = await methodOf('antigravity', 'balances')(
      offlineEnv(env, 'antigravity', accounts, {
        resolve: async () => ({ value: JSON.stringify(credential) }),
        fetcher: fixtureFetcher,
        force: true,
      }),
    )
    assert.deepEqual(result, {
      ok: true,
      value: { accounts: [
        { accountId: 'ag-a', nickname: 'Pro 账号', balance: expectedBalance, extra: expectedExtra },
      ] },
    })
  })

  // ── ②-e 有凭据 + 协议替身驱动（2026-11-06 全码审查 t3-#1 修复）───────
  // 旧 offlineEnv.resolve 恒 undefined ⇒ plain/window 组只走「凭据未配置」短路，
  // fetchBalance 钩子从未被驱动（假绿：钩子整段写错也全绿）。本组给每个渠道
  // 一份「该渠道已知成功形状」的协议替身，断言 balance 真被解析出来；
  // 另加「替身抛错 → 单账号带原因 error 行、不炸整轮」的失败驱动。
  const STANDIN_RESPONSES = {
    '/points/records': { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } },
    // raccoon 核心字段是 available_points（fetchRaccoonCreditBalance 只认它）
    '/points/v1/balance': { code: '000000', data: { available_points: 123, reward_points: 20, daily_points: 3 } },
    '/credit/details': { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] },
    '/me/usage': { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } },
    '/balance': { data: { userId: 'usr-fixture', balance: 123 }, success: true },
    // codearts：package.is_credit_package + metrics 的 usageTotalPackageCredit（fetchCodeArtsAccountInfoDetailed 只认这些）
    '/statistics/plugin': { code: 0, data: { package: { is_credit_package: true, package_name_cn: '积分包', status: 'active' }, metrics: [{ name: 'usageTotalPackageCredit', package_credit_amount: 200, package_credit_used: 77, package_credit_remain: 123 }] } },
    // buddy/workbuddy：fetchCreditBalance（helper 默认实现）→ data.Response.Data.Accounts[]
    '/get-user-resource': { code: 0, data: { Response: { Data: { Accounts: [{ PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1 }] } } } },
    // commandcode：{balance,limit,used}（fetchCredits → /alpha/billing/credits）
    '/billing/credits': { balance: 123, limit: 1000, used: 77 },
    // autoclaw：data.wallets[]，元素含 public_wallet_type + balance（v2 链路）
    '/wallets': { code: 0, data: { wallets: [{ public_wallet_type: 'main', balance: 123 }] } },
    // officeace：skus[].quotas[].sku_attr_code === 'officeace_points'（sku_value/current_value）
    '/subscription': { skus: [{ sku_name: '果办套餐', expired_time: 4102444800000, quotas: [{ sku_attr_code: 'officeace_points', sku_value: 200, current_value: 77 }] }] },
    // trae：postJson 不解包，user_entitlement_pack_list 在顶层；quota.credits_limit 必 >0
    '/ide_user_ent_usage': { code: 0, user_entitlement_pack_list: [{ entitlement_base_info: { quota: { credits_limit: 200 }, display_desc: '每月登录赠送' }, usage: { credits_amount: 77 }, expire_time: 4102444800 }] },
  }
  const standinFetcher = async (input) => {
    const target = String(input instanceof Request ? input.url : input)
    for (const [needle, body] of Object.entries(STANDIN_RESPONSES)) {
      if (target.includes(needle)) return Response.json(body)
    }
    throw new Error(`协议替身未覆盖端点：${target}`)
  }
  const FIXTURE_CREDENTIAL = JSON.stringify({
    access_token: 'fixture-token', zcode_jwt: 'fixture-jwt', device_mid: 'fixture-device',
    account_id: 'usr-fixture', user_id: 'usr-fixture', uid: 'fixture-uid',
    access_key_id: 'fixture-ak', secret_access_key: 'fixture-sk',
    // officeace：业务签名用 access_key/secret_key，网关地址取 model_info.model_api_url_base
    access_key: 'fixture-ak', secret_key: 'fixture-sk',
    model_info: { model_api_url_base: 'https://officeace-fixture.example' },
  })
  const credEnv = (base, provider, accounts, fetcher) => offlineEnv(base, provider, accounts, {
    resolve: async () => ({ value: FIXTURE_CREDENTIAL }),
    fetcher,
  })
  for (const provider of BALANCES_PLAIN) {
    if (provider === 'antigravity' || provider === 'zcode') continue // zcode 走 RPC 级，antigravity 有 ②-d
    await check(`balances/driven/${provider}`, 'balances', async () => {
      const result = await methodOf(provider, 'balances')(
        credEnv(env, provider, FAKE_ACCOUNTS, standinFetcher))
      assert.equal(result.ok, true, `${provider} balances 有凭据驱动应 ok`)
      const rows = result.value?.accounts ?? []
      assert.equal(rows.length, FAKE_ACCOUNTS.length, `${provider} 应逐账号返回`)
      const parsed = rows.filter((row) => row.balance !== null && row.balance !== undefined)
      assert.ok(parsed.length > 0,
        `${provider} fetchBalance 钩子未被驱动成功：${JSON.stringify(rows).slice(0, 200)}`)
    })
  }
  for (const provider of BALANCES_WITH_WINDOW) {
    await check(`balances/driven-window/${provider}`, 'balances', async () => {
      const result = await methodOf(provider, 'balances')(
        credEnv(env, provider, FAKE_ACCOUNTS, standinFetcher))
      assert.equal(result.ok, true, `${provider} balances 有凭据驱动应 ok`)
      const rows = result.value?.accounts ?? []
      const parsed = rows.filter((row) => row.balance !== null && row.balance !== undefined)
      assert.ok(parsed.length > 0, `${provider} fetchBalance 钩子未被驱动成功`)
      assert.equal(result.value.windowDays, expectedWindowDays(), `${provider} 顶层 windowDays 必须保留`)
    })
  }
  for (const provider of [...BALANCES_PLAIN, ...BALANCES_WITH_WINDOW]) {
    if (provider === 'antigravity' || provider === 'opencode') continue
    await check(`balances/driven-error/${provider}`, 'balances', async () => {
      const boom = async () => { throw new Error('fixture 传输失败') }
      const result = await methodOf(provider, 'balances')(
        credEnv(env, provider, FAKE_ACCOUNTS, boom))
      assert.equal(result.ok, true, `${provider} 单账号传输失败不得炸整轮`)
      const rows = result.value?.accounts ?? []
      assert.equal(rows.length, FAKE_ACCOUNTS.length, `${provider} 失败驱动仍应逐账号返回`)
      for (const row of rows) {
        assert.equal(row.balance ?? null, null, `${provider} 传输失败不得编造余额`)
        assert.ok(typeof row.error === 'string' && row.error.length > 0,
          `${provider} 传输失败必须带原因 error 行`)
      }
    })
  }

  // ── ③ status 真查组 + claim 组（信封形状 / bad-request 文案 / kind）──

  // ③-a status queried：kind + 信封 {ok:true,value:{accounts}}
  for (const provider of STATUS_QUERIED) {
    await check(`status/queried/${provider}`, 'statusClaim', async () => {
      const outcome = await methodOf(provider, 'status')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      assert.equal(outcome.kind, 'queried', `${provider} status 应真查（queried）`)
      const expectedRows = expectedQueriedStatusRows(FAKE_ACCOUNTS)
      assert.deepEqual(outcome.accounts, expectedRows)
      assert.deepEqual(toStatusEnvelope(outcome), {
        ok: true, value: { accounts: expectedRows },
      })
    })
  }

  // ③-b claim：{ok:true,value:{results,summary}} 信封逐字
  for (const provider of CLAIM_MIGRATED) {
    await check(`claim/envelope/${provider}`, 'statusClaim', async () => {
      const result = await methodOf(provider, 'claim')(
        offlineEnv(env, provider, FAKE_ACCOUNTS),
      )
      assert.deepEqual(result, {
        ok: true,
        value: {
          results: expectedClaimResultRows(FAKE_ACCOUNTS),
          summary: expectedFailedSummary(FAKE_ACCOUNTS.length),
        },
      }, `${provider} claim 信封/汇总不符`)
    })
  }

  // ③-c bad-request 文案 + status outcome kind：buddy 兜底对白名单外 provider
  await check('status/bad-request/buddy兜底白名单外', 'statusClaim', async () => {
    const message = `unsupported provider: ${UNKNOWN_PROVIDER}`
    const badEnv = offlineEnv(env, UNKNOWN_PROVIDER, FAKE_ACCOUNTS)
    const outcome = await methodOf('buddy', 'status')(badEnv)
    assert.equal(outcome.kind, 'bad-request')
    assert.equal(outcome.message, message)
    assert.deepEqual(toStatusEnvelope(outcome), {
      ok: false, error: { code: 'bad-request', message },
    })
  })
  await check('claim/bad-request/buddy兜底白名单外', 'statusClaim', async () => {
    const message = `unsupported provider: ${UNKNOWN_PROVIDER}`
    const result = await methodOf('buddy', 'claim')(
      offlineEnv(env, UNKNOWN_PROVIDER, FAKE_ACCOUNTS),
    )
    assert.deepEqual(result, { ok: false, error: { code: 'bad-request', message } })
  })
  await check('balances/bad-request/buddy兜底白名单外', 'statusClaim', async () => {
    const message = `unsupported provider: ${UNKNOWN_PROVIDER}`
    const result = await methodOf('buddy', 'balances')(
      offlineEnv(env, UNKNOWN_PROVIDER, FAKE_ACCOUNTS),
    )
    assert.deepEqual(result, { ok: false, error: { code: 'bad-request', message } })
  })

  // ── ④ 未迁移组合必须缺席 ──────────────────────────────────────────
  // 先钉住 zcode 确实已接进来（有 balances），否则「claim/status 缺席」可能是
  // 整个 provider 没接线造成的假阳性。
  await check('absent/zcode.claim（阶段4不迁）', 'absent', async () => {
    assert.equal(typeof registry.get('zcode')?.balances, 'function',
      'zcode 应已迁入 balances（否则 claim 缺席是假阳性）')
    assert.equal(typeof registry.get('zcode')?.claim, 'undefined',
      'zcode.claim 必须缺席（阶段 4 明确不迁）')
    assert.equal(typeof registry.get('zcode')?.status, 'undefined',
      'zcode.status 必须缺席')
  })
  for (const [provider, method] of ABSENT_COMBOS) {
    await check(`absent/${provider}.${method}`, 'absent', async () => {
      assert.equal(typeof registry.get(provider)?.[method], 'undefined',
        `${provider}.${method} 是未迁移组合，必须缺席`)
    })
  }

  // 2026-11-06 全码审查修复（t3-#8）：钉死各组最低数量 —— 删组/漏登记会直接红，
  // 防止「守卫悄悄变少」。新加组合请同步上调对应下限。
  const FLOORS = { presence: 1, r0: 6, matrix: 1, balances: 21, statusClaim: 14, absent: 16, driven: 0 }
  for (const [group, floor] of Object.entries(FLOORS)) {
    const n = group === 'driven'
      ? checks.filter((c) => c.startsWith('balances/driven')).length
      : groups[group] ?? 0
    assert.ok(n >= floor, `差分守卫分组 ${group} 只有 ${n} 项（下限 ${floor}）—— 组被删/漏登记`)
  }
  assert.ok(checks.length >= 82, `差分守卫总数 ${checks.length} 低于基线 82 —— 有检查被静默删除`)
  return { ok: true, count: checks.length, checks, groups }
}

export default verifyExtraSlice
