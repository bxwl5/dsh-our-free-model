/**
 * OpenCode 的 `<env>` 环境块：**匿名槽**发请求前的注入。
 *
 * ## ⚠️ 为什么必须有这块（不是可选的美化）
 *
 * Zen 的免费层只有在**某条 system 消息**里带着 OpenCode 自己的环境块时，
 * 才把请求当「OpenCode 本尊」服务：`<env>` + `Working directory: ` + `</env>`，
 * 这是每条 OpenCode 提示词的结尾。没有它的请求（别的 agent 自己的提示词，
 * Kimi Work 的、WorkBuddy 的）只能拿到每天很小的一份额度，然后就是
 * `429 FreeUsageLimitError`（"Free models work in OpenCode"）直到 UTC 零点。
 *
 * ## ⚠️⚠️ 「逐字」与「真实目录」两条都是硬约束
 *
 * - 块文本必须与 OpenCode 2.2.5 自己发的**逐字一致**（含最后那条 temp 行）。
 *   上游会按固定文本认指纹：改一个字（或漏掉一行）就是「另一个客户端」。
 * - `Working directory:` 必须是**真实绝对路径**。曾经有过一版写了字面量
 *   `Working directory: unknown`，2026-10-29 起 Zen 对那一行**立刻** 429 ——
 *   只有本插件会发的固定文本就是它的指纹。拿不到路径就写 home，
 *   **绝不写占位**。
 *
 * ## ⚠️ 判据只认 OpenCode 自己的块
 *
 * `<env>` 之后必须是**两个空格** + `Working directory: `。别的 agent 的块
 * （Claude Code 到 2.1.100 左右是 `<env>\nWorking directory: …`，无缩进）
 * 不算「已有」：把它当成 OpenCode 的块，请求就会不带 OpenCode 的块出门，
 * 结果是同一个出口 IP 下 Pi（本来就没有块，于是被补上）能用、Claude Code 429。
 * 所以别人的块**保留**，OpenCode 的块**跟在后面**。
 *
 * ## 注入位置：追加，不锚到最前面
 *
 * 追加到该请求**最后一条 system 消息**的末尾（没有 system 消息才在 messages
 * 前面放一条）。把块插到最前面会让整段前缀变一次，前缀缓存（服务端按消息
 * 前缀命中）全部失效；追加则只在尾部增长，下一轮仍然命中。
 *
 * 参考实现：magpie 的 `provider.mjs`（`HAS_ENVIRONMENT` / `environment()` /
 * `withEnvironment()` / `addEnvironment()`，2026-11-01 实测通过）。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * OpenCode 自己的 env 块判据（与 magpie 同款正则）。
 *
 * ⚠️ 两个空格是判据的核心：`<env>` 后紧跟 `Working directory: ` 的是 Claude
 * Code 等别的 agent 的块，**不算已有**（见模块头）。
 */
export const HAS_ENVIRONMENT = /<env>\r?\n {2}Working directory: [^\n]*\n[\s\S]*?<\/env>/

/** 这些 role 的消息按「系统提示」处理（与 magpie 的 `SYSTEM_ROLES` 一致）。 */
const SYSTEM_ROLES = new Set(['system', 'developer'])

/** 一条可以是纯字符串、也可以是 text part 数组的消息内容 → 纯文本。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

/** 一条消息的 role（非字符串一律空串）。 */
function roleOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const role = (message as { role?: unknown }).role
  return typeof role === 'string' ? role : ''
}

/**
 * 绝对路径的形状（与 magpie 一致）：`/…`、`~/…`、`C:\…` / `C:/…`、`\\server\…`。
 *
 * ⚠️ 排除空白、反引号、引号与尖括号：这些是包裹路径的定界符，不是路径本身。
 */
const ABSOLUTE = String.raw`((?:~?/|[A-Za-z]:[\\/]|\\\\)[^\s\x60'"<>]*)`

/**
 * agent 各自报工作目录的三种写法（与 magpie 的 `STATED_DIRECTORY` 同款）：
 *
 * - Codex 的 `<cwd>/path</cwd>`；
 * - Claude Code 等的 `Working directory: /path`；
 * - Kimi 的 "The current working directory is \`/path\`"（被第二条正则覆盖）。
 */
const STATED_DIRECTORY = [
  new RegExp(String.raw`<cwd>\s*${ABSOLUTE}\s*</cwd>`),
  new RegExp(String.raw`working directory(?: is)?:?\s+\x60?${ABSOLUTE}`, 'i'),
]

