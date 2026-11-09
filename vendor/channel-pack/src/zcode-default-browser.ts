/**
 * 「用户**自己的**默认浏览器」探测（2026-11-09，用户要求）。
 *
 * ## 为什么要有这个模块（用户报障的形态）
 *
 * 用户问：「只能使用谷歌浏览器吗？就不能看看用户有什么浏览器，再考虑使用什么
 * 浏览器吗？」—— 事实就是如此：{@link findBrowserExecutable} 用的是一张
 * **硬编码的候选链**，按**固定优先级**取第一个存在的（Windows: scoop chromium →
 * Chrome → Chromium → Edge；macOS / Linux 同序），**从不问系统**哪个才是默认浏览器。
 *
 * 实测（2026-11-09，Debian/Deepin 桌面机）：
 *
 * ```text
 * /usr/bin/google-chrome      存在      ← 候选链里排第一 ⇒ 永远选它
 * /usr/bin/microsoft-edge     存在（且是**系统默认**浏览器，xdg-settings 实测
 *                                       default-web-browser = microsoft-edge.desktop）
 * ```
 *
 * 也就是说：用户的默认浏览器**根本没被看过一眼**，Chrome 只因为「链里排在前面」
 * 就赢得了选择。这不是「只支持谷歌」，但用户感受到的结论完全一样。
 *
 * ## 判据必须限定在 **Chromium 内核**（这是硬约束，不是偏好）
 *
 * 本仓库产 captcha 走的是 **CDP**（`/json/version` + 页面级 WebSocket，见
 * `zcode-captcha.ts` 的 `CdpConnection`），并且**必须 headful**（`--headless=new`
 * 实测一律 `F001`）。Firefox / Safari 都不提供这套协议 ⇒ 默认浏览器是它们时，
 * 本模块**如实返回 `undefined`**，由调用方回落到既有候选链。
 *
 * ⇒ 「看用户有什么浏览器」的准确含义是「在**用户默认的那个**里面，能用的就用」，
 * 而不是把用户没装的东西也拿来试。
 *
 * ## 为什么单独一个文件
 *
 * 它要**起子进程**读系统设置（`xdg-settings` / `reg` / `plutil`）——
 * 这是唯一带副作用的环节。抽出来后：
 * - `zcode-captcha.ts` 的候选链仍是纯函数（见 `browserCandidates` 的说明）；
 * - 本模块的每个解析器都能被单测**零子进程、零文件系统**地断言
 *   （`run` / `readFile` / `exists` 全部可注入）。
 *
 * ## 失败一律静默（`undefined`）
 *
 * 探测默认浏览器是**锦上添花**：系统命令缺失、超时、输出格式变了、
 * 用户装的是 Firefox……任何一种情况都只是「这条捷径走不通」，必须回落到
 * 既有的硬编码候选链 —— 那条链才是保底。故本模块**不抛错、不打日志**。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, posix, win32 } from 'node:path'

/**
 * macOS：默认浏览器的 **bundle id → app bundle 名 + 内部可执行文件名**。
 *
 * ⚠️ 表里同时收了 **Safari**：它不是 Chromium 内核（CDP 不可用），
 * 收录它只为让「默认浏览器是 Safari」能**被识别出来并明确跳过**，
 * 而不是当成「探测失败」——两者的日志/排障含义不同。
 *
 * ⚠️ `Microsoft Edge` / `Brave Browser` **不带扩展名**：macOS 的 app bundle
 * 内部就是这个名字（与 Windows 的 `msedge.exe` / `brave.exe` 不同）。
 *
 * ⚠️ **与 `zcode-captcha.ts` 的 `MAC_BROWSER_BUNDLES` 同源**：那张表是
 * 「硬编码候选链」，本表是「默认浏览器解析」。新增内核时**两处都要加**，
 * `scripts/zcode-default-browser-test.mjs` 有漂移守卫用例。
 */
export const MAC_DEFAULT_BROWSER_BUNDLES: ReadonlyArray<
  readonly [bundleId: string, bundle: string, exe: string]
