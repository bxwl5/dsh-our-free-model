import { directFetch } from './direct-fetch.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { signRequestHuawei } from './sign.js'
import type { CodeArtsCredential } from './types.js'

/**
 * opengw 网关配置端点 — 返回 benefit（免费额度）模型列表（glm-5.3-flash 等）。
 * 逆向自 CodeArts Agent IDE mitmproxy 抓包（2026-08）。
 */
export const OPENGW_GATEWAY_CONFIG_URL = 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config'

/**
 * snap-access 内置模型列表端点 — 返回常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）。
 * 响应结构：{ count, builtinModels: [{ model_id, model_name, ... }] }。
 * 用 AK/SK 签名 + Agent-Type: PromptCenter header。
 * 替代旧 SNAP_STATISTICS_URL（statistics/plugin 已不再返回 model_metrics）。
 */
export const SNAP_MODEL_BUILTIN_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin'

/** 远端动态模型列表缓存文件名（~/.cache/deveco/codearts_models.json）。 */
/**
 * agent-center 端点（模型消耗系数「倍率」的来源，2026-10-29）：
 * 账号主智能体（`original_id === 'build'`，旧清单叫 CodeAgent）的
 * `agents/detail → gpts.models[].credit[0].ratio_display`（字符串 "1.50"）。
 * magpie opencode-codearts-auth 同源同判据；该端点用 `Agent-Type: AgentCenter`
 * （**签名后追加**，与 PromptCenter 同一批「不参与签名」的头，见
 * `codearts-credits.ts` 的 SNAP_EXTRA_HEADERS 注记）。
 */
export const CODEARTS_AGENT_LIST_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/useragents?offset=0&limit=100'
export const CODEARTS_AGENT_DETAIL_URL = (id: string): string =>
  `https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(id)}`
/** 主智能体识别：`original_id` 是 build（现行）或 CodeAgent（旧清单）。 */
const MAIN_AGENT_ORIGINAL_IDS: readonly string[] = ['build', 'CodeAgent']
/** 主智能体 agent_id 兜底（magpie 实测固定值；agent 列表读不出时直接试它）。 */
const MAIN_AGENT_FALLBACK_ID = 'a8bcb36232554267a5142361cc25a393'
/** 最多试几个智能体的 detail 才放弃（magpie 同款 3）。 */
const AGENT_DETAIL_TRIES = 3
/** agent-center 附加头（签名后追加，不参与签名计算）。 */
const AGENT_CENTER_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json',
  'Agent-Type': 'AgentCenter',
  'X-Language': 'zh-cn',
}

const CODEARTS_MODELS_CACHE_FILENAME = 'codearts_models.json'

/**
 * benefit（免费额度）模型 id 集合的缓存文件名
 * （~/.cache/deveco/codearts_benefit_models.json）。
 *
 * 与模型列表分开缓存：判定 `maas_type` 只关心 id 集合，且 chat 请求在每次
 * 签名前都要查它，独立文件可避免解析整份模型元数据。
 */
const CODEARTS_BENEFIT_CACHE_FILENAME = 'codearts_benefit_models.json'

/**
 * 远端不可用时的 benefit 模型兜底集合。
 *
 * **为什么需要它**：benefit 模型调用必须带 `maas_type: benefit`（参与
 * SDK-HMAC-SHA256 签名），否则后端返回
 * `InferHub.002002009.404 The model is not registered`。该集合的权威来源是
 * `opengw gateway/config` 的 `result.models`（见 {@link fetchCodeArtsRemoteModels}），
 * 但首次启动、未登录或远端拉取失败时拿不到，故保留一份兜底。
 *
 * 实证（2026-09-23，对齐 deveco-code-rust fb1b4a2）：
 * 1. IDE kernel 日志的 `inferhub-provider [header-debug] full headers` 显示
 *    `deepseek-v4.1-flash` 的实际出站请求带 `"maas_type":"benefit"`；
 * 2. 逐个对照两个端点的模型：`gateway/config` 的模型（glm-5.3-flash、
 *    deepseek-v4.1-flash 等）不带该头一律 404 not registered、带上即成功；
 *    而 `/v1/model/builtin` 的模型（GLM-5.2 等）带上反而 `unsupported model`。
 *
 * ⚠️ `deepseek-v4-flash` / `deepseek-v4-pro`（无日期后缀）**不在**此集合：
 * 它们是后端另外注册的非 benefit 模型，带上 maas_type 会报 unsupported model。
 * 尤其注意 gateway/config 返回的是它们的**带日期后缀**形态
 * （`deepseek-v4-flash-0731`），归一化后落到这两个 id —— 绝不能连带标成 benefit。
 */
