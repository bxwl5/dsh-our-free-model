/**
 * Command Code 认证服务。
 *
 * 与 ClineAuth 的最大差别：**没有 refresh 流程**。
 * Command Code 用的是单个长期 API Key，不会过期，也就没有
 * refresh_token 轮换、没有 RefreshScheduler、没有「续期失败」这类状态。
 * 失效只有一种形态：`/alpha/whoami` 返回 401 → 让用户重新登录。
 *
 * 因此本服务刻意保持薄：登录（起回调服务器）、登出（删凭据）、
 * 状态查询。所有网络动作都在 `commandcode-auth.ts` 的纯函数里。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'

import {
  type CommandCodeProduct,
} from './commandcode-product.js'
import { COMMANDCODE } from './commandcode-product.js'
import {
  type CommandCodeCredential,
  isCredentialUsable,
} from './commandcode.js'
import {
  readCredits,
  type CommandCodeCreditsSnapshot,
} from './commandcode-credits.js'
import {
  resolveCredential,
  runCommandCodeLogin,
  startCommandCodeLogin,
  validateApiKey,
  type OpenBrowser,
  type StartedCommandCodeLogin,
} from './commandcode-auth.js'

/** 认证服务依赖。 */
export interface CommandCodeAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link COMMANDCODE}。 */
  product?: CommandCodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `commandcodeAuth`）。 */
  serviceName?: string
  /** 打开浏览器的实现（默认交给宿主）。 */
  openBrowser?: OpenBrowser
}

/** 服务状态（供设置页展示）。 */
export interface CommandCodeStatus {
  /** 是否有可用凭据。 */
  configured: boolean
  /** 账号 id（`/alpha/whoami` 的 userId）。 */
  accountId?: string
  /** 昵称。 */
  nickname?: string
  /** Key 名称。 */
  keyName?: string
  /** 额度快照。 */
  credits?: CommandCodeCreditsSnapshot
  /** 凭据 ref 名称。 */
  credentialRefName: string
}

/**
 * Command Code 认证服务。
 *
 * 服务名默认 `commandcodeAuth`，注册后可用 `ctx.commandcodeAuth` 访问。
 */
export class CommandCodeAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: CommandCodeProduct
  /** 本实例默认读写的凭据 ref 名称（`COMMANDCODE_API_KEY`）。 */
  readonly credentialRefName: string
  /** 进行中的登录流程（单飞：并发调用复用同一个）。 */
  private pending: StartedCommandCodeLogin | undefined
  private readonly fetcher: typeof fetch

  constructor(ctx: Context, private readonly options: CommandCodeAuthOptions = {}) {
    const product = options.product ?? COMMANDCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
    this.fetcher = options.fetcher ?? fetch
  }

  /**
   * 读取当前凭据。
   *
   * 返回 `undefined` 表示未登录或凭据损坏 —— 不抛错，因为「未登录」
   * 是这个服务最正常的状态之一。
   */
  async credential(): Promise<CommandCodeCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (resolved === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(resolved.value)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      const credential = parsed as CommandCodeCredential
      return isCredentialUsable(credential) ? credential : undefined
    } catch {
      return undefined
    }
  }

  /** 写入凭据（覆盖）。 */
  async save(credential: CommandCodeCredential): Promise<void> {
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(credential))
  }

  /** 删除凭据（登出）。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /**
   * 启动登录并返回授权 URL（**不等待**用户完成）。
   *
   * 单飞：已有进行中的登录时直接返回那一个，不会起第二个回调服务器。
   * 调用方负责把 `loginUrl` 展示给用户（或交给浏览器打开），
   * 然后 await `result`。
   */
  async beginLogin(): Promise<StartedCommandCodeLogin> {
    if (this.pending !== undefined) return this.pending
    const started = await startCommandCodeLogin({
      product: this.product,
      fetcher: this.fetcher,
      openBrowser: this.options.openBrowser,
    })
    this.pending = started
    // 结果落定后清掉 pending，允许下一次登录。
    void started.result.catch(() => {}).finally(() => {
      if (this.pending === started) this.pending = undefined
    })
    return started
  }

  /**
   * 跑完整个登录流程（打开浏览器 + 等待 + 验证 + 落盘）。
   *
   * 成功后自动写入凭据；失败抛错。
   */
  async login(): Promise<CommandCodeCredential> {
    const credential = await runCommandCodeLogin({
      product: this.product,
      fetcher: this.fetcher,
      openBrowser: this.options.openBrowser,
    })
    await this.save(credential)
    return credential
  }

  /**
   * 用给定 Key 直接登录（不走浏览器）。
   *
   * 供「手动粘贴 Key」与自动化测试使用。会先调 `/alpha/whoami` 验证。
   */
  async loginWithKey(apiKey: string): Promise<CommandCodeCredential> {
    const probe = await validateApiKey(this.fetcher, this.product, apiKey)
    if (!probe.ok) {
      const reason = probe.reason === 'invalid_key'
        ? 'API Key 无效（whoami 返回 401）'
        : probe.reason === 'server_error'
          ? `上游服务端错误（HTTP ${probe.status ?? '?'}）`
          : '网络不可达'
      throw new Error(`Command Code：${reason}`)
    }
    const credential = await resolveCredential(this.fetcher, this.product, apiKey)
    await this.save(credential)
    return credential
  }

  /** 查询状态（含额度）。 */
  async status(): Promise<CommandCodeStatus> {
    const credential = await this.credential()
    if (credential === undefined) {
      return { configured: false, credentialRefName: this.credentialRefName }
    }
    const credits = await readCredits(this.fetcher, this.product, credential)
    return {
      configured: true,
      ...(credential.account_id === undefined ? {} : { accountId: credential.account_id }),
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
      ...(credential.key_name === undefined ? {} : { keyName: credential.key_name }),
      ...(credits === undefined ? {} : { credits }),
      credentialRefName: this.credentialRefName,
    }
  }
}