> = [
  ['com.google.chrome', 'Google Chrome.app', 'Google Chrome'],
  ['org.chromium.chromium', 'Chromium.app', 'Chromium'],
  ['com.microsoft.edgemac', 'Microsoft Edge.app', 'Microsoft Edge'],
  ['com.brave.browser', 'Brave Browser.app', 'Brave Browser'],
  ['com.vivaldi.vivaldi', 'Vivaldi.app', 'Vivaldi'],
  ['com.operasoftware.opera', 'Opera.app', 'Opera'],
  // 非 Chromium 内核：识别得出、但**永不选**（见本文件头「判据必须限定」）。
  ['com.apple.safari', 'Safari.app', 'Safari'],
]

/**
 * 该可执行文件名是否属于 **Chromium 内核**（能产 CDP / 能过阿里云 captcha）。
 *
 * ## 判据：**文件名前缀**，不是「路径里含 chrome」
 *
 * 路径里搜关键字会把 `/opt/chromium-not-really/firefox` 这种边界情况判错
 * （与 `isEdgeExecutable` 踩过的坑同型，见 `zcode-captcha.ts` 的说明）。
 *
 * ## 归一化：小写 + 空格转连字符 + 去 `.exe`
 *
 * 三个平台的名字长得不一样，归一化后一套前缀表就能覆盖：
 *
 * | 平台 | 原始 | 归一化 |
 * |---|---|---|
 * | macOS | `Google Chrome` | `google-chrome` |
 * | macOS | `Microsoft Edge` | `microsoft-edge` |
 * | Windows | `chrome.exe` / `msedge.exe` | `chrome` / `msedge` |
 * | Linux | `/usr/bin/google-chrome-stable` | `google-chrome-stable` |
 *
 * ## ⚠ 切文件名必须**两种分隔符都认**
 *
 * 不能用 `node:path` 的 `basename`：它按**宿主平台**分叉，于是在 Linux 上跑
 * `basename('C:\\Program Files\\…\\msedge.exe')` 会返回**整条字符串**
 * （反斜杠不是 Linux 的分隔符）⇒ 前缀匹配一律失败、Windows 分支静默判 false。
 * 那正是本仓库 `macBrowserCandidates` 踩过的「宿主平台污染纯函数」同型缺陷
 * （Gitee issue IKJKNT）。故这里用正则按 `/` **和** `\` 一起切。
 */
export function isChromiumFamilyExecutable(executable: string): boolean {
  const fileName = executable.split(/[\\/]/).pop() ?? ''
  const normalized = fileName
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/\s+/g, '-')
  return CHROMIUM_FAMILY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Chromium 内核浏览器可执行名名的**前缀表**。
 *
 * ⚠️ 用前缀而不是全等：发行版会给同一个浏览器多个包名 / 多个通道
 * （`google-chrome` / `google-chrome-stable` / `google-chrome-beta`、
 * `microsoft-edge` / `microsoft-edge-stable` / `microsoft-edge-beta`、
 * `vivaldi` / `vivaldi-stable`）。
 *
 * ⚠️ 顺序**不表示优先级**（本函数只回答「是不是」，不回答「谁更好」）。
 */
const CHROMIUM_FAMILY_PREFIXES: readonly string[] = [
  'google-chrome',
  'chrome',
  'chromium',
  'microsoft-edge',
  'msedge',
  'brave',
  'vivaldi',
  'opera',
  'yandex',
  'thorium',
]