export const CODEARTS_BENEFIT_FALLBACK: readonly string[] = ['glm-5.3-flash', 'deepseek-v4.1-flash']

/** 动态模型拉取超时（ms）。 */
const FETCH_TIMEOUT_MS = 10_000

/** 定时刷新远端模型列表的间隔（2 小时）。 */
export const MODEL_REFRESH_INTERVAL_MS = 2 * 3_600_000

export interface RemoteModel {
  id: string
  name: string
}

/** 模块级内存缓存：远端拉取或磁盘加载后填充；availableCodeArtsModels 优先读取。 */
let memoryCache: RemoteModel[] | undefined

/** benefit 模型 id 集合的内存缓存：远端拉取或磁盘加载后填充。 */
let benefitMemoryCache: string[] | undefined

/**
 * 去掉模型 id 末尾的日期版本后缀：deepseek-v4-flash-0731 → deepseek-v4-flash。
 * 远端 gateway/config 返回带日期后缀的 model_id（-0731 = 7月31日版本），
 * 但 chat 端点只认不带后缀的 id（InferHub.002002009.404 "model is not registered"）。
 * 仅匹配末尾 -NNNN（4 位数字），避免误去 glm-5.3-flash 等无后缀 id。
 */
export function normalizeModelId(id: string): string {
  if (id.length > 5) {
    const suffix = id.slice(-5)
    if (suffix.startsWith('-') && /^\d{4}$/.test(suffix.slice(1))) {
      return id.slice(0, -5)
    }
  }
  return id
}

function parseModelInfo(m: Record<string, unknown>, seen: Set<string>): RemoteModel | undefined {
  const rawId = m['model_id']
  if (typeof rawId !== 'string' || rawId.length === 0) return undefined
  const id = normalizeModelId(rawId)
  // 过滤视觉（VL）多模态模型
  // id 含 -VL- 或以 -VL 结尾（如 Qwen3-VL-235B），上下文小、不支持工具调用，
  // 不适合当 agent 主模型，从列表隐藏；只通过 analyzeImage 等工具间接调用。
  if (id.includes('-VL-') || id.endsWith('-VL')) return undefined
  const rawName = m['model_name']
  const name = typeof rawName === 'string' && rawName.length > 0 ? normalizeModelId(rawName) : id
  if (seen.has(id)) return undefined
  seen.add(id)
  return { id, name }
}

