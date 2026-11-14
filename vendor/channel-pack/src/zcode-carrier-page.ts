/**
 * 内部载体的**载体页**（由 server 渲染，guest 里自己跑阿里云 SDK）。
 *
 * ## 为什么 captcha 逻辑留在 server 侧这一份
 * 「在 client 里再写一遍 SDK 调用」必然与 `src/zcode-captcha.ts` 漂移 ——
 * 本仓库反复吃过同型缺陷（同一份 wire 逻辑两处实现，改一处漏一处）。
 * 所以页面由 **server 渲染**（路由见 `src/channel-pack-rpc.ts` 的载体页 GET），
 * 客户端只做两件事：导航过来、`executeJavaScript` 读 `window.__zcodeCaptcha`。
 * 这也是本文件**只搬表达式、不写任何 captcha 判定**的原因。
 *
 * ## 结果契约（Task 5 的 client 依赖它，形状别改）
 * ```
 * window.__zcodeCaptcha = { stage, param, interactive, updatedAt, error? }
 * ```
 * `stage` 取值：`'pending'`（还没出结果）→ `'success'`，或失败形态
 * `'fail'` / `'onError'` / `'timeout'` / `'cfg-throw'` / `'call-throw'` /
 * `'init-throw'`（这六种是 mint 表达式自己上报的）+ `'throw'`（页面兜住的未预期异常）。
 *
 * ⚠ `updatedAt` 只是「这一轮什么时候完成的」的**观测值**（guest 与 server 同机），
 * **不参与**过期决策 —— 时效判定的唯一那道闸在 `src/captcha-supply.ts` 的
 * `takeFreshParam`，口径是 server 时钟。两处都判会互相矛盾。
 *
 * ## 三段表达式的顺序不是排版问题（真实缺陷 2026-10-01）
 * 容器 → SDK → `initAliyunCaptcha` + 无感验证，**必须配对且一次配齐**：
 * `src/zcode-captcha.ts` 的 `buildDomExpression` 注释记着「DOM 被重置而 SDK 未重建
 * ⇒ `F001`」那条实测。载体页是**一次性文档**（导航即全新），所以这里天然走的是
 * 「首次完整准备」那条路径 —— 不复用、不二次重置 DOM。
 * 又因 param 一次性（复用必 `3007`，见 `src/captcha-requirement.ts`），
 * 页面**只自动产一次**；要下一个必须重新导航。
 *
 * ⚠ 刻意**不带** `STEALTH_PATCH`：那是外挂 chromium 遮 `--headless` 痕迹用的，
 * 内部载体（Electron 真实 guest）实测 `webdriver=false`、UA 带 `Electron/44.0.0`
 * 时 4/4 产出合法 param ⇒ 搬进来属于无据扩面。
 *
 * ## ★ 回传通道（2026-11-14，用户定的方向：captcha 只走客户端内置浏览器）
 *
 * 页面由 client 经 `captcha.carrierHtml` RPC 拿到全文、塞进 `iframe.srcdoc`
 * —— **不经过载体页小服务**（那是给旧 carrierUrl 路径用的，对 NAS/web 必死：
 * server 本机的 127.0.0.1 端口在用户浏览器里指向用户自己的回环）。
 * 因此页面产完结果后 `parent.postMessage` 交给面板，面板再经
 * `captcha.contribute` RPC 送进供给槽 —— 同源（srcdoc 继承父 origin）、
 * 无端口依赖、三端同一行为。
 *
 * ⚠ `MESSAGE_TYPE` 与 client.js 的监听键必须两边同步（无共享模块，注释互指）。
 * ⚠ `elapsedMs` 由页面测「文档开始 → param 落袋」的耗时；contribute 的时效闸
 *   用它修正跨机时钟（协议见 `types.ts` 的 RpcCaptchaContributeRequest）。
 */
import {
  buildDomExpression,
  buildMintExpression,
  buildSdkInjectExpression,
  type ZcodeCaptchaConfig,
} from './zcode-captcha.js'

/** 结果挂载位（Task 5 的 `executeJavaScript` 读的就是这个名字，改名要两边同步）。 */
export const CAPTCHA_CARRIER_RESULT_KEY = '__zcodeCaptcha'