/**
 * 拆一条命令行（`.desktop` 的 `Exec=` / Windows 的 `shell\open\command`）。
 *
 * 支持单引号、双引号与 `\"` 转义；引号内的空白不切分。
 * 不做变量展开（那需要 shell 语义 —— 而本模块**绝不**经过 shell）。
 */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let started = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      if (char === quote) {
        quote = undefined
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * 从 `.desktop` 的正文里取**可执行文件候选路径**（Linux 默认浏览器）。
 *
 * ## 必须处理的三种真实写法（实测于 Debian / Deepin 桌面）
 *
 * ```text
 * Exec=/usr/bin/google-chrome-stable %U                       ← 绝对路径
 * Exec=google-chrome-stable %U                                ← 只有命令名（靠 PATH）
 * Exec=env BAMF_DESKTOP_FILE_HINT=… /usr/bin/microsoft-edge %U ← 前面挂 env 与赋值
 * Exec=/usr/bin/flatpak run --branch=stable … com.google.Chrome %U  ← flatpak
 * ```
 *
 * ## flatpak 为什么要特殊处理
 *
 * flatpak 的 `Exec` 是「flatpak 自己 + 应用 id」，**可执行文件不是 flatpak**。
 * 直接把 `/usr/bin/flatpak` 当浏览器 spawn 会得到一个既不产 CDP、也不会报
 * 「找不到浏览器」的进程（比找不到更糟 —— 与 `zcode-captcha.ts` 里
 * 「flatpak 只能列 `exports/bin`」是同一个坑）。故这里把 app id 映射成
 * `…/flatpak/exports/bin/<appid>`，那才是真正的入口。
 *
 * `%U` / `%F` / `%i` 之类是 `.desktop` 的**字段码**，不是参数：它们会让
 * 「参数是否为空」的判据失真，故直接丢弃。
 *
 * @returns 绝对路径候选（按顺序，可能为空数组 —— 由调用方逐个 `exists` 判定）
 */
export function parseDesktopEntryExec(
  text: string,
  input: { env?: Record<string, string | undefined>; home?: string } = {},
): string[] {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const matched = /^Exec\s*=\s*(.+)$/m.exec(text)
  if (matched === null) return []
  const tokens = splitCommandLine(matched[1].trim())
    // `.desktop` 的字段码：不是参数。
    .filter((token) => !/^%[A-Za-z]$/.test(token))

  // 跳过 `env` 与其后的 `VAR=value` 前缀（systemd 化的桌面文件常见）。
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ''
    if (token === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      index += 1
      continue
    }
    break
  }
  const command = tokens[index]
  if (command === undefined || command === '') return []

  if (basename(command) === 'flatpak') {
    const appId = tokens.slice(index + 1).find((token) => /^[A-Za-z][\w-]*(\.[\w-]+){2,}$/.test(token))
    if (appId === undefined) return []
    const dataHome = env.XDG_DATA_HOME?.trim() || posix.join(home, '.local', 'share')
    return [
      posix.join(dataHome, 'flatpak', 'exports', 'bin', appId),
      posix.join('/var/lib/flatpak/exports/bin', appId),
    ]
  }
  if (posix.isAbsolute(command)) return [command]
  // 只有命令名 ⇒ 在 PATH 里找（`.desktop` 允许省略绝对路径）。
  const pathDirs = (env.PATH ?? '').split(':').filter((dir) => dir.startsWith('/'))
  return pathDirs.map((dir) => posix.join(dir, command))
}

/**
 * 从 `reg query` 的输出里取某一行的值（Windows 默认浏览器）。
 *
 * 实测输出（`reg query <key> /v ProgId`）：
 *
 * ```text
 *
 * HKEY_CURRENT_USER\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice
 *     ProgId    REG_SZ    MSEdgeHTM
 * ```
 *
 * 取**最后一段**而不是固定某一列：值本身可能含空格（如 `Google Chrome` 的
 * ProgId 是 `ChromeHTML`，但 `shell\open\command` 的默认值是一整条命令行）。
 *
 * ⚠️ **值名不能用 `\w+`**：`/ve`（「默认」那一项）在中文 Windows 上打印的是
 * `(默认)` —— `\w` 不匹配汉字，于是整行被跳过、探测**永远失败**（而中文
 * Windows 恰是本仓库大多数用户）。用 `\S+` 只要求「非空白的值名」即可，
 * 真正的判据是后面的 `REG_SZ` 这类**类型标记**。
 */
export function parseRegQueryValue(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const matched = /\s+\S+\s+REG_[A-Z_]+\s+(.+)$/.exec(line)
    if (matched !== null && matched[1].trim() !== '') return matched[1].trim()
  }
  return undefined
}

/**
 * 从 Windows 的 `shell\open\command` 默认值里取**可执行文件**。
 *
 * ```text
 * "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --single-argument %1
 * C:\Windows\system32\rundll32.exe …            ← 没有引号时按第一个空格切
 * ```
 *
 * ⚠ 判据是 `win32.isAbsolute`：不能用 `node:path` 的 `isAbsolute`，
 * 那按**宿主平台**分叉（在 Linux 上跑本函数会判 false，单测就锁不住了）。
 */
