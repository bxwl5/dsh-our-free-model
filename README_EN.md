<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

<sub>Private snapshot 2.5.7-priv.2 · EAC co-pay and the announcement/update/sponsor/aggregation features have been removed</sub>

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.2--0.2.0-2f6f4f?style=flat-square">

</div>

> Install it and it works: no login, no sign-up, no API key.
> A pure plugin mount — no core changes, no build step, zero dependencies.
>
> Original project: https://github.com/Ebony-Vinyl/dsh-our-free-model

---

## Install

**Send this repository link to your AI (the assistant inside dsh) and let it install for you.**

Repository:

```
https://github.com/bxwl5/dsh-our-free-model
```

> Open Add plugin in DSH settings and paste the repository address.

You can just say:

> Install this plugin for me: https://github.com/bxwl5/dsh-our-free-model

> The same-named package on npm is **not** published by this repository — do not install from npm.

## Usage

After restarting, the composer's model picker gains an **Our Free Model** group. Pick a model and go.

## Docker (standalone service)

You can skip DSH entirely and run the standalone build in a container. The image is
built by GitHub Actions and pushed to GHCR for both `linux/amd64` and `linux/arm64`.

### For LAN use / local use

The whole point of a container is letting your phone, tablet, or another computer use it,
so switch the relay on explicitly:

```bash
docker run -d --name ofm \
  --network host \
  -v ofm-data:/data \
  -e TZ=Asia/Shanghai \
  -e OFM_PASSWORD=pick-your-own-password \
  --restart unless-stopped \
  ghcr.io/bxwl5/dsh-our-free-model:latest \
  --lan --lan-port 9981 --lan-panel
```

Open `http://<host-ip>:9981/` and enter the `OFM_PASSWORD` you set at launch
(**leave it unset and there is no auth at all** — anyone can get in). The key for calling
models is on the **API access** page inside the dashboard; you don't configure it at launch.


## Channels

**Keyless lanes (2)** — anonymous free lane (OpenCode) and the Kilo free pool. Neither needs an account.

**Account channels (15)**, added under Channels in settings:

| Channel | Sign-in | Chat |
|---|---|---|
| CodeArts / CodeBuddy / WorkBuddy | browser | ✅ |
| Qoder / Qoder CN / TRAE / Cline / Antigravity (formerly Gemini) | browser | ✅ |
| Loomy / Raccoon / MiniMax Code / ZCode | browser | ✅ |
| Command Code | browser (auto callback) | ✅ |
| OfficeAce | browser (polling) | ✅ |
| AutoClaw (CN) | phone + SMS code | ✅ |

MIT, see [LICENSE](LICENSE). This project has no affiliation with, and no endorsement from, any model provider.
