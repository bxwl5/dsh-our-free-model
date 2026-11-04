/**
 * 腾讯系渠道的**内容级**风控指纹改写（Gitee issue IKJNA1）。
 *
 * ## 现象
 *
 * 外部客户端（ZCode 等）经本插件的 OpenAI 网关调 `buddy` / `workbuddy` 时，
 * 只要 `system` 消息里带着某些**客户端自带的模板句**，腾讯网关就稳定回
 * `HTTP 400 / code 11128 / "Illegal API invocation from an unapproved channel"`，
 * 客户端侧只显示 `provider_code=INVALID_REQUEST reason=unknown`。
 * DSH 直连同一模型则完全正常 —— 差别只在于**外部客户端往 system 里注了什么**。
 *
 * ## 为什么这一层只改非 user 角色、且只对腾讯系
 *
 * 本机逐组实测（`www.workbuddy.ai` 与 `copilot.tencent.com` **两个端点表现一致**，
 * 同账号 / 同模型 / 同 UA 与 X-* 头 / `max_tokens=16`，被拦不耗额度）：
 *
 * | 探针 | system 文本 | 结果 |
 * |---|---|---|
 * | 中性对照 | `You are a helpful assistant.` | ✅ 200 |
 * | 最小充分触发 | `Main branch (you will usually use this for PRs): master` | ❌ 400/11128 |
 * | 只留标签 | `Main branch: master` | ✅ 200 |
 * | 换分支名 | `…(you will usually use this for PRs): dev` | ❌ 400/11128 |
 * | 句中/段中 | 前后都接别的句子 | ❌ 400/11128 |
 * | **改写该句** | `Main branch (PRs usually go here): master` | ✅ 200 |
 * | 同一句放进 **user** 消息 | — | ✅ 200 |
 * | 同一句放进 **tool** 消息 | — | ✅ 200 |
 * | 指纹在**第二条** system（非 `messages[0]`） | — | ❌ 400/11128 |
 * | **指纹放进 `assistant` 历史** | — | ❌ 400/11128 |
 * | 只差一个词（`normally` 替 `usually`） | — | ✅ 200 |
 * | 内层多一个空格 | `Main branch  (you will…)` | ✅ 200 |
 * | 全小写 / 全大写 | — | ❌ 400/11128 |
 *
 * 由此得到三条**不能违反**的实现约束：
 *
 * 1. **改 `system` 与 `assistant`，跳过 `user` / `tool`**：后两者里同一句**不拦**
 *    （上表第 6、7 行）。改写它们只会白白破坏用户的原话与工具输出，且换不来
 *    任何收益。**但 `assistant` 必须改** —— 多轮会话会把模型自己含指纹的回复
 *    持久化并每轮原样回传，于是「首次命中之后，这个会话每一轮都失败」形成自锁。
 *    这正是「新会话能过、旧会话过不了」的成因。
 * 2. **改写**所有** system 消息**，不只 `messages[0]`：非首位的 system 同样被拦
 *    （上表第 8 行）。WorkBuddy 网关那条「首条必须是 system」的硬要求是**另一回事**
 *    （见 `account-probe.ts` 的 `PROBE_SYSTEM`），与本文件无关。
 * 3. **大小写不敏感的精确匹配**：全小写与全大写都被拦（上表末行），所以
 *    `replaceAll` 的字面量比对必须带 `i`；但**只差一个词**或**多一个空格**都不拦，
 *    说明服务端认的是**逐字符的字面量**，**不能**把它泛化成正则/关键词。
 *
 * ## 调用点必须落在**出站 wire 数组**上
 *
 * ⚠️ 只改 `options.system` **不生效**：identity 句在当前链路上是作为一条
 * `role:'system'` 消息存在于 `options.messages[]` 里，由
 * `buddy-adapter.serializeMessages` 原样透传到 wire；`options.system` 那个
 * `unshift` 分支在桌面端根本不执行（实测：只在那里做替换，重启后仍然 400）。
 * 因此清洗循环必须放在 `serializeMessages(...)` **返回之后**、且在所有
 * `messages.unshift(...)` **之后** —— 否则 `options.system` 里的指纹会漏洗。
 *
 * ## 两层防御：网关 + 适配器
 *
 * - **网关层**（`openai-gateway/messages.ts`、`responses.ts`）：外部客户端
 *   （ZCode 等）经本插件的 OpenAI 网关进来时，在把 OpenAI 消息转成 harness
 *   消息的过程中改写 `system` 内容。指纹来自客户端，网关正是知道 provider
 *   的那一层。
 * - **适配器层**（`buddy-adapter.ts` 的 `serializeMessages` 之后）：**权威的一层**。
 *   它作用在最终要发出去的 wire 数组上，同时覆盖两个入口 —— DSH 直连与经网关，
 *   因为网关转换出的 harness 消息同样要经这个适配器序列化。
 *
 * ⚠️ 曾经认为「DSH 直连不受影响」，**这个判断是错的**：DSH 内核
 * `@deepseek-ai/dsh-system-prompt` 的 `harness:identity` section 正是以
 * `You are an AI agent powered by DeepSeek Harness.` 开头，于是 DSH 自己的
 * 请求就会命中。适配器层因此不是「多余的第二道」，而是**必须有**的一道 —— 没有
 * 它，DSH 直连 buddy 渠道必然失败。
 *
 * ## ⚠️ 千万不要把 11128 加进 `isContentRejection`
 *
 * 那是**内容级**拦截：同一账号换掉这一句就通（上面「改写该句」一行）。
 * 认成「账号被策略拦」会触发换号 + 30 分钟账号冷却（`CONTENT_REJECTION_COOLDOWN_MS`），
 * 把整个账号池白锁 30 分钟，而真正该做的是改写那一句。
 * 维持现状（`isContentRejection` 只认 11140 / `request illegal` / 安全审核文案）
 * **是正确**的。
 *
 * ## 表驱动，而不是写死一处
 *
 * 屏蔽名单服务端掌握、可能随时更新，任何客户端将来都可能撞上新指纹。
 * 故这里是**表**：新增一条 = 往 {@link CONTENT_FINGERPRINTS} 里加一行 + 一条用例。
 */