export function parseWindowsCommandExecutable(command: string): string | undefined {
  const first = splitCommandLine(command)[0]
  if (first === undefined || !win32.isAbsolute(first)) return undefined
  return first
}

/**
 * 从 macOS 的 LaunchServices plist（JSON 形态）里取默认浏览器的 bundle id。
 *
 * `LSHandlers[]` 里每一项形如：
 *
 * ```json
 * { "LSHandlerURLScheme": "https", "LSHandlerRoleAll": "com.google.chrome" }
 * ```
 *
 * 优先 `https`，其次 `http` —— 两者不一致时用户真正点开链接用的是 `https`。
 */
export function parseMacDefaultHandler(plistJson: unknown): string | undefined {
  if (typeof plistJson !== 'object' || plistJson === null) return undefined
  const handlers = (plistJson as { LSHandlers?: unknown }).LSHandlers
  if (!Array.isArray(handlers)) return undefined
  const pick = (scheme: string): string | undefined => {
    for (const item of handlers) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (record.LSHandlerURLScheme !== scheme) continue
      const id = record.LSHandlerRoleAll ?? record.LSHandlerRoleViewer
      if (typeof id === 'string' && id.trim() !== '') return id.trim().toLowerCase()
    }
    return undefined
  }
  return pick('https') ?? pick('http')
}

/** 探测用的可注入依赖（单测靠它做到零子进程、零文件系统）。 */
export interface DefaultBrowserProbeInput {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
  /** 执行外部命令并取 stdout；失败/非零返回 `undefined`。 */
  run?: (command: string, args: readonly string[]) => string | undefined
  /** 读文本文件；不存在返回 `undefined`。 */
  readFile?: (path: string) => string | undefined
  /** 路径是否存在。 */
  exists?: (path: string) => boolean
}

/** 缺省的外部命令执行（**只读**系统设置，不经 shell）。 */
function defaultRun(command: string, args: readonly string[]): string | undefined {
  try {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
    if (result.error !== undefined) return undefined
    if (result.status !== 0) return undefined
    return typeof result.stdout === 'string' ? result.stdout : undefined
  } catch {
    return undefined
  }
}

/** 缺省的读文件（失败返回 `undefined`，不抛）。 */
function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 用户的**系统默认浏览器**里，能产 captcha 的那一个（绝对路径）。
 *
 * 返回 `undefined` 的一切情况都表示「这条捷径不可用」：
 * 没设默认浏览器 / 系统命令不存在 / 默认是非 Chromium 内核（Firefox、Safari）/
 * 解析出的路径不存在。调用方必须回落到既有候选链。
 *
 * ⚠️ 这里**已包含** `isChromiumFamilyExecutable` 过滤：非 Chromium 内核的
 * 默认浏览器不会出现在返回值里，也不会「空占」候选链的首位。
 *
 * ⚠️ 不读 `ZCODE_CHROME_PATH`：那是**显式用户指定**，优先级高于「猜出来的
 * 默认浏览器」，由 `zcode-captcha.ts` 的 `browserCandidates` 统一处理。
 */
export function defaultBrowserExecutable(input: DefaultBrowserProbeInput = {}): string | undefined {
  const platform = input.platform ?? process.platform
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const run = input.run ?? defaultRun
  const readFile = input.readFile ?? defaultReadFile
  const exists = input.exists ?? existsSync

  const candidates = platform === 'win32'
    ? windowsDefaultBrowserCandidates({ run })
    : platform === 'darwin'
      ? macosDefaultBrowserCandidates({ run, exists, home })
      : linuxDefaultBrowserCandidates({ run, readFile, env, home })

  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (!isChromiumFamilyExecutable(candidate)) continue
    if (!exists(candidate)) continue
    return candidate
  }
  return undefined
}

/**
 * Linux：`xdg-settings get default-web-browser` → `.desktop` 文件 → `Exec=`。
 *
 * ⚠️ `xdg-mime query default x-scheme-handler/https` 是**第二口径**：部分
 * 「精简」桌面（无 `xdg-settings` 的镜像）只有它。两个都试，先到的算数。
 *
 * ⚠️ `.desktop` 的搜索目录必须包含 `XDG_DATA_HOME`（用户级覆盖优先于系统级，
 * 用户用 `gio set` 改过的默认浏览器常落在那里）。
 */
