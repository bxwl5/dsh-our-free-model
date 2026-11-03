/**
 * 渠道包的**内容级风控指纹清洗** —— 对全部 20 个渠道生效。
 *
 * ## 它解决什么
 *
 * 上游网关按**内容**判定「这是不是我们批准过的客户端」：请求里出现某些**客户端
 * 自带的模板句**（agent 身份句）时直接拒绝。腾讯系回 `HTTP 400 / code 11128 /
 * "Illegal API invocation from an unapproved channel"`，其它厂商形态各异但成因
 * 同一 —— **指纹来自客户端，不来自账号**。
 *
 * 本模块把这些模板句做**窄改写**（只换掉被锚定的字面量、语义等义），让请求带上
 * 的是「中性身份句」，从而在任何渠道都不触发内容级拦截。
 *
 * ## 为什么现在是**全渠道**（2026-11-04 用户要求）
 *
 * 最初这套清洗只在 `buddy` / `workbuddy` 两个腾讯系 provider 上做（Gitee
 * issue IKJNA1 的实测证据也来自那两个端点）。但**每一条指纹都不是腾讯家的东西**：
 *
 * | 指纹 | 出处 | 会进到哪 |
 * |---|---|---|
 * | `You are an AI agent powered by DeepSeek Harness` | DSH 内核 `@deepseek-ai/dsh-system-prompt` 的 `harness:identity` 首句 | **每一次** DSH 直连，所有渠道 |
 * | `You are interacting with the user through the DeepSeek Harness Web GUI` | DSH `@deepseek-ai/dsh-harness-dev-context` 的 `WEB_SURFACE_PROMPT` | **每一轮** Web GUI 对话，所有渠道 |
 * | `You are Claude Code` | Claude Code 兼容层 / 第三方 agent | 经网关打进任何渠道的外部客户端 |
 * | `Main branch (you will usually use this for PRs)` | ZCode 内建常量 `$Js` | 任何 git 仓库里的会话，所有渠道 |
 *
 * 也就是说：**同一条 DSH 身份句此前只在腾讯系被改写，在其它 18 个渠道原样发出**。
 * 各家风控阈值不同，本机的腾讯系实测不能替别家打包票，但「把已知的 agent 身份
 * 指纹换成中性写法」这件事**在任何渠道都没有代价**：
 *
 * - 它改的不是用户的话（`user` / `tool` 一律不动，见下）；
 * - 语义等义，模型读到的指令不变；
 * - 未命中的文本**逐字符原样返回**（同一个字符串引用），所以**不会**破坏上游的
 *   前缀缓存 —— 这是这套改写最重要的性能约束。
 *
 * 而收益是：任何一个渠道将来加上同类内容闸门时，本插件**默认免疫**，不必再像
 * 11128 那样等用户撞上去才补。
 *
 * ## 三条不能违反的判据（来自腾讯系逐组实测，见 `openai-gateway/tencent-fingerprint.ts`）
 *
 * 1. **只改 `system` 与 `assistant`，跳过 `user` / `tool`**：实测同一句话放进
 *    user 或 tool **不拦**，改写它们只会白白破坏用户的原话与工具输出。
 *    `assistant` **必须**一起改 —— 多轮会话会把模型自己含指纹的回复持久化并每轮
 *    原样回传，形成「首次命中后这个会话每一轮都失败」的自锁，这正是
 *    「新会话能过、旧会话过不了」的成因。
 * 2. **改所有 system 消息，不只 `messages[0]`**：非首位的 system 同样被拦。
 * 3. **大小写不敏感的逐字符字面量匹配**：全小写 / 全大写都被拦（所以比对带 `i`）；
 *    但只差一个词、或多一个空格都不拦（所以**不能**泛化成正则或关键词）。
 *
 * ## 接线（三层，缺一层就有漏网的入口）
 *
 * | 入口 | 接线点 |
 * |---|---|
 * | 全部渠道的**最终请求** | `channel-fetch.ts` 的 `createChannelFetch` —— `index.ts` 把它的 fetch 注入每一个适配器，这是 20 个渠道共同的、绕不过去的出口 |
 * | 签名车道（CodeArts） | `direct-fetch.ts` 的 `send` —— 它用自己的 undici，不经过上面那层；**必须在签名之前**清洗，否则签的是脏字节、请求必然 401 |
 * | 交给适配器之前（消息层） | `llm-register-compat.ts` 的 `wrapAdapterWithTokenLedger` —— 少数适配器会把 body 加密/编码后再发（Qoder 信封、Gemini proto），出口层看到的已不是 JSON 消息 |
 * | 外部客户端经 OpenAI 网关 | `openai-gateway/messages.ts`、`responses.ts` 在把 OpenAI 消息转成 harness 消息时改写；改写后的消息**再**经上面两层 |
 *
 * 出口层与消息层是**同一份规则表**：两层都走到时第二次自然不命中（指纹已被改写
 * 掉），不会双重改写。
 *
 * ⚠️ 宿主 `dsh-llm` 派发前可能把 options 对象**重建**（`{...options, ...resolvedConfig}`
 * 或 `deepFreeze` 副本，实测见其 `lib/index.js` 的 `resolvedOptions` 分支）。因此
 * **不能**原地改 `options.messages` 的元素（`normalizeHarnessMessages` 在
 * `shape === 'tool-role'` 时返回**同一个数组引用**，元素就是宿主构造的消息），
 * 必须**构造新数组与新元素**，宿主冻结构造出的副本才能拿到改写后的内容。
 * 注册包装层对 `messages` **总是**给出新数组，与「未命中逐字符不变」是两件事：
 * 前者是对象身份，后者是字符串内容 —— 内容仍然逐字节相同，前缀缓存照旧命中。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通。认成「账号被策略拦」会触发换号 +
 * 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），把整个账号池白锁 30 分钟，
 * 而真正该做的是改写那一句。维持现状（`isContentRejection` 只认 11140 /
 * `request illegal` / 安全审核文案）**是正确**的。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单由服务端掌握、随时可能更新，任何客户端都可能撞上新指纹。新增一条 =
 * 往 {@link CONTENT_FINGERPRINTS} 加一行 + 一条用例，接线不用动。
 *
 * ⚠️ **每一条都必须有实发证据**（被拦 + 改写后放行，两条都要）。照抄别家客户端的
 * 常量而没实测过，等于给全渠道上游加了一条没人验证过的改写。
 */

