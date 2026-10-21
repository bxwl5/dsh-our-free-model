<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

<div align="center">

> All you do is install this plugin in dsh — no login, no sign-up, no API key.
> The roster follows upstream, availability is measured from **your own** network
> egress, and a local OpenAI / Anthropic-compatible gateway comes included.

</div>

---

## Highlights

- **Nothing to configure** — install, restart, pick a model. No account, no key, no quota to register on.
- **Two keyless lanes** — an anonymous free lane (OpenCode's gateway) and the Kilo free pool (Kilo AI's public gateway), both dialled directly with no third party relaying your traffic.
- **Thirteen account channels** — CodeArts, CodeBuddy / WorkBuddy, LobsterAI, Qoder / Qoder CN, TRAE, Cline, Loomy, Raccoon, MiniMax Code, ZCode and Gemini work out of the box; credentials only ever reach the host's credential store.
- **A roster that tracks upstream** — model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin.
- **The picker offers only what actually answers** — a model the upstream listing names but the gateway refuses to route outright (`Model is unavailable`, a 404 for that id) leaves the dropdown and stays visible in the settings page with its refusal recorded. Everything that is *not* a statement about the model keeps its model reachable: a 5xx from the gateway, a 429 quota window, a timeout or a dropped connection. Region-gated ones move to their own `region-limited` group.
- **Thinking effort that actually binds** — two kinds of model, two kinds of control. A model that declares thinking levels (DeepSeek V4.1 Flash, GLM 5.3 Flash among them) gets its own level menu (Off / Low / High / Max …), and the selected level is sent as-is in the upstream `reasoning_effort` field — which the gateway validates, so a value outside the set is a 400. A model with no level menu gets the budget ladder: `Light / Balanced / Deep` map to output-token budgets. Both are recorded per call, and every model card prints either the levels or the number it will actually send.
- **The body decides what it is, not the header** — under load the gateway answers 200 with a JSON `Content-Type` over a perfectly ordinary SSE frame stream. The plugin sniffs the first bytes and replays them into the stream, so the turn keeps streaming instead of being thrown away.
- **Token savers** — tool-output compaction (RTK) rewrites `tool_result` content in place before the request is sent (git diff / status / log, grep, find, ls, tree, build logs, duplicate log lines); prompt shaping offers two families, every level off by default; and five local answers that never call a provider.
- **Routing (fallback chains)** — chain models from any lane into one named chain that appears in the picker and on the gateway as the virtual model `combo:<name>`, with `fallback` and `round-robin` policies.
- **The local gateway** — `/v1/chat/completions`, `/v1/responses`, `/v1/messages` (streaming and non-streaming, with `thinking` / `tool_use` blocks and a real `stop_reason`), `/v1/messages/count_tokens` and `/v1/models`, all behind a generated key, plus a LAN relay.
- **Usage dashboard, local only** — token heatmap, cumulative curve, output speed and time-to-first-token sampled per call. Nothing is uploaded.
- **Works without a browser UI** — only `llm` is a hard dependency, so the plugin activates on a headless composition such as dsh-tui and still serves its models.

## Install

> **⚠️ Do not install this plugin from npm.**
> The `dsh-our-free-model` package on npm **is not published by this repository.**
> It is a third-party repackaging whose contents do not match this tree.
> Install only the ways documented below: a release package from this repository,
> or a local source directory.

### Command line (plain `dsh web`)