/** 从 JSON 响应中沿路径指针取数组。 */
function extractJsonArray(text: string, path: string[]): unknown[] | undefined {
  try {
    let value: unknown = JSON.parse(text)
    for (const key of path) {
      if (typeof value !== 'object' || value === null) return undefined
      value = (value as Record<string, unknown>)[key]
    }
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 签名 GET 请求远端端点并读取文本；网络失败或非 200 时返回 undefined
 * （不阻断调用方）。
 */
async function fetchSignedGet(
  fetcher: typeof fetch,
  url: string,
  ak: string,
  sk: string,
  st: string,
  /** 签名后追加的头（不参与 SDK-HMAC-SHA256 签名计算）。 */
  extraUnsignedHeaders?: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const signed = await signRequestHuawei(ak, sk, st, 'GET', url, new Uint8Array())
  const headers = new Headers()
  signed.forEach((v, k) => {
    if (k !== 'host') headers.set(k, v)
  })
  if (extraUnsignedHeaders !== undefined) {
    for (const [k, v] of Object.entries(extraUnsignedHeaders)) headers.set(k, v)
  }
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return await response.text()
  } catch {
    return undefined
  }
}

/**
 * 从两个远端端点拉取模型列表并合并去重：
 * 1. opengw gateway/config → result.models（benefit 模型）
 * 2. snap-access /v1/model/builtin → builtinModels（常规模型）
 * 失败或空凭据时返回空数组（不阻断）。
 *
 * 同时把 gateway/config 下发的 benefit 模型 id 集合写入独立缓存
 * （见 {@link saveBenefitCache}），供 chat 请求判定是否带 `maas_type: benefit`。
 */
export async function fetchCodeArtsRemoteModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch = directFetch,
): Promise<RemoteModel[]> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) return []

  const models: RemoteModel[] = []
  const seen = new Set<string>()
  // 来自 gateway/config 的 benefit 模型 id —— 调用时必须带 maas_type: benefit。
  //
  // ⚠️ 只记录**未被去掉日期后缀**的 id（即 chat 请求真正发出的那个 id）。
  // 原因：normalizeModelId 会把 gateway 的 `deepseek-v4-flash-0731` 改写成
  // `deepseek-v4-flash`，而两者在后端是**不同模型**、benefit 属性相反
  // （实测：`-0731` 不带 maas_type → 404；无后缀的不带 → 成功、带上 →
  // `unsupported model`）。记录被改写过的 id 会把无后缀模型错误标记为
  // benefit，导致它反而调用失败。既然该 id 我们根本不发送，它也就无从
  // 决定我们发送的 id 的 benefit 属性。
  const benefitIds: string[] = []

  // 1. opengw gateway/config — benefit 模型（glm-5.3-flash 等）
  const gatewayText = await fetchSignedGet(fetcher, OPENGW_GATEWAY_CONFIG_URL, ak, sk, st)
  if (gatewayText !== undefined) {
    const arr = extractJsonArray(gatewayText, ['result', 'models'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const entry = item as Record<string, unknown>
          const rawId = typeof entry['model_id'] === 'string' ? entry['model_id'] : ''
          const mi = parseModelInfo(entry, seen)
          if (mi) {
            // 仅当归一化未改写 id 时才记为 benefit（见上方说明）
            if (rawId.length > 0 && normalizeModelId(rawId) === rawId) benefitIds.push(mi.id)
            models.push(mi)
          }
        }
      }
    }
  }

  // 2. snap-access /v1/model/builtin — 常规模型（GLM-5.2、openpangu、glm-5.2-sft-harmony 等）
  //    Agent-Type: PromptCenter + X-Language: zh-cn（不参与签名）。
  //    替代旧 statistics/plugin（已不再返回 model_metrics）。
  const snapText = await fetchSignedGet(fetcher, SNAP_MODEL_BUILTIN_URL, ak, sk, st, {
    'Content-Type': 'application/json',
    'Agent-Type': 'PromptCenter',
    'X-Language': 'zh-cn',
  })
  if (snapText !== undefined) {
    const arr = extractJsonArray(snapText, ['builtinModels'])
    if (arr !== undefined) {
      for (const item of arr) {
        if (typeof item === 'object' && item !== null) {
          const mi = parseModelInfo(item as Record<string, unknown>, seen)
          if (mi) models.push(mi)
        }
      }
    }
  }

  // 3. agent-center 主智能体模型列表（2026-10-29）：给目录里已有的模型**补
  //    消耗系数**（rate），智能体独有的可调用模型也一并补进列表（magpie 同款
  //    合并规则：非自有（!own）、未隐藏（!hidden）、非 VL）。失败/空响应不
  //    阻断目录 —— 只是没有倍率（与 ①② 两个端点同级降级）。
  const agent = await fetchCodeArtsAgentModels(credential, fetcher)
  if (agent.rates.size > 0) {
    for (const model of models) {
      const rate = agent.rates.get(model.id)
      if (rate !== undefined && rate > 0) model.rate = rate
    }
  }
  // 智能体独有、目录里没有的模型补进列表（Agent 独有模型也是该账号能调用的）。
  for (const [id, rate] of agent.rates) {
    if (models.some((model) => model.id === id)) continue
    models.push({ id, name: id, ...(rate > 0 ? { rate } : {}) })
  }

  // 持久化 benefit 集合：chat 请求签名时据此决定是否带 maas_type。
  // 仅在确实从 gateway 拿到模型时写入，避免把空集合覆盖掉可用缓存。
  if (benefitIds.length > 0) {
    setBenefitMemoryCache(benefitIds)
    saveBenefitCache(benefitIds)
  }

  return models
}

/**
 * 从 `credit` 字段解析消耗系数：单层或一层价格档数组，`ratio_display`
 * 是字符串形态的倍率（"1.50"）。无/非法 → 0。
 */
