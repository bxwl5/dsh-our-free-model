<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

<sub>私有快照 2.5.7-priv.2 · 已移除 EAC 协付、公告/升级/赞助/聚合功能</sub>

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">

</div>

> 装上就能用：无需登录、注册、填 API Key。纯插件挂载，不改内核、无构建步骤、零依赖。
>
> 原项目地址：https://github.com/Ebony-Vinyl/dsh-our-free-model

---

## 安装

**把本仓库链接发给你的 AI（dsh 里的助手），让它帮你装。**

仓库地址：

```
https://github.com/bxwl5/dsh-our-free-model
```

> 打开 DSH 设置的「添加插件」，输入上面的仓库地址

可以直接这样对 AI 说：

> 帮我安装这个插件：https://github.com/bxwl5/dsh-our-free-model

> npm 上的同名包不是本仓库发布的，请勿从 npm 安装。

## 使用

装上后重启，输入框的模型选择器里会多出 **Our Free Model** 分组，直接选即可。

## Docker（独立服务）

也可以**完全不用 DSH**，直接把独立版跑在容器里。镜像由 GitHub Actions 构建并推送到
GHCR，多架构 `linux/amd64` + `linux/arm64`。


### 给局域网用/本机使用

容器部署的价值就是让手机 / 平板 / 另一台电脑也能用，所以要显式开中继：

```bash
docker run -d --name ofm \
  --network host \
  -v ofm-data:/data \
  -e TZ=Asia/Shanghai \
  -e OFM_PASSWORD=换成你自己的密码 \
  --restart unless-stopped \
  ghcr.io/bxwl5/dsh-our-free-model:latest \
  --lan --lan-port 9981 --lan-panel
```

打开 `http://<宿主机IP>:9981/` 即可（端口按你写的来）。这套组合给出两组凭据：

| 凭据 | 用途 |
|---|---|
| **面板密码**（`OFM_PASSWORD`） | 登录面板改配置。**不设就完全免认证**，谁都能进 |
⚠️ 设了密码后，**进入控制面板**需要认证后进入控制台；点「退出」回到密码框。


## 渠道

**免密车道（2 个）**：匿名免费车道（OpenCode）、Kilo 免费池。都不需要账号。

**账号渠道（15 个）**，在「渠道接入」页添加：

| 渠道 | 登录方式 | 对话 |
|---|---|---|
| CodeArts / CodeBuddy / WorkBuddy | 浏览器授权 | ✅ |
| Qoder / Qoder 中国版 / TRAE / Cline / Antigravity（原 Gemini） | 浏览器授权 | ✅ |
| Loomy / Raccoon / MiniMax Code / ZCode | 浏览器授权 | ✅ |
| Command Code | 浏览器授权（自动回调） | ✅ |
| OfficeAce 果办 | 浏览器授权（轮询授权码） | ✅ |
| AutoClaw（国内） | 手机号 + 短信验证码（本地弹窗页） | ✅ |

MIT，见 [LICENSE](LICENSE)。本项目与任何模型提供方无隶属或背书关系。