```bash
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

Restart the app once. `--profile` should name the profile you actually use.

### Manual install as a real directory (tarball)

1. Create `<DSH_HOME>/profiles/<profile>/vendor/`. From the reviewed repository, run `npm pack --ignore-scripts --pack-destination "<DSH_HOME>/profiles/<profile>/vendor"`, or place an official same-version release tarball there.
2. Add `"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"` to the profile's `package.json` dependencies, then use the host's installation flow to resolve it. Keep the filename version aligned with this repository's `package.json`.
3. Append `"dsh-our-free-model"` to `dsh.profile.bundles`.

If copying release files manually, copy the entire package, including `adapter/`, `src/`, `locale/` and `vendor/channel-pack/`. Copying only entry scripts leaves channel loading incomplete.

> Do **not** also add an entry to `cordis.patch.yml`. A bundle referenced from
> `dsh.profile.bundles` already applies its own patch layer, and registering it
> twice fails with `duplicate loader entry id: our-free-model`.

### Install failure: `profile "desktop" is managed exclusively by the Electron application`

That is the host's own protection, not a plugin problem: the Electron desktop profile may only be managed by the desktop application, so the command line cannot write to it. Install or upgrade through the desktop app's plugin manager; command-line installs apply to plain web profiles only.

## Usage

**Pick a model** — open the composer's model picker and choose anything under the `Our Free Model` group. The choice persists per conversation.

**Adjust thinking effort** — the same menu's Effort control. A model that declares levels gets its own (Off / Low / High / Max …) sent as-is; the rest get the `Light / Balanced / Deep` ladder. Thinking and the visible answer share one output ceiling, so a model that cannot switch thinking off gets the whole ladder moved up (the model card prints the number each rung really sends).

**Expose it to other local tools** — Settings → Our Free Model → Local forward; enable it, copy the base URL and generate a key. Supported:

- `GET /v1/models`
- `POST /v1/chat/completions` (streaming and non-streaming)
- `POST /v1/responses`
- `POST /v1/messages` (streaming and non-streaming, Anthropic Messages)
- `POST /v1/messages/count_tokens` (a local estimate)

When the port is taken the plugin never fails silently: it retries the same port a few times, then moves to the next free one and reports the port that actually bound on the settings page.

**Expose it to the rest of the network** — the same panel's LAN access, off by default. When enabled the relay binds a routable address and requires a separate LAN key (never interchangeable with the local one). While it is on, anyone who can reach this host can spend its quota with that key, so enable it only on trusted networks.

**Re-check the region** — "Re-probe availability" probes from the current egress again. After switching VPN state, run it once more and region-gated models move between the groups automatically.

## Settings page

Seven pages under Settings → Our Free Model:

| Page | Contents |
| --- | --- |
| Free models | Model roster and availability, capabilities, the output ceiling each effort rung really sends, measured TTFT, an on-demand single-call benchmark |
| Channels | Thirteen channel cards: sign-in, account pool, per-model switches, daily credit claim |
| Token savers | Compaction switches, two prompt families, five local answers, savings stats |
| Routing | Fallback chain editor |
| Dashboard | Token consumption, average generation speed, success rate, account and per-model tables |
| Request log | Per-request detail: result, duration, TTFT, speed, token breakdown |
| Gateway | Gateway switch/endpoint/key, LAN relay, connect-a-client recipes |

## How it works

```
index.js            Host half: adapter registration, roster and availability probing, storage, routes, forward port
adapter/            The kernel seam: the only place allowed to import @deepseek-ai/*
client.js           Browser half: a hand-written ModuleLoader bundle, no build step
src/adapter.js      The structural LlmAdapter: providerInfo, listModels, resolveModel, stream
src/upstream.js     Gateway identity: credentials, session/request id minting, per-wire endpoint selection
src/stream.js       Three wire protocols decoded into harness StreamChunks
src/messages.js     harness messages -> per-wire shapes, plus tool-call pairing repair
src/effort.js       Thinking levels -> output budgets
src/forward.js      The standalone OpenAI-compatible listener (plus Anthropic Messages)
src/kilo.js         The Kilo free pool channel
src/channel.js      The shared skeleton for the thirteen account channels
src/combos.js       Fallback chains: virtual roster rows, two policies, capacity intersection
src/recovery.js     Bounded automatic recovery after a long reasoning stream is cut
src/token-saver/    The compaction pipeline: prompt shaping -> tool-output compaction, fail-open
src/route/          One failure vocabulary and cooldown policy for every lane
src/trust.js        The request trust fence for the plugin's own routes
```

### A few decisions worth knowing about

**One adapter, several provider routes.** The harness picker groups strictly by provider route, and the roster's wire format carries no group / tag / badge field. Registering a second route is therefore the only way to present a separate `region-limited` heading; because the client drops empty groups, the two groups merge back into one the moment the region gate lifts.

**A structural adapter that does not import @deepseek-ai/dsh-llm.** The kernel never runs an instanceof check, so duck typing suffices. That keeps the plugin off a pinned kernel version, and it is why one tree runs on both 0.1.5 and 0.1.7.

**Its own JSON store, not the settings seam.** The settings registration API differs between the two kernels; a private JSON store behaves identically on both, and the forward key lives in a 0600 file that never enters a shared settings document.

**Token compaction runs at the single choke point, and fails open.** Prompt shaping and tool-output compaction both run after every other payload rewrite, at `payloadFor()`: the adapter's own dispatch and the local gateway (which also goes through the adapter) pass through that one place, so every lane and every recovery request is compacted alike. Each step fails open — a throwing compactor is skipped, a throwing filter passes the content through, an unrecognised shape is left alone. A request must never fail because of a step whose whole purpose was to make it cheaper.

**A combo is a virtual roster row, and failover resolves inside the adapter.** A chain enters the merged roster as `channel:'combo'` plus a list of real model ids, so the picker broadcasts it and the local gateway calls it by name; the expansion and advancement decisions happen in the adapter's `runStream()`, so neither caller needs to know failover exists.

## Three kernel behaviours that cost real debugging time

**providerRetryPolicy() is stored and used as returned.** Neither kernel parses the value, and the backoff scheduler reads the top-level initialDelayMs / maxDelayMs / jitterRatio. Nest those three inside `backoff:{}` and the scheduler reads undefined, so `undefined * 2ⁿ = NaN` — and the durable session log rejects non-finite numbers outright, which turns one recoverable transient failure into a wasted turn. Return a flat, already-resolved policy.

**One interrupted tool call poisons the session for good.** A tool call without its matching result is replayed upstream as a 400 invalid_request_error, after which every request in that session fails. The plugin repairs the pairing before sending, in one place shared by all three wire protocols.

**A service that is not in `inject` throws on a direct property read** — different from returning undefined. After trimming `inject` down to just `llm`, `typeof ctx.interval === 'function'` threw and the plugin stopped activating in every composition. The correct move is `ctx.inject(deps, callback)`: open a dedicated fiber for the services you need and let it wait.

## Known limitations

"Unlimited" means there is no quota system at all: no top-up, no per-token billing. The lane does meter per session, so a burst returns 429; the plugin marks that model "quota reached", hides nothing, and the next probe restores it.

Some models are simply slow upstream (a first token has been measured at over 30 seconds); the dashboard reports it as it is.

Output speed can say `—`: a model whose answer lands in one or two big frames, or whose reasoning is never streamed, has no window to time. The dashboard would rather stay blank than bill thinking time as output speed.

Reasoning is a silent wait and shares the output ceiling. A model has been measured thinking silently for 60–70 seconds, billed for thousands of reasoning tokens, sending no reasoning frames at all; such a turn ends with `stop` and an empty answer. The forward endpoint and the LAN relay keep the connection alive with heartbeats, but a heartbeat holds the connection, it does not fix the timeout: an SSE client's idle watchdog only resets on a real content frame. The budget is the caller's to set: raise the per-call output ceiling, or use a model whose card says `reasoning: false`.

Automatic recovery is bounded by count, time and context: it recovers only a pure-reasoning EOF and a pure-reasoning empty stop, and appends at most one request; a turn that already produced content or tool calls, a user cancellation and an explicit error never trigger it. With usage missing, the reported total is only the known part.

Capabilities are labelled only where a probe can prove them. Where neither the public listing nor a live measurement can produce evidence, nothing is claimed.

The source is plain JavaScript. A local plugin has to be — treat that as a property of this distribution form; obfuscation does not solve it.

## Where the models come from

Two public keyless sources, both dialled directly, with no third party relaying your traffic.

**Free lane: OpenCode's keyless gateway, `https://opencode.ai/inference/v1/*`**

| Purpose | Target | Credential carried |
| --- | --- | --- |
| Inference | `POST …/inference/v1/chat/completions`, `…/responses`, `…/messages` (routed per model) | `Authorization: Bearer public` — the lane itself is a public keyless allowance |
| Model listing | `GET …/inference/v1/models` | same |
| Egress region | api.ipify.org / ipinfo.io / ipapi.co, only for this machine's public IP and country code | none |

**Kilo channel: Kilo AI's public gateway, `https://api.kilo.ai/api/gateway`**

| Purpose | Target | Credential carried |
| --- | --- | --- |
| Inference | `POST …/api/gateway/chat/completions` (SSE streaming) | **none** — the free pool (`isFree: true`, including the `kilo-auto/free` auto-router) needs no account, key or session |
| Model listing | `GET …/api/gateway/models` | none |

On privacy and trust: no account pool, no relay. The tables above are this plugin's complete set of network targets; the offline suites in `npm test` never touch the network at all — only `host-selftest.mjs` and `scripts/probes/` call these addresses, and only when you run them by hand.

Your prompts, tool results and attached images are sent to the upstream behind the model you chose, exactly as with any model API. Beyond that the plugin uploads nothing: dashboard data, settings and forward keys all land under this machine's `DSH_HOME/our-free-model/`.

**The Kilo free pool states on its model cards that prompts may be logged by the upstream provider and used to improve their services** — never send sensitive content. The model set and the quota policy are the upstream's to change at any time; the plugin can only honestly drop what stops working.

## Disclaimer

- **This plugin is a client, not a model provider.** Every model response is produced and transmitted by the third-party upstreams named above; the plugin does not host, modify or filter any model output. Models can be wrong, stale or biased — verify before relying on it.
- **Free is neither infinite nor private.** The free allowance is the upstream's to grant, throttle, charge for or withdraw, and the Kilo pool explicitly states prompts may be logged. **Do not send passwords, keys, personal data, commercial secrets, or anything you would rather a third party not process, through this plugin's free lanes.** Use your own paid API for production and sensitive work.
- **The upstream terms are yours to follow.** Using a channel means accepting that upstream's terms and usage policy; throttling, bans and other consequences of violating them are the user's own. The plugin makes no promise about any upstream's availability, accuracy or continuity.
- **This plugin has no affiliation with, and no endorsement from, any upstream vendor.** Vendor names and trademarks belong to their owners and are cited only to state provenance.

## Security and privacy

All state is written under `DSH_HOME/our-free-model/`; usage and settings stay on this machine and are uploaded nowhere.

The forward listener binds loopback only, default 127.0.0.1, and refuses every keyless request. Changing the address to a routable interface is rejected outright (`POST /settings` returns 400) — that port spends this machine's keyless allowance, and one string should not decide whether a whole subnet gets it. The hostname is resolved first and every result must be loopback, so a hosts file pointing `localhost` at a routable interface cannot split the check from the bind.

LAN access is a second door and relaxes none of the above: the local listener still binds loopback and still refuses an address change; cross-machine use must be enabled explicitly, the relay binds a routable address, and every request needs the LAN key — including the `/` and `/health` liveness probes. The relay forwards only the five whitelisted `/v1/*` paths and never proxies an arbitrary loopback service; it swaps the LAN key for the local key at the entrance, so the two keys are never interchangeable, and a request carrying the hop marker is refused (508), so the relay cannot loop even if pointed at the local listener's own port.

Forward keys are generated by the crypto runtime, compared with `timingSafeEqual`, and stored in a 0600 file. This repository contains no hardcoded credentials.

The plugin's HTTP routes carry a request trust fence: the plugin's `/api/our-free-model` prefix wins the webServer's longest-prefix dispatch over the kernel's `/api` and once bypassed kernel authentication. Every request is now admitted through the composition's connection service first (exactly the kernel `/api` cookie/token check); a composition without `connection` falls back to the structured fence — loopback Host, cross-site `sec-fetch-site` refused, Origin/Referer must match Host's origin and port (fail closed).

Uninstalling is just removing the bundle entry; the plugin leaves no patch behind, and its data directory is plain JSON you can delete.

## Development

```
npm test                     # every offline suite plus the manifest consistency check, in one command
node scripts/client-lint.mjs # browser half: copy-key and style-key coverage both ways, bundle executable
```

Requires Node ^22.19.0 || >=24.0.0. No install step, no dependencies.

```
npm run typecheck # tsc --noEmit, strict over the adapter/ seam (optional: needs typescript)
```

## License

MIT, see LICENSE.

This is an independent plugin with no affiliation to, endorsement from, or sponsorship by any model provider. Access to the free allowances through it remains subject to each provider's own terms.