function creditRateOf(credit: unknown): number {
  const tier = Array.isArray(credit) ? credit[0] : credit
  if (typeof tier !== 'object' || tier === null) return 0
  const raw = (tier as Record<string, unknown>)['ratio_display'] ?? (tier as Record<string, unknown>)['ratioDisplay']
  const parsed = typeof raw === 'string' ? Number.parseFloat(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/** 解析 agent 模型条目（`model_parameters.model_id` 才是请求真正用的 id）。 */
function parseAgentModel(m: Record<string, unknown>): { id: string; rate: number; own: boolean; hidden: boolean } | undefined {
  const params = typeof m['model_parameters'] === 'object' && m['model_parameters'] !== null
    ? (m['model_parameters'] as Record<string, unknown>)
    : {}
  const rawId = typeof params['model_id'] === 'string' && params['model_id'] !== '' ? params['model_id']
    : typeof m['model_id'] === 'string' ? m['model_id'] : undefined
  if (rawId === undefined) return undefined
  const id = normalizeModelId(rawId)
  // VL 模型不进目录（与 ①② 同判据）。
  if (id.includes('-VL-') || id.endsWith('-VL')) return undefined
  const own = m['model_type'] === 'third' || m['model_type'] === 'custom' || m['is_custom_model'] === true
  const hidden = m['display_enabled'] === false || params['display_enabled'] === false
  return { id, rate: creditRateOf(m['credit'] ?? params['credit']), own, hidden }
}

/**
 * 拉主智能体的模型清单 → `Map<模型id, 消耗系数>`。
 *
 * 顺序（magpie agentCandidates 同判据）：agent 列表按 `original_id` 排序
 * （build 最优先），逐个试 `agents/detail`（最多 {@link AGENT_DETAIL_TRIES} 个）；
 * 列表端点不可用时直接试固定兜底 id。任一 detail 拿到 `gpts.models` 即停。
 */
async function fetchCodeArtsAgentModels(
  credential: CodeArtsCredential,
  fetcher: typeof fetch,
): Promise<{ rates: Map<string, number> }> {
  const { access_key_id: ak, secret_access_key: sk, security_token: st } = credential
  if (!ak || !sk) return { rates: new Map() }

  const ids: string[] = []
  const listText = await fetchSignedGet(fetcher, CODEARTS_AGENT_LIST_URL, ak, sk, st, AGENT_CENTER_HEADERS)
  if (listText !== undefined) {
    const agents = extractJsonArray(listText, ['agents']) ?? extractJsonArray(listText, ['data', 'agents']) ?? []
    const ranked: Array<{ id: string; rank: number }> = []
    for (const agent of agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const record = agent as Record<string, unknown>
      const agentId = typeof record['agent_id'] === 'string' ? record['agent_id'] : undefined
      if (agentId === undefined || agentId === '') continue
      const originalId = typeof record['original_id'] === 'string' ? record['original_id'] : agentId
      const rank = MAIN_AGENT_ORIGINAL_IDS.indexOf(originalId)
      ranked.push({ id: agentId, rank: rank < 0 ? MAIN_AGENT_ORIGINAL_IDS.length : rank })
    }
    ranked.sort((a, b) => a.rank - b.rank)
    ids.push(...ranked.map((entry) => entry.id))
  }
  ids.push(MAIN_AGENT_FALLBACK_ID)

  for (const agentId of [...new Set(ids)].slice(0, AGENT_DETAIL_TRIES)) {
    const detailText = await fetchSignedGet(fetcher, CODEARTS_AGENT_DETAIL_URL(agentId), ak, sk, st, AGENT_CENTER_HEADERS)
    if (detailText === undefined) continue
    let models: unknown[] | undefined
    try {
      const parsed: unknown = JSON.parse(detailText)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const gpts = typeof record['gpts'] === 'object' && record['gpts'] !== null
          ? (record['gpts'] as Record<string, unknown>)
          : typeof (record['data'] as Record<string, unknown> | undefined)?.gpts === 'object'
            ? ((record['data'] as Record<string, unknown>).gpts as Record<string, unknown>)
            : undefined
        if (Array.isArray(gpts?.['models'])) models = gpts['models'] as unknown[]
      }
    } catch {
      models = undefined
    }
    if (models === undefined || models.length === 0) continue
    const rates = new Map<string, number>()
    for (const item of models) {
      if (typeof item !== 'object' || item === null) continue
      const parsed = parseAgentModel(item as Record<string, unknown>)
      // 智能体自有/隐藏/VL 模型不进倍率表（own 是用户或租户配置的，不是
      // CodeArts 自己的计费模型；hidden 是 IDE 里被关掉的）。
      if (parsed === undefined || parsed.own || parsed.hidden) continue
      if (parsed.rate > 0 && !rates.has(parsed.id)) rates.set(parsed.id, parsed.rate)
    }
    if (rates.size > 0) return { rates }
  }
  return { rates: new Map() }
}

/**
 * 缓存目录：默认 `~/.cache/deveco`，可用 `DSH_CODEARTS_CACHE_DIR` 覆盖
 * （单测借此隔离，避免污染真实用户缓存）。
 */
function cacheDir(): string | undefined {
  const override = process.env.DSH_CODEARTS_CACHE_DIR
  if (override !== undefined && override.length > 0) return override
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home) return undefined
  return `${home}/.cache/deveco`
}