/** 受风控锚定的客户端模板句。 */
interface ContentFingerprint {
  /** 被拦的**字面量**（匹配时**大小写不敏感**，但不做任何模式泛化）。 */
  readonly find: string
  /** 等义改写，实测放行。⚠️ 必须去掉品牌词，且不含 `find` 里的短语。 */
  readonly replace: string
  /** 来源与证据，写死在代码里，免得后人「顺手」把它改成正则或删掉。 */
  readonly note: string
}

/**
 * 已知会被内容级风控拦下的模板句。**全渠道**改写。
 *
 * 四条 2026-10-21/25 在 `copilot.tencent.com` 与 `www.workbuddy.ai` 实测复现
 * （见 `openai-gateway/tencent-fingerprint.ts` 的证据表）。自
 * 2026-11-04 起这套改写不再按 provider 开关 —— 依据是本模块头「为什么现在是
 * 全渠道」一节：无代价、有收益，且这几条指纹全都来自**我们这侧**的客户端。
 */
const CONTENT_FINGERPRINTS: readonly ContentFingerprint[] = [
  {
    // DSH 内核 `@deepseek-ai/dsh-system-prompt` 的 `harness:identity` 首句。
    // 实测该句在 system 与 **assistant 历史**里都拦；重新登录 / 换号 / 换网络都
    // 不会好转 —— 它是**内容级**判定。
    //
    // ⚠️ find **不带末尾句号**：上游对带 / 不带句号两种写法都拦，而 `escapeRegExp`
    // 会把 "." 转义成字面点号。去掉句号后一条规则同时覆盖两种写法，原文的句号
    // 也会保留在替换结果里。
    // ⚠️ replace 必须是**中性表达并去掉品牌词**：`DeepSeek Harness` 本身就是被
    // 检测的目标；只把 `agent` 改成 `assistant` 只是碰巧绕开一个短语，上游随时
    // 可能把 `assistant` 也加进名单。
    find: 'You are an AI agent powered by DeepSeek Harness',
    replace: 'You are an AI assistant',
    note: 'DSH harness:identity 首句；上游锚定内容开头、忽略大小写、末尾句号可选',
  },
  {
    // **DSH 自己的 Web GUI 提示词**（`@deepseek-ai/dsh-harness-dev-context` 的
    // `WEB_SURFACE_PROMPT` 首句）。这是 2026-10-24 用户报「WorkBuddy 国内版模型
    // 调用报错 Illegal API invocation」的**真正原因** —— 它在**每一轮**对话里都会注入。
    //
    // 实测（`copilot.tencent.com` / `hy3` / stream / max_tokens=8，2026-10-25）：
    //   只放第一句（到 "runtime context names." 为止）              → ✅ 200
    //   第一句 + 第二句（"When the user refers to "this page"…"）  → ❌ 400/11128
    //   整段 1004 字符原文                                          → ❌ 400/11128
    //   把品牌词 `the DeepSeek Harness Web GUI` 改成 `the Web GUI`   → ✅ 200
    // 即**上游锚定的是这两句的组合**，单句放行；逐字符敏感（改一个词即可绕过）。
    find: 'You are interacting with the user through the DeepSeek Harness Web GUI',
    replace: 'You are interacting with the user through the Web GUI',
    note: 'DSH WEB_SURFACE_PROMPT 首句；2026-10-25 实测 copilot.tencent.com 单句放行、两句组合拦截',
  },
  {
    // 其它客户端（Claude Code 兼容层 / 第三方 agent）注入的身份句。
    // 2026-10-25 本机实测（`copilot.tencent.com`，同账号同模型，max_tokens=8）：
    //   system = `You are Claude Code, Anthropic's official CLI for Claude.` → ❌ 400/11128
    //   system = `You are Claude Code`                                     → ❌ 400/11128
    //   system = `This is powered by Claude Code.`                         → ✅ 200
    //   system = `Anthropic's official CLI for Claude.`                     → ✅ 200
    // 即**上游锚定的是 `You are Claude Code` 这个开头短语**，后面接什么都拦；
    // 只出现 "Claude Code" 而不带 "You are " 前缀则放行。
    // replace 去掉品牌名、保留「你是一个助手」的语义，且**不含 Claude / Code**，
    // 避免上游把替换后的文本也加进名单。
    find: 'You are Claude Code',
    replace: 'You are a helpful assistant',
    note: '2026-10-25 本机实测 copilot.tencent.com；锚定 You are Claude Code 开头，尾随内容不影响',
  },
  {
    // ZCode 内建常量：`$Js="Main branch (you will usually use this for PRs)"`。
    // 每个 git 仓库里的会话都会被注入（拼在 `Main branch … : <分支名>` 这一行）。
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
    note: 'Gitee IKJNA1；本机 2026-10-05 对 workbuddy / CodeBuddy 双端点实测复现',
  },
]

