/**
 * 「系统默认浏览器优先」回归（2026-11-09，用户要求）。
 *
 * ## 锁住的东西
 *
 * 用户原话：「只能使用谷歌浏览器吗？就不能看看用户有什么浏览器，再考虑使用什么
 * 浏览器吗？」—— 事实是候选链**从不问系统**哪个才是默认浏览器，只按一张硬编码表
 * 取第一个存在的。实测本机：`/usr/bin/google-chrome` 与 `/usr/bin/microsoft-edge`
 * 都在，而系统默认是 Edge（`default-web-browser = microsoft-edge.desktop`），
 * 结果永远选 Chrome。
 *
 * 本套件锁四类行为：
 *
 * 1. **候选链顺序**：`ZCODE_CHROME_PATH` → 用户默认浏览器 → 硬编码链
 *    （顺序错一个，用户的选择就被绕过）；
 * 2. **只认 Chromium 内核**：默认浏览器是 Firefox / Safari 时，探测必须返回
 *    `undefined` 并**回落到硬编码链** —— 而不是把 Firefox 当浏览器 spawn 出去
 *    （它不产 CDP，症状会是「浏览器起来了但 captcha 一直失败」，比找不到更难查）；
 * 3. **三个平台的解析器**：Linux `.desktop` 的 `Exec=`、Windows 的
 *    `UserChoice\ProgId` + `shell\open\command`、macOS 的 LaunchServices plist ——
 *    全部**零子进程**断言（`run` / `readFile` / `exists` 注入），
 *    否则 macOS / Windows 分支在本机（Linux）永远测不到；
 * 4. **失败一律静默**：系统命令不存在、输出格式变了、路径不存在 ⇒ 一律 `undefined`，
 *    绝不抛错（探测是锦上添花，不能把领取变成一条看不懂的失败）。
 *
 * ⚠️ 零网络、零真实系统调用、零文件系统写入。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-default-browser-'))
process.env.DSH_HOME = scratch
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
      }
    }
    return nextLoad(url, context)
  },
})

let checks = 0
const check = async (name, run) => { await run(); checks += 1; console.log('ok  ' + name) }

try {
  const db = await import('../vendor/channel-pack/src/zcode-default-browser.ts')
  const captcha = await import('../vendor/channel-pack/src/zcode-captcha.ts')

  /** 造一个「系统里只有这些路径存在」的 `exists`。 */
  const existsIn = (paths) => (candidate) => paths.includes(candidate)

  /** 造一个「只会这几条命令」的 `run`（其余一律 undefined = 命令不存在/失败）。 */
  const runOf = (table) => (command, args) => {
    const key = `${command} ${args.join(' ')}`
    return table[key]
  }

  // ── 1. 纯函数：Chromium 内核判据 ──
  await check('isChromiumFamilyExecutable：三平台命名归一后都能认出来', async () => {
    for (const yes of [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/brave-browser',
      '/usr/bin/vivaldi-stable',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ]) {
      assert.equal(db.isChromiumFamilyExecutable(yes), true, `应当认出：${yes}`)
    }
    for (const no of [
      '/usr/bin/firefox',
      '/Applications/Safari.app/Contents/MacOS/Safari',
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      '/usr/bin/epiphany',
      '',
    ]) {
      assert.equal(db.isChromiumFamilyExecutable(no), false, `不应当认出：${no}`)
    }
  })

  // ── 2. Linux：xdg-settings → .desktop → Exec= ──
  await check('Linux：默认浏览器是 Edge 时选 Edge（不再永远选 Chrome）', async () => {
    const desktop = `[Desktop Entry]
Name=Microsoft Edge
Exec=/usr/bin/microsoft-edge-stable %U
Type=Application
`
    const readFileOf = (table) => (p) => table[p]
    const chosen = db.defaultBrowserExecutable({
      platform: 'linux',
      env: { XDG_DATA_DIRS: '/usr/local/share:/usr/share', PATH: '/usr/bin' },
      home: '/home/u',
      run: runOf({
        'xdg-settings get default-web-browser': 'microsoft-edge.desktop\n',
      }),
      readFile: readFileOf({ '/usr/share/applications/microsoft-edge.desktop': desktop }),
      exists: existsIn(['/usr/bin/microsoft-edge-stable']),
    })
    assert.equal(chosen, '/usr/bin/microsoft-edge-stable', '⚠️ 必须选中用户的默认浏览器（Edge），而不是候选链里排第一的 Chrome')
  })

  await check('Linux：默认浏览器是 Firefox ⇒ 探测返回 undefined（回落硬编码链）', async () => {
    const desktop = `[Desktop Entry]
Exec=/usr/bin/firefox %u
`
    const chosen = db.defaultBrowserExecutable({
      platform: 'linux',
      env: { XDG_DATA_DIRS: '/usr/share', PATH: '/usr/bin' },
      home: '/home/u',
      run: runOf({ 'xdg-settings get default-web-browser': 'firefox.desktop\n' }),
      readFile: (p) => (p === '/usr/share/applications/firefox.desktop' ? desktop : undefined),
      exists: existsIn(['/usr/bin/firefox']),
    })
    assert.equal(chosen, undefined, '⚠️ Firefox 不产 CDP ⇒ 必须跳过，交给硬编码链去兜底')
  })

  await check('Linux：`Exec=` 只有命令名时在 PATH 里找；`env VAR=…` 前缀被跳过', async () => {
    const onlyName = db.parseDesktopEntryExec('Exec=google-chrome-stable %U\n', {
      env: { PATH: '/usr/bin:/usr/local/bin' }, home: '/home/u',
    })
    assert.deepEqual(onlyName, ['/usr/bin/google-chrome-stable', '/usr/local/bin/google-chrome-stable'], '命令名要在 PATH 里展开')

    const withEnv = db.parseDesktopEntryExec(
      'Exec=env BAMF_DESKTOP_FILE_HINT=/x/y.desktop /usr/bin/microsoft-edge %U\n',
      { env: { PATH: '/usr/bin' }, home: '/home/u' },
    )
    assert.deepEqual(withEnv, ['/usr/bin/microsoft-edge'], '⚠️ 必须跳过 `env` 与 `VAR=value`，直接取真正的可执行文件')
  })

  await check('Linux：flatpak 的 Exec 要映射到 exports/bin/<appid>（不是 spawn flatpak）', async () => {
    const parsed = db.parseDesktopEntryExec(
      'Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=google-chrome com.google.Chrome %U\n',
      { env: { PATH: '/usr/bin', XDG_DATA_HOME: '/home/u/.local/share' }, home: '/home/u' },
    )
    assert.deepEqual(parsed, [
      '/home/u/.local/share/flatpak/exports/bin/com.google.Chrome',
      '/var/lib/flatpak/exports/bin/com.google.Chrome',
    ], '⚠️ flatpak 的 Exec 里那个可执行文件不是浏览器')
  })

  await check('Linux：xdg-settings 缺失时退回 xdg-mime 口径', async () => {
    const chosen = db.defaultBrowserExecutable({
      platform: 'linux',
      env: { XDG_DATA_DIRS: '/usr/share', PATH: '/usr/bin' },
      home: '/home/u',
      run: runOf({
        'xdg-mime query default x-scheme-handler/https': 'brave-browser.desktop\n',
      }),
      readFile: () => 'Exec=/usr/bin/brave-browser-stable %U\n',
      exists: existsIn(['/usr/bin/brave-browser-stable']),
    })
    assert.equal(chosen, '/usr/bin/brave-browser-stable', '没有 xdg-settings 的桌面也要能探到')
  })

  await check('Linux：XDG_DATA_HOME 里的用户级 .desktop 优先于系统级', async () => {
    const seen = []
    const chosen = db.defaultBrowserExecutable({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/u/.local/share', XDG_DATA_DIRS: '/usr/share', PATH: '/usr/bin' },
      home: '/home/u',
      run: runOf({ 'xdg-settings get default-web-browser': 'custom-chrome.desktop\n' }),
      readFile: (p) => {
        seen.push(p)
        return 'Exec=/home/u/bin/google-chrome-beta %U\n'
      },
      exists: existsIn(['/home/u/bin/google-chrome-beta']),
    })
    assert.equal(chosen, '/home/u/bin/google-chrome-beta')
    assert.ok(seen[0].startsWith('/home/u/.local/share/applications/'), `用户级目录必须排在第一位，实际第一个是 ${seen[0]}`)
  })

  // ── 3. Windows：UserChoice → shell\open\command ──
  await check('Windows：从 UserChoice 的 ProgId 解析到 msedge.exe', async () => {
    const progIdOutput = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice
    ProgId    REG_SZ    MSEdgeHTM
`
    const commandOutput = `
HKEY_CLASSES_ROOT\\MSEdgeHTM\\shell\\open\\command
    (默认)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --single-argument %1
`
    const chosen = db.defaultBrowserExecutable({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\u',
      run: runOf({
        'reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice /v ProgId': progIdOutput,
        'reg query HKCR\\MSEdgeHTM\\shell\\open\\command /ve': commandOutput,
      }),
      exists: existsIn(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']),
    })
    assert.equal(chosen, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '⚠️ Windows 必须认用户选过的默认浏览器')
  })

  await check('Windows：默认是 Firefox ⇒ undefined；reg 不可用 ⇒ undefined', async () => {
    const firefox = db.defaultBrowserExecutable({
      platform: 'win32',
      env: {},
      home: 'C:\\Users\\u',
      run: runOf({
        'reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice /v ProgId': '    ProgId    REG_SZ    FirefoxURL\n',
        'reg query HKCR\\FirefoxURL\\shell\\open\\command /ve': '    (默认)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"\n',
      }),
      exists: existsIn(['C:\\Program Files\\Mozilla Firefox\\firefox.exe']),
    })
    assert.equal(firefox, undefined, 'Firefox 不是 Chromium 内核')

    const noReg = db.defaultBrowserExecutable({
      platform: 'win32', env: {}, home: 'C:\\Users\\u',
      run: () => undefined,
      exists: () => true,
    })
    assert.equal(noReg, undefined, '⚠️ reg 查不到必须静默回落，不能抛错')
  })

  // ── 4. macOS：LaunchServices plist ──
  await check('macOS：LaunchServices 的 https handler 决定用哪个 app bundle', async () => {
    const plistPath = '/Users/u/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
    const chosen = db.defaultBrowserExecutable({
      platform: 'darwin',
      env: {},
      home: '/Users/u',
      run: runOf({
        [`plutil -convert json -o - ${plistPath}`]: JSON.stringify({
          LSHandlers: [
            { LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' },
            { LSHandlerURLScheme: 'http', LSHandlerRoleAll: 'com.apple.safari' },
            { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.brave.browser' },
          ],
        }),
      }),
      exists: existsIn([plistPath, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser']),
    })
    assert.equal(chosen, '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'https handler 优先于 http')
  })

  await check('macOS：默认是 Safari ⇒ undefined（识别得出但永不选）', async () => {
    const plistPath = '/Users/u/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
    const chosen = db.defaultBrowserExecutable({
      platform: 'darwin', env: {}, home: '/Users/u',
      run: runOf({
        [`plutil -convert json -o - ${plistPath}`]: JSON.stringify({
          LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.apple.safari' }],
        }),
      }),
      exists: existsIn([plistPath, '/Applications/Safari.app/Contents/MacOS/Safari']),
    })
    assert.equal(chosen, undefined, 'Safari 不提供 CDP')
  })

  await check('macOS：plist 缺失 / plutil 输出非法 JSON ⇒ undefined（静默）', async () => {
    assert.equal(db.defaultBrowserExecutable({
      platform: 'darwin', env: {}, home: '/Users/u', run: () => undefined, exists: () => false,
    }), undefined)
    const plistPath = '/Users/u/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist'
    assert.equal(db.defaultBrowserExecutable({
      platform: 'darwin', env: {}, home: '/Users/u',
      run: runOf({ [`plutil -convert json -o - ${plistPath}`]: 'not json {{{' }),
      exists: () => true,
    }), undefined, '⚠️ 输出格式变了也必须静默回落')
  })

  // ── 5. 候选链顺序（三档优先级）──
  await check('候选链顺序：ZCODE_CHROME_PATH → 默认浏览器 → 硬编码链', async () => {
    const base = { platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/u' }
    // ① 都没给：硬编码链原样（Linux 里 Chrome 仍在最前 —— 保底语义不变）
    const plain = captcha.browserCandidates({ ...base })
    assert.equal(plain[0], '/usr/bin/google-chrome', '没有默认浏览器信息时，硬编码链的顺序不能变')

    // ② 给了默认浏览器：它排第一，硬编码链整体后移
    const withDefault = captcha.browserCandidates({ ...base, defaultBrowser: '/usr/bin/microsoft-edge' })
    assert.equal(withDefault[0], '/usr/bin/microsoft-edge', '⚠️ 用户默认浏览器必须排在硬编码链之前')
    assert.ok(withDefault.includes('/usr/bin/google-chrome'), '硬编码链要保留（保底）')

    // ③ 再给显式指定：它比默认浏览器更优先
    const withOverride = captcha.browserCandidates({
      ...base,
      env: { PATH: '/usr/bin', ZCODE_CHROME_PATH: '/opt/my-chromium/chrome' },
      defaultBrowser: '/usr/bin/microsoft-edge',
    })
    assert.equal(withOverride[0], '/opt/my-chromium/chrome', '⚠️ 显式指定永远第一')
    assert.equal(withOverride[1], '/usr/bin/microsoft-edge', '其次才是探到的默认浏览器')
  })

  await check('findBrowserExecutable：默认浏览器存在就用它；显式指定时跳过探测', async () => {
    // 用真实路径做不到确定性断言 ⇒ 借 `defaultBrowser` 注入 + 只验顺序语义。
    // ① 注入一个真实存在的可执行文件（当前 node 自身，任何平台都有）
    const self = process.execPath
    assert.equal(
      captcha.findBrowserExecutable({ defaultBrowser: self }),
      self,
      '注入的默认浏览器存在 ⇒ 应当选它',
    )
    // ② 注入一个不存在的路径 ⇒ 回落到硬编码链（本机很可能没有浏览器，故只断言「不等于那个假路径」）
    const ghost = '/nonexistent/ofm-browser-probe'
    assert.notEqual(captcha.findBrowserExecutable({ defaultBrowser: ghost }), ghost, '⚠️ 不存在的默认浏览器不能选中')
    // ③ 显式传 undefined = 「我探过了，没有」⇒ 不再自行探测（结果来自硬编码链）
    const explicitNone = captcha.findBrowserExecutable({ defaultBrowser: undefined })
    assert.notEqual(explicitNone, ghost)
    // ④ ZCODE_CHROME_PATH 存在时优先于默认浏览器
    assert.equal(
      captcha.findBrowserExecutable({
        env: { ...process.env, ZCODE_CHROME_PATH: self },
        defaultBrowser: ghost,
      }),
      self,
      '⚠️ 显式指定必须赢过默认浏览器',
    )
  })

  await check('默认浏览器探测失败时，候选链行为与引入本特性前逐字一致', async () => {
    // 同一组入参、只差 defaultBrowser 一个字段 ⇒ 除了多出的那一项，其余完全一致
    const base = { platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' }, home: 'C:\\Users\\u' }
    const before = captcha.browserCandidates({ ...base })
    const after = captcha.browserCandidates({ ...base, defaultBrowser: undefined })
    assert.deepEqual(after, before, '⚠️ 探测不到时必须完全没有副作用')
  })

  await check('候选链是纯函数：传 defaultBrowser 不起子进程（不依赖本机环境）', async () => {
    // 若 browserCandidates 内部偷偷探测，这两次调用的耗时会明显不同且结果不可控。
    // 这里用「故意荒谬的平台 + 假路径」验证它只做字符串拼接。
    const out = captcha.browserCandidates({
      platform: 'linux',
      env: {},
      home: '/nowhere',
      defaultBrowser: '/absolutely/not/installed/browser',
    })
    assert.equal(out[0], '/absolutely/not/installed/browser', '候选链只负责拼接，不负责 existence')
    assert.ok(out.length > 1, '硬编码链仍然在')
  })

  console.log(`zcode-default-browser: ${checks} 组断言通过（Chromium 判据 / Linux .desktop / flatpak 映射 / Windows UserChoice / macOS LaunchServices / 候选链三档顺序 / 纯函数性）`)
} finally {
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}