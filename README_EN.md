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

```bash
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

Restart the app once (`--profile` names the profile you actually use).

**To install as a real directory**, place this repository's tarball in the profile's `vendor/` and add to its `package.json` dependencies:

```
"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"
```

then append `"dsh-our-free-model"` to `dsh.profile.bundles`. Keep the filename version aligned with this repository's `package.json`; do not substitute a same-named npm registry version.

> The same-named package on npm is **not** published by this repository — do not install from npm.

## Usage

After restarting, the composer's model picker gains an **Our Free Model** group. Pick a model and go.

- **Thinking effort** — the Effort control in the model menu: an on/off switch where the model supports it, otherwise Light / Balanced / Deep.
- **Local gateway** — Settings → Our Free Model → Local forward. Enable it and other local tools can call these models through a base URL plus a key, over OpenAI- and Anthropic-compatible endpoints.
- **LAN access** — the same panel exposes a relay for other devices on your network (off by default, uses a separate key).
- **After changing networks** — hit "Re-probe availability" and the groups re-measure from your current egress.

The settings page has seven parts: free models, channels, token savers, routing, dashboard, request log and gateway.

MIT, see [LICENSE](LICENSE). This project has no affiliation with, and no endorsement from, any model provider.
