/**
 * ZCode 的阿里云 captcha 产出（**唯一还需要浏览器的环节，但只服务 claim 路径**）。
 *
 * ## 谁还要 captcha（2026-10-01 直连上游实测，别再凭印象改）
 *
 * | 端点 | 不带验证头 | 结论 |
 * |---|---|---|
 * | `/api/v1/zcode-plan/anthropic`（**模型请求**） | **HTTP 200**（6 个采样点） | **自 3.14.4（2026-09-29）起不再索要** |
 * | `/api/v1/zcode-plan/billing/claim`（**领取**） | `400 {"code":3007}` | **始终索要**，且校验**前置于** plan 校验 |
 *
 * ⇒ 模型请求这条路现在**恒不产** param（`src/captcha-requirement.ts` 的
 * 「先探后取」使 mint 次数归零）；仍在产的是**领取**（每日一次 / 手动点「一键领取」，
 * **每个 plan 独立一个**，一次性，复用必 `3007`）。
 * ⚠ 模型请求侧的 `3007` 防御分支**故意保留**：万一上游回滚再开校验，推理请求仍能自愈，
 * 而不是把失败抛给用户。
 *
 * ## 载体：web 版必需浏览器，桌面版可用内部载体
 * captcha 是**网页 SDK**（`o.alicdn.com/.../AliyunCaptcha.js`），任何有 DOM 能跑 JS 的
 * 浏览器都能产。本文件这套外挂 chromium 路径是 **web 版的必需项**；
 * DSH Desktop 下会优先用**桌面自己的 Electron 内核**（`dshDesktop.browser` 租约 +
 * 隐藏 `<webview>` + `executeJavaScript`，见 `src/captcha-carrier.ts`），
 * 本文件退为其**兜底**（`DSH_ZCODE_INTERNAL_CARRIER=0` 可强制只用它）。
 *
 * ## 为什么能用普通浏览器而不是 ZCode 那个壳
 *
 * captcha 是**网页 SDK**，不是 Electron 专有 API：
 *
 * ```
 * script:  https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js
 * config:  window.AliyunCaptchaConfig = { region, prefix }
 * 调用:    initAliyunCaptcha({ SceneId, mode, element, button, getInstance, success, … })
 * 取参:    getInstance 里调 instance.startTracelessVerification()（无感验证）
 *          → success(param) 回调给出 param
 * ```
 *
 * 故任何「有 DOM + canvas + 能跑 JS」的浏览器都行。实测
 * **scoop 的 chromium（headful + 基本 stealth 补丁）** 可稳定产出。
 *
 * ## ⚠ 两个实测得到的约束（第 1 条后来**被推翻**，结论以第 2 条为准）
 *
 * ### 1. ~~同一个页面**不能**重复 mint~~ → **已推翻**（当时页面停在 `about:blank`）
 *
 * 同一 page 上连续 `initAliyunCaptcha` 三次的实测结果：
 *
 * | 次序 | 结果 | 耗时 |
 * |---|---|---|
 * | #1 | ✓ len=280 | 817ms |
 * | #2 | ✗ `F001` | 279ms |
 * | #3 | ✗ `F001` | 296ms |
 *
 * ⇒ SDK 实例状态在页面内不可重复初始化。**每次 mint 必须新建 page target**。
 * 采用该策略后实测 **4/4 成功，中位 1246ms**（浏览器冷启动仅 690ms）。
 *
 * ⚠⚠ **上面那两行是当时的结论，现在别再照着做**：真正的变量是页面 origin ——
 * 那三次是在 `about:blank`（origin 为字符串 `"null"`）上跑的。换到真实
 * `https://zcode.z.ai/` 后同一页面可**连续 mint 5/5**，中位 426ms / 平均 546ms，
 * 现行实现因此**复用常驻页面 + 每次重置 DOM**。证据与推理见
 * {@link CAPTCHA_PAGE_ORIGIN}；上面的表保留仅作原始记录（改回去会让耗时翻 2.3 倍）。
 *
 * ### 2. `--headless=new` 过不了，必须 **headful**
 *
 * | 模式 | 结果 |
 * |---|---|
 * | `--headless=new`（+ 补丁） | ✗ `fail` / `verifyCode: F001` |
 * | **headful + 补丁** | ✓ 280 字符合法 param |
 *
 * 阿里云风控会看这个差异。headful 在 Windows 上可以**不打扰用户**
 * （`--window-position=-32000,-32000` 移出屏幕）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { basename, isAbsolute, join, posix } from 'node:path'

/** 阿里云 captcha 配置（服务端下发；此处为实测兜底值）。 */
export interface ZcodeCaptchaConfig {
  /** 区域：`cn`。 */
  region: string
  /** 前缀：决定请求走到哪个阿里云子域。 */
  prefix: string
  /** 场景 id。 */
  sceneId: string
}

/**
 * 兜底 captcha 配置。
 *
 * ⚠ 这些值**实测自本机账号**（`GET /api/v1/client/configs?platform=unknown`
 * 的 `data.configs.captcha`）。理论上可能随账号/灰度变化，故
 * `ZcodeAuth.fetchCaptchaConfig()` 会优先向服务端索取，此处仅作兜底。
 */
export const ZCODE_CAPTCHA_FALLBACK: ZcodeCaptchaConfig = {
  region: 'cn',
  prefix: 'no8xfe',
  sceneId: '11xygtvd',
}

/** 阿里云 captcha SDK 地址（与官方逐字一致）。 */
export const ALIYUN_CAPTCHA_SDK_URL =
  'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

/** SDK 需要的 DOM 宿主 id（与官方 `zcode-aliyun-captcha-*` 一致）。 */
export const CAPTCHA_CONTAINER_ID = 'zcode-aliyun-captcha-container'
/** 挂载点 id。 */
export const CAPTCHA_ELEMENT_ID = 'zcode-aliyun-captcha-element'
/** 按钮 id。 */
export const CAPTCHA_BUTTON_ID = 'zcode-aliyun-captcha-button'

/**
 * captcha 页面必须导航到的**真实 origin**。
 *
 * ⚠⚠ **这是能否重复 mint 的关键**（实测矩阵）：
 *
 * | origin | 同一页面连续 mint |
 * |---|---|
 * | `about:blank` | **1/3**（#2 起 `F001`） |
 * | **`https://zcode.z.ai/`** | **5/5，平均 546ms** |
 *
 * 阿里云 SDK 会读 `location.origin` 参与风控判定，而 `about:blank` 的
 * origin 是字符串 `"null"` —— 于是第二次起被拒。
 *
 * ⚠ 这一条此前被**误判**成「同一页面不能重复 mint，必须每次新建 page」，
 * 导致实现多付了 2.3 倍的耗时（1246ms → 546ms）。
 * 结论修正的代价是：**改一个变量、看结果**比堆假设更快。
 */
