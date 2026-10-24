# dsh-onebot-companion

> One plugin that gives a QQ channel its manners back: **outbound silence guard + per-turn behaviour rules + conversation rhythm + persona + voice + session-adoption guard + timestamps**.

> ⚠️ **This English README is a partial translation.** It still describes an older snapshot
> (11 modules, 12 rules). The plugin now has **17 modules and 14 rules** — including `linkcard`
> (restoring QQ share-card titles/URLs), `hands` (poke / react / like / request approval gate),
> `qq_profile`, `qq_intimate`, `diary` (her notebook, graded forgetting), `promise` (things she
> said she'd do), `tier` (relationship stages), `lastword` (when she last actually spoke) and
> `physical` (the health-board data surface). **The Chinese [README.md](./README.md) is
> authoritative** for module lists, rule text and configuration; this file is accurate for
> installation, upgrade resistance, HTTP surface and the core concepts it does cover.

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
| 11 behaviour rules | injected each turn by `prompt` |
| Session-adoption guard | the `adopt` module |
| Timestamps and gaps (`time=`/`gap=`) | the `stamp` module |
| Calling her name in a group counts as being addressed | the `mention` module |
| Chiming in when the group talks about something she cares about | `mention`'s `topics` |

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

The result: **one package, one config block, one HTTP surface**, split internally into eleven
modules that can each be toggled independently.

## What it does

| Module | Does what | Attaches to |
| --- | --- | --- |
| `guard` | Outbound gate: blocks `[[silent]]`, strips whole-line parenthetical asides, swallows the "⏳ task running" queue notice and the "admin only" receipt; sends nothing if the result is empty | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |
| `adopt` | Session-adoption guard: when a bare id still owns an on-disk log, **adopt** it (resume) instead of retiring it forever and starting a brand-new session | `ChatRegistry.prototype.createChat` |
| `stamp` | Adds back `time="..."` (the moment this message was sent) and `gap="..."` (the interval since the previous one, e.g. `3m47s`) at the injection boundary, so the model never has to subtract timestamps itself | `ChatBridge.prototype.handleInbound` (bookkeeping) + `ChatBridge.prototype.dispatchFollowup` (injection) |
| `prompt` | Injects 12 behaviour rules + a mood line + a style line each turn | host `agent/pre-step` (no prototype) |
| `rhythm` | Inbound coalescing + outbound bursting | `ChatBridge.prototype.dispatchFollowup` / `sendToChat` |
| `persona` | Four mood variables + randomised proactive talk + style learning | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |
| `mention` | Group wake-up: calling her name counts (`diving` for follow-ups) + chiming in when a topic she cares about comes up (`topics`) | `InboundPipeline.prototype.processInbound` |
| `isolation` | Denies every tool during non-admin group turns (leaving only speech tools plus whitelisted `read_image`) | host `ctx.tools.guard()` (no prototype) |
| `emoji` | Replaces upstream's mistranslated emoji with `[表情:name]`; turns the discarded sticker images back into readable pictures; drops a message whose native face it cannot identify | `InboundPipeline.prototype.processInbound` |
| `sleep` | Sleep gate: after she says goodnight, in groups only an @ or her name gets through; private chats unaffected | `InboundPipeline.prototype.processInbound` (priority 30, outside `mention`) |
| `voice` | The `qq_say` tool: text → synthesis (edge-tts cloud or local IndexTTS) → sent as a QQ voice message | registers a tool only; attaches to no prototype |
| `lastword` | Records when she last genuinely said something, plus the text and a running total. Changes no arguments, throws nothing | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |

Eleven of the seventeen modules wrap prototypes, and they **share mount points** (`dispatchFollowup`
carries stamp + rhythm, `handleInbound` carries stamp + persona, `processInbound` carries
sleep + mention + emoji + linkcard + hands). They coexist via module-identity tags in `core/patch.js` without
swallowing one another, and their order on the chain is decided **solely by module priority**,
never by attach timing.

> `sleep` has priority **30** (above `stamp`'s 20) and must sit **outside** `mention`:
> `mention` fabricates an `at` segment for messages that merely call her name, so if
> `sleep` were inside, the gate would already see "she was mentioned" and never close.

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

When the bare id (e.g. `onebot-group-900000002`) **still owns a history log on disk**, it does not
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

### What `mention` fixes

`dsh-onebot-qq/lib/cq.js`'s `detectMention` recognises exactly two things: an `at` segment aimed
at the bot, or a `reply` segment quoting the bot. **Typing "云玥" in a group does not count.** That
is not how a real group chat behaves — humans know they are being called when they hear their
name. The module adds three criteria around `InboundPipeline.prototype.processInbound`:

| Criterion | Does what | Default |
| --- | --- | --- |
| Name-calling | Any of `names` (default `云玥` / `玥玥` / `Yara`) appears in the text → treated as addressed | on |
| `diving` | For a short while after being woken, she will also jump in when not @-mentioned, then dives back | off |
| `topics` | Chiming in on her own when the group talks about something she cares about (see below) | off |

**How "she heard it" is expressed**: an `{ type: 'at', data: { qq: bot } }` segment is appended to
`inbound.segments`, reusing the upstream "was @-mentioned" semantics — `detectMention`'s `at`
branch returns true, the `requireMention` gate lets it through, the group prefix gains `[@我]`, and
the model sees "someone called for you". Inventing a second "being addressed" vocabulary would
just break when upstream changes how @ is handled.

> Verified: `inbound.segments` has **exactly one consumer in the whole package** —
> `detectMention` at `inbound.js:119`. Appending a segment therefore only affects that one
> criterion; it never pollutes the body, media or quote expansion (the body was already computed
> into `inbound.text` back in `normalizeOneBot11`).

**A bug fixed along the way**: `cq.js` renders an `at` segment as a **bare QQ number**
(`@100000002`), so all she saw was an unfamiliar number. Worse, the rule layer used to say "the
number after @ is the person being mentioned", which made her file *her own* id under "someone
else" — that is exactly what happened at 2026-10-16 23:10: the group prefix said `[@我]`, her
reasoning said "nobody @-ed me", and she stayed silent the whole time. Now a bare id in the body
that points at **her** is rewritten to `@你` (`rewriteSelfMention`, other people's numbers left
alone), and the rule layer adds "`@你` means you".

**Topic chiming (`topics`)**: on 2026-10-17 the user asked for "a few directions she might find
interesting, so she can join in when the group brings them up". This is **speaking up in a group
on her own**, so like `diving` it is off by default. Once on, it is still not "let every group
message through" — six gates must be passed:

| Gate | Does what | Default |
| --- | --- | --- |
| Keyword hit | A specific word she cares about appears in the text | 7 groups, see `DEFAULT_TOPIC_GROUPS` |
| Message length | Anything shorter than `minChars` is not matched | 4 chars |
| Dice roll | A hit is not an obligation to reply | `chance` 0.4 |
| Per-group cooldown | Minimum gap between two chimes in the same group | 30 minutes |
| Daily cap | At most this many per group per day | 3 |
| Quiet hours | Complete silence during this window | 1:00–8:00 |
| Group whitelist | When `chats` is non-empty, only those groups qualify | `[]` = all |

The one message that gets through carries an explanatory line at the end of the body
(`topicHint`): `[群里在聊「猫」，你正好感兴趣就自然接一句；不想接就回 [[silent]]]`. It has to be
spelled out — the gate borrows the "was @-mentioned" semantics, so the group prefix gains `[@我]`
and without the explanation she would ask "what did you call me for".

Keyword groups are **merged**, not replaced (`normalizeTopics`): when the user writes
`mention: { topics: { enabled: true } }`, `mergeConfig`'s shallow merge drops the whole `topics`
object, so the module restores the missing keys itself; `groups` gets an extra merge layer, so
adding a group does not disturb the default ones and writing `[]` for a group turns it off.

**Two separate window maps**: `awake` covers `diving` only, `topicAwake` covers topic chiming
only. Sharing one map makes it impossible to tell *which* criterion opened a window, and then
"diving is off so she should stay quiet" gets silently broken by a topic window (caught by the
self-test). By the same logic, a real @ **advances the diving window only, never the topic
window** — otherwise one @ would grant that group ten minutes of free-for-all, which is exactly
the "randomly chiming in on groups" the user explicitly rejected.

**What this module does not do**: it never touches reply segments. Upstream's reply branch is
fail-open (`const qq = seg.data.qq ?? ''; if (qq === '' || qq === bot) return true;`), and
NapCat's reply segment carries only an `id`, never `qq` — so "A quotes B" in a group is judged as
@-ing the bot. Fixing it means either an RPC to `get_msg` (the user rejected that) or tightening
it to "quoting anyone never counts" (which would miss "quoting 云玥") — the trade-off is left to
the user. It is **also offline**: every criterion is local string matching plus in-memory state,
zero RPC, zero dependencies.

### The 12 behaviour rules

| id | Rule | Default |
| --- | --- | --- |
| `silent` | Express silence with `[[silent]]` only — never with text or parentheses | on |
| `speak` | When to speak up in a group: being named/questioned/interested/moved — don't default to "not about me", but never force a reply either | on |
| `aside` | Say only what you mean to say; full-line parenthesised asides marked "to the other person" | on |
| `image` | Images may be sent proactively (`qq_send_image`), but never invent local paths | on |
| `quarrel` | In a group argument, stay out of it by default — even when @-mentioned | on |
| `face` | Use emoji well, but don't overuse them or use them instead of talking | on |
| `tone` | Short spoken phrasing, no documents, never expose runtime state; carries **real-human benchmarks** (median 6 chars / 90% ≤20) and "send several short ones instead of one long one" | on |
| `voice` | When it runs long, say it with `qq_say` — but don't overuse it; make it sound like speech first | on |
| `time` | Keep track of the time internally, but never announce it or invent gaps | on |
| `channel` | Tell private from group, and one speaker from another; `@你` means her | on |
| `batch` | Answer several consecutive messages as one, not one reply each | on |
| `topic` | Being dropped into a group to look at a topic does not oblige her to speak — `[[silent]]` is fine | on |

> `silent` is a **contract** with the `guard` module: the rule layer forbids expressing silence
> with parentheses so that guard's detector hits 100% of the time with no residue. Change this
> wording only together with guard's detection logic.

> `speak` fills a gap found on 2026-10-17: with `requireMention: false` (every group message
> reaches the model, she decides whether to answer), the prompt had **5** rules on how *not*
> to speak and **zero** on when to speak — so the cheapest strategy was staying silent
> (measured: 4 silent turns out of 19, 21.1%). This rule gives concrete, checkable cues
> (named / questioned / interested / moved) while keeping "never force a reply", so it can't
> slide into a spam bot. It sits right after `silent` so "how to be silent" and "when to
> speak" are adjacent.

### `isolation`: hard tool gate for non-admins in groups

Measured incident, 2026-10-17: a group member (`2665507357`) @-mentioned her asking "what's
in the working directory", and she ran `ops_bash {"command":"ls -a","workdir":"D:\\Documents\\yunyue"}`,
posting the host's real directory listing into the group. The asker was a member, not the admin.

Upstream has `restrictedMemberPrefix` (tags non-admin messages `[受限用户:仅问答]` and adds one
prohibition line to the prompt), but that is a **prompt-level constraint** — a disobedient model
still executes, and the incident itself proves it doesn't hold.

This module uses the host's `ctx.tools.guard()` as a hard gate (host docs: "A denial that must
hold regardless of order is a `ctx.tools.guard()`"; signature
`guard(guard: ToolGuard): () => void` where
`ToolGuard = (execution) => string | undefined` — **returning a string denies**, order-independent
and HMR-safe).

The verdict keys on **the sender of the current turn**, not the session — in a group the admin
and members share one session, so gating per session would lock out the admin too. Two criteria,
union:

1. the message carries the `[受限用户:仅问答]` prefix (upstream already judged it non-admin);
2. the `qq="X"` in `<user_message qq="X">` is not in `adminUsers`.

The union means the gate does **not** depend on the `restrictedMemberPrefix` switch — flip it
back to `false` and the hard gate still holds.

Restricted turns may still use three tools by default: `qq_say` (voice), `qq_send_face`
(emoji) and `read_image` (view images group members send). `read_image` also passes a
**path allowlist** — it may only read files under `mediaDir` (default
`D:\Documents\yunyue\.dsh-media`), anything else is denied. That allowlist exists to fix the
2026-10-18 "she says the image is blank" bug: she genuinely could not see images members sent,
because her own hard gate blocked `read_image`. Everything else is denied — `ops_*` touches
files and shell, search touches the network, and both would leak host or outside-world facts
into the group.

### `emoji`: native QQ faces and stickers

**Native QQ faces (the `face` segment)**: upstream `cq.js` turns them into an emoji character,
but its `FACE_EMOJI` table maps ids as if they were emoji codepoints and is broadly wrong (123
of 329 ids fall back to `😀`, the rest are semantically off). Measured: the owner sent
`/变形` (id=312) → the table says 🐳 → she replied "you sent a whale again".

This module strips that wrong emoji at the `InboundPipeline#processInbound` entry and replaces
it with `[表情:变形]`. Names come from `lib/modules/face-names.js` (329 id→name entries, sourced
from NapCat's `sysface-full.json`, zero mismatches against the outbound `faces.js` table of 321).

**Deliberately does not download faces as images.** The QQ emoji CDN
`qzonestyle.gtimg.cn/qzone/em/e<id>@2x.gif` looks usable, but pixel-level checking showed its
`e<id>` is **a different id space from sysface ids**:

| id | sysface name | what the CDN actually returns |
| --- | --- | --- |
| 182 | 笑哭 (laugh-cry) | a hand making a V sign |
| 312 | 变形 (transform) | a smiley wearing a golden crown |
| 106 | 委屈 (aggrieved) | a cartoon baby photo |
| 99 | 鼓掌 (applause) | a 1×1 blank pixel |

"Name says transform, image is a crowned smiley" is worse than a name alone. So only the name
is emitted by default; `downloadFaces: true` opts into images (for when the id spaces are
confirmed to match).

**Sticker mall images (`image` segment with `sub_type === '1'`)**: upstream `cq.js:150` drops
them entirely, leaving only the four characters `[表情包]`. This module restores them as
`[表情包][图片:local-path]` — their url comes from QQ itself and therefore always matches the
content, so they are still downloaded.

**Unrecognised faces → the whole message is dropped** (`muteUnknownFaces`, on by default). The
test is simply whether the native face id exists in that 329-entry table: a known id emits
`[表情:笑哭]` and replies as usual; an unknown one emits `[表情:id=9999]` as a traceable marker
and then the **entire message is swallowed** (`return undefined`, upstream never called).
Stickers are real images and count as readable, so they never trigger this.

> The drop has to be a direct return from the wrapper, not "rewrite the text and hope she stays
> quiet": the latter still burns a full generation and only relies on the prompt, which fails
> exactly when she is most talkative. A test pins this down (upstream call count must be 0).

Counters live in `modules.emoji` on `/status`: `muted` and `lastMuted` (with `ids` / `chatId` /
`at`) — those are what you check when wondering why she has been so quiet.
`muteUnknownFaces: false` turns it off.

### `sleep`: the goodnight gate

**The problem**: she says "I can't keep going, going to sleep for a bit" or "goodnight", and
then keeps answering every following group message. Between 15:11 and 15:12 she posted four
messages in a row, sounding progressively more awake.

**Prompting cannot fix this**: `[[silent]]` only suppresses *that one* reply; the next message
is a brand-new, still-exhausted generation. `sleep` decides *before the message enters the
pipeline*, so while she is asleep those messages never become turns at all.

Three ways to fall asleep — any one is enough:

| Trigger | Rule |
| --- | --- |
| She said a sleep word | `matchSleepWord(text)` hits `SLEEP_WORDS` (goodnight / going to bed / sleepy / can't keep going …) |
| Energy bottomed out | `moodOf(chatId).energy <= energyThreshold` (default 25) |
| Quiet at night | inside `[nightStartHour, nightEndHour)` (default 0–8) with the chat quiet for a while |

**How long she sleeps depends on the time of day**: daytime (`dayStartHour`–`dayEndHour`,
default 7–23, end exclusive) is only a nap of `daytimeDurationMs` (default 1 hour); any other
time sleeps the full `durationMs` (default 7 hours). A "going to sleep for a bit" at 3pm should
not silence her until 10pm.

| She says it at | Asleep for |
| --- | --- |
| 15:12 | 60 min |
| 23:40 | 420 min |
| 06:59 | 420 min |
| 07:00 | 60 min |

While asleep, **only these get through in groups**: a message with an `at` segment pointing at
her own QQ (an `atall` does not count), or text that calls her name (names come from
`mention.names`). **Private chats always pass** — a DM to her is a DM to her. Being @'d or
named also wakes her (`stats.sleepWoke`, table cleared) rather than leaving the gate shut.

The sleep expires on its own (1 hour by day / 7 hours at night, see the table above);
`enabled: false` disables the whole module.

> Priority **30**, outside `mention` (10) — see the note under "What it does".

### `diary`: a notebook with graded forgetting (2026-10-19)

**The problem**: memory is blocked at both ends — session logs are **kept forever**
(`session.v4.jsonl.zstd` never shrinks) while the context is **fully compressed**
(compaction turns details into a summary). The middle layer is missing: nowhere for her
to write down what *she* decided to remember, look back at it, and let it fade naturally.

Remembering everything is itself a distortion. A throwaway remark three days ago and a
long conversation last month should not have the same shelf life.

`qq_diary` gives her one table, three levels:

| Level | Retained | When to use it |
| --- | --- | --- |
| `normal` | 7 days | Everyday trivia: what was eaten, which class today |
| `important` | 30 days | Worth keeping: his worries, things agreed on, things he cares about |
| `critical` | forever | Things that define the relationship: his limits, important dates, his choices |

Three actions: `write` (one entry, in her own voice), `list`, `forget`. **Only she writes
it**, never an automatic transcript of the chat — auto-summarising grows a pile of
"the user said X" ledger lines, which is a second copy of the log, not a diary.

Injection is bucketed by level with a per-level cap (default normal 3 / important 5 /
critical 6) and only the most recent entries, so the context doesn't blow up. The table
has a hard cap of 400 entries; overflow evicts expired first, then lower levels, then oldest.

State file `diary-state.json`, next to `mood-state.json` (mediaDir).

### `promise`: things she said she'd do (2026-10-19)

**The problem**: she says "I'll take a look in a bit" or "remind you tomorrow", and then
nothing happens. Flakiness isn't malice — there is simply **nowhere to store the promise**;
every turn is generated in a context that owes nobody anything.

`qq_promise` records what she promised: `add` / `list` / `done` / `drop`. Due 24 hours
later by default; once due it is injected into the prompt and **injection consumes it**
(`consumeReminders`) — one promise reminds at most 3 times (`MAX_REMINDERS`), then goes
quiet. Without consumption she'd still be apologising for the same sentence three days later.

Settled records are kept 3 days before being dropped, so "already agreed" isn't recorded twice.
State file `promise-state.json`.

### `tier`: relationship stages (2026-10-19)

`affinity` is continuous (+1.5 per received message, −0.8 per silent hour). The maths is
fine, but it is **perceptually flat**: 62 and 68 mean nothing different to a relationship,
and a model handed a number cannot act out the difference between "we're getting closer"
and "we're really close".

Real relationships are stair-stepped — and the steps aren't an illusion of the number, they're
the **boundaries of what's permitted** widening.

| Lower bound | Stage | What's allowed |
| --- | --- | --- |
| 0 | Not close yet | Polite, don't presume; curious is fine, don't pry |
| 15 | Slightly acquainted | Small jokes, occasional complaints; still no overstepping |
| 35 | Acquainted | Start conversations, tease him, bring up small things he mentioned |
| 55 | Close | Whining is fine, managing him is fine (eat, sleep) |
| 75 | Very close | Possessiveness and jealousy allowed; silence together allowed |
| 90 | His only | He comes first; dependence is fine, don't turn it into a clingy template |

Pure projection, zero side effects: `tier.js` reads no state and writes none — it turns the
`affinity` computed by `mood.js` into a stage plus one line of "what's allowed at this
stage", riding the same injection as `prompt`'s `extra`. It **deliberately never states the
number** — state it and the model starts reporting "our intimacy is 62" in chat.

The stage boundaries live in exactly one place; retune the pacing by editing `TIERS[].min`.

> Why not inside `mood.js`: that file's random-number consumption count is asserted
> line-by-line by unit tests, so touching it is asking for trouble; computing and
> interpreting should be decoupled anyway.

### `lastword`: when she last actually spoke (2026-10-19)

The single most informative line on the health board. **A live process is not the same as a
working one**: an agent stuck on a step, an upstream model timing out, a session blocked by
something else — in all of those every "√ enabled" still reads green, and only "she hasn't
said anything for three hours" gives it away.

Nothing else answered that question: `burst.replies` only counts bursts, `voice.lastSentAt`
only updates on voice messages, `faces` only counts emoji. So it gets its own module on the
one outbound chokepoint, `OutboundPipeline.prototype.sendToChat` / `sendMsg`. It is *not* part
of `guard` on purpose: `guard` is a gate that can be switched off, and this record must not
freeze at a stale value precisely when the gate is off.

**It has to be persisted, and read back synchronously.** `lastWordAt` is the board's main
indicator; if it resets with every process restart the board will forever say "she hasn't said
anything yet" — losing accuracy exactly when she is stuck and that line matters most. So it is
stored in `state.json` and read back with `store.loadSync()` at startup.

Why not the async `store.load()`: a `persist()` fires the moment the prototype patch lands, and
`JsonStore.loadFrom` is **memory-first** (existing keys are not overwritten, otherwise a debounced
flush would write stale values back over fresh ones). The empty snapshot written first therefore
shadows the on-disk one and the async load skips the whole key. This bug really happened — symptom:
"after a restart it always says she hasn't spoken yet".

`restore(snapshot)` carries two easy-to-miss rules: `recent` is **cleared before loading** (this
is a move, not an append, otherwise the sync and async restore paths each add a copy), and a
missing or `null` snapshot **must restore as empty** rather than returning early — `stats` lives
on `globalThis` and survives hot reload, so skipping the clear leaves last generation's values
pretending she just spoke.

### `physical`: the health board (2026-10-19)

`/physical` is the **only endpoint that allows cross-origin reads** (`access-control-allow-origin: *`,
GET only): it serves a local `file://` html page whose origin is `null`. The scope is
deliberately one path — other endpoints have POSTs that change runtime configuration.

`buildPhysical(deps)` is a **pure projection**: it assembles already-computed snapshots (mood,
diary, promises, last word, patch records, errors) into one flat object. No judgement, no state
writes — tests feed it fake data directly.

`link.connected` tries three sources: first the outbound `ctx.connected()` remembered by
`lastword` (still valid after a hot reload, and it is exactly what the outbound pipeline itself
consults before sending or queueing), then `lastReceiver.deps.connection.connected`, and only
`null` if neither answers. **`null` means unknown, not disconnected** — the board shows "unknown"
rather than "disconnected" so it never claims something it cannot know.

> No health score, no traffic lights on purpose. A 0–100 score invites chasing the score, while
> what actually matters is the raw fact of how long ago she last spoke.

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

It provides the `qq_say` tool: given text, the plugin synthesises audio and sends it as a QQ
voice message. Together with the `voice` rule, long content gets spoken.

Synthesis has **two backends**, switched with `voice.backend`:

| `backend` | Where it runs | What you need | Good for |
| --- | --- | --- | --- |
| `edge` (default) | Microsoft edge-tts (cloud) | a local Python with `edge-tts` | works out of the box, no VRAM |
| `local` | a resident **IndexTTS-2.5** service on this machine | an NVIDIA GPU (8 GB VRAM+) plus 5.2 GB of weights | voice cloning, fully offline, livelier prosody |

See [Local backend (IndexTTS-2.5)](#local-backend-indextts-25) below.

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

**Requirement for the default backend (you install this yourself)**: a Python with `edge-tts`
installed — `pip install edge-tts`. The plugin itself adds **no Node dependency** and downloads
nothing; the Python process `qq_say` spawns reads the `edge-tts` you already have on this machine.
The `local` backend needs no Python package here — only the resident service described below.

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

#### Local backend (IndexTTS-2.5)

With `backend: local` the plugin **spawns no Python**. It posts one sentence to a resident HTTP
service on this machine:

```
plugin  --POST /tts {text, ref}-->  http://127.0.0.1:7862  -->  D:\...\outputs\tts_<ts>.wav
```

**Why it has to be resident**: the IndexTTS weights are 5.2 GB and take tens of seconds to minutes
to load (disk read), while one sentence synthesises in 4–6 s. Spawning per sentence would mean
waiting for a model load before every utterance — unusable for chat. The model lives in its own
process; the plugin only sends text and gets back a wav path.

The server script lives with the IndexTTS checkout (not bundled here). Endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /ping` | `{ok, loaded, loading, error, device, loadMs, ref}` |
| `GET /refs` | list `voices/*.wav` with durations |
| `POST /tts` | `{text, ref?, emo?, emo_alpha?, out?}` → `{ok, path, bytes, seconds, costMs}` |

Synthesis is **serialised** (one lock server-side) to keep VRAM and threads from fighting — fine
for a single conversation.

Config:

```yaml
  voice:
    backend: local
    localUrl: 'http://127.0.0.1:7862'
    ref: 'D:\ruanjian\indextts\voices\yara.wav'   # reference clip for cloning (3–15 s of clean speech)
```

**Changing it at runtime**: the plugin config in `cordis.yml` is read into the loader **at
startup**; editing the file does not hot-apply (`dsh-hot-reloader` only watches source files).
Swapping a voice is a try-it-out operation, so there is an endpoint:

```powershell
Invoke-RestMethod 'http://127.0.0.1:5931/onebot-companion/voice-config' -Method Post `
  -ContentType 'application/json' `
  -Body '{"backend":"local","ref":"D:\\path\\to\\voice.wav"}'
```

It changes the live in-memory config and **does not write back to yml** — after a restart the yml
wins again.

`/say` synthesises without sending, handy for auditioning:

```powershell
Invoke-RestMethod 'http://127.0.0.1:5931/onebot-companion/say' -Method Post `
  -ContentType 'application/json' -Body '{"text":"Hi, I am Yara."}'
```

> Works for both backends: `edge` writes an mp3 under `mediaDir`, `local` writes a wav under the
> server's `outputs/`.

## Requirements

- **DSH** (DeepSeek Harness) **0.2.0-rc.2 or newer, below 0.3.0** (developed and verified on
  0.2.1-rc.2 / Electron 44) with [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq)
  installed and enabled (the target package; this plugin binds to its `0.9.x` internals).
- **Node.js ≥ 22**.
- **No third-party dependencies** — Node built-ins only.
- Voice needs `pip install edge-tts` on your side for the default `backend: edge` (see above);
  switching to `backend: local` additionally needs an NVIDIA GPU with 8 GB+ VRAM and the IndexTTS
  service.

## Install

### 1. Get the plugin

```powershell
git clone https://github.com/xfgil/dsh-onebot-companion.git D:\path\to\plugins\dsh-onebot-companion
```

No git? Download `Source code (zip)` from the
[latest release](https://github.com/xfgil/dsh-onebot-companion/releases/latest) and unpack it instead.
This plugin is **not published to npm**, so `npm i` / `dsh plugin add` is not a supported channel —
it is meant to be `link:`-ed into your profile (see next step).

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
    muteAdminOnlyNotice: true    # swallow "该命令仅管理员可用。" (framework reply when a member sends a slash command)
    logHits: true

  adopt:
    enabled: true
    logAdoptions: true           # log an info line each time an existing session is adopted

  mention:
    enabled: true
    names: [云玥, 玥玥, Yara]     # calling these in a group counts as addressing her; [] disables it
    diving:
      enabled: false             # diving: for a short while, she joins in without being @-mentioned
      awakeMs: 300000
    logMentions: true
    topics:
      enabled: false             # chime in when the group brings up something she cares about (off)
      chats: []                  # group whitelist; [] = any group. Group number or group:xxx
      chance: 0.4                # the dice still rolled after a keyword hit
      cooldownMs: 1800000        # minimum gap between two chimes in the same group
      maxPerDay: 3               # per group, per day
      minChars: 4                # messages shorter than this never match
      quietStart: 1              # quiet hours (wraps midnight; start === end disables it)
      quietEnd: 8
      awakeMs: 600000            # after a chime, this long of unrestricted follow-up in that group
      groups: {}                 # keyword groups, **merged**: adding one keeps the defaults,
                                 # writing [] disables a group. The 7 defaults: anime/TV,
                                 # cats, gaming, coffee & food, music, slacking off, gossip

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

  isolation:
    enabled: true
    # Tools still allowed during a non-admin group turn (speech only + reading images members sent)
    allowedTools: [qq_say, qq_send_face, read_image]
    # Boundary for read_image: only files under this dir. Empty = deny all (not unrestricted)
    mediaDir: D:\Documents\yunyue\.dsh-media
    # Admin fallback; normally read live from dsh-onebot's adminUsers
    adminUsers: ['100000001']

  emoji:
    enabled: true          # render faces/stickers as a Chinese name (plus a local path for stickers)
    names: true            # false = only [表情:id=N], no name
    muteUnknownFaces: true # an unrecognised native face drops the whole message (play dead)
    downloadFaces: false   # download face images (off by default — the image CDN's ids are a different set)
    maxPerMessage: 6       # cap per message, so a face spam burst cannot blow up the prompt

  sleep:                   # goodnight gate: after "goodnight", groups need an @ or her name
    enabled: true
    durationMs: 25200000        # sleep 7 hours at night
    daytimeDurationMs: 3600000  # only a 1-hour nap during the day
    dayStartHour: 7             # daytime window (end exclusive): 7:00–23:00
    dayEndHour: 23
    energyThreshold: 25    # energy at or below this also counts as asleep
    autoByMood: true       # false = only the "said a sleep word" trigger
    logWake: true          # log a line when an @ wakes her
    nightStartHour: 0
    nightEndHour: 8

  diary:                   # notebook: what she chooses to remember, three levels, expires
    enabled: true
    injectNormalMax: 3     # per-level cap when injecting
    injectImportantMax: 5
    injectCriticalMax: 6
    maxEntries: 400        # hard cap; overflow evicts expired, then low levels, then oldest
    maxTextChars: 200      # per-entry cap (truncated), so the model can't dump a wall of text
    stateFile: diary-state.json

  promise:                 # promises she made; becomes a reminder once due
    enabled: true
    injectMax: 4           # at most this many due promises per injection
    maxEntries: 100
    maxTextChars: 120
    defaultDueHours: 24    # default delay when no dueAt is given
    stateFile: promise-state.json

  tier:                    # relationship stages: projects affinity onto steps
    enabled: true

  voice:
    enabled: true
    # edge = Microsoft edge-tts (cloud); local = resident IndexTTS service (see above)
    backend: edge
    localUrl: 'http://127.0.0.1:7862'   # service address when backend=local
    ref: ''                        # reference wav for cloning when backend=local
    emo: ''                        # optional: emotion reference clip
    emoAlpha: 1                    # emotion strength 0–1 (only with emo set)
    program: python              # the interpreter with edge-tts installed (backend=edge only)
    voice: zh-CN-XiaoxiaoNeural  # see the voice table above (backend=edge only)
    rate: -5%                    # speech rate (edge-tts syntax)
    pitch: -10Hz                 # pitch
    maxChars: 120                # characters per utterance
    timeoutMs: 45000
    retries: 3                   # attempts including the first
    retryDelayMs: 800            # backoff base
    mediaDir: ''                 # voice output dir; empty = config.mediaDir (backend=edge only)
```

> `packageName` / `profileDir` are propagated into all seventeen module sections automatically —
> you never repeat them.

### Where state lives

| File | Contents | Location |
| --- | --- | --- |
| `state.json` | This plugin's runtime state (which gates are attached, scan count, hit counts) | `$DSH_HOME/onebot-companion/` |
| `mood-state.json` | The four mood variables (one entry per chat) | `config.persona.mediaDir` |
| `style-state.json` | Style profiles (one entry per chat) | `config.persona.mediaDir` |
| `stamp-state.json` | The `gap` baseline (one entry per chat: the moment of the last injected message, at most 500, evicting the least recently active) | the `mediaDir` from the bridge's runtime config |
| `diary-state.json` | Her diary (three levels, expired entries pruned automatically) | `config.persona.mediaDir` |
| `promise-state.json` | Promises made (open/done/dropped) | `config.persona.mediaDir` |
| `media_*.mp3` | Voice files synthesised by `qq_say` | `config.voice.mediaDir` |

Mood and style are **deliberately kept out of `state.json`**: `mediaDir` is where that
historical data already lives, so rewriting or swapping the plugin inherits it instead of
resetting days of accumulated affinity and style.

## HTTP surface

Everything is **loopback only** (anything not from `127.0.0.1` gets 403).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/onebot-companion` | Overall status: config, stats, attachments of all eleven prototype mount points |
| GET | `/onebot-companion/hits?limit=` | Last 200 guard hits (original + cleaned text; covers all three kinds: `blocked` / `stripped` / `muted`) |
| GET | `/onebot-companion/mood` | Mood snapshot (per chat) |
| GET | `/onebot-companion/style` | Style snapshot (per chat) |
| GET | `/onebot-companion/voice` | Voice config, available voices, last failure reason |
| GET | `/onebot-companion/diary` | Diary snapshot (counts, levels, most recent entries) |
| GET | `/onebot-companion/promise` | Promise snapshot (open / done / due-but-unmentioned) |
| GET | `/onebot-companion/lastword` | When she last spoke, the text, and the running total |
| GET | `/onebot-companion/physical` | Health-board data surface (**cross-origin readable**, for the local html page; every other endpoint stays loopback only) |
| POST | `/onebot-companion/toggle` | `{"enabled": bool}` master switch |
| POST | `/onebot-companion/module` | `{"module":"guard\|mention\|adopt\|prompt\|rhythm\|stamp\|persona\|voice\|isolation\|emoji\|sleep\|lastword\|diary\|promise\|tier","enabled":bool}` |
| POST | `/onebot-companion/rule` | `{"id":"silent","enabled":false}` per-rule toggle |
| POST | `/onebot-companion/rescan` | Re-attach immediately |
| POST | `/onebot-companion/selftest` | Run guard's self-test (feed real text, see the verdict) |
| POST | `/onebot-companion/selftest-adopt` | Run adopt's self-test (never touches the real registry; 9 cases) |
| POST | `/onebot-companion/selftest-mention` | Run mention's self-test (32 cases: name-calling, the diving window, self-id rewriting, and the whole topic-chime chain — whitelist, cooldown, daily cap, quiet hours) |
| POST | `/onebot-companion/selftest-diary` | Run diary's self-test (35 cases: level normalising, expiry, over-cap eviction by level, injected text free of braces, store round-trip on a fake store) |
| POST | `/onebot-companion/selftest-promise` | Run promise's self-test (30 cases: the three due conditions, never earlier than now, over-cap eviction of settled entries, store round-trip) |
| POST | `/onebot-companion/selftest-tier` | Run tier's self-test (37 cases: six closed-on-the-left boundaries, clamping, per-tier wording) |
| POST | `/onebot-companion/selftest-lastword` | Run lastword's self-test (on the real prototype chain: attachment and bookkeeping) |
| POST | `/onebot-companion/selftest-stamp` | Run stamp's self-test (pure-function cases for formatting, the whitelist and injection, plus the whole "bookkeeping → injection → baseline advance" chain, all on a fake proto — never touches the real bridge) |
| POST | `/onebot-companion/burst` | `{"text":"…","maxChars":20}` preview the split |
| POST | `/onebot-companion/seed-style` | `{"chatId":"private:100000001","profile":{…}}` seed an offline profile (statistics only, never raw lines) |
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
- **Voice depends on an external service.** With `backend: edge`, `qq_say` shells out to
  Python + edge-tts, which talks to a Microsoft endpoint that is unofficial and has already
  changed once (see the voice section). When it breaks, `qq_say` returns a plain error and
  nothing else is affected — and `/voice` shows the last failure reason.
- **Each synthesis spawns a Python process** (`backend: edge`; a few hundred ms plus network).
  Calls are serialised, so a burst of `qq_say` calls queues up rather than running in parallel.
  With `backend: local` the plugin posts to the resident service instead and spawns nothing.
- **The local backend needs you to keep that service alive.** If it is down, `qq_say` reports
  "local speech service unavailable" together with the start command, but it **will not start it
  for you** (the plugin does not manage other processes' lifetimes). Make it start on login.
- A personal tool; compatibility with other third-party OneBot implementations is not guaranteed.

## License

[MIT](./LICENSE) © 2026 xfgil

---

*A personal plugin, written to a "good enough" standard. Evaluate before production use.*