function linuxDefaultBrowserCandidates(input: {
  run: (command: string, args: readonly string[]) => string | undefined
  readFile: (path: string) => string | undefined
  env: Record<string, string | undefined>
  home: string
}): string[] {
  const { run, readFile, env, home } = input
  const desktopId = (
    run('xdg-settings', ['get', 'default-web-browser'])
    ?? run('xdg-mime', ['query', 'default', 'x-scheme-handler/https'])
    ?? ''
  ).trim()
  if (desktopId === '') return []

  const dataHome = env.XDG_DATA_HOME?.trim() || posix.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS?.trim() || '/usr/local/share:/usr/share').split(':')
  const applicationDirs = [
    posix.join(dataHome, 'applications'),
    ...dataDirs.filter((dir) => dir.startsWith('/')).map((dir) => posix.join(dir, 'applications')),
    // flatpak 导出的桌面文件（用户级优先）。
    posix.join(dataHome, 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
  ]
  const out: string[] = []
  for (const dir of applicationDirs) {
    const text = readFile(posix.join(dir, desktopId))
    if (text === undefined) continue
    out.push(...parseDesktopEntryExec(text, { env, home }))
  }
  return out
}

/**
 * Windows：注册表 `UrlAssociations\https\UserChoice` 的 `ProgId`
 * → `HKCR\<ProgId>\shell\open\command` 的默认值 → 可执行文件。
 *
 * ⚠️ 用 `HKCU`（用户级 UserChoice）而不是 `HKLM` 的默认关联：后者是
 * 「系统推荐」，前者才是用户在「默认应用」里真选过的。
 *
 * ⚠️ `reg` 的输出是本地化的（列头随语言变化），故解析器只认
 * `REG_SZ` 这种**类型标记**，不认列名（见 `parseRegQueryValue`）。
 */
function windowsDefaultBrowserCandidates(input: {
  run: (command: string, args: readonly string[]) => string | undefined
}): string[] {
  const { run } = input
  const userChoice = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice'
  const progIdOutput = run('reg', ['query', userChoice, '/v', 'ProgId'])
  if (progIdOutput === undefined) return []
  const progId = parseRegQueryValue(progIdOutput)
  if (progId === undefined) return []
  const commandKey = `HKCR\\${progId}\\shell\\open\\command`
  const commandOutput = run('reg', ['query', commandKey, '/ve'])
  if (commandOutput === undefined) return []
  const command = parseRegQueryValue(commandOutput)
  if (command === undefined) return []
  const executable = parseWindowsCommandExecutable(command)
  return executable === undefined ? [] : [executable]
}

/**
 * macOS：LaunchServices 的 plist（`plutil -convert json` 之后）→ bundle id
 * → `/Applications/<bundle>/Contents/MacOS/<exe>` 或 `~/Applications/…`。
 *
 * ⚠️ 用 `plutil -convert json -o -` 而不是 `defaults read`：后者的输出是
 * **plist 文本**（含 `{ } ; =` 语法），自己解析等于重写半个 plist 解析器；
 * 而 `plutil` 是系统自带（和 `zcode-captcha.ts` 里选 `powershell.exe` 而非
 * `pwsh` 同一条理由：只依赖系统必带的那个）。
 */
function macosDefaultBrowserCandidates(input: {
  run: (command: string, args: readonly string[]) => string | undefined
  exists: (path: string) => boolean
  home: string
}): string[] {
  const { run, exists, home } = input
  const plist = posix.join(
    home,
    'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist',
  )
  if (!exists(plist)) return []
  const output = run('plutil', ['-convert', 'json', '-o', '-', plist])
  if (output === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  const bundleId = parseMacDefaultHandler(parsed)
  if (bundleId === undefined) return []
  const entry = MAC_DEFAULT_BROWSER_BUNDLES.find(([id]) => id === bundleId)
  if (entry === undefined) return []
  const [, bundle, exe] = entry
  return [
    posix.join('/Applications', bundle, 'Contents', 'MacOS', exe),
    posix.join(home, 'Applications', bundle, 'Contents', 'MacOS', exe),
  ]
}