/** 动态模型列表缓存路径：~/.cache/deveco/codearts_models.json。 */
function modelsCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_MODELS_CACHE_FILENAME}`
}

/** benefit 模型集合缓存路径：~/.cache/deveco/codearts_benefit_models.json。 */
function benefitCachePath(): string | undefined {
  const dir = cacheDir()
  return dir === undefined ? undefined : `${dir}/${CODEARTS_BENEFIT_CACHE_FILENAME}`
}

/**
 * 保存动态模型列表到缓存文件（原子写入 tmp+rename）。
 *
 * ⚠️ 必须用**顶层静态导入**的 `node:fs`（见文件头），**不能**用
 * `require('node:fs')`：本包是 ESM（package.json `"type": "module"`），
 * `require` 在 ESM 下未定义，调用会抛 ReferenceError —— 被下面的 catch
 * 静默吞掉，表现为「写入/读取永远无效」。真实缺陷（2026-09-23）：磁盘缓存
 * 的读取路径曾因 `require` 恒返回 undefined，于是模型列表与 benefit 集合
 * 每次都要回退静态兜底。
 */
export function saveModelsCache(models: RemoteModel[]): void {
  const path = modelsCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(models), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的动态模型列表; 文件不存在或解析失败时返回 undefined。 */
export function loadModelsCache(): RemoteModel[] | undefined {
  const path = modelsCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const models: RemoteModel[] = JSON.parse(text)
    return Array.isArray(models) && models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 取出可用模型列表，优先级：内存缓存 → 磁盘缓存 → 空。
 * 由 adapter 的 listModels 调用；无远端模型时仍回退到 adapter 的静态默认列表。
 */
export function availableCodeArtsModels(): RemoteModel[] | undefined {
  if (memoryCache !== undefined) return memoryCache
  const disk = loadModelsCache()
  if (disk !== undefined) {
    memoryCache = disk
    return disk
  }
  return undefined
}

/** 设置内存缓存（由 service 拉取成功后调用）。 */
export function setMemoryCache(models: RemoteModel[] | undefined): void {
  memoryCache = models
}

/**
 * 保存 benefit 模型 id 集合到缓存文件（原子写入 tmp+rename）。
 * 文件不存在或写入失败时静默忽略 —— 判定会回退到静态兜底集合。
 *
 * 同步写入（与 {@link loadBenefitCache} 一致）：chat 请求签名前要读它，
 * 异步写入会让「刚拉取完就发消息」的窗口期内读到旧值/空值。
 */
export function saveBenefitCache(ids: readonly string[]): void {
  const path = benefitCachePath()
  if (!path) return
  const dir = path.slice(0, path.lastIndexOf('/'))
  try {
    mkdirSync(dir, { recursive: true })
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(ids), 'utf-8')
    renameSync(tmp, path)
  } catch {
    // 写入失败静默忽略
  }
}

/** 加载缓存文件中的 benefit 模型 id 集合；文件不存在或解析失败时返回 undefined。 */
export function loadBenefitCache(): string[] | undefined {
  const path = benefitCachePath()
  if (!path) return undefined
  try {
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, 'utf-8')
    const ids: unknown = JSON.parse(text)
    if (!Array.isArray(ids) || ids.length === 0) return undefined
    return ids.filter((id): id is string => typeof id === 'string')
  } catch {
    return undefined
  }
}

/** 设置 benefit 集合内存缓存（由远端拉取成功后调用；undefined 表示清除）。 */
export function setBenefitMemoryCache(ids: string[] | undefined): void {
  benefitMemoryCache = ids
}

/**
 * 判断某模型是否为 benefit（免费额度）模型 —— 决定 chat 请求是否必须带
 * `maas_type: benefit`。
 *
 * 优先级：内存缓存 → 磁盘缓存（远端拉取所得）→ 静态兜底集合。
 * 远端集合优先，使后端新增 benefit 模型时**无需改代码**即可自动识别。
 *
 * ⚠️ 判定**不是**「名字里带 flash」这类猜测：`deepseek-v4-flash`（无后缀）
 * 与 `glm-5.3-flash` 名字形态相同，benefit 属性却相反。唯一权威来源是
 * gateway/config 的模型清单 + 兜底表。
 */
export function isCodeArtsBenefitModel(model: string): boolean {
  if (benefitMemoryCache === undefined) benefitMemoryCache = loadBenefitCache()
  if (benefitMemoryCache !== undefined && benefitMemoryCache.includes(model)) return true
  return CODEARTS_BENEFIT_FALLBACK.includes(model)
}