/** 该 UA/块是否已经带 OpenCode 自己的 env 块。 */
export function hasOpencodeEnvironment(text: string | undefined): boolean {
  return typeof text === 'string' && HAS_ENVIRONMENT.test(text)
}

/**
 * 请求里「agent 自己声明的」工作目录，取不到返回 `undefined`。
 *
 * 搜索顺序（与 magpie 一致）：系统提示（顶层 `system` 与 system/developer
 * 消息）→ 用户消息。用户消息按出现顺序找，先命中的先用。
 */
export function statedDirectory(payload: Record<string, unknown>): string | undefined {
  const texts: string[] = []
  const system = payload.system
  if (typeof system === 'string' && system.length > 0) texts.push(system)
  const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
  for (const message of messages) {
    if (SYSTEM_ROLES.has(roleOf(message))) {
      texts.push(textOfContent((message as { content?: unknown }).content))
    }
  }
  for (const message of messages) {
    if (roleOf(message) === 'user') texts.push(textOfContent((message as { content?: unknown }).content))
  }
  for (const text of texts) {
    if (text.length === 0) continue
    for (const pattern of STATED_DIRECTORY) {
      // ⚠️ 去掉路径末尾的标点：`Working directory: /a/b.` 里的句号不属于路径。
      const found = pattern.exec(text)?.[1]?.replace(/[.,;:)\]]+$/, '')
      // ⚠️ `/` 与 `~/` 是「根」而不是工作目录，等同于没写。
      if (found !== undefined && found !== '' && found !== '/' && found !== '~/') return found
    }
  }
  return undefined
}

/**
 * OpenCode 的项目目录判定（`packages/core/src/project.ts` 的等价物）。
 *
 * 从 `directory` 向上找最近的 `.git`：它所在的目录就是工作区根；有 `origin`
 * （否则取列出的第一个）remote 就带上归一化后的 `host/path`。
 *
 * ⚠️ 不走 `git` 子进程：一次请求一次 git 是负担，且用户机器可能没装 git。
 */
function repository(directory: string): { root: string; remote?: string } | undefined {
  let dir = directory
  for (;;) {
    const dotGit = join(dir, '.git')
    let stat: ReturnType<typeof statSync> | undefined
    try {
      stat = statSync(dotGit)
    } catch {
      stat = undefined
    }
    if (stat !== undefined) {
      try {
        // `.git` 可能是文件（worktree / submodule）：里面的 `gitdir:` 指向真正的 git 目录。
        let common = dotGit
        if (stat.isFile()) {
          const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
          if (gitdir === undefined) return undefined
          const own = resolve(dir, gitdir)
          try {
            common = resolve(own, readFileSync(join(own, 'commondir'), 'utf8').trim())
          } catch {
            common = own
          }
        }
        const config = readFileSync(join(common, 'config'), 'utf8')
        const remotes = [...config.matchAll(/^\s*\[remote\s+"([^"]+)"\]([^[]*)/gm)].map((match) => ({
          name: match[1],
          url: /^\s*url\s*=\s*(.+)$/m.exec(match[2] ?? '')?.[1],
        }))
        const remote = remotes.find((candidate) => candidate.name === 'origin') ?? remotes[0]
        const remoteUrl = remote?.url
        if (remoteUrl === undefined) return { root: dir }
        const normalized = remotePath(remoteUrl)
        return normalized === undefined ? { root: dir } : { root: dir, remote: normalized }
      } catch {
        return { root: dir }
      }
    }
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** remote URL → `host/path`（与 OpenCode 的归一化一致）。 */
function remotePath(value: string): string | undefined {
  const input = value.trim()
  if (input === '') return undefined
  const parts = (host: string, name: string): string | undefined => {
    const path = name.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '')
    return host !== '' && path !== '' ? `${host.toLowerCase()}/${path}` : undefined
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      const url = new URL(input)
      return url.protocol === 'file:' ? undefined : parts(url.hostname, url.pathname)
    } catch {
      return undefined
    }
  }
  const scp = /^([^@/:]+@)?([^/:]+):(.+)$/.exec(input)
  return scp === null ? undefined : parts(scp[2] ?? '', scp[3] ?? '')
}