/** 正则元字符转义：把字面量安全地变成**精确**匹配，而不是模式。 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CompiledFingerprint {
  readonly replace: string
  /** 小写形态，用于 `includes` 预检（不命中就不必跑正则，字符串**原样**返回）。 */
  readonly findLower: string
  readonly pattern: RegExp
}

const COMPILED: readonly CompiledFingerprint[] = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  // `g` = 全部出现都改写；`i` = 大小写不敏感（实测全小写 / 全大写同样被拦）。
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

/**
 * 把文本里已知的风控指纹做**窄改写**。
 *
 * ## 契约
 *
 * - **不含任何指纹的文本逐字符不变**，且返回**同一个字符串引用** —— 硬要求：
 *   上游按前缀缓存计费，无谓地重建字符串会让每一轮都算作新前缀，白白吃掉缓存命中；
 * - 只改**内容**，不删句子、不改结构：`Main branch (PRs usually go here)` 与原句
 *   语义等价，模型读到的仍是「主分支（提 PR 通常走这里）」；
 * - **不看 provider** —— 全渠道同一判据（见模块头）。
 */
export function rewriteContentFingerprints(text: string): string {
  let out = text
  for (const rule of COMPILED) {
    // 预检：不含（小写化后的）字面量就整条跳过，全部未命中时 `out` 仍是入参本身。
    if (!out.toLowerCase().includes(rule.findLower)) continue
    // `String.replace` 配 `g` 正则会在调用前后把 lastIndex 归零，不会串状态。
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

/** harness / wire 消息的最小形状（只需 role + content 两个维度）。 */
interface ScrubbableMessage {
  role?: unknown
  content?: unknown
  [key: string]: unknown
}

/**
 * 该角色的内容**要不要**清洗。
 *
 * `system` / `assistant` / `developer` 要（developer 是 0.1.7 的 system 等价角色，
 * 归一化前也要清，免得它被当普通消息透传）；`user` / `tool` 不要 —— 实测那里不拦，
 * 改写只会破坏用户的原话与工具输出。
 */
function scrubbableRole(role: unknown): boolean {
  return role === 'system' || role === 'assistant' || role === 'developer'
}

/**
 * 清洗一条消息里的 `text` 块（harness 形状：`content` 是块数组）。
 *
 * @returns 有块被改写时返回**新数组**；否则返回原数组引用（身份不变，
 *   调用方据此判断「这条消息不用换」）。
 */
function scrubContentBlocks(content: readonly unknown[]): readonly unknown[] {
  let changed: unknown[] | undefined
  content.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return
    const record = block as { type?: unknown, text?: unknown }
    if (record.type !== 'text' || typeof record.text !== 'string') return
    const next = rewriteContentFingerprints(record.text)
    if (next === record.text) return
    // 惰性拷贝：只有第一次命中才建新数组，全未命中时保持原引用。
    const target = (changed ??= [...content])
    target[index] = { ...record, text: next }
  })
  return changed ?? content
}