export const CAPTCHA_PAGE_ORIGIN = 'https://zcode.z.ai/'

/**
 * 解析**载体页 origin**：注入值优先，空白/缺省一律回落实测常量。
 *
 * ## 为什么存在（以及它为什么**不是**配置项）
 * 唯一的用途是让本地探针 `scripts/probe-captcha-local-origin.mjs`（不入库）能验证
 * 「在 `http://127.0.0.1:<port>` 这种本地 origin 上，阿里云 SDK 到底产不产得出合法
 * param」—— 那是「DSH web 版能否用用户浏览器当载体」这条路线的唯一准入问题
 * （跨域 iframe 拿不到 DOM、浏览器也不给页面 CDP 权，所以载体页只能是 GUI 自己的 origin）。
 *
 * ⚠ **不许**把它接到 env / settings / UI：真实 https origin 是实测硬前提
 * （`about:blank` 的 origin 是 `"null"`，第二次 mint 必 `F001`）。
 * 默认值与空白回退由 `tests/unit/zcode-captcha-origin.spec.ts` 锁死。
 *
 * ⚠ 空白也算回落：注入空串会让导航变成 `about:blank`（即上面那条已知失败形态）。
 */
export function resolveCaptchaPageOrigin(
  options: { pageOrigin?: string } = {},
): string {
  const injected = options.pageOrigin?.trim() ?? ''
  return injected.length > 0 ? injected : CAPTCHA_PAGE_ORIGIN
}

/**
 * captcha param 的合法判据（与桥侧 `isUsableCaptchaParam` 同一套）。
 *
 * 三条全中才算合法：
 * 1. 长度 ≥ **200**（实测合法值 280；降级垃圾约 76）
 * 2. 是 base64 且能解出 JSON
 * 3. 含 `securityToken` 且长度 ≥ **50**（实测合法值 128）
 *
 * 任一条不中即判为降级 —— **不发请求**：在索要验证的窗口里那发注定 `3007`；
 * 即便上游此刻不校验这个头，把降级产物发出去也不是「成功」，故本地判据不放宽。
 */
export function validateCaptchaParam(param: unknown): { ok: boolean; reason?: string } {
  if (typeof param !== 'string' || param.length === 0) {
    return { ok: false, reason: 'captcha param 缺失' }
  }
  if (param.length < 200) {
    return {
      ok: false,
      reason: `captcha param 长度 ${param.length} < 200（疑似 SDK 降级输出，发了必 3007）`,
    }
  }
  let decoded: string
  try {
    decoded = Buffer.from(param, 'base64').toString('utf8')
  } catch {
    return { ok: false, reason: 'captcha param 不是合法 base64' }
  }
  let parsed: { securityToken?: unknown; certifyId?: unknown }
  try {
    parsed = JSON.parse(decoded) as typeof parsed
  } catch {
    return { ok: false, reason: 'captcha param 解出的不是 JSON' }
  }
  if (typeof parsed.certifyId !== 'string' || parsed.certifyId.length === 0) {
    return { ok: false, reason: 'captcha param 缺 certifyId' }
  }
  const token = parsed.securityToken
  if (typeof token !== 'string' || token.length < 50) {
    return {
      ok: false,
      reason: `securityToken 缺失或过短（${typeof token === 'string' ? token.length : 0} < 50）`,
    }
  }
  return { ok: true }
}

/**
 * macOS 的 app bundle → `Contents/MacOS/` 下的可执行文件名。
 *
 * ⚠️ **顺序即优先级**：Chrome → Chromium → Edge → Brave，与 Windows 候选链
 * （Chrome → Chromium → Edge）**同序**追加 —— 别把 Edge/Brave 提到 Chrome 前面
 * （同 {@link browserCandidates} 的 ①②③ 编号口径）。
 * ⚠️ `Microsoft Edge` / `Brave Browser` **不带扩展名**：macOS 的 app bundle
 * 内部就是这个名字，与 Windows 的 `msedge.exe` / `brave.exe` 不同。
 */
const MAC_BROWSER_BUNDLES: ReadonlyArray<readonly [bundle: string, exe: string]> = [
  ['Google Chrome.app', 'Google Chrome'],
  ['Chromium.app', 'Chromium'],
  ['Microsoft Edge.app', 'Microsoft Edge'],
  ['Brave Browser.app', 'Brave Browser'],
]

