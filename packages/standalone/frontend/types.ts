export type Page = 'overview' | 'models' | 'usage' | 'channels' | 'routing' | 'settings' | 'connection'
export interface Model {
  id: string
  name: string
  channel: string
  routable: boolean
  hiddenByUser?: boolean
  hiddenByGroup?: boolean
  vision?: boolean
  reasoning?: boolean
  contextWindow?: number
  maxOutput?: number
  availabilitySource?: 'listing' | 'probe' | 'manual'
  detail?: string
  probedAt?: number
  latencyMs?: number
  availability?: string
  ttftMs?: number | null
}
export interface ModelTestResult { ok: boolean; text: string; latencyMs: number; ttftMs?: number; persisted?: boolean }
export interface ServiceSettings {
  enabled: boolean
  exposeRegionModels: boolean
  hiddenModelIds: string[]
  hideFreeModels: boolean
  streamRecovery: boolean
  standaloneProbe: boolean
  probeIntervalMinutes: number
  defaultMaxTokens: number
}
export interface Summary {
  version: string
  baseUrl: string
  dataDir: string
  networkMode: string
  automaticRefresh: boolean
  catalogSyncedAt: number
  settings: ServiceSettings
  channels: { state: string; error?: string }
  catalog: Model[]
  /**
   * LAN 中继状态（`service.mjs` 的 `lanState()`）。
   *
   * 2026-11-17 补：此前后端一直返回这个字段，但前端**没有类型也没有渲染** ——
   * 结果是开了 `--lan --lan-port 9981` 的用户在面板里找不到局域网地址与 LAN Key，
   * 只能照着「API 接入」页显示的 `127.0.0.1:18900` + 本机 key 去连，必然 401。
   */
  lan?: LanState
}

/** LAN 中继状态。字段与后端 `lanState()` 一一对应。 */
export interface LanState {
  /** 用户在设置里是否开了中继。 */
  enabled: boolean
  /** 中继是否真的在监听（`enabled` 为真但端口被占时会为 false）。 */
  running: boolean
  host: string
  /** 用户期望的端口（0 = 自动挑）。 */
  requestedPort: number
  /** 实际绑定的端口，未运行时为 null。 */
  port: number | null
  /** 本机的局域网地址列表。 */
  addresses: string[]
  /** 可直接复制的推理端点，如 `http://192.168.2.6:9981/v1`。 */
  baseUrls: string[]
  /** 面板中继是否也开着（`--lan-panel`）。 */
  panel?: boolean
  /** 启动失败时的原因。 */
  error?: string
}
export interface Stats {
  requests: number
  requestFailures: number
  requestFailuresEstimated?: boolean
  logicalEstimated?: boolean
  turns: number
  failedTurns: number
  recoveredTurns: number
  days: { day: string; total: number }[]
  grand: { input: number; output: number; reasoning: number }
  models: UsageModel[]
  samples: { model?: string; ok?: boolean; error?: string; at?: number; ms?: number }[]
}
export interface UsageModel {
  model: string
  name: string
  calls: number
  turns: number
  input: number
  output: number
  reasoning: number
  failed: number
  failedTurns: number
  recoveredTurns: number
  avgTtftMs?: number | null
  tps?: number | null
}
export interface Snapshot { summary: Summary; stats: Stats }
export interface Host {
  navigate(page: Page): void
  refresh(): Promise<void>
  copy(value: string): Promise<void>
  getApiKey(): Promise<string>
  rotateKey(): Promise<string>
  /** 读取路由链：配置 + 候选模型 + 每条链的解析结果（对齐插件端 `/combos`）。 */
  getCombos(): Promise<{ combos: RoutingChain[]; models: RoutingCandidate[]; usable: RoutingUsable[]; strategies: string[] }>
  /** 整表替换路由链；服务端归一化非法项，并回写解析结果。 */
  saveCombos(combos: RoutingChain[]): Promise<{ combos: RoutingChain[]; usable: RoutingUsable[] }>
  /** 草稿链的能力交集预览（未保存的链也能算）。 */
  previewCombo(models: string[]): Promise<{ contextWindow?: number; maxOutput?: number; vision?: boolean } | null>
  /** 取 LAN 中继用的密钥（与本机 `forwardKey` 是两套，见 `LanState` 注释）。 */
  getLanKey(): Promise<string>
  /** 轮换 LAN 密钥（只影响中继，不动本机密钥）。 */
  rotateLanKey(): Promise<string>
  logout(): Promise<void>
  error(error: Error): void
  testModel(model: string, signal: AbortSignal): Promise<ModelTestResult>
  refreshModels(probe: boolean, signal: AbortSignal): Promise<void>
  saveSettings(settings: Partial<ServiceSettings>): Promise<ServiceSettings>
}

/**
 * 一条路由链（`combo`）—— 一个虚拟模型名背后是一串真实模型。
 *
 * 字段与 `src/combos.js` 的 `normalizeCombos` 输出一致；`members` / `missing`
 * 由服务端在读取时按**当前目录**算出来，不参与保存。
 */
export interface RoutingChain {
  id: string
  name: string
  /** 链上成员，按尝试顺序。 */
  models: string[]
  strategy: 'fallback' | 'round-robin'
  /** 轮询时同一成员连任几回合。 */
  stickyLimit: number
  enabled: boolean
}

/** 成员候选：本服务的真实模型（排除链路自身，链路不能嵌套）。 */
export interface RoutingCandidate {
  id: string
  name: string
  /** 车道：`free` / `kilo` / `channel:<provider>`。 */
  channel: string
  /** 分组键 —— 同名模型会来自不同供应商，平铺无法分辨。 */
  provider?: string
  vision?: boolean
  contextWindow?: number
  maxOutput?: number
}

/** 一条链的解析结果：`models` 是当前目录里查得到的成员，附能力交集。 */
export interface RoutingUsable {
  id: string
  name: string
  models: string[]
  contextWindow?: number
  maxOutput?: number
  vision?: boolean
}