/**
 * postMessage 的消息类型键（client.js 的 message 监听按它过滤，两边同步）。
 * client 侧还会校验 `event.source === iframe.contentWindow`，伪造消息进不来。
 */
export const CAPTCHA_CARRIER_MESSAGE_TYPE = 'zcode-captcha-param'

/**
 * 构造载体页 HTML。
 *
 * **纯函数**：同一个 `config` 恒定输出同一份字符串（单测据此逐条断言）；
 * 页面里的 `Date.now()` 由 guest 在**运行时**求值，不参与本函数的输出。
 *
 * ⚠ 输出里**不含任何凭据**。`region` / `prefix` / `SceneId` 是阿里云 SDK 的公开
 * 初始化参数（本来就要发给阿里云，不是秘密）；JWT / token / cookie 一个都不许出现 ——
 * 这整页会被写进 guest 的文档，而 guest 与 GUI 同源。
 */
export function buildCarrierPageHtml(config: ZcodeCaptchaConfig): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>dsh captcha carrier</title></head><body>',
    '<script>',
    `window.${CAPTCHA_CARRIER_RESULT_KEY} = { stage: "pending", param: "", interactive: false, updatedAt: 0 };`,
    '    const pageStartedAt = Date.now();',
    '(async () => {',
    '  try {',
    // 三段与生产 chromium 路径**逐字同源**（同一批构造函数，不留第二份）。
    // ⚠ 末尾那个 `;` 不是排版：`buildDomExpression()` 产出的是**语句串**（以 `'ok'`
    // 收尾），下一行紧跟 `await (...)`。靠 ASI 今天能过，但它把整页的正确性押在
    // 「上游表达式恰好不以可续接的表达式收尾」上 —— 表达式一改就整页语法错，
    // 而载体页跑在离屏 guest 里，谁也看不见。
    `    ${buildDomExpression()};`,
    `    await (${buildSdkInjectExpression()});`,
    `    const outcome = JSON.parse(await (${buildMintExpression(config)}));`,
    `    window.${CAPTCHA_CARRIER_RESULT_KEY} = {`,
    '      stage: String(outcome.stage || "fail"),',
    '      param: typeof outcome.param === "string" ? outcome.param : "",',
    '      interactive: outcome.interactive === true,',
    '      updatedAt: Date.now(),',
    '      error: outcome.err === undefined ? undefined : String(outcome.err),',
    '    };',
    // ★ 回传给面板（client.js）：postMessage 允许跨源，srcdoc 与父同源更无碍。
    //   elapsedMs = 页面文档开始到现在的耗时（页面加载即开始 mint，无其余阶段），
    //   contribute 的时效闸用它修正跨机时钟漂移。
    //   只在产出成功时回传 —— 失败形态面板不关心（client 只认 param），
    //   面板对失败的处理是超时放弃并回落「不支持」提示。
    '    if (window.__zcodeCaptcha.stage === "success" && window.__zcodeCaptcha.param) {',
    '      try {',
    `        parent.postMessage({ type: ${JSON.stringify(CAPTCHA_CARRIER_MESSAGE_TYPE)}, param: window.__zcodeCaptcha.param, interactive: window.__zcodeCaptcha.interactive === true, elapsedMs: Math.max(0, Date.now() - pageStartedAt) }, "*");`,
    '      } catch (postError) { /* 回传失败不影响 param 落在 window 上（旧路径还能读） */ }',
    '    }',
    '  } catch (error) {',
    '    const detail = String((error && (error.stack || error.message)) || error);',
    `    window.${CAPTCHA_CARRIER_RESULT_KEY} = {`,
    '      stage: "throw", param: "", interactive: false, updatedAt: Date.now(), error: detail,',
    '    };',
    '    // 载体页是离屏 guest，出问题时的**唯一现场**就是这份文档 —— 不写进 DOM，',
    '    // 「为什么这个 session 一次都没产过 param」就只能靠猜（截图也看不到，它在屏外）。',
    '    try {',
    '      document.body.insertAdjacentHTML("beforeend", "<pre id=carrier-throw></pre>");',
    '      document.getElementById("carrier-throw").textContent = detail;',
    '    } catch { /* DOM 都没了就没别的可写了 */ }',
    '  }',
    '})();',
    '</script></body></html>',
  ].join('\n')
}
