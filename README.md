<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

<sub>私有快照 2.5.7-priv.1 · 已移除 EAC 协付、公告/升级/赞助/聚合功能</sub>

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">

</div>

> 装上就能用：无需登录、注册、填 API Key。纯插件挂载，不改内核、无构建步骤、零依赖。

---

## 安装

**把本仓库链接发给你的 AI（dsh 里的助手），让它帮你装。**

仓库地址：

```
https://github.com/bxwl5/dsh-our-free-model
```
> 打开DSH设置的添加插件，输入仓库地址

可以直接这样对 AI 说：

> 帮我安装这个插件：https://github.com/bxwl5/dsh-our-free-model

手工安装时，在 profile 的 `vendor/` 下放入本仓库 tarball，然后在 `package.json` 的 dependencies 中加入：

```
"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"
```

并在 `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`。

> npm 上的同名包不是本仓库发布的，请勿从 npm 安装。

## 使用

装上后重启，输入框的模型选择器里会多出 **Our Free Model** 分组，直接选即可。

- **思考强度**——模型菜单里的 Effort。能关思考的模型给开关，其余给 Light / Balanced / Deep 三档。
- **本地网关**——设置 → Our Free Model → 本地转发，启用后本机其它工具即可通过 base URL + Key 调用，兼容 OpenAI 与 Anthropic 接口。
- **局域网访问**——同一面板可开启，供同网段设备调用（默认关闭，需要单独的 Key）。
- **换网络后**——点一下"重新探测可用性"，可用模型会按当前出口重新分组。

设置页共七部分：免费模型、渠道接入、省 Token、路由、数据看板、运行日志、网关设置。

## 渠道

**免密车道（2 个）**：匿名免费车道（OpenCode）、Kilo 免费池。都不需要账号。

**账号渠道（22 个）**，在「渠道接入」页添加：

| 渠道 | 登录方式 | 对话 |
|---|---|---|
| CodeArts / CodeBuddy / WorkBuddy / LobsterAI | 浏览器授权 | ✅ |
| Qoder / Qoder 中国版 / TRAE / Cline / Gemini | 浏览器授权 | ✅ |
| Loomy / Raccoon / MiniMax Code / ZCode | 浏览器授权 | ✅ |
| Command Code | 浏览器授权（自动回调） | ✅ |
| OfficeAce 果办 | 浏览器授权（轮询授权码） | ✅ |
| Accio / Accio 国内版 | 浏览器授权 | ✅ |
| OrcaTerm | 粘贴 Cookie（`ot_session`） | ✅ |
| KukuAI | 粘贴 Cookie（`BDUSS`） | ✅ |
| MonkeyCode | 粘贴 Cookie（`nebula_session`） | ✅ |
| AutoClaw / AutoClaw 国际版 | 粘贴令牌 | ✅ |

**关于粘贴型渠道**：这些上游没有可脚本化的授权流程，需要先在官方站点登录，再从开发者工具复制 Cookie 或令牌粘贴进来。

**关于 AutoClaw**：它的 OAuth 强制要求阿里云验证码 SDK（`AliyunCaptcha.js`，场景 `sq51tr`），插件内无法自动完成，故用粘贴令牌。

**看不到某个渠道的模型？** 模型选择器只列**已登录渠道**的模型：没有可用账号的渠道会整组隐藏，
免得列出一堆点了不能用的条目。想先看看某渠道有哪些模型，给它加一个账号即可；只想看不想登录时，
把环境变量 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 设为 `0`，未登录渠道也会列出其静态模型表
（点进去仍需登录才能用）。各渠道支持哪种登录方式见
[docs/channel-login-methods.md](docs/channel-login-methods.md)。

MIT，见 [LICENSE](LICENSE)。本项目与任何模型提供方无隶属或背书关系。