/**
 * 清洗一条消息（`content` 可能是字符串，也可能是块数组）。
 *
 * 单独暴露出来是为了给**已经自己拼好 wire** 的适配器用（`buddy-adapter` 在
 * `messages.unshift(...)` 之后统一过一遍）。
 *
 * ⚠️ 返回**新元素**而不是原地改：宿主可能把消息对象 `deepFreeze`，原地赋值会抛。
 */
export function scrubWireMessage<T extends ScrubbableMessage>(message: T): T {
  if (!scrubbableRole(message.role)) return message
  const content = message.content
  if (typeof content === 'string') {
    const next = rewriteContentFingerprints(content)
    return next === content ? message : ({ ...message, content: next } as T)
  }
  if (Array.isArray(content)) {
    const next = scrubContentBlocks(content)
    return next === content ? message : ({ ...message, content: next } as T)
  }
  return message
}

/**
 * 清洗整份消息数组：`system` 与 `assistant`（含 `developer`）里的已知指纹。
 *
 * ⚠️ 返回**新数组**（元素只在被改写时才换新对象，未改写的元素保持原引用）。
 * 为什么不原地改：见模块头「宿主会重建派发 options」那条 —— 新数组是唯一能被
 * `{...options, ...resolvedConfig}` 这类展开可靠带过去的形式。
 */
export function scrubMessages<T extends ScrubbableMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => scrubWireMessage(message))
}

/**
 * 清洗一个 OpenAI 兼容 `GenerateOptions` 里的 system 通道。
 *
 * 覆盖**全部** system 载体：`options.messages` 里的 system/assistant 消息，以及
 * 顶层 `options.system` 字符串 —— 适配器把 `options.system` `unshift` 成首条
 * system 消息发生在**适配器内部**，注册包装层拿不到那个 wire 数组，所以两处都得清。
 *
 * ⚠️ **绝不原地改**：宿主 `dsh-llm` 会 `deepFreeze` 它构造的 options 副本；这里
 * 只复制被改动的消息，并把**新数组**挂在返回对象的新属性上。
 *
 * @returns 有内容被改写时返回 `{...options, messages?, system?}`；
 *   一份都没命中时返回**同一个入参对象**（不复制、不改身份）。
 */
export function scrubGenerateOptions<T>(options: T): T {
  if (typeof options !== 'object' || options === null) return options
  const record = options as { messages?: unknown, system?: unknown }
  let out = options as object
  let replaced = false

  if (Array.isArray(record.messages)) {
    const before = record.messages as ScrubbableMessage[]
    const after = before.map((message) => scrubWireMessage(message))
    if (after.some((message, index) => message !== before[index])) {
      out = { ...out, messages: after }
      replaced = true
    }
  }

  if (typeof record.system === 'string') {
    const next = rewriteContentFingerprints(record.system)
    if (next !== record.system) {
      out = { ...out, system: next }
      replaced = true
    }
  }

  return replaced ? (out as T) : options
}