/** 解析 `~` 并尽量取真实路径（失败时用原文，绝不因此不出块）。 */
function localDirectory(directory: string, home: string): string {
  const dir = directory.replace(/^~(?=\/|$)/, home)
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/**
 * OpenCode 的临时目录：系统临时目录下的 `opencode`（按系统的解析结果）。
 *
 * 块里最后一行会点名它（"Prefer … over generic system temporary directories"），
 * 所以它必须与真实 CLI 的取值同形，不能手写 `/tmp`。
 */
export function opencodeTmp(): string {
  try {
    return join(realpathSync(tmpdir()), 'opencode')
  } catch {
    return join(tmpdir(), 'opencode')
  }
}

export interface OpencodeEnvironmentOptions {
  /** 用户家目录（缺省 `os.homedir()`；单测注入以便断言）。 */
  home?: string
  /** 平台名（缺省 `process.platform`；单测注入以便跨机断言）。 */
  platform?: string
  /** OpenCode 临时目录（缺省 {@link opencodeTmp}）。 */
  tmp?: string
}

/**
 * OpenCode 的 env 块文本（**逐字**，见模块头）。
 *
 * @param directory 已经解析好的**绝对**目录（调用方保证不是占位串）。
 */
export function buildOpencodeEnvironment(directory: string, options: OpencodeEnvironmentOptions = {}): string {
  const home = options.home ?? homedir()
  const local = localDirectory(directory, home)
  const repo = repository(local)
  return [
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${repo !== undefined && repo.root !== local ? repo.root : directory}`,
    `  Is directory a git repo: ${repo === undefined ? 'no' : 'yes'}`,
    `  Platform: ${options.platform ?? process.platform}`,
    `  Prefer ${options.tmp ?? opencodeTmp()} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    '</env>',
  ].join('\n')
}

/** 把块追加到一条消息的 content 上（字符串直接续写，数组续一个 text part）。 */
function withEnvironment(content: unknown, block: string): unknown {
  if (typeof content === 'string') return content.length > 0 ? `${content}\n\n${block}` : block
  if (Array.isArray(content)) return [...content, { type: 'text', text: block }]
  return block
}

export interface AddOpencodeEnvironmentOptions extends OpencodeEnvironmentOptions {
  /**
   * 该请求走的是哪类槽。
   *
   * ⚠️ **只有匿名槽注入**：账号槽带真 key，上游按认证通道服务，块是多余的
   * 伪装；而「账号槽请求逐字节不变」是可断言的硬约束（少一层改动就少一处
   * 影响真实付费请求的地方）。
   */
  slotKind: 'account' | 'anonymous'
}

/**
 * 发请求前调用：匿名槽且请求里没有 OpenCode 的 env 块时，把块追加进去。
 *
 * @returns 是否真的注入了（便于日志/单测断言）。
 *
 * ⚠️ 返回 `false` 时**必须一个字节都没动**（账号槽 / 已有块）。
 */
export function addOpencodeEnvironment(
  payload: Record<string, unknown>,
  options: AddOpencodeEnvironmentOptions,
): boolean {
  if (options.slotKind !== 'anonymous') return false

  const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
  // 判据覆盖三处：顶层 `system`（本渠道的系统提示载体）、system/developer 消息。
  if (hasOpencodeEnvironment(typeof payload.system === 'string' ? payload.system : undefined)) return false
  if (messages.some((message) => SYSTEM_ROLES.has(roleOf(message))
    && hasOpencodeEnvironment(textOfContent((message as { content?: unknown }).content)))) return false

  const home = options.home ?? homedir()
  // ⚠️ 拿不到 agent 声明的目录就写 home：**绝不写 `unknown` 之类的占位**
  // （上游对那行固定文本立刻 429，见模块头）。
  // ⚠️ `~/x` 也要展开成**绝对**路径：块里那一行是「真实目录」的指纹，
  // 不是「用户写法」的复述。
  const stated = statedDirectory(payload)
  const directory = stated === undefined ? home : stated.replace(/^~(?=\/|$)/, home)
  const envOptions: OpencodeEnvironmentOptions = { home }
  if (options.platform !== undefined) envOptions.platform = options.platform
  if (options.tmp !== undefined) envOptions.tmp = options.tmp
  const block = buildOpencodeEnvironment(directory, envOptions)

  // 追加到**最后一条** system 消息：锚到最前面会让前缀缓存整体失效。
  let target: Record<string, unknown> | undefined
  for (const message of messages) {
    if (roleOf(message) === 'system') target = message as Record<string, unknown>
  }
  if (target !== undefined) {
    target.content = withEnvironment(target.content, block)
    return true
  }
  // 一条 system 消息都没有（本渠道的系统提示通常走顶层 `system` 字段）：
  // 在 messages 前面放一条 ONLY-块 的 system 消息，语义与 magpie 的
  // 「one is put first when the agent sent none」一致。
  payload.messages = [{ role: 'system', content: block }, ...messages]
  return true
}