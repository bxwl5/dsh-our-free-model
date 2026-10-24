<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">

</div>

> Install it and it works: no login, no sign-up, no API key.
> A pure plugin mount — no core changes, no build step, zero dependencies.

---

## Install

**Send this repository link to your AI (the assistant inside dsh) and let it install for you.**

Repository:

```
https://github.com/bxwl5/dsh-our-free-model
```

You can just say:

> Install this plugin for me: https://github.com/bxwl5/dsh-our-free-model
> Use the local source directory method, target my `web` profile, restart the host when done.

What the AI does (or you can do by hand):

1. Clone or unpack this repository anywhere locally.
2. In that directory run `npm pack --ignore-scripts --pack-destination "<DSH_HOME>/profiles/<profile>/vendor"` to produce the tarball.
3. Add to the profile's `package.json` dependencies:

```
"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"
```

4. Append `"dsh-our-free-model"` to `dsh.profile.bundles`.
5. Restart the host.

The AI can also install straight from the command line:

```
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

> The same-named package on npm is **not** published by this repository — do not install from npm.

## Usage

After restarting, the composer's model picker gains an **Our Free Model** group. Pick a model and go.

- **Thinking effort** — the Effort control in the model menu: an on/off switch where the model supports it, otherwise Light / Balanced / Deep.
- **Local gateway** — Settings → Our Free Model → Local forward. Enable it and other local tools can call these models through a base URL plus a key, over OpenAI- and Anthropic-compatible endpoints.
- **LAN access** — the same panel exposes a relay for other devices on your network (off by default, uses a separate key).
- **After changing networks** — hit "Re-probe availability" and the groups re-measure from your current egress.

The settings page has seven parts: free models, channels, token savers, routing, dashboard, request log and gateway.

## Channels

**Keyless lanes (2)** — anonymous free lane (OpenCode) and the Kilo free pool. Neither needs an account.

**Account channels (22)**, added under Channels in settings:

| Channel | Sign-in | Chat |
|---|---|---|
| CodeArts / CodeBuddy / WorkBuddy / LobsterAI | browser | ✅ |
| Qoder / Qoder CN / TRAE / Cline / Gemini | browser | ✅ |
| Loomy / Raccoon / MiniMax Code / ZCode | browser | ✅ |
| Command Code | browser (auto callback) | ✅ |
| OfficeAce | browser (polling) | ✅ |
| Accio / Accio CN | browser | ✅ |
| OrcaTerm | paste cookie (`ot_session`) | ✅ |
| KukuAI | Baidu App QR scan (local page) | ✅ |
| MonkeyCode | paste cookie (`nebula_session`) | ✅ |
| AutoClaw (CN) | phone + SMS code | ✅ |
| AutoClaw Intl | paste token | ✅ |

**On paste-based channels** — these upstreams expose no scriptable authorization flow. Sign in on the official site first, then copy the cookie or token out of the browser's developer tools.

**On AutoClaw** — the mainland site signs in with a **phone number plus SMS code** (no browser; "paste a token instead" still works). The international site's OAuth hard-requires the Aliyun CAPTCHA SDK (`AliyunCaptcha.js`, scenario `sq51tr`), which the plugin cannot complete on its own, hence the pasted-token route there.

**Can't see a channel's models?** The picker only lists models of channels you are signed in to;
a channel with no usable account is not offered (its rows could not work). Its model list and the
per-model switches still show up in the settings page, and signing in refreshes the picker on the
next open. To preview signed-out channels' static catalogs in the picker, set
`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0`. Per-channel sign-in methods: [docs/channel-login-methods.md](docs/channel-login-methods.md).

MIT, see [LICENSE](LICENSE). This project has no affiliation with, and no endorsement from, any model provider.
