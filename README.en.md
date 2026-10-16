# dsh-onebot-companion

> One plugin that gives a QQ channel its manners back: **outbound silence guard + per-turn behaviour rules + conversation rhythm + persona + voice + session-adoption guard + timestamps**.
>
> [中文](./README.md) · English

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

**A DSH plugin** · Restores the capabilities that the 0.9.0 upgrade of [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq) wiped out.

**Sibling plugins**: [dsh-hot-reloader](https://github.com/xfgil/dsh-hot-reloader) ·
[dsh-session-clock](https://github.com/xfgil/dsh-session-clock) ·
[dsh-proxy-on-demand](https://github.com/xfgil/dsh-proxy-on-demand) · [dsh-second-opinion](https://github.com/xfgil/dsh-second-opinion)（第二意见）

> **This repository supersedes** the separate `dsh-onebot-guard` / `dsh-onebot-prompt` /
> `dsh-onebot-rhythm` plugins (their capabilities now live in this plugin's modules).
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

`dsh-onebot-qq` only wires up the QQ channel; it does not care about the conversation itself:
how silence is expressed, whether a parenthetical aside counts as speech, whether one long reply
should go out as several messages, whether three lines in a row count as one turn, what mood she
is in, whether she should speak up unprompted, how long it has been between messages. All of that
has to come from outside — and that whole set is what this plugin adds:

| Capability | Today |
| --- | --- |
| Silence protocol (`[[silent]]`) | blocked by `guard` |
| Parenthetical aside stripping | stripped by `guard` |
| Outbound bursting (one long reply → a few short messages) | done by `rhythm` |
| Inbound coalescing (three lines in a row = one turn) | done by `rhythm` |
| Mood / proactive talk / style learning | provided by `persona` |
| 10 behaviour rules | injected each turn by `prompt` |
| Session-adoption guard | the `adopt` module |
| Timestamps and gaps (`time=`/`gap=`) | the `stamp` module |

**Why not hand-patch `node_modules`**: writing those conventions straight into `node_modules`
means one `dsh-onebot-qq` upgrade (pnpm swaps the directory) wipes them all — the same trap
would repeat. This plugin therefore touches nothing inside `node_modules`; it wraps prototypes
from the outside, so an upgrade can no longer take the features away.

### Why one plugin instead of four

These capabilities were originally four separate packages. Merging them is plain arithmetic:

- Too much duplication — `resolveProfileDirs()` duplicated verbatim, `patchMethod()` twice,
  three copies of the HTTP surface, three copies of the loopback check, two state stores.
- Four packages each `import()` the same `dsh-onebot-qq`, each runs its own 3-second scan
  timer, each keeps its own stats.
- Users install one thing and configure one block instead of four.

The result: **one package, one config block, one HTTP surface**, split internally into seven
modules that can each be toggled independently.

## What it does

| Module | Does what | Attaches to |
| --- | --- | --- |
| `guard` | Outbound gate: blocks `[[silent]]`, strips whole-line parenthetical asides, swallows the "⏳ task running" queue notice; sends nothing if the result is empty | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |
| `adopt` | Session-adoption guard: when a bare id still owns an on-disk log, **adopt** it (resume) instead of retiring it forever and starting a brand-new session | `ChatRegistry.prototype.createChat` |
| `stamp` | Adds back `time="..."` (the moment this message was sent) and `gap="..."` (the interval since the previous one, e.g. `3m47s`) at the injection boundary, so the model never has to subtract timestamps itself | `ChatBridge.prototype.handleInbound` (bookkeeping) + `ChatBridge.prototype.dispatchFollowup` (injection) |
| `prompt` | Injects 10 behaviour rules + a mood line + a style line each turn | host `agent/pre-step` (no prototype) |
| `rhythm` | Inbound coalescing + outbound bursting | `ChatBridge.prototype.dispatchFollowup` / `sendToChat` |
| `persona` | Four mood variables + randomised proactive talk + style learning | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |
| `voice` | The `qq_say` tool: text → edge-tts synthesis → sent as a QQ voice message | registers a tool only; attaches to no prototype |

Five of the seven modules wrap prototypes, and they **share mount points** (`dispatchFollowup`
carries stamp + rhythm, `handleInbound` carries stamp + persona). They coexist via
module-identity tags in `core/patch.js` without swallowing one another, and their order on the
chain is decided **solely by module priority**, never by attach timing.

### What `adopt` fixes

`dsh-onebot-qq`'s own `createChat` contains this:

```js
let sessionId = makeSessionId(sessionIdForChat(chatId));
if (this.isSessionIdBlocked(sessionId)) {
    sessionId = this.freshSessionId(chatId);
}
else if (await this.hasPersistedLog(sessionId)) {
    this.retireSession(sessionId);          // ← permanent: written to retired-sessions.json
    sessionId = this.freshSessionId(chatId);
}
```

When the bare id (e.g. `onebot-group-535746440`) **still owns a history log on disk**, it does not
adopt it — it retires the bare id **forever** and switches to a new id with a timestamp suffix.
`retireSession` is permanent, so from then on every `createChat` falls into the first branch and
takes `freshSessionId` — the symptom is **a brand-new session per message**, with all context lost.

The key distinction: **only `agents.create()` collides with an existing log; `agents.resume()` is
exactly the call that adopts one.** So this module wraps `createChat` from the outside and makes
that decision before the original method runs. Three cases are **explicitly passed through** to the
original: ① the chat has an `evictedChats` snapshot (that id is more authoritative than the bare
one) ② the bare id is already blocked (respect the record) ③ the bare id has no persisted log
(nothing to adopt).

The session id is derived **using upstream's own `chat.js#sessionIdForChat`**, never by copying
that regex into this module — a copy would plant the trap "upstream changed the rule while we still
compute ids the old way", and a wrong id means "adopting a session that does not exist", which is
worse than not adopting. If that function cannot be loaded, the module **refuses to attach**
rather than degrading into a guess.

### What `stamp` fixes

Upstream's `<user_message ...>` boundary carries **no time information at all**. Both constructors
in `lib/chat.js` take three arguments, with no moment anywhere in the signature:

```js
export function wrapUserMessage(content, userId, nickname) { … }            // lib/chat.js:133
export function buildGroupMessagePrefix(nickname, userId, mentioned) { … }  // lib/chat.js:109
```

The object `normalizeOneBot11(event)` returns in `lib/inbound.js` has no time field either — it
throws `event.time` away. So every message the model sees is "just now", with neither timestamp.

**Why it is needed**: the model **cannot reliably subtract two timestamps** — it readily turns
"two hours apart" into "a whole day has passed". That is the entire motivation for these two
attributes: hand over an interval that is already computed and the arithmetic is taken out of
the model's hands, leaving **no arithmetic it can get wrong**.

This module writes two attributes back onto the opening tag:

- `time="2026-10-08T15:15:23+08:00"` — the moment the other person **pressed send** (local time
  zone, with seconds; seconds are kept so two messages in the same minute can still be ordered and
  reliably subtracted).
- `gap="3m47s"` — how long since their previous message, **already computed**. The form is a
  compact, **space-free** duration with at most two highest whole units: `47s` / `3m47s` /
  `15h35m` / `2d4h`. No spaces so it passes the character whitelist below unchanged, and short
  enough to read at a glance.

**With no baseline yet, `gap` stays empty — no guessing.** Omitting an attribute beats printing an
interval the model will take as fact. So the "last inbound moment" has to survive a host restart
and is persisted (`stamp-state.json`, same directory and same pattern as `mood-state.json` /
`style-state.json`, debounced 3 seconds, atomic replace). Without persistence the baseline is
empty after a restart, the first message could only omit `gap`, and the model went off to read
the Elapsed line in the periodic aside — turning "two hours" into "a whole day" all over again.
The baseline table holds **at most 500 chats** (the same `MAX_CHATS`); past that, the least
recently active entries are evicted — without this cap the table would grow monotonically with
every chat this bot has ever heard from.

**Character whitelist**: both values are scrubbed with a regex — the timestamp keeps only digits
and `T:+-` (`replace(/[^0-9T:+-]/g, '')`), the interval only digits and `dhms`
(`replace(/[^0-9dhms]/g, '')`). That guarantees these two values can **never close the tag and
never escape the `<user_message>` boundary**. The rewrite touches only the **opening tag**; the
block's contents are not altered by a single character; and a same-named attribute is stripped
before writing, so repeated injection or a hot-reload re-entry never stacks a second `time=`.

**Why two attach points**: they have different jobs, and the two tables are meaningfully
**distinct**.

| Attach point | Does what | What it records |
| --- | --- | --- |
| `ChatBridge.prototype.handleInbound` | **Bookkeeping**: records the OneBot event's `time` (unix seconds) together with which chat it belongs to | `seenAt`: overwritten on every inbound, including messages later swallowed by a gate (non-@, dedupe, rate limit, commands) — it only answers "when did this chat last receive something" |
| `ChatBridge.prototype.dispatchFollowup` | **Injection**: writes the attributes into the text handed to the model | `baseline`: written only **after** a successful injection — the basis for `gap`; only messages that actually reached the model advance it, so deliveries like command receipts do not pollute it |

`dispatchFollowup` is already wrapped by `rhythm` (inbound coalescing). `core/patch.js` attaches
the **later wrapper on the outside**, so this module must come **after** rhythm in `scanAll()`:
that way each message passes through this module individually (each getting its own `time`/`gap`
for its own moment), and rhythm then merges the already-stamped messages into one batch. The other
order (this module inside) would only ever see the whole merged batch and could stamp a single
time on all of it.

The chatId is derived **using upstream's own `chat.js#buildChatId`**, never by copying that
construction — a copy would plant the trap "upstream changed the rule while we still compute ids
the old way", and a wrong id means recording the moment under **the wrong chat**. If that function
cannot be loaded the module **refuses to attach** rather than degrading into a guess. The inbound
moment is also sanity-checked (a plausible unix-second range covering 2001–2286) and falls back to
the current moment otherwise — a bad value must never stamp a message with a nonsensical clock.

> **One known gap left unfixed**: the group prefix `[HH:MM nickname(QQ)]` is untouched by this
> module — it uses the **processing** time, which differs from the `time` attribute by seconds,
> while rewriting the group prefix would mean wrestling with square brackets inside nicknames.
> Not worth it.

### The 10 behaviour rules

| id | Rule | Default |
| --- | --- | --- |
| `silent` | Express silence with `[[silent]]` only — never with text or parentheses | on |
| `aside` | Say only what you mean to say; full-line parenthesised asides marked "to the other person" | on |
| `image` | Images may be sent proactively (`qq_send_image`), but never invent local paths | on |
| `quarrel` | In a group argument, stay out of it by default — even when @-mentioned | on |
| `face` | Use emoji well, but don't overuse them or use them instead of talking | on |
| `tone` | Short spoken phrasing, no documents, never expose runtime state; carries **real-human benchmarks** (median 6 chars / 90% ≤20) and "send several short ones instead of one long one" | on |
| `voice` | When it runs long, say it with `qq_say` — but don't overuse it | on |
| `time` | Keep track of the time internally, but never announce it or invent gaps | on |
| `channel` | Tell private from group, and one speaker from another | on |
| `batch` | Answer several consecutive messages as one, not one reply each | on |

> `silent` is a **contract** with the `guard` module: the rule layer forbids expressing silence
> with parentheses so that guard's detector hits 100% of the time with no residue. Change this
> wording only together with guard's detection logic.

### Rhythm parameters

| Direction | Behaviour | Default |
| --- | --- | --- |
| Inbound | Messages from one chat collect in a quiet window and become **one** turn | 8s private / 3s group |
| Inbound | An **@** pierces the window immediately | on |
| Inbound | Hard cap on batching | 30s |
| Outbound | The final reply is split into a few short messages with typing delays | ≤20 chars each, ≤6 messages |
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

### Voice (`qq_say`)

**The requirement behind it**: "reply in one line if you can (within 20 characters), same as in
groups, and **when it runs long, send a voice message**" plus "**can the voice be changed? Make
it more mature**".

It provides the `qq_say` tool: given text, the plugin synthesises an mp3 with edge-tts and sends
it as a QQ voice message. Together with the `voice` rule, long content gets spoken.

> **Why not "auto-convert anything long to speech"**: which things are worth saying aloud and
> which are better typed is part of conversational judgement (reading out a one-line quip sounds
> odd). Automating the swap would take that judgement away, so the plugin only offers the
> capability and explains when to use it.

Voices (default `zh-CN-XiaoxiaoNeural`, the mature one):

| Voice id | Name | Character |
| --- | --- | --- |
| `zh-CN-XiaoxiaoNeural` | Xiaoxiao | Warm and mature (**default**) |
| `zh-CN-XiaoyiNeural` | Xiaoyi | Lively, girlish |
| `zh-CN-liaoning-XiaobeiNeural` | Xiaobei | North-eastern accent, forthright |
| `zh-CN-shaanxi-XiaoniNeural` | Xiaoni | Shaanxi accent, brisk |
| `zh-CN-YunxiNeural` | Yunxi | Bright youth |
| `zh-CN-YunyangNeural` | Yunyang | Steady announcer |
| `zh-CN-YunjianNeural` | Yunjian | Deep and powerful |

**Requirement (you install this yourself)**: a Python with `edge-tts` installed —
`pip install edge-tts`. The plugin itself adds **no Node dependency** and downloads nothing;
the Python process `qq_say` spawns reads the `edge-tts` you already have on this machine.

#### Three mechanics behind the voice

1. **Synthesis endpoint substitution.** edge-tts defaults to `speech.platform.bing.com`, and that
   host answers the synthesis WebSocket with **403** in many regions (upstream issue
   [rany2/edge-tts#490](https://github.com/rany2/edge-tts/issues/490)). The current fix is
   [PR #491](https://github.com/rany2/edge-tts/pull/491): use
   `api.msedgeservices.com/tts/cognitiveservices/websocket/v1` and pass the token as the
   **`Ocp-Apim-Subscription-Key`** query parameter (not the legacy `TrustedClientToken`).
   The plugin applies this with a **runtime shim** (an inline `python -c`), never touching
   site-packages — pip upgrades would overwrite it, the same trap as `node_modules`. The shim
   is idempotent: once upstream ships the fix the old host disappears and the replacement is
   skipped. **Both places must be patched**: `constants.WSS_URL` and the module-level constant
   that `communicate.py` binds via `from .constants import (... WSS_URL ...)` — changing only
   the former does nothing.

2. **Backoff retries.** The speech service is flaky, so the plugin retries with backoff
   (3 attempts, 800ms base). Voice is directly user-visible — one failure means she suddenly
   cannot speak — so retrying beats surfacing an error.

3. **Proxy variables are stripped.** edge-tts talks to Microsoft directly while the host often
   carries `HTTP(S)_PROXY` for the LLM upstream. The plugin deletes those six keys from the child
   environment. Stripping has no downside, so it stays as a defence.

## Requirements

- **DSH** (DeepSeek Harness) with [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq)
  installed and enabled (the target package; this plugin binds to its `0.9.x` internals).
- **Node.js ≥ 22**.
- **No third-party dependencies** — Node built-ins only.
- Voice needs `pip install edge-tts` on your side (see above).

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
curl.exe http://127.0.0.1:<port>/onebot-companion
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
    muteQueueNotice: true        # swallow dsh-onebot-qq's "⏳ task running" queue notice
    logHits: true

  adopt:
    enabled: true
    logAdoptions: true           # log an info line each time an existing session is adopted

  stamp:
    enabled: true
    injectTime: true             # inject time= (the moment the other person pressed send); off = gap only
    injectGap: true              # inject gap= (the already-computed interval since the previous message)
    logStamps: false             # log an info line per injection (useful for debugging, noisy day to day)

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
      maxChars: 20               # per-message character budget (real humans: median 6, 90% ≤20)
      maxChunks: 6               # at most this many messages; the tail folds into the last
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
    # "Proactive talk to me only — I am the admin." With allowAllUsers: true strangers can
    # DM too; without a whitelist she would proactively approach strangers.
    proactiveOnlyChats: []

  voice:
    enabled: true
    program: python              # the interpreter with edge-tts installed (absolute path is fine)
    voice: zh-CN-XiaoxiaoNeural  # see the voice table above
    rate: -5%                    # speech rate (edge-tts syntax)
    pitch: -10Hz                 # pitch
    maxChars: 120                # characters per utterance
    timeoutMs: 45000
    retries: 3                   # attempts including the first
    retryDelayMs: 800            # backoff base
    mediaDir: ''                 # voice output dir; empty = use config.mediaDir
```

> `packageName` / `profileDir` are propagated into all seven module sections automatically —
> you never repeat them.

### Where state lives

| File | Contents | Location |
| --- | --- | --- |
| `state.json` | This plugin's runtime state (which gates are attached, scan count, hit counts) | `$DSH_HOME/onebot-companion/` |
| `mood-state.json` | The four mood variables (one entry per chat) | `config.persona.mediaDir` |
| `style-state.json` | Style profiles (one entry per chat) | `config.persona.mediaDir` |
| `stamp-state.json` | The `gap` baseline (one entry per chat: the moment of the last injected message, at most 500, evicting the least recently active) | the `mediaDir` from the bridge's runtime config |
| `media_*.mp3` | Voice files synthesised by `qq_say` | `config.voice.mediaDir` |

Mood and style are **deliberately kept out of `state.json`**: `mediaDir` is where that
historical data already lives, so rewriting or swapping the plugin inherits it instead of
resetting days of accumulated affinity and style.

## HTTP surface

Everything is **loopback only** (anything not from `127.0.0.1` gets 403).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/onebot-companion` | Overall status: config, stats, attachments of all seven modules |
| GET | `/onebot-companion/hits?limit=` | Last 200 guard hits (original + cleaned text; covers all three kinds: `blocked` / `stripped` / `muted`) |
| GET | `/onebot-companion/mood` | Mood snapshot (per chat) |
| GET | `/onebot-companion/style` | Style snapshot (per chat) |
| GET | `/onebot-companion/voice` | Voice config, available voices, last failure reason |
| POST | `/onebot-companion/toggle` | `{"enabled": bool}` master switch |
| POST | `/onebot-companion/module` | `{"module":"guard\|adopt\|prompt\|rhythm\|stamp\|persona\|voice","enabled":bool}` |
| POST | `/onebot-companion/rule` | `{"id":"silent","enabled":false}` per-rule toggle |
| POST | `/onebot-companion/rescan` | Re-attach immediately |
| POST | `/onebot-companion/selftest` | Run guard's self-test (feed real text, see the verdict) |
| POST | `/onebot-companion/selftest-adopt` | Run adopt's self-test (never touches the real registry; 9 cases) |
| POST | `/onebot-companion/selftest-stamp` | Run stamp's self-test (pure-function cases for formatting, the whitelist and injection, plus the whole "bookkeeping → injection → baseline advance" chain, all on a fake proto — never touches the real bridge) |
| POST | `/onebot-companion/burst` | `{"text":"…","maxChars":20}` preview the split |
| POST | `/onebot-companion/seed-style` | `{"chatId":"private:745516569","profile":{…}}` seed an offline profile (statistics only, never raw lines) |
| POST | `/onebot-companion/unarchive` | `{"sessionId":"onebot-group-…"}` unarchive a Session; omit `sessionId` to release every archived `onebot-*` Session |
| POST | `/onebot-companion/say` | `{"text":"…"}` preview synthesis (writes the file, sends nothing) |
| POST | `/onebot-companion/reset-hits` | Clear hit records and counters |

## How it works

### Attaching: wrap prototypes at runtime, write nothing to disk

`core/patch.js` locates the target class by **absolute path** with `pathToFileURL()` and
`import()`s it, then wraps prototype methods. Why not
`require.resolve('dsh-onebot-qq/lib/outbound.js')`:

```
Package subpath './lib/outbound.js' is not defined by "exports"
```

Upstream's `exports` field exposes no subpaths, so building the absolute path is simpler.

**Module identity** is the premise of the whole approach: the namespace object returned by
`import()`ing the normalized `pathToFileURL` URL is the **same** one the host instantiates,
because the ESM module cache keys on the resolved URL. Wrapping a prototype method therefore
affects the host's real instances.

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
- Moment bookkeeping throws → the inbound flow is untouched (a failed record just means one
  missing interval); a failed injection → **the original text is delivered**, not one character
  lost.
- Every timer is `unref()`ed, so a pending batch never pins the host process.

## Known limits

- **Attach points bind to 0.9.x internals.** If upstream renames `sendToChat` / `sendMsg` /
  `dispatchFollowup` / `handleInbound` / `onSessionEvent`, the matching module silently stops
  working. The `pollMs` scan records losses in `lost` but does not adapt.
- **Swallowing the "⏳ queue notice" means the other side gets no acknowledgement.** While a long
  task runs, several incoming messages leave the chat completely silent — no "received, queued"
  feedback at all. That is exactly the cost of `guard.muteQueueNotice` (on by default). Set it to
  `false` to bring the notice back.
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
- **Splits happen only at punctuation and English spaces.** The splitter prefers sentence ends
  (`。！？…`) and falls back to commas, enumeration commas and semicolons for over-long
  sentences. **A space inside Chinese prose is not a break point** — the typographic spaces in
  "攒了 100 多块" or "7 月到 10 月" sit between digits and Han characters, and splitting there
  cuts a word in half. English sentences are unaffected and still break on spaces.
- **Text-image cards are never split**: when `textImageThreshold` kicks in the whole reply goes
  as a card, which is already a single message.
- **Proactive talk is pull-based**: the host exposes no public API for a plugin to start a turn
  on an idle session, so the scheduler only works while an active chat table exists.
- **Mood variables are time-integrated**, so persisted values carry IEEE-754 float tails
  (`56` may be `55.99999722222222`). That is expected, not a bug.
- **Voice depends on an external service.** `qq_say` shells out to Python + edge-tts, which talks
  to a Microsoft endpoint that is unofficial and has already changed once (see the voice section).
  When it breaks, `qq_say` returns a plain error and nothing else is affected — and `/voice`
  shows the last failure reason.
- **Each synthesis spawns a Python process** (a few hundred ms plus network). Calls are
  serialised, so a burst of `qq_say` calls queues up rather than running in parallel.
- A personal tool; compatibility with other third-party OneBot implementations is not guaranteed.

## License

[MIT](./LICENSE) © 2026 xfgil

---

*A personal plugin, written to a "good enough" standard. Evaluate before production use.*
