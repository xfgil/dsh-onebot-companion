# dsh-onebot-companion

> One plugin that gives a QQ channel its manners back: **outbound silence guard + per-turn behaviour rules + conversation rhythm + persona**.
>
> [中文](./README.md) · English

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

**A DSH plugin** · Restores four capabilities that the 0.9.0 upgrade of [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq) wiped out.

**Sibling plugins**: [dsh-hot-reloader](https://github.com/xfgil/dsh-hot-reloader) ·
[dsh-session-clock](https://github.com/xfgil/dsh-session-clock) ·
[dsh-session-coop](https://github.com/xfgil/dsh-session-coop) ·
[dsh-proxy-on-demand](https://github.com/xfgil/dsh-proxy-on-demand)

> **This repository supersedes** the separate `dsh-onebot-guard` / `dsh-onebot-prompt` /
> `dsh-onebot-rhythm` plugins (their capabilities now live in this plugin's four modules).
> If you installed any of them, uninstall first — **do not run both**. Two copies would wrap
> the same prototype chain independently, causing double bursting and double counting.

---

## Table of contents

- [Why](#why)
- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [HTTP surface](#http-surface)
- [How it works](#how-it-works)
- [Known limits](#known-limits)
- [License](#license)

---

## Why

When `dsh-onebot-qq` went to 0.9.0 on 2026-10-12 23:43, a batch of behaviour conventions that
had been hand-patched into `node_modules` was **wiped in one go** — pnpm swapped the directory
and the edits were gone:

| Capability | Original implementation | After 0.9.0 |
| --- | --- | --- |
| Silence protocol (`[[silent]]`) | `prompt.js` + `split.js` + `outbound.js` | gone |
| Parenthetical aside stripping | `split.js` `stripAsideLines` | gone |
| Outbound bursting (one long reply → a few short messages) | `split.js` burst + `outbound.js` `burstChunks` | gone |
| Inbound coalescing (three lines in a row = one turn) | `coalesce.js` | file does not exist |
| Mood / proactive talk / style learning | `mood.js` / `proactive.js` / `style.js` | gone |
| 5 behaviour rules | 29 edits to `prompt.js` | gone |

**Hand-patching `node_modules` is exactly what got wiped — the same trap would repeat.** This
plugin touches nothing inside `node_modules`; it wraps prototypes from the outside, so an
upgrade can no longer take the features away.

### Why one plugin instead of four

These capabilities were originally four separate packages. Merging them is plain arithmetic:

- Too much duplication — `resolveProfileDirs()` duplicated verbatim, `patchMethod()` twice,
  three copies of the HTTP surface, three copies of the loopback check, two state stores.
- Four packages each `import()` the same `dsh-onebot-qq`, each runs its own 3-second scan
  timer, each keeps its own stats.
- Users install one thing and configure one block instead of four.

The result: **one package, one config block, one HTTP surface**, split internally into four
modules that can each be toggled independently.

## What it does

| Module | Does what | Attaches to |
| --- | --- | --- |
| `guard` | Outbound gate: blocks `[[silent]]`, strips whole-line parenthetical asides; sends nothing if the result is empty | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |
| `prompt` | Injects 5 behaviour rules + a mood line + a style line each turn | host `agent/pre-step` (no prototype) |
| `rhythm` | Inbound coalescing + outbound bursting | `ChatBridge.prototype.dispatchFollowup` / `sendToChat` |
| `persona` | Four mood variables + randomised proactive talk + style learning | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |

The four modules attach to **different** methods and coexist via module-identity tags in
`core/patch.js`, so none of them swallows another.

### The 5 behaviour rules

| id | Rule | Default |
| --- | --- | --- |
| `silent` | Express silence with `[[silent]]` only — never with text or parentheses | on |
| `image` | Images may be sent proactively (`qq_send_image`), but never invent local paths | on |
| `quarrel` | In a group argument, stay out of it by default — even when @-mentioned | on |
| `face` | Use emoji well, but don't overuse them or use them instead of talking | on |
| `tone` | Short, spoken phrasing; no documents; never expose runtime state | on |

> `silent` is a **contract** with the `guard` module: the rule layer forbids expressing silence
> with parentheses so that guard's detector hits 100% of the time with no residue. Change this
> wording only together with guard's detection logic.

### Rhythm parameters

| Direction | Behaviour | Default |
| --- | --- | --- |
| Inbound | Messages from one chat collect in a quiet window and become **one** turn | 8s private / 3s group |
| Inbound | An **@** pierces the window immediately | on |
| Inbound | Hard cap on batching | 30s |
| Outbound | The final reply is split into a few short messages with typing delays | ≤36 chars each, ≤4 messages |
| Outbound | Pulses "typing" during the split (private chats only) | on |

### The four persona variables

| Variable | Governs | Timescale | Initial |
| --- | --- | --- | --- |
| `mood` | How she feels right now (8 states) | minutes | `calm` |
| `energy` | How much charge is left | hours | 80 |
| `affinity` | How deep the relationship is | days | 20 |
| `warmth` | How fired-up and talkative she is right now | hours | 50 |

Proactive talk has **no cron**: there are exactly two random points — the interval until the
next evaluation is drawn from a range, and each eligible chat rolls a probability gate at
evaluation time. It defaults to **private chats only** (speaking up in a group disturbs everyone).

## Requirements

- **DSH** (DeepSeek Harness) with [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq)
  installed and enabled (the target package; this plugin binds to its `0.9.x` internals).
- **Node.js ≥ 22** (developed and tested on v24).
- **No third-party dependencies** — Node built-ins only.

## Install

### 1. Get the plugin

```powershell
git clone https://github.com/xfgil/dsh-onebot-companion.git D:\path\to\plugins\dsh-onebot-companion
```

### 2. Register it in your profile

Edit `<DSH_HOME>\profiles\<profile>\package.json`:

```jsonc
{
  "dependencies": {
    "dsh-onebot-companion": "link:D:/path/to/plugins/dsh-onebot-companion"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-onebot-companion"   // ← adding it to bundles self-registers it
      ]
    }
  }
}
```

The plugin ships its own `cordis.patch.yml` (referenced by `dsh.bundle.patch`), so the bundle
**self-registers**. Do **not** hand-write an `insert` into the profile's `cordis.patch.yml` —
a duplicate insert starts a second instance.

### 3. Link it and let the host load it

```powershell
cd <DSH_HOME>\profiles\<profile>
pnpm install
```

> ⚠️ **Order matters: create the `node_modules` link first, then edit the profile manifest.**
> The host's hot-reload `refresh(manifestOnly)` short-circuits on:
> ```js
> if (manifestOnly && bundles === lastBundles) return;   // manifest unchanged → bail out
> ```
> If you edit the manifest before the link exists, that reconcile can't resolve the package
> and skips it — but `lastBundles` has already been updated, so **every later manifest edit is
> short-circuited and never retried**. The symptom: the plugin manager shows `enabled: true`
> but that row has no `entryId` and nothing works.
>
> Fix: toggle the plugin **off and on** in the plugin manager (this makes the manifest content
> actually change once) to bypass the short-circuit.

No host restart is needed — hot reload picks it up. With
[`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) installed it follows along too.

### 4. Confirm it's running

```powershell
curl.exe http://127.0.0.1:<port>/dsh-onebot-companion
```

Or just check that the state file was written:

```powershell
Get-Content "$env:USERPROFILE\.dsh\onebot-companion\state.json"
```

## Configuration

Configuration lives in the profile's bundle config and is passed to `apply(ctx, config)`.
**This plugin deliberately exports no Config schema** — the profile side cannot resolve the
host's `schemastery`, and exporting a non-schema object makes the loader's config projection
fail.

```yaml
dsh-onebot-companion:
  enabled: true
  packageName: dsh-onebot-qq     # the QQ channel plugin to wrap
  profileDir: ''                 # empty = multi-path auto-detection
  pollMs: 3000                   # re-attach scan period; self-heals after upgrades
  stateFile: ''                  # empty = $DSH_HOME/onebot-companion/state.json

  guard:
    enabled: true
    stripAside: true             # also strip whole-line parenthetical asides
    logHits: true

  prompt:
    enabled: true
    rules: {}                    # per-id toggles, e.g. { quarrel: false }; all on by default
    firstStepOnly: true          # inject on the first step only (recommended)
    sourceName: onebot-prompt

  rhythm:
    enabled: true
    inbound:
      enabled: true
      quietMs: 8000              # private-chat quiet window
      groupQuietMs: 3000         # group-chat quiet window
      maxWaitMs: 30000           # hard batching cap
      mentionPierces: true       # an @ pierces the window
    burst:
      enabled: true
      maxChars: 36               # per-message character budget
      maxChunks: 4               # at most this many messages; the tail folds into the last
      delayMs: 300               # base pause between messages
      perCharMs: 45              # typing time derived from the previous message's length
    typing: true

  persona:
    enabled: true
    mediaDir: ''                 # mood/style state dir; empty = take it from bridge config
    moodEnabled: true
    styleEnabled: true
    proactiveEnabled: true
    moodDriftMinutes: 20
    energyDecayPerHour: 7
    nightRecoveryPerHour: 14
    nightStartHour: 0
    nightEndHour: 8
    affinityDecayPerHour: 0.8
    affinityGraceHours: 6
    warmthBaseline: 30
    warmthRegressPerHour: 10
    warmthJitter: 8
    proactiveChance: 0.45
    proactiveMinMinutes: 25
    proactiveMaxMinutes: 150
    proactiveIdleMinutes: 20
    proactiveMaxPerDay: 6
    proactiveQuietStart: 1
    proactiveQuietEnd: 8
```

> `packageName` / `profileDir` are propagated into all four module sections automatically —
> you never repeat them.

### Where state lives

| File | Contents | Location |
| --- | --- | --- |
| `state.json` | This plugin's runtime state (which gates are attached, scan count, hit counts) | `$DSH_HOME/onebot-companion/` |
| `mood-state.json` | The four mood variables (one entry per chat) | `config.persona.mediaDir` |
| `style-state.json` | Style profiles (one entry per chat) | `config.persona.mediaDir` |

Mood and style are **deliberately kept out of `state.json`**: `mediaDir` is where that
historical data already lives, so rewriting or swapping the plugin inherits it instead of
resetting days of accumulated affinity and style.

## HTTP surface

Everything is **loopback only** (anything not from `127.0.0.1` gets 403).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/dsh-onebot-companion` | Overall status: config, stats, module attachments |
| GET | `/dsh-onebot-companion/hits?limit=` | Last 200 guard hits (original + cleaned text) |
| GET | `/dsh-onebot-companion/mood` | Mood snapshot (per chat) |
| GET | `/dsh-onebot-companion/style` | Style snapshot (per chat) |
| POST | `/dsh-onebot-companion/toggle` | `{"enabled": bool}` master switch |
| POST | `/dsh-onebot-companion/module` | `{"module":"guard\|prompt\|rhythm\|persona","enabled":bool}` |
| POST | `/dsh-onebot-companion/rule` | `{"id":"silent","enabled":false}` per-rule toggle |
| POST | `/dsh-onebot-companion/rescan` | Re-attach immediately |
| POST | `/dsh-onebot-companion/selftest` | Run guard's self-test (feed real text, see the verdict) |
| POST | `/dsh-onebot-companion/burst` | `{"text":"…","maxChars":36}` preview the split |
| POST | `/dsh-onebot-companion/reset-hits` | Clear hit records and counters |

## How it works

### Attaching: wrap prototypes at runtime, write nothing to disk

`core/patch.js` locates the target class by **absolute path** with `pathToFileURL()` and
`import()`s it, then wraps prototype methods. Why not
`require.resolve('dsh-onebot-qq/lib/outbound.js')`:

```
Package subpath './lib/outbound.js' is not defined by "exports"
```

Upstream's `exports` field exposes no subpaths, so building the absolute path is simpler.

**Module identity** is the premise of the whole approach, and it is verified: the namespace
object returned by `import()`ing the normalized `pathToFileURL` URL is the **same** one the
host instantiates, because the ESM module cache keys on the resolved URL. Wrapping a prototype
method therefore affects the host's real instances.

### Upgrade resistance

Wrapping happens at **runtime** and writes no files. When pnpm overwrites `lib/*.js` with the
original version, the gates simply vanish — the plugin's `pollMs` scan (3s by default)
re-`import()`s and checks whether its module tag is still on the prototype, and re-attaches if
not. **A target-package upgrade that changes directories does not break it either.**

### Detach semantics: modules don't swallow each other

The same prototype method can be wrapped by more than one module (e.g. `sendToChat` is
interesting to both guard and rhythm). A naive `unwrap()` would peel to the chain bottom and
discard other modules' wrappers. `core/patch.js` therefore tags every wrapper with a
`Symbol.for` module marker and **peels only its own layer**:

```js
// peel only this module's layer; other modules' wrappers stay intact
```

It also keeps `originalOf()` (fetch the chain-bottom original) for paths that need to bypass
every wrapper.

### Failure degradation

- Guard cleaning throws → **pass the original through**. A guard that eats a user's message is
  far worse than one that misses a marker.
- Inbound coalescing throws → dispatch the original text (call the original method as usual).
- Outbound bursting throws → send the original as one message; a mid-split failure re-sends the
  remainder merged.
- Mood/style recording throws → only records `lastError`, never affects delivery.
- Every timer is `unref()`ed, so a pending batch never pins the host process.

## Known limits

- **Attach points bind to 0.9.x internals.** If upstream renames `sendToChat` / `sendMsg` /
  `dispatchFollowup` / `handleInbound` / `onSessionEvent`, the matching module silently stops
  working. The `pollMs` scan records losses in `lost` but does not adapt.
- **`agent/pre-step` adds one message per turn.** That is a real token cost, noticeable per day
  in long conversations. Hence `prompt.firstStepOnly` defaults to `true`.
- **The prompt layer cannot out-shout history.** If a session's history already contains
  hundreds of `[[silent]]` examples, one injected rule may not override them; `guard`'s hard
  gate is the primary defence and the prompt layer is secondary.
- **The coalescer only works at the `dispatchFollowup` layer.** Steering and speech-to-text go
  through another path and **bypass the coalescer** — intentional, since an interruption should
  take effect immediately.
- **Bursting changes message counts.** Downstream logic assuming "one reply = one message" will
  see several.
- **Text-image cards are never split**: when `textImageThreshold` kicks in the whole reply goes
  as a card, which is already a single message.
- **Proactive talk is pull-based**: the host exposes no public API for a plugin to start a turn
  on an idle session, so the scheduler only works while an active chat table exists.
- **Mood variables are time-integrated**, so persisted values carry IEEE-754 float tails
  (`56` may be `55.99999722222222`). That is expected, not a bug.
- A personal tool; compatibility with other third-party OneBot implementations is not guaranteed.

## Development

```powershell
node test/selftest.mjs
```

**220 assertions**, in three layers:

1. **Pure functions** — mood / style / burst / coalesce / aside / rules; no IO, no host.
2. **Module interfaces** — the four modules' `createXxx` return values and config semantics.
3. **Real integration** — builds a fake profile (with `dsh-onebot-qq/lib/{bridge,outbound}.js`),
   lets each module's `scan()` really `import()` and wrap the prototypes, then **really calls**
   the wrapped methods and asserts on behaviour.

Layer 3 is why this test file exists: the first two layers can be fully green while the plugin
"reports it attached" but does nothing — only a real attach-and-call catches that.

## License

[MIT](./LICENSE) © 2026 xfgil

---

*A personal plugin, written to a "good enough" standard. Evaluate before production use.*