/**
 * ⚠️ 自 2026-11-04 起本模块**不再自己持有一份规则表** —— 用户要求「全部模型、
 * 包含免费模型，直接在底层(出口层/请求层)进行指纹清洗」，规则表已收归
 * `src/content-fingerprint.ts`（全渠道、无 provider 判据）。
 *
 * 本文件保留两样东西：
 * 1. **上面的实测证据表**（哪一句被拦、改成什么放行、在哪个端点验的）—— 这是
 *    唯一能证明「这条规则不是凭空加的」的记录，删掉就等于把结论变成传说；
 * 2. **兼容导出** {@link isTencentContentFingerprintProvider}：`buddy-adapter.ts`
 *    与 `scripts/tencent-fingerprint-test.mjs` 仍在调它（**不是**零引用，
 *    2026-11-04 复核时对照了全仓 grep，避免误删）。
 *    `TENCENT_PROVIDERS` 常量已于同日删除 —— 它确实全仓零引用。
 *
 * ⚠️ `isTencentContentFingerprintProvider` 现在**恒为 true**：清洗不再按 provider
 * 开关。它留着只为让「调用点先判 provider 再清」的旧写法继续编译与运行 —— 那种
 * 写法在语义上已经退化成「总是清洗」，与共享模块一致。
 */

import { rewriteContentFingerprints } from '../content-fingerprint.js'

/**
 * 该 provider 是否走「内容级风控指纹清洗」。
 *
 * ⚠️ **现在恒为 `true`** —— 清洗是全渠道的（2026-11-04 用户要求）。
 * 保留该函数是为了让既有的「先判 provider 再清洗」调用点不必改结构。
 */
export function isTencentContentFingerprintProvider(_provider: string): boolean {
  return true
}

/**
 * 把文本里已知的风控指纹做**窄改写**（全渠道，规则表见
 * `../content-fingerprint.ts`）。
 *
 * ⚠️ `provider` 参数保留只为兼容旧调用点，**不参与判定**。
 *
 * @param text 已取出的 system 纯文本
 * @param _provider 旧调用点传的 provider 段（已不使用）
 */
export function rewriteTencentContentFingerprints(text: string, _provider?: string): string {
  return rewriteContentFingerprints(text)
}