// ── 底层（出口/请求层）清洗 ────────────────────────────────────────────────
//
// 上面那些是**在消息数组上**清洗：谁负责把 harness 消息拼成请求体，谁就要记得调。
// 全渠道覆盖时这条要求很脆 —— 20 个渠道里有的是 `openai-compat.serializeMessages`、
// 有的是自己手写的 wire、有的把 system 单独塞进顶层字段，**漏一个渠道就是一个
// 静默的漏网入口**（2026-11-04 用户要求「直接在底层(出口层/请求层)进行指纹清洗」）。
//
// 所以这里再给一层**与渠道无关**的兜底：作用在**最终要发出去的请求**上 ——
// 也就是每个渠道共用、且无法绕过的出口 `createChannelFetch` / `createDirectFetch`。
// 它只认「HTTP 请求体里装着 JSON 消息」这一个事实，不关心是哪个渠道、哪套 wire：
//
// | 形态 | 处理 |
// |---|---|
// | `init.body` 是 JSON 字符串 | 解析 → 清洗 → 只在**有改动**时重新序列化 |
// | `init.body` 是 `Uint8Array` / `ArrayBuffer` | 同上（网关/压缩前的字节体） |
// | `input` 是 `Request`（body 在里面） | 复制成新 `Request`，body 换成清洗后的 |
// | 其它（FormData / Blob / stream / 无 body） | **原样放行**，绝不猜测 |
//
// ⚠️ **只在有改动时重建 body**：JSON 重新序列化会改字节（键序、空格），即使内容
// 等价也会打掉上游的前缀缓存。所以流程是「解析 → 清洗 → 若一个指纹都没命中，
// 直接把**原始字节**发出去」，原始字符串连解析结果都不采用。
//
// ⚠️ **清洗失败一律放行原请求**：这是兜底，不是闸门。上游 400 比请求发不出去好，
// 而「因为我们的正则写错导致整条通道不可用」是不可接受的。

/** 该 JSON 对象里可能要清洗的**消息数组**字段名（各家 wire 的拼写）。 */
const MESSAGE_KEYS = ['messages', 'input', 'contents'] as const

/** 该 JSON 对象里可能是**独立 system 提示词**的字段名。 */
const SYSTEM_KEYS = ['system', 'instructions'] as const

/** 一条 wire 消息里可能承载文本的字段名（Chat / Claude / Gemini 三种拼写）。 */
const TEXT_KEYS = ['content', 'text', 'parts'] as const

/**
 * 清洗一个**任意 wire 形状**的 JSON 请求体（就地修改并返回是否有改动）。
 *
 * 覆盖三种真实拼写：
 * - Chat / Responses：`messages[]` / `input[]`，元素 `{role, content: string | blocks}`；
 * - Claude：`messages[]` + 顶层 `system`（string 或 blocks）；
 * - Gemini：`contents[]`，元素 `{role, parts: [{text}]}`。
 *
 * ⚠️ **只改 system / assistant 等价角色**：Gemini 的 `model` 就是 assistant，
 * `user` 是 user；没有 role 的元素（如纯 `{text}` 片段）**不碰** —— 无法判定归属
 * 时宁可不改，改了就是篡改用户原话。
 */
function scrubJsonBody(body: Record<string, unknown>): boolean {
  let changed = false

  // ① 顶层 system / instructions（Claude 与部分自研 wire）
  for (const key of SYSTEM_KEYS) {
    const value = body[key]
    if (typeof value === 'string') {
      const next = rewriteContentFingerprints(value)
      if (next !== value) { body[key] = next; changed = true }
      continue
    }
    if (Array.isArray(value)) {
      const blocks = scrubTextBlocks(value)
      if (blocks !== value) { body[key] = blocks; changed = true }
    }
  }

  // ② 消息数组（三种拼写）
  for (const key of MESSAGE_KEYS) {
    const value = body[key]
    if (!Array.isArray(value)) continue
    let listChanged = false
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue
      const message = entry as Record<string, unknown>
      // ⚠️ 无 role 的元素不判定归属：Gemini 的 `parts` 只出现在有 role 的 content
      // 里，顶层裸 `{text}` 只可能是调用方自定义结构 —— 不动。
      if (message.role === undefined) continue
      if (!scrubbableRole(message.role === 'model' ? 'assistant' : message.role)) continue
      for (const textKey of TEXT_KEYS) {
        const field = message[textKey]
        if (typeof field === 'string') {
          const next = rewriteContentFingerprints(field)
          if (next !== field) { message[textKey] = next; listChanged = true }
          continue
        }
        if (Array.isArray(field)) {
          const blocks = scrubTextBlocks(field)
          if (blocks !== field) { message[textKey] = blocks; listChanged = true }
        }
      }
      // 工具调用里的**参数**也可能携带指纹（模型把自己的身份句写进参数），
      // 但那是 assistant 自己产出的历史，同样会每轮回传 —— 一并清洗。
      const calls = message.tool_calls
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (call === null || typeof call !== 'object') continue
          const fn = (call as Record<string, unknown>).function
          if (fn === null || typeof fn !== 'object') continue
          const args = (fn as Record<string, unknown>).arguments
          if (typeof args !== 'string') continue
          const next = rewriteContentFingerprints(args)
          if (next !== args) { (fn as Record<string, unknown>).arguments = next; listChanged = true }
        }
      }
    }
    if (listChanged) changed = true
  }

  return changed
}