/** Windows 候选链（逐字保留自重构前，⚠️ 改这里等于动本仓库绝大多数用户）。 */
function windowsBrowserCandidates(
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const localAppData = env.LOCALAPPDATA ?? ''
  const programFiles = env.PROGRAMFILES ?? ''
  const programFilesX86 = env['PROGRAMFILES(X86)'] ?? ''
  return [
    /**
     * ① scoop 的 **显式声明的**根目录优先于默认推导。
     *
     * `SCOOP` / `SCOOP_GLOBAL` 是 scoop 自己的「我装在哪」的权威声明 ——
     * 用户设了它们就说明默认路径不对。若排在 `~/scoop` 之后，会出现
     * 「旧默认路径恰好存在 → 用它，而用户实际在用的那个被忽略」。
     */
    ...(env.SCOOP !== undefined && env.SCOOP.trim().length > 0
      ? [join(env.SCOOP.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
      : []),
    ...(env.SCOOP_GLOBAL !== undefined && env.SCOOP_GLOBAL.trim().length > 0
      ? [join(env.SCOOP_GLOBAL.trim(), 'apps', 'chromium', 'current', 'chrome.exe')]
      : []),
    // ② scoop 默认根目录（`~/scoop`）。实测可用。
    join(home, 'scoop', 'apps', 'chromium', 'current', 'chrome.exe'),
    // ③ 系统 Chrome。
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    // ④ Chromium。
    join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    // ⑤ Edge（Chromium 内核，系统普遍自带）。
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
}

/**
 * macOS 候选链：每个浏览器先找 `/Applications`，再找 `~/Applications`
 * （Mac 上把 app 拖进「应用程序」文件夹会装到后者，而**两者都是常规位置**）。
 *
 * ⚠⚠ **必须用 `posix.join`，不能用 `join`**（真实缺陷，2026-10-03，Gitee issue IKJKNT）。
 *
 * `join` 按**宿主**平台选分隔符：本仓库的 CI 与绝大多数开发机是 Windows，
 * 在那里执行本函数会拼出 `/Applications\Google Chrome.app\Contents\MacOS\…`
 * —— 在真机 macOS 上完全正常（那里 `join` 就是 `posix.join`），
 * 但这意味着**整条 darwin 分支在 Windows 上不可测、CI 永远测不到**。
 * 显式 `posix.join` 与 mac 上的行为逐字一致，同时让本分支可被单测锁死。
 * 回归用例见 `tests/unit/zcode-browser-macos.spec.ts` 的「一个反斜杠都没有」。
 */
function macBrowserCandidates(home: string): string[] {
  const roots = ['/Applications', posix.join(home, 'Applications')]
  const candidates: string[] = []
  for (const [bundle, exe] of MAC_BROWSER_BUNDLES) {
    for (const root of roots) {
      candidates.push(posix.join(root, bundle, 'Contents', 'MacOS', exe))
    }
  }
  return candidates
}

/**
 * Linux 候选链。
 *
 * ## ⚠️ 签名里**刻意没有 `env`** —— 这是对报障人建议的一处**结构性**修正
 *
 * Gitee issue IKJKNT 的报障人在评论里给了实现建议，其中写了
 * `const env = process.env` —— 那会让函数**忽略注入的 `env`**，
 * linux 分支在 Windows CI 上就不可测、永远静默通过。
 * 那正是 {@link macBrowserCandidates} 存在的同一条理由（只是它用 `posix.join` 躲掉了）。
 * 这里**连参数都不给** ⇒ 结构上不可能误读进程环境。
 *
 * ⚠️ **`ZCODE_CHROME_PATH` 本函数不得处理**：{@link browserCandidates} 已统一
 * `unshift`，平台分支再处理一次会出现重复候选。
 *
 * ## ⚠️ flatpak 只能用 `exports/bin/`，**不是 `appstream/`**
 *
 * 报障人建议里写的是 `…/flatpak/appstream/org.chromium.Chromium` —— 那是
 * **AppStream 元数据目录**，不是可执行文件。而 {@link findBrowserExecutable}
 * 的判据只有 `existsSync`（**不做「能不能执行」**），列了它就会
 * 「探测成功 → spawn 时 EACCES」，**比不列更糟**。
 * 反例锁在 `tests/unit/zcode-browser-linux.spec.ts`。
 */
function linuxBrowserCandidates(home: string): string[] {
  return [
    // ① Chrome（`google-chrome` 与 `google-chrome-stable` 是两个包名）。
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    // ② Chromium（Debian/Ubuntu 的 `chromium`、`chromium-browser`；snap 版）。
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // ③ Edge（微软的 Linux 包）。
    '/usr/bin/microsoft-edge',
    // ④ Brave（chromium 内核）。
    '/usr/bin/brave-browser',
    // ⑤ flatpak 导出的**可执行文件**（见函数头关于 appstream 的警告）。
    posix.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.chromium.Chromium'),
  ]
}

export function buildDomExpression(): string {
  return `document.body.innerHTML =
    '<div id="${CAPTCHA_CONTAINER_ID}" aria-hidden="true">' +
    '<div id="${CAPTCHA_ELEMENT_ID}"></div>' +
    '<button id="${CAPTCHA_BUTTON_ID}">verify</button></div>'; 'ok'`
}

/**
 * 构造注入 SDK 的表达式（用 `<script src>`，简单可靠）。
 *
 * ⚠ **无参**：SDK 地址是常量，`region`/`prefix`/`SceneId` 由 {@link buildMintExpression}
 * 在 `initAliyunCaptcha` 那一刻才用 —— 别在这里塞 config，那会多出一条无人读的形参。
 */
export function buildSdkInjectExpression(): string {
  return `new Promise((resolve) => {
    if (typeof window.initAliyunCaptcha === 'function') { resolve('already'); return; }
    const script = document.createElement('script');
    script.src = ${JSON.stringify(ALIYUN_CAPTCHA_SDK_URL)};
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha);
    script.onerror = () => resolve('onerror');
    document.head.appendChild(script);
    setTimeout(() => resolve('timeout'), 25000);
  })`
}

/**
 * 一次 captcha 产出的**结果 + 观测**。
 *
 * `interactive` 的语义（对齐官方 `mnn` 的 `interactive_displayed`）：
 * - `false` = **无感验证**直接通过（正常路径）
 * - `true`  = 被要求**交互式验证**（滑块/拼图）⇒ **设备信誉可能已下降**
 *
 * ⚠ 判据是「曾经观察到交互元素」——因为阿里云的这一层**不对外透出**
 *（官方文档 Q9 原文：「该安全策略逻辑不支持自定义，不对外透出」），
 * 只能靠看 DOM。
 */
export interface CaptchaMintOutcome {
  /** 产出的 param。 */
  param: string
  /** 本次是否被降级为交互式验证（`true` = 信誉预警信号）。 */
  interactive: boolean
}

/**
 * 构造「触发无感验证并等 param」的表达式。
 *
 * ## 为什么这三个表达式构造函数现在**导出**（二期 Task 3）
 * 内部载体的**载体页**（`src/zcode-carrier-page.ts`）必须由 server 渲染，
 * 才守得住「captcha 表达式只在 server 侧一份」这条约束 ——
 * client 里再写一遍 SDK 调用必然与本文件漂移（本仓库反复吃过同型缺陷）。
 * 除载体页外**不得**有第二个消费方。
 *
 * ⚠ 与 {@link STEALTH_PATCH} 的区别刻意为之：那份反检测补丁是**外挂 chromium**
 * 为了遮 `--headless` 痕迹才需要的，内部载体是 Electron 真实 guest，
 * 实测 `webdriver=false`、UA 带 `Electron/44.0.0` 时 4/4 产出合法 param
 * ⇒ 补丁**既不导出也不使用**（搬进载体页属于无据扩面）。
 */
export function buildMintExpression(config: ZcodeCaptchaConfig): string {
  return `new Promise((resolve) => {
    const done = (payload) => resolve(JSON.stringify(payload));
    /**
     * ★ **降级检测**（2026-10-01，对齐官方 \`mnn\` 的 interactive_displayed）。
     *
     * 我们调的是无感验证（\`startTracelessVerification\`）。阿里云若把本设备
     * 判为风险用户，会**静默弹出交互式验证**（滑块/拼图）—— 而官方文档明确说
     * 「该安全策略逻辑不支持自定义，不对外透出」（验证码 2.0 功能相关问题 Q9）。
     * 也就是说**没有回调告诉我们被降级了**，只能自己看 DOM。
     *
     * ⇒ 轮询检测那些交互元素是否出现过，用一个标志记住「曾经出现过」。
     *
     * ⚠ 用「曾经出现」而不是「此刻存在」：交互元素在验证完成后会被 SDK 移除，
     * 只在 success 那一刻查 DOM 会**漏报**（那正是最需要知道的场景）。
     *
     * ⚠ 选择器取自 dsh-free-glm 对空开源版 renderer 的实测记录
     *（\`bench/CAPTCHA-SLIDER-ATTEMPT.md\` 的 2.1 节，四个 id 逐字一致）。
     */
    let sawInteractive = false;
    const detectInteractive = () => {
      try {
        if (sawInteractive) return;
        if (document.querySelector('#aliyunCaptcha-window-popup')
          || document.querySelector('#aliyunCaptcha-sliding-slider')
          || document.querySelector('#aliyunCaptcha-puzzle')) {
          sawInteractive = true;
        }
      } catch (error) { /* 检测失败不影响产出 */ }
    };
    const pollTimer = setInterval(detectInteractive, 200);
    try {
      window.AliyunCaptchaConfig = ${JSON.stringify({ region: config.region, prefix: config.prefix })};
    } catch (error) { done({ stage: 'cfg-throw', err: String(error) }); }
    try {
      initAliyunCaptcha({
        SceneId: ${JSON.stringify(config.sceneId)},
        mode: 'popup',
        element: '#${CAPTCHA_ELEMENT_ID}',
        // ⚠ 必须传**元素对象**：传字符串会报「button参数传入值不合法」。
        button: document.getElementById('${CAPTCHA_BUTTON_ID}'),
        getInstance: (instance) => {
          try {
            if (typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
            } else if (typeof instance.show === 'function') {
              /**
               * ⚠ 走 \`show()\` 说明 SDK 里**没有**无感验证能力 —— 那本身
               * 就是一种降级形态（我们请求的是无感，拿到的是强制交互）。
               */
              sawInteractive = true;
              instance.show();
            }
          } catch (error) {
            done({ stage: 'call-throw', err: String((error && error.message) || error) });
          }
        },
        success: (param) => {
          /**
           * ⚠ 收尾前再查一次 DOM（轮询间隔 200ms，可能在两次轮询之间就完成了）。
           */
          detectInteractive();
          clearInterval(pollTimer);
          done({ stage: 'success', param, interactive: sawInteractive });
        },
        fail: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'fail',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
        onError: (error) => {
          clearInterval(pollTimer);
          done({
            stage: 'onError',
            err: String((error && error.message) || JSON.stringify(error)),
            interactive: sawInteractive,
          });
        },
      });
    } catch (error) {
      clearInterval(pollTimer);
      done({ stage: 'init-throw', err: String((error && error.message) || error) });
    }
    setTimeout(() => {
      clearInterval(pollTimer);
      done({ stage: 'timeout', interactive: sawInteractive });
    }, 60000);
  })`
}

/** 常驻浏览器的启动选项。 */
export interface ZcodeCaptchaBrowserOptions {
  /** 可执行文件；缺省自动探测。 */
  executablePath?: string
  /** 调试端口；缺省随机（9300-9799）。 */
  debugPort?: number
  /** 是否隐藏窗口（默认 true —— 用户不应被打扰）。 */
  hideWindow?: boolean
  /**
   * 载体页 origin（缺省 `CAPTCHA_PAGE_ORIGIN` = `https://zcode.z.ai/`）。
   *
   * ⚠ 仅供本地探针验证「本地 origin 行不行」，**不是生产配置**；
   * 取值规则与红线见 {@link resolveCaptchaPageOrigin}。
   */
  pageOrigin?: string
  /** 就绪等待上限（毫秒）。 */
  readyTimeoutMs?: number
  /**
   * 页面导航后的等待（毫秒）。
   *
   * ⚠ 真实 origin 的页面需要等 `domcontentloaded` 才有 `body`
   * （实测约 1.5 秒足够；`about:blank` 只需几百毫秒）。
   */
  navigationWaitMs?: number
  /**
   * 页面**空闲多久后主动换页**（毫秒）。
   *
   * ## ⚠ 默认已改为「**不因空闲换页**」（`Number.POSITIVE_INFINITY`）
   *
   * ### 为什么会改（原设计基于一个**未能复现**的前提）
   *
   * 原默认 `8_000`（8 秒）的依据是一条实测：*「同一页面空闲 15 秒后 mint
   * 必然 `F001`」*。但 2026-10-01 用更严格的变量分离**复测时无法复现**：
   *
   * | 场景（同一页面、零换页） | 结果 | 耗时 |
   * |---|---|---|
   * | 空闲 20 秒后**什么都不做**直接 mint | ✓ 3/3 | **467ms** |
   * | 空闲 20 秒后**重置 DOM** 再 mint（= 原生产行为） | ✓ 3/3 | 479ms |
   * | 空闲 20 秒后清 SDK 全局 + 重注入 | ✓ 2/2 | 488ms |
   *
   * 而**走生产 `mint()` 路径**时空闲 20 秒后：成功但**每次都换页**，
   * 耗时 **2.6–3.5 秒**。
   *
   * ⇒ 结论：**「空闲必然失效」不成立**；那个阈值让每次空闲后都白付一次
   * 建页成本（约 2.7 秒）。这正是用户报障「一键签到里 ZCode 很久」的成因
   * —— 而不是 captcha 本身慢（**失败时**的自愈能力仍然保留：`mint()` 里
   * `attempt > 1` 会 `forceFresh` 换页重试）。
   *
   * ### 现在的策略：**复用优先，失败才换页**
   *
   * ```
   * 默认（Infinity）           → 只要页面还在就复用（约 0.5 秒）
   * mint 失败（F001 等）        → 丢弃该页 + 换新页重试一次（原有的自愈链）
   * ```
   *
   * ⚠ 这**不增加 captcha 调用次数**：失败那次本就发了请求，且它是恢复所必需的。
   * 最坏情况（真遇到 F001）比原来多花约 0.5 秒，而**常态下省掉约 2.7 秒**。
   *
   * ⚠ 若将来又观测到「空闲后必失败」，把这里设成一个有限值即可回到
   * 「预测式换页」——但请**先复现证据**，别只看单次现象（本参数就是这么来的）。
   *
   * 设成 `0` 等于「每次新建」（慢，仅在排查时用）。
   */
  idleReuseMs?: number
  /**
   * 等**别的 mint** 让出页面时的上限（毫秒，默认 30000）。
   *
   * ⚠ 这不是「性能参数」而是**防死锁参数**（真实缺陷，2026-09-29）：
   * 取页是 `while (pageBusy) await sleep(50)` 的自旋，一旦某个持有者没能
   * 复位标志，这里就是**永久自旋** —— 而它既不看 signal 也没有上限，
   * 表现为「请求根本不发出、UI 永远深度求索中、点停止也无反应」。
   * 有界失败远好于永久挂起（失败会被上报成错误，挂起只能重启宿主）。
   */
  pageWaitTimeoutMs?: number
  /**
   * 新建页面时等待 CDP WebSocket `open` 的上限（毫秒，默认 10000）。
   *
   * ⚠ 同理是防死锁：旧实现只等 `open` / `error` 两个事件，Chromium 僵死时
   * **两个都不来**，于是永久挂起（且因为不抛错，`pageBusy` 也不会复位）。
   */
  connectTimeoutMs?: number
  /**
   * 诊断输出（可选，缺省静默）。
   *
   * ⚠ 只用于**说明性**信息，目前只有一条：实际落到系统 Edge 兜底时告警
   * （Gitee issue IKJLB1 的期望行为 2 —— 此前 Edge 是被静默选中的，
   * 用户既不知道用了哪个浏览器，也不知道该去哪换）。
   *
   * ⚠ 形参与 `src/captcha-carrier.ts` 的 `CaptchaCarrierDeps.log` 一致，
   * 由 `zcode-auth.ts` 传 `ctx.logger` 进来；**不给也不影响功能**。
   */
  log?: (message: string) => void
}

/**
 * 挑一个**确实空闲**的调试端口。
 *
 * ⚠ 为什么不能随机取（见 `launch()` 里 `this.port` 处的完整缺陷链）：
 * 随机撞上「尚未退干净的旧实例」会让新实例启动失败、而我们连到旧实例上，
 * 最终 `dispose()` 打空 ⇒ 旧实例整棵树泄漏。
 *
 * 做法：先用 `net.createServer` **真的占用**一下候选端口来验证可用性
 * （比查「谁在监听」可靠：既覆盖监听态，也避开刚关闭进入 TIME_WAIT 的端口）。
 *
 * ⚠ 探测与真正启动之间仍有理论竞态，故 `launch()` 里还有第二道
 * 「应答端口是否一致」的校验。
 */
async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 9300 + Math.floor(Math.random() * 500)
    if (await isPortFree(candidate)) return candidate
  }
  // 兜底：极端情况下退回随机（后续的端口校验会把问题暴露成明确报错）。
  return 9300 + Math.floor(Math.random() * 500)
}

/** 试占一个端口判断是否空闲（能绑上就算空闲）。 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    // 只绑回环：chromium 的调试端口也在回环上。
    try {
      server.listen(port, '127.0.0.1')
    } catch {
      resolve(false)
    }
  })
}

/**
 * ★ 把 chromium 的窗口从**任务栏**移除（Windows）。
 *
 * ## 为什么需要（用户报障 2026-09-29）
 *
 * > captcha 打开的 chromium 虽然最小化在任务栏，但**每次刷新页面完成都会闪烁
 * > 提示**。任务栏设成自动隐藏时，它会不停**浮上来**显示那个闪烁提示，
 * > 挡住屏幕最下面一排。
 *
 * ## 根因（Win32 实测取证）
 *
 * 枚举窗口的 `exStyle` 发现，**主窗口缺 `WS_EX_TOOLWINDOW`（0x80）**：
 *
 * | 时机 | 窗口类 | exStyle | toolWindow | inTaskbar |
 * |---|---|---|---|---|
 * | 启动后（不可见） | `Chrome_WidgetWin_1` | `0x200100` | ✗ | false（未显示） |
 * | **页面加载后（可见）** | 同上 | `0x200100` | ✗ | **true** ★ |
 *
 * ⇒ 页面一渲染，窗口就**获得任务栏按钮**。有按钮，Windows 就有可闪的东西；
 * 任务栏自动隐藏时便浮出来显示它。
 *
 * ## 修法
 *
 * 给窗口加上 `WS_EX_TOOLWINDOW`：Win32 文档原话是「工具窗口**不出现在任务栏**」。
 * 没有按钮 ⇒ 没有可闪烁的提示 ⇒ 任务栏不会浮出。
 * 同时加 `WS_EX_NOACTIVATE`（不抢焦点、不前置），并清掉 `WS_EX_APPWINDOW`
 * （它会**强制**出现在任务栏，与目的相反）。
 *
 * ## 实测验证
 *
 * | 项 | 结果 |
 * |---|---|
 * | 打上后 `inTaskbar` | 13 个窗口**全部 false** |
 * | 连续 3 次 mint 后样式是否被重置 | **全部保持**（不会被 chromium 重置） |
 * | 对 captcha 功能的影响 | mint 仍成功（1802~1950ms） |
 * | 成本 | 约 1.2 秒（**这是这一步 PowerShell 自身的耗时，不是 mint 的耗时**；mint 的稳态口径见上面 `CAPTCHA_PAGE_ORIGIN` 的矩阵）；**只需在启动时做一次**，可与 3.7 秒的启动并行 ⇒ 几乎免费 |
 *
 * ⚠ **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。
 * 借外部 PowerShell 有失败可能（策略限制/无权限），此时最坏结果是回到
 * 修复前的行为（窗口在任务栏），**绝不能让 captcha 因此不可用**。
 *
 * ⚠ 用 **`powershell.exe`**（Windows 5.1，系统自带）而不是 `pwsh` ——
 * 后者是可选安装，不能假设存在。实测本机 5.1 存在且 Add-Type 可用。
 *
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选）。macOS 藏窗失败时用它告警一次，原因见
 *   {@link hideWindowMacos}：失败被静默吞掉，用户报「窗口还是弹出来」时
 *   没有这条日志就只能猜。
 */
function hideWindowFromTaskbar(pid: number, log?: (message: string) => void): void {
  try {
    if (process.platform === 'win32') hideWindowWindows(pid)
    else if (process.platform === 'linux') hideWindowLinux(pid)
    else if (process.platform === 'darwin') hideWindowMacos(pid, log)
  } catch {
    // 静默：优化失败不影响 captcha。
  }
}

/**
 * Windows：直接改窗口的**扩展样式**。
 *
 * 见 {@link hideWindowFromTaskbar} 的取证表（`WS_EX_TOOLWINDOW` 一出，
 * 窗口即不在任务栏）。
 */
function hideWindowWindows(pid: number): void {
  let dirCreated: string | undefined
  try {
    /**
     * 脚本**纯 ASCII**（无中文注释）—— PS 5.1 对无 BOM 的 UTF-8 会按 ANSI
     * 解读，含中文的脚本会损坏（实测过）。
     *
     * ⚠ 关键设计：**回读校验 + before 为 0 时跳过**。
     * 内联版失败时的特征是「读到的 `exStyle` 恒为 0」，而脚本仍把样式
     * 写成 0（可能破坏窗口）。这里明确要求 before 非 0 才写。
     */
    const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class ZcodeWinStyle {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int i, IntPtr v);
  public static List<IntPtr> All() {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
}
"@
$EX = -20
$TOOL = 0x80
$APP = 0x40000
$NOACT = 0x8000000
$target = ${String(pid)}
$n = 0
$all = @([ZcodeWinStyle]::All())
if ($all.Count -eq 0) { Write-Output 'enum-empty'; exit 0 }
foreach ($h in $all) {
  $wp = 0
  [void][ZcodeWinStyle]::GetWindowThreadProcessId($h, [ref]$wp)
  if ([int]$wp -ne $target) { continue }
  $before = [int64][ZcodeWinStyle]::GetWindowLongPtr($h, $EX)
  if ($before -eq 0) { continue }
  $new = (($before -bor $TOOL -bor $NOACT) -band (-bnot $APP))
  [void][ZcodeWinStyle]::SetWindowLongPtr($h, $EX, [IntPtr]$new)
  $n++
}
Write-Output "hidden=$n"
`
    const dir = mkdtempSync(join(tmpdir(), 'zcode-hide-'))
    const file = join(dir, 'hide.ps1')
    dirCreated = dir
    writeFileSync(file, script, 'ascii')
    /**
     * ⚠ 用 `-File`（**不是** `-Command`）—— 见函数头的实测对比表。
     * `stdio: 'ignore'`：装饰路径不该因沙箱下的 stdio EPERM 而失败。
     *
     * ⚠ 闭包里用 `file`（局部 const）而不是可变的 let：后者在回调里会
     * **丢失类型收窄**（TS 报 undefined 不可赋值）。
     */
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-File', file,
    ], { stdio: 'ignore', windowsHide: true })
    child.on('exit', () => { safeRemoveDir(dir) })
    child.on('error', () => { safeRemoveDir(dir) })
  } catch {
    if (dirCreated !== undefined) safeRemoveDir(dirCreated)
  }
}

/**
 * Linux（X11）：用 **EWMH** 标准机制把窗口从任务栏移除。
 *
 * ## ⚠⚠ 与 Windows 的**本质差异**（先读这段）
 *
 * | | Windows | Linux（X11） |
 * |---|---|---|
 * | 机制 | 窗口**属性**（`SetWindowLongPtr`） | **WM 协议**（EWMH 客户端消息） |
 * | 生效条件 | 立刻生效，不需 WM 配合 | **需 WM 支持 `_NET_WM_STATE_SKIP_TASKBAR`** |
 * | 依赖 | 系统自带 `powershell.exe` | **外部工具 `wmctrl`**（非自带，可能没装） |
 * | Wayland | 不适用 | **完全无效**（无 X11 访问权） |
 *
 * ⇒ **本路径是「尽力而为」**：装了就生效，没装就静默跳过（回到修复前行为）。
 * **不引入 npm 依赖**去直接发 X11 协议（那要动 X11 连接层，风险与体积都不划算）。
 *
 * ## 为什么用 `wmctrl` 而不是 `xdotool`
 *
 * `xdotool` 的 `windowstate` 只支持 `add/remove` 少数几项，**不含
 * `SKIP_TASKBAR`**；而 `wmctrl -r <win> -b add,skip_taskbar` 正是干这个的。
 * 故主选 `wmctrl`，`xdotool` 仅用于**按 pid 找窗口 id**（若 `wmctrl` 的
 * `-lp` 不够用时作为补充）。
 *
 * ## ⚠ 未在本机实测（如实标注）
 *
 * 开发机是 Windows，且 WSL 实例损坏、无 X11 工具 —— **无法真机验证 Linux 行为**。
 * 故：
 *   - 命令构造抽成纯函数 {@link buildLinuxSkipTaskbarArgs} 并**单测锁死**
 *   - 失败路径**完全静默**（最坏回到修复前）
 *   - 这里只依赖 `wmctrl` 的**文档化语义**，不做任何"猜测式"的额外调用
 */
function hideWindowLinux(pid: number): void {
  /**
   * ⚠ `wmctrl -lp` 列出所有窗口，格式（文档）：
   * ```
   * 0x0320000a  0 12345  hostname  Window Title
   * ```
   * 第 1 列是窗口 id、**第 3 列是 pid** —— 据此筛出我们自己的窗口。
   *
   * 用 `-r <id> -b add,skip_taskbar` 逐个设置。
   * `-i` 表示按**窗口 id**（而不是标题）匹配（标题可能含特殊字符）。
   *
   * 为什么不写 shell 脚本（与 Windows 侧对称）：Linux 侧没有「内联脚本
   * 被转义破坏」那类问题（`spawn` 不经 shell），但**需要解析 `-lp` 输出**
   * 才能按 pid 过滤 —— 那段解析逻辑放在 JS 里更好测（见 `parseWmctrlList`）。
   *
   * ⚠ 不检查 `wmctrl` 是否存在：`spawn` 失败会走 `error` 事件（静默处理），
   * 比预先 `which` 探测更简单且无竞态。
   */
  const list = spawn('wmctrl', ['-lp'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const chunks: Buffer[] = []
  list.stdout?.on('data', (c: Buffer) => chunks.push(c))
  list.on('error', () => { /* 没装 wmctrl —— 静默跳过 */ })
  list.on('exit', () => {
    try {
      const ids = parseWmctrlList(Buffer.concat(chunks).toString('utf8'), pid)
      for (const id of ids) {
        const child = spawn('wmctrl', buildLinuxSkipTaskbarArgs(id), {
          stdio: 'ignore',
          windowsHide: true,
        })
        child.on('error', () => { /* 静默 */ })
      }
    } catch {
      // 静默：优化失败不影响 captcha。
    }
  })
}

/**
 * macOS：把该 pid 的 chrome 窗口**最小化**（`set miniaturized of every window to true`）。
 *
 * ## 为什么是最小化（而非 osascript 移屏 / 1x1）
 *
 * 真机（macOS，主屏 0,0 1470×956）对 4 种藏法逐一验证了「窗口是否仍挂在
 * 屏幕可见区」与「captcha 是否仍能 mint」：
 *
 * | 藏法 | 命令 | captcha 实测 |
 * |---|---|---|
 * | 最小化 | `set miniaturized … to true` | **稳**（10/10 mint OK，paramLen 280） |
 * | 移到 -32000 | `set position … to {-32000,-32000}` | **偶发 `F001`**（窗口离屏时 SDK 取证帧偶尔拿到空 canvas） |
 * | 1×1 缩到角 | `set size … to {2,2}` | 偶发 F001（同上，渲染尺寸过小触发 SDK 重试） |
 * | `--headless=new` | （启动参数） | 一律 `F001`，**不可用** |
 *
 * 结论：macOS 上**最小化是唯一同时满足「不挡屏幕」与「mint 稳定」**的做法。
 * 最小化后窗口缩到屏幕右下角（Dock 区），肉眼几乎不可见，且不破坏 captcha。
 *
 * ## 为什么不用 osascript `set position`（移屏）
 *
 * `--window-position=-32000,-32000` 已经由 `launch()` 传给了 chromium，但
 * **macOS 的 WindowServer 会把离屏窗口钳回屏幕内**（与 `--headless` 相反，
 * 这是系统行为，不是 chromium 行为）。所以「移屏」这条在 macOS 上等于没移。
 * 最小化则不受该钳制影响（窗口仍在屏幕坐标系内，只是缩到角上）。
 *
 * ## ⚠⚠ 依赖：宿主必须已授予 macOS「辅助功能」权限（与 Linux 的 wmctrl 不同）
 *
 * | | Linux | macOS |
 * |---|---|---|
 * | 机制 | WM 协议（EWMH 客户端消息） | `osascript` 驱动 System Events 的 UI 脚本 |
 * | 依赖 | 外部工具 `wmctrl` | 系统自带 `osascript`，**但 UI 脚本需宿主被授予「辅助功能」权限** |
 * | 缺了怎么办 | `apt install wmctrl`，一条命令 | 系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主，**通常还要重启应用** |
 * | 用户知道吗 | 报错会说「没装 wmctrl」 | **大多数人不知道这个权限存在**，且授权可能随应用升级被重置 |
 *
 * ⇒ 未授权时 `osascript` 非零退出，被本函数的静默语义吞掉，**窗口照常弹出**。
 * 这是「减少打扰」的优化失效，不是功能故障；用户报「窗口还是弹出来」时先查这一项。
 *
 * ## 接入与失败语义（与 Windows/Linux 侧对称）
 *
 * - **失败必须静默**：这是「减少打扰」的优化，不是功能依赖。`spawn` 的
 *   `error`/非零退出都直接吞掉，最坏结果回到修复前的行为（窗口正常弹出），
 *   **绝不能让 captcha 因此不可用**。
 * - 与 Windows 侧一样用 `windowsHide: true` + `stdio: 'ignore'` 异步 fire-and-forget。
 * - **只按 pid 匹配**（`unix id`），刻意没有「按进程名兜底」—— 理由与代价见
 *   {@link hideWindowMacos} 的函数头。
 * - ⚠ 本函数是本文件**唯一**拼 AppleScript 的地方，且**只插值一个整数**：
 *   没有字符串插值 ⇒ 没有引号/反斜杠转义问题（初版的进程名兜底栽在这里）。
 *
 * @param pid 目标浏览器主进程 pid。
 * @returns `osascript` 参数数组（`-e <script>`），纯函数便于单测锁死。
 */
export function buildMacosMiniaturizeArgs(pid: number): string[] {
  // AppleScript：遍历该 pid 名下所有窗口并最小化。
  // `System Events` 需要 `process` 句柄，`pid` 用 `unix id` 精确匹配。
  const appleScript =
    `tell application "System Events" to set miniaturized of every window of ` +
    `(first process whose unix id is ${pid}) to true`
  return ['-e', appleScript]
}

/**
 * 对 macOS 该 pid 的窗口执行最小化（异步、失败静默）。
 *
 * ## ⚠⚠ 刻意**没有**「按进程名兜底」——那会最小化用户自己的浏览器
 *
 * 初版在 pid 匹配非零退出后，用 `first process whose name is "Google Chrome"`
 * 再试一次。**已删除**，两个原因：
 *
 * ① **会误伤用户真实浏览器**：`whose name is` 匹配**任意**同名进程，不是「我们
 *    那个」。用户在用 Chrome 时兜底一旦触发，其全部真实窗口被最小化。
 *    ⚠ 而触发条件比想象中宽：本函数以「osascript 非零退出」触发兜底，
 *    `stdio: 'ignore'` 又丢掉 stderr ⇒ **分不清「pid 落空」与「辅助功能未授权
 *    （-1719）」**。后者才是更常见的失败原因（真机第一轮实测就撞到过）。
 * ② **字符串插值未转义**：`"${exeName}"` 里若进程名含 `"`，字面量会被撑开
 *    （实测 `evil".do shell script "id` → `… whose name is "evil".do shell
 *    script "id") to true`）。删掉兜底后**本文件不再有任何字符串插值进
 *    AppleScript**，注入面随之一并消失。
 *
 * ⇒ pid 落空就**什么都不做**：窗口短暂可见，正是**修复前**的行为。代价是
 * Chrome re-exec 换 pid 时最小化失效 —— 那是「少一个优化」，不是功能回退。
 * 拿「少隐藏一次」换「绝不最小化用户自己的浏览器」，这笔账划算。
 *
 * 契约锁在 `tests/unit/zcode-window-hide-macos-review.spec.ts`。
 *
 * 一次性告警闸门：同一进程里只提醒一次，避免每次 `launch()` 刷屏。
 */
let macosHideWarned = false

/**
 * macOS 藏窗失败时告警一次。
 *
 * ⚠ 只说「可能的原因」而不下断言：`stdio: 'ignore'` 丢掉了 stderr，
 * 区分不出「pid 落空」与「辅助功能未授权（-1719）」，而后者更常见。
 */
function warnMacosHideOnce(log: ((message: string) => void) | undefined, reason: string): void {
  if (log === undefined || macosHideWarned)
    return
  macosHideWarned = true
  log(
    `[channel-pack] zcode macOS 藏窗未生效（${reason}）—— 窗口会照常弹出，但不影响 captcha。` +
    '最常见原因是宿主未获 macOS「辅助功能」权限：系统设置 → 隐私与安全性 → 辅助功能 → 勾选宿主（通常需重启应用）。',
  )
}

/**
 * @param pid 目标浏览器主进程 pid。
 * @param log 诊断回调（可选），见 {@link hideWindowFromTaskbar}。
 */
function hideWindowMacos(pid: number, log?: (message: string) => void): void {
  const child = spawn('osascript', buildMacosMiniaturizeArgs(pid), {
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => { warnMacosHideOnce(log, 'osascript 不可用') })
  // 非零退出同样静默继续（不重试，见函数头 ①），但留一条告警。
  child.on('close', (code) => {
    if (code !== 0)
      warnMacosHideOnce(log, `osascript 退出码 ${code}`)
  })
}

/**
 * 构造「把窗口加入 `_NET_WM_STATE_SKIP_TASKBAR`」的 `wmctrl` 参数。
 *
 * ⚠ `-i` 必带：让 `-r` 按**窗口 id** 匹配（`0x...`），而不是按标题 ——
 * 标题里有空格/括号（chromium 的标题是「新标签页 - Chromium」）会被误解析。
 *
 * ⚠ **只加 `skip_taskbar`，不加 `skip_pager`**：前者即「不出现在任务栏」
 * （这正是要的）。`skip_pager` 是「不出现在工作区切换器」，与本次目的无关，
 * 多加会改变用户对窗口的既有预期（用户没要求隐藏工作区条目）。
 *
 * ⚠ 也**不**用 `-b add,hidden`（最小化）：chromium 已经用
 * `--window-position=-32000,-32000` 移出屏幕，再改最小化状态会与
 * captcha 流程的窗口假设冲突（那些流程依赖窗口"存在且可渲染"）。
 */
export function buildLinuxSkipTaskbarArgs(windowId: string): string[] {
  return ['-i', '-r', windowId, '-b', 'add,skip_taskbar']
}

/**
 * 从 `wmctrl -lp` 的输出里筛出**属于指定 pid** 的窗口 id。
 *
 * 输出格式（每行，字段以空白分隔）：
 * ```
 * 0x0320000a  0 12345  hostname  Window Title
 * └─ 窗口 id  │  └─ pid
 *            └─ 桌面号
 * ```
 *
 * ⚠ **标题可能含任意空白**，故只能按「前 4 个字段」切分，**不能**整体
 * `split(/\s+/)` 后取全部 —— 那样标题会被拆散（对本用途无害，但会让人
 * 误以为解析"完全正确"）。
 *
 * ⚠ 只取**前 4 个字段**：第 4 列（hostname）之后全是标题。
 * 用 `split(/\s+/, 5)`（限 5 段）恰好把标题保留为最后一段。
 *
 * @returns 属于该 pid 的窗口 id（形如 `0x0320000a`）；解析不到就返回空数组。
 */
export function parseWmctrlList(output: string, pid: number): string[] {
  const ids: string[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    // 限 5 段：id / desktop / pid / host / 其余（标题）
    const fields = line.split(/\s+/, 5)
    if (fields.length < 3) continue
    const id = fields[0] ?? ''
    // 窗口 id 必须是 0x 开头的十六进制（防把标题行当数据行）
    if (!/^0x[0-9a-f]+$/i.test(id)) continue
    const linePid = Number(fields[2])
    if (!Number.isInteger(linePid) || linePid !== pid) continue
    ids.push(id)
  }
  return ids
}

/** 尽力删除临时目录（失败无妨，系统会回收临时目录）。 */
function safeRemoveDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch { /* 忽略 */ }
}

/**
 * 一个可复用的 captcha 页面。
 *
 * ⚠ **页面被复用**（不再每次新建）—— 见 `mint()` 的说明。
 * 复用要求它一直停在 {@link CAPTCHA_PAGE_ORIGIN} 上。
 */
interface CaptchaPage {
  /** CDP target id（诊断用）。 */
  readonly targetId: string
  /** 页面级 WebSocket。 */
  readonly ws: WebSocket
  /** 页面级 CDP 连接。 */
  readonly cdp: CdpConnection
  /** 上次成功使用它的时刻（用于空闲判定）。 */
  lastUsedAt: number
  /**
   * 是否已做过「建 DOM + 注入 SDK」的完整准备。
   *
   * ⚠ **不能每次都重做**（真实缺陷，见 `mintOnPage` 的取证）：
   * 重置 `document.body.innerHTML` 会销毁 captcha 元素，而 SDK 已加载时
   * 不会重建实例 —— 两者叠加必然 `F001`。
   *
   * 故只在**首次使用**时准备（`undefined`/`false` ⇒ 准备一次），
   * 之后复用同一元素与实例。
   */
  prepared?: boolean
}

/**
 * 常驻浏览器会话。
 *
 * ## 为什么常驻
 *
 * 冷启动实测约 690ms，但**每次请求都冷启动**会让首字延迟凭空多一秒。
 * 而 mint 只在**上游索要验证时**才发生：复用常驻页面的稳态约 0.4–0.5 秒
 * （中位 426ms / 平均 546ms，见 `CAPTCHA_PAGE_ORIGIN` 的矩阵），含 chromium
 * 冷启动的首发实测 4.2 秒；至于「每次新建 page」那个 1246ms，是 origin 修正
 * **之前**的历史值，别当现行口径（数字汇总见 README 的 ZCode 章节）。
 * （上游不要验证的窗口里这条路**一次都不走**，见文件头的「按需」段。）
 *
 * ## 生命周期
 *
 * `dispose()` 必须被调用（`ZcodeAuth.stop()` 里做），否则会留下
 * 一个孤儿 chromium 进程（约 200-400MB）。进程退出兜底见文件底部
 * 的 `process.once('exit')` 注册（2026-11-08 终审 R9：原注释声称有钩子
 * 但实现不存在，现已补上——同步 killProcessTree，best-effort）。
 */
