# dsh-onebot-companion

> 一个插件，把 QQ 通道该有的四件事都装回来：**出站沉默守卫 + 每轮行为规则 + 对话节奏 + 人设 + 语音**。
>
> 中文 · [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

**DSH 插件** · 为 [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq) 补上四项被 0.9.0 升级冲掉的能力。

**同系列**：[dsh-hot-reloader](https://github.com/xfgil/dsh-hot-reloader)（热重载）·
[dsh-session-clock](https://github.com/xfgil/dsh-session-clock)（会话时钟）·
[dsh-proxy-on-demand](https://github.com/xfgil/dsh-proxy-on-demand)（按需代理） · [dsh-second-opinion](https://github.com/xfgil/dsh-second-opinion)（第二意见）

> **本仓库取代** `dsh-onebot-guard` / `dsh-onebot-prompt` / `dsh-onebot-rhythm` 三个独立插件
> （它们的能力已全部并入本插件的五个模块）。已装过旧插件的请先卸载再装这个，**不要同时装**——
> 两套代码会各自包装同一条原型链，导致重复分条、重复计数。

---

## 目录

- [为什么需要它](#为什么需要它)
- [它做什么](#它做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [HTTP 观测面](#http-观测面)
- [工作原理](#工作原理)
- [已知边界](#已知边界)
- [License](#license)

---

## 为什么需要它

`dsh-onebot-qq` 在 2026-10-12 23:43 升到 0.9.0 时，把此前在 `node_modules` 里手改出来的
一批行为约定**一次性冲掉了**——pnpm 换了目录，改动不复存在。被冲掉的包括：

| 能力 | 原实现 | 0.9.0 之后 |
| --- | --- | --- |
| 沉默协议（`[[silent]]`） | `prompt.js` + `split.js` + `outbound.js` 三层 | 全没了 |
| 括号旁白剥离 | `split.js` 的 `stripAsideLines` | 没了 |
| 出站分段（一条长回复分几次发） | `split.js` burst 段 + `outbound.js` 的 `burstChunks` | 没了 |
| 入站合并（连打三行算一个回合） | `coalesce.js` | 整个文件不存在 |
| 情绪 / 主动发言 / 风格学习 | `mood.js` / `proactive.js` / `style.js` | 全没了 |
| 5 条行为规则 | `prompt.js` 的 29 次 edit | 全没了 |

**手改 `node_modules` 正是被冲掉的那套做法，同样的坑会再踩一遍。** 所以本插件一行都不改
`node_modules`，只从外面给原型挂包装 —— 升级不会再把功能冲掉。

### 为什么是一个插件而不是四个

这四个能力最初被拆成 `guard` / `prompt` / `rhythm` / `persona` 四个独立包。合并的理由很实在：

- 四份代码里重复的东西太多 —— `resolveProfileDirs()`（探测 profile 目录）逐字重复两份、
  `patchMethod()` 两份、HTTP 观测面三份、loopback 判定三份、状态落盘两份。
- 四个包各自 `import()` 同一个 `dsh-onebot-qq`，各自起一个 3 秒扫描定时器，各自维护一份统计。
- 用户只装一个、只配一块，比装四个再对着四份文档调参好得多。

合并后：**一个包、一份配置、一个 HTTP 面**，内部按职责分成五个模块，各自可独立开关。

## 它做什么

| 模块 | 干什么 | 挂在哪 |
| --- | --- | --- |
| `guard` | 出站闸：拦 `[[silent]]`、剥整行括号旁白；整条为空就不发 | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |
| `prompt` | 每轮注入 6 条行为规则 + 情绪行 + 风格行 | 宿主 `agent/pre-step`（不挂原型） |
| `rhythm` | 入站合并（连打三行 = 一个回合）+ 出站分段（一条长回复分几次发） | `ChatBridge.prototype.dispatchFollowup` / `sendToChat` |
| `persona` | 情绪四变量 + 随机主动发言 + 风格学习 | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |
| `voice` | `qq_say` 工具：文字 → edge-tts 合成 → 作为 QQ 语音发出 | 只注册工具，不挂原型 |

五个模块挂在**不同**的方法上，靠 `core/patch.js` 的模块身份标记共存，互不吞并。

### 6 条行为规则

| id | 规则 | 默认 |
| --- | --- | --- |
| `silent` | 沉默就用 `[[silent]]`，不许用文字或括号表示沉默 | 开 |
| `image` | 图片可主动发（`qq_send_image`），但严禁编造本地路径 | 开 |
| `quarrel` | 群里有人争执/对线时默认不接，被 @ 也可沉默 | 开 |
| `face` | 表情善用但别滥用，别拿表情代替说话 | 开 |
| `tone` | 短句口语、别写文档、绝不暴露运行状态 | 开 |
| `voice` | 话一长就用 `qq_say` 说出来，但别滥用 | 开 |

> `silent` 这条是与 `guard` 模块的**契约**：规则层明令禁止用括号表达沉默，只许用
> `[[silent]]` 一个写法，这样 guard 的判别器才能 100% 命中且不留残余。改这条措辞前
> 请先同步 guard 的判别逻辑。

### 节奏参数

| 方向 | 行为 | 默认 |
| --- | --- | --- |
| 入站 | 一个 chat 连发的消息攒进安静窗口，合成**一个**回合 | 私聊 8s / 群聊 3s |
| 入站 | 被 **@** 立刻穿透窗口 | 开 |
| 入站 | 攒批硬上限 | 30s |
| 出站 | 模型最终回复切成几条短消息，带打字间隔发出 | ≤36 字/条，≤4 条 |
| 出站 | 分条期间脉冲「正在输入」（仅私聊） | 开 |

### 人设四变量

| 变量 | 管什么 | 时间尺度 | 初始 |
| --- | --- | --- | --- |
| `mood` | 此刻的感觉（8 态） | 分钟级 | `calm` |
| `energy` | 此刻的电量 | 小时级 | 80 |
| `affinity` | 关系有多深 | 天级 | 20 |
| `warmth` | 当下多来劲、话多不多 | 小时级 | 50 |

主动发言**没有 cron**：只有两处随机 —— 下一次评估的间隔是区间随机的，评估时每个候选
chat 各掷一次概率门。默认只对**私聊**主动（群里主动开口是打扰所有人）。

### 语音（`qq_say`）

**对应需求**：「能不能回复我也尽量用一句话（尽量20字内），跟群聊一样，**长的就发语音**」+
「**语音声音能改吗？改成熟点**」。

提供 `qq_say` 工具：给一段文字，插件用 edge-tts 合成 mp3，再作为 QQ 语音消息发出去。
配合第 6 条规则，长内容她会用说的。

> **为什么不做成「超长自动转语音」**：哪些话适合说、哪些适合打字是聊天判断的一部分
> （一句吐槽用念的很怪）。自动替换会抢走这个判断，所以只提供能力 + 讲清何时用。

音色可选（默认 `zh-CN-XiaoxiaoNeural` 晓晓，成熟取向）：

| 音色 id | 名字 | 风格 |
| --- | --- | --- |
| `zh-CN-XiaoxiaoNeural` | 晓晓 | 成熟温柔（**默认**） |
| `zh-CN-XiaoyiNeural` | 晓伊 | 活泼少女 |
| `zh-CN-liaoning-XiaobeiNeural` | 晓北 | 东北口音，直爽 |
| `zh-CN-shaanxi-XiaoniNeural` | 晓妮 | 陕西口音，爽利 |
| `zh-CN-YunxiNeural` | 云希 | 清朗少年 |
| `zh-CN-YunyangNeural` | 云扬 | 沉稳播音腔 |
| `zh-CN-YunjianNeural` | 云健 | 浑厚有力 |

**依赖**：Python 装了 `edge-tts`（`pip install edge-tts`）。插件**不额外引入 Node 依赖**。

#### 两个已踩过的坑（插件内已处理）

1. **上游 host 失效**：`speech.platform.bing.com` 自 2026-10 起在很多地区对合成
   WebSocket 直接回 **403**（上游 issue [rany2/edge-tts#490](https://github.com/rany2/edge-tts/issues/490)）。
   本机实测 7.2.7 / 7.2.8 都 403，且**与系统时钟无关**（手动补 ±5s/±10s 偏差仍然 403）。
   修法见 [PR #491](https://github.com/rany2/edge-tts/pull/491)：改用
   `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`，且 token 要作为
   **`Ocp-Apim-Subscription-Key`** 查询参数传入（不是旧的 `TrustedClientToken`）。
   插件用**运行时 shim**（内联 `python -c`）完成替换，**不改 site-packages**
   （pip 升级会覆盖回去，与 `node_modules` 同一个坑）。shim 带幂等保护：上游发版后
   旧 host 消失，替换自动跳过。

   > ⚠️ 只改 `constants.WSS_URL` **无效** —— `communicate.py` 用
   > `from .constants import (... WSS_URL ...)` 把值绑成了模块级常量，两处都要改。

2. **偶发失败要重试**：语音服务有瞬时抖动（实测同一段文本在同一台机器上连续 11 次里
   失败 2 次，随后单独复测 12/12 全成功）。插件内置退避重试（默认 3 次，基数 800ms）。
   语音是用户直接看到的东西，失败一次就是「她突然说不出话」，重试比报错友好。

3. **剥代理变量**：edge-tts 直连微软，而宿主环境常带 `HTTP(S)_PROXY`（给 LLM 上游用）。
   插件从子进程环境里删掉这六个键（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 及其小写）。
   实测本机带代理时**也能**成功，所以它不是必然失败项 —— 但剥掉没有副作用，作为防御保留。

## 环境要求

- **DSH**（DeepSeek Harness）宿主，已装并启用 [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq)（目标包，默认按 `0.9.x` 的内部结构挂载）。
- **Node.js ≥ 22**（用到 `node:zlib` 之外的现代 ESM 特性；实测在 v24 上开发）。
- 本插件**不额外依赖任何第三方包** —— 全部用 Node 内置模块。

## 安装

### 1. 放进插件目录

```powershell
git clone https://github.com/xfgil/dsh-onebot-companion.git D:\path\to\plugins\dsh-onebot-companion
```

（任何目录都行，下称 `<插件目录>`。）

### 2. 在 profile 里注册

编辑 `<DSH_HOME>\profiles\<profile>\package.json`，加两处：

```jsonc
{
  "dependencies": {
    "dsh-onebot-companion": "link:D:/path/to/plugins/dsh-onebot-companion"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-onebot-companion"   // ← 加进 bundles，bundle 会自注册
      ]
    }
  }
}
```

本插件自带 `cordis.patch.yml`（`dsh.bundle.patch` 指向它），**bundle 自注册**——
不要再往 profile 的 `cordis.patch.yml` 里手写 `insert`，重复 insert 会起两个实例。

### 3. 建链接并让宿主加载

```powershell
cd <DSH_HOME>\profiles\<profile>
pnpm install
```

> ⚠️ **顺序很重要：先建 `node_modules` 链接，再改 profile 清单。**
> 宿主的热更新 `refresh(manifestOnly)` 里有一行短路：
> ```js
> if (manifestOnly && bundles === lastBundles) return;   // 清单没变就直接返回
> ```
> 如果先改清单、后建链接，那次 reconcile 解析不到包就跳过了，而 `lastBundles`
> 已经被更新 —— **之后再怎么改 `package.json` 都被这行短路，永不重试**。
> 表现是：插件管理页显示 `enabled: true`，但那一行没有 `entryId`，功能完全不生效。
>
> 补救：在插件管理页把它**关掉再打开**（让清单内容真的变一次），即可绕过短路。

改完**不用重启宿主**：宿主的热更新会重新加载。若你装了
[`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader)，它也会自动跟进。

### 4. 确认它在跑

```powershell
curl.exe http://127.0.0.1:<端口>/onebot-companion
```

或者直接看状态文件有没有落盘：

```powershell
Get-Content "$env:USERPROFILE\.dsh\onebot-companion\state.json"
```

## 配置

配置写在 profile 的 bundle 配置段里（宿主会把它透传给 `apply(ctx, config)`）。
**本插件刻意不导出 Config schema** —— 沿用实测结论：profile 侧解析不到宿主的
`schemastery`，导出非 schema 对象会让 loader 投影 config 时报错。

```yaml
dsh-onebot-companion:
  enabled: true
  packageName: dsh-onebot-qq     # 要挂的 QQ 通道插件
  profileDir: ''                 # 留空则多路自动探测
  pollMs: 3000                   # 补挂扫描周期；目标包被升级换目录后靠它自愈
  stateFile: ''                  # 留空用 $DSH_HOME/onebot-companion/state.json

  guard:
    enabled: true
    stripAside: true             # 是否连「整行一对括号」的旁白一起剥
    logHits: true

  prompt:
    enabled: true
    rules: {}                    # 按 id 单独开关，如 { quarrel: false }；缺省全开
    firstStepOnly: true          # 仅第一步注入（推荐）；关掉会撑大上下文
    sourceName: onebot-prompt

  rhythm:
    enabled: true
    inbound:
      enabled: true
      quietMs: 8000              # 私聊安静窗口
      groupQuietMs: 3000         # 群聊安静窗口
      maxWaitMs: 30000           # 攒批硬上限
      mentionPierces: true       # 被 @ 立刻穿透
    burst:
      enabled: true
      maxChars: 36               # 每条消息字数预算
      maxChunks: 4               # 一次回复最多几条（尾巴折叠进最后一条）
      delayMs: 300               # 分条基础停顿
      perCharMs: 45              # 按上一条字数折算的打字时间
    typing: true

  persona:
    enabled: true
    mediaDir: ''                 # 情绪/风格状态目录；留空从 bridge 配置取
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
    # 「主动只对我，我才是管理员」——allowAllUsers: true 时陌生人也能私聊，
    # 不设白名单她就会去主动搭话陌生人。写纯 QQ 号或完整 chatId 都认。
    proactiveOnlyChats: []

  voice:
    enabled: true
    program: python              # 装了 edge-tts 的解释器（可写绝对路径）
    voice: zh-CN-XiaoxiaoNeural  # 音色，见上表
    rate: -5%                    # 语速（edge-tts 语法）
    pitch: -10Hz                 # 音调
    maxChars: 120                # 每次最多念多少字
    timeoutMs: 45000
    retries: 3                   # 偶发失败重试次数（含首次）
    retryDelayMs: 800            # 重试退避基数
    mediaDir: ''                 # 语音文件目录；留空用 config.mediaDir
```

> `packageName` / `profileDir` 会自动下发到五个模块段，**不需要在每个段里重复写**。

### 状态文件放在哪

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `state.json` | 本插件运行态（挂了哪些闸、扫了几次、命中多少） | `$DSH_HOME/onebot-companion/` |
| `mood-state.json` | 情绪四变量（每 chat 一条） | `config.persona.mediaDir` |
| `style-state.json` | 风格画像（每 chat 一条） | `config.persona.mediaDir` |
| `media_*.mp3` | `qq_say` 合成的语音 | `config.voice.mediaDir` |

情绪与风格**刻意不放在 `state.json` 里**：`mediaDir` 是那批历史数据本来的家，
换插件/重写插件都能继承，亲密度和风格画像攒了几天的东西不该因为换插件清零。

## HTTP 观测面

全部 **loopback only**（非 `127.0.0.1` 一律 403）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/onebot-companion` | 总状态：配置、统计、五个模块挂载情况 |
| GET | `/onebot-companion/hits?limit=` | 最近 200 条 guard 命中（原文 + 清理后文本） |
| GET | `/onebot-companion/mood` | 情绪快照（每 chat） |
| GET | `/onebot-companion/style` | 风格画像快照（每 chat） |
| GET | `/onebot-companion/voice` | 语音配置、可用音色表、上次失败原因 |
| POST | `/onebot-companion/toggle` | `{"enabled": bool}` 总开关 |
| POST | `/onebot-companion/module` | `{"module":"guard\|prompt\|rhythm\|persona\|voice","enabled":bool}` |
| POST | `/onebot-companion/rule` | `{"id":"silent","enabled":false}` 单条规则开关 |
| POST | `/onebot-companion/rescan` | 立刻补挂一次 |
| POST | `/onebot-companion/selftest` | 跑 guard 自测（喂真实文本看会怎么处理） |
| POST | `/onebot-companion/burst` | `{"text":"…","maxChars":36}` 看分段结果 |
| POST | `/onebot-companion/say` | `{"text":"…"}` 试合成语音（只落盘，不发送） |
| POST | `/onebot-companion/reset-hits` | 清空命中记录与计数 |

## 工作原理

### 挂载：运行时包装原型，不落盘

`core/patch.js` 用 `pathToFileURL()` 定位目标类的**绝对路径**并 `import()`，然后包装
原型方法。为什么不用 `require.resolve('dsh-onebot-qq/lib/outbound.js')`：

```
Package subpath './lib/outbound.js' is not defined by "exports"
```

上游 `exports` 字段没暴露子路径，所以直接拼绝对路径更省事。

**模块同一性**（这是整套做法的前提，已实测）：`pathToFileURL` 规范化后的 URL
`import()` 回来的命名空间对象，与宿主正在实例化的那一个是**同一个** —— 因为 ESM
模块缓存按解析后的 URL 命中。包装原型方法因此能影响宿主真实的实例。

### 升级抗性

包装发生在**运行时**，不落地任何文件。pnpm 下次把 `lib/*.js` 覆盖回原版，只是让闸
消失而已 —— 插件的 `pollMs` 扫描（默认 3 秒）会重新 `import()` 并检查原型上还有没有
本模块的标记，没有就补挂。**目标包被升级换目录也不会失效。**

### 脱链语义：多个模块互不吞并

同一个原型方法可能被多个模块包装（例如 `sendToChat` 同时被 guard 和 rhythm 关注）。
朴素的 `unwrap()` 会剥到链底，把别的模块的包装一起丢掉。`core/patch.js` 因此给每个
包装打上 `Symbol.for` 模块标记，脱链时**只剥自己那一层**：

```js
// 只脱本模块的层，链上其他模块的包装原样保留
```

同时它保留 `originalOf()`（取链底原方法）给需要「绕过所有包装直接发」的路径用。

### 失败降级

- guard 清洗异常 → **按原文放行**。一个守卫把用户消息吃掉，比漏一条标记严重得多。
- 入站合并异常 → 按原文直投（原方法照常调用）。
- 出站分段异常 → 按原文整条发；分条中途失败 → 剩余内容合并补发。
- 情绪/风格记录异常 → 只记 `lastError`，绝不影响消息投递。
- 所有计时器 `unref()`，停着的批绝不把宿主进程钉住。

## 已知边界

- **挂载点绑定 0.9.x 的内部结构。** 上游若改名 `sendToChat` / `sendMsg` /
  `dispatchFollowup` / `handleInbound` / `onSessionEvent`，对应模块会静默失效。
  `pollMs` 扫描会把丢失记进 `lost`，但不会自动适配。
- **`agent/pre-step` 每轮多一条消息。** 这是实打实的 token 成本，长聊场景按天算可观。
  所以 `prompt.firstStepOnly` 默认为 `true`（只在每轮第一步注入一次）。
- **提示词层压不过历史惯性。** 如果会话历史里已经堆了几百条 `[[silent]]` 示范，注入
  一句新规则未必压得过；`guard` 的硬拦才是主防线，提示词层是辅助。
- **合并器只在 `dispatchFollowup` 这一层工作。** 插话（steer）与语音转写走另一条
  路径，**不经过合并器** —— 这是刻意的，插话本来就该立刻生效。
- **分条会改变消息计数。** 依赖「一条回复 = 一条消息」的下游逻辑会看到多条。
- **文字图卡片不分条**：`textImageThreshold` 生效时整条走卡片，卡片本来就是一条。
- **主动发言是拉取式的**：宿主没给插件「替某个空闲会话发起一轮」的公开接口，
  调度器只在有活跃 chat 表时才工作。
- **情绪变量按时间积分**，落盘值会有 IEEE-754 浮点尾差（`56` 可能是
  `55.99999722222222`）。这是正常的，不是 bug。
- **语音依赖外部服务**：`qq_say` 起 Python + edge-tts，连的是微软一个非官方端点，
  而且已经变过一次（见语音章节）。它坏掉时 `qq_say` 只返回一个普通错误、不影响别的
  功能，`/voice` 端点会显示上次失败原因。
- **每次合成都起一个 Python 进程**（几百毫秒 + 网络）。调用是串行的，所以连着几次
  `qq_say` 会排队而不是并发。
- 本插件为自用工具，不保证与其他第三方 OneBot 实现的兼容性。

## 开发

```powershell
node test/selftest.mjs
```

**252 项断言**，三层覆盖：

1. **纯函数** —— mood / style / burst / coalesce / aside / rules，无 IO、无宿主。
2. **模块接口** —— 五个模块的 `createXxx` 返回值与配置语义。
3. **真实集成** —— 造一个假 profile（含 `dsh-onebot-qq/lib/{bridge,outbound}.js`），
   让五个模块的 `scan()` 真的 `import()` 并给原型挂包装，然后**真的调用**被包装的
   方法并断言行为。

第 3 层是这个测试文件存在的理由：前两层全绿也可能「插件说挂好了但功能完全不生效」，
那种 bug 只有真挂真调才抓得到。

## License

[MIT](./LICENSE) © 2026 xfgil

---

*自用插件，按「够用就好」的标准写。生产环境请自行评估。*