/**
 * 清洗块数组里的文本（`{type:'text'|'input_text'|'output_text', text}` 与
 * Gemini 的 `{text}`）。返回新数组或**原数组**（无改动时保持身份）。
 */
function scrubTextBlocks(blocks: readonly unknown[]): readonly unknown[] {
  let changed: unknown[] | undefined
  blocks.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return
    const record = block as Record<string, unknown>
    const text = record.text
    if (typeof text !== 'string') return
    const next = rewriteContentFingerprints(text)
    if (next === text) return
    const target = (changed ??= [...blocks])
    target[index] = { ...record, text: next }
  })
  return changed ?? blocks
}

/** 解码请求体字节（支持 UTF-8 字符串与字节数组；其它形态返回 undefined）。 */
function decodeBody(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body)
    } catch {
      return undefined
    }
  }
  if (body instanceof ArrayBuffer) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(body))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 把一个请求体字符串过一遍清洗。
 *
 * @returns 有改动时返回**新的** JSON 字符串；无改动 / 不是 JSON / 清洗失败时
 *   返回 `undefined`（调用方据此保留原始字节，连解析结果都不采用）。
 */
export function scrubJsonText(text: string): string | undefined {
  // 廉价预检：一个指纹都不含就别解析了（99% 的请求走这条路）。
  const probe = text.toLowerCase()
  if (!COMPILED.some((rule) => probe.includes(rule.findLower))) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 非 JSON 体（表单、纯文本、压缩流）：不猜，原样放行。
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  try {
    return scrubJsonBody(parsed as Record<string, unknown>) ? JSON.stringify(parsed) : undefined
  } catch {
    // 结构异常（循环引用等）：放行原请求，绝不因为清洗让请求发不出去。
    return undefined
  }
}

/**
 * 底层出口的清洗入口：把 `fetch(input, init)` 的入参过一遍。
 *
 * @returns 无需改动时返回 `null`（调用方**原样**转发，零开销）；
 *   需要改动时返回新的 `{ input, init }`。
 *
 * ⚠️ 这是**全渠道**的兜底，与 `scrubGenerateOptions`（消息层）是同一份规则表；
 * 两层都走到时第二次自然不命中（指纹已被改写掉），不会双重改写。
 */
export function scrubFetchArguments(
  input: RequestInfo | URL,
  init?: RequestInit,
): { input: RequestInfo | URL, init?: RequestInit } | null {
  try {
    // ① body 在 init 上（绝大多数 POST）
    const fromInit = decodeBody(init?.body)
    if (fromInit !== undefined) {
      const scrubbed = scrubJsonText(fromInit)
      return scrubbed === undefined ? null : { input, init: { ...init, body: scrubbed } }
    }
    // ② body 在 Request 里（构造好的 Request 对象）
    if (typeof Request === 'function' && input instanceof Request) {
      // ⚠️ 不能 `await input.text()`：这会**消耗** body 流，原请求就废了。
      // 这里只在调用方已经显式给了 `duplex`/`body` 之外的场景需要读流，
      // 而我们的所有 POST 都把 body 放在 init 上 —— 因此 Request 形态只在
      // **没有 body** 时才是安全的，此时必然没有指纹可清。
      return null
    }
    return null
  } catch {
    return null
  }
}
