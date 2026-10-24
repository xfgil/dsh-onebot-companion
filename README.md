# dsh-onebot-companion

> 一个插件，把 QQ 通道该有的都装回来：**出站沉默守卫 + 每轮行为规则 + 对话节奏 + 人设 + 语音 + 会话换代防护 + 时间戳**。
>
> 中文 · [English](./README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

**DSH 插件** · 为 [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq) 补上被 0.9.0 升级冲掉的能力。

**同系列**：[dsh-hot-reloader](https://github.com/xfgil/dsh-hot-reloader)（热重载）·
[dsh-session-clock](https://github.com/xfgil/dsh-session-clock)（会话时钟）·
[dsh-proxy-on-demand](https://github.com/xfgil/dsh-proxy-on-demand)（按需代理） · [dsh-second-opinion](https://github.com/xfgil/dsh-second-opinion)（第二意见）

> **本仓库取代** `dsh-onebot-guard` / `dsh-onebot-prompt` / `dsh-onebot-rhythm` 三个独立插件
> （它们的能力已全部并入本插件的模块）。已装过旧插件的请先卸载再装这个，**不要同时装**——
> 两套代码会各自包装同一条原型链，导致重复分条、重复计数。

---

## 目录

- [为什么需要它](#为什么需要它)
- [它做什么](#它做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [HTTP 观测面](#http-观测面)
- [给别的插件用的接口](#给别的插件用的接口)
- [工作原理](#工作原理)
- [已知边界](#已知边界)
- [License](#license)

---

## 为什么需要它

`dsh-onebot-qq` 只负责把 QQ 通道接上，聊天本身该有的东西它不管：沉默怎么表达、括号里的
旁白算不算话、一条长回复要不要分几次发、对方连打三行算几个回合、她此刻什么心情、
要不要主动开口、消息之间隔了多久。这些都得由外面补上 —— 本插件补的就是这一整套：

| 能力 | 现状 |
| --- | --- |
| 沉默协议（`[[silent]]`） | 由 `guard` 拦下 |
| 括号旁白剥离 | 由 `guard` 剥掉 |
| 出站分段（一条长回复分几次发） | 由 `rhythm` 完成 |
| 入站合并（连打三行算一个回合） | 由 `rhythm` 完成 |
| 情绪 / 主动发言 / 风格学习 | 由 `persona` 提供 |
| 14 条行为规则 | 由 `prompt` 每轮注入 |
| QQ 分享卡片的标题与链接 | `linkcard` 模块（上游只留一个 `[卡片]`） |
| 会话换代防护 | `adopt` 模块 |
| 时间戳与间隔（`time=`/`gap=`） | `stamp` 模块 |
| 群里喊名字也算被叫到 | `mention` 模块 |
| 群里聊到兴趣时插一句 | `mention` 模块的 `topics` |
| 群友回合禁用工具（硬隔离） | `isolation` 模块（`ctx.tools.guard()`） |
| 她自己的小本子（三档遗忘） | `diary` 模块 + `qq_diary` 工具 |
| 答应过的事到点想起来 | `promise` 模块 + `qq_promise` 工具 |
| 表情包图库（收到的贴纸自己攒起来） | `stickers` 模块 + `qq_sticker` 工具 |
| 她此刻在忙别的（刷手机/打游戏） | `focus` 模块 |
| 他不在的时候，她自己在过 | `solitude` 模块 |
| 这一阵过得好不好，会改她的底子 | `temper` 模块（按天记事实 → 乘心情权重） |
| 她的作息跟着你的作息走 | `circadian` 模块（24 小时桶学「你几点在」） |
| 关系阶段（不只是个数字） | `tier` 模块（把 `affinity` 投影成台阶） |
| 「她最后一次开口是什么时候」 | `lastword` 模块 + `/physical` 体检表 |

**为什么不手改 `node_modules`**：把那批约定直接写进 `node_modules` 里，`dsh-onebot-qq`
一升级（pnpm 换目录）就会整个被冲掉，同样的坑会再踩一遍。所以本插件一行都不改
`node_modules`，只从外面给原型挂包装 —— 升级不会再把功能冲掉。

### 为什么是一个插件而不是四个

这四个能力最初被拆成 `guard` / `prompt` / `rhythm` / `persona` 四个独立包。合并的理由很实在：

- 四份代码里重复的东西太多 —— `resolveProfileDirs()`（探测 profile 目录）逐字重复两份、
  `patchMethod()` 两份、HTTP 观测面三份、loopback 判定三份、状态落盘两份。
- 四个包各自 `import()` 同一个 `dsh-onebot-qq`，各自起一个 3 秒扫描定时器，各自维护一份统计。
- 用户只装一个、只配一块，比装四个再对着四份文档调参好得多。

合并后：**一个包、一份配置、一个 HTTP 面**，内部按职责分成十七个模块，各自可独立开关。

## 它做什么

| 模块 | 干什么 | 挂在哪 |
| --- | --- | --- |
| `guard` | 出站闸：拦 `[[silent]]`、剥整行括号旁白、吞「⏳ 排队提示」「该命令仅管理员可用。」与**自述/报幕**（「我在等他回话」「我已经发了一句过去」这类回合进度，2026-10-19 加）、**复述**（刚说完的话又用第三人称讲一遍，2026-10-20 加）；整条为空就不发 | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |
| `adopt` | 会话换代防护：裸 id 还有磁盘日志时**接管**（resume）而不是把它永久退休、另开一个新会话 | `ChatRegistry.prototype.createChat` |
| `stamp` | 给注入边界补回 `time="..."`（本条消息的时刻）与 `gap="..."`（距上一条的间隔，如 `3m47s`），让模型不必自己做时间戳减法 | `ChatBridge.prototype.handleInbound`（记账）+ `ChatBridge.prototype.dispatchFollowup`（注入） |
| `prompt` | 每轮注入 14 条行为规则 + 情绪行 + 风格行 | 宿主 `agent/pre-step`（不挂原型） |
| `rhythm` | 入站合并（连打三行 = 一个回合）+ 出站分段（一条长回复分几次发） | `ChatBridge.prototype.dispatchFollowup` / `sendToChat` |
| `persona` | 情绪四变量 + 随机主动发言 + 风格学习 | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |
| `mention` | 群里喊她名字算被叫到（`diving` 潜水续话）+ 聊到她感兴趣的方向时插一句（`topics`） | `InboundPipeline.prototype.processInbound` |
| `isolation` | 群聊里非管理员回合禁用一切工具（只留发声 + 白名单内的 `read_image` + 本轮聊天里出现过的链接） | 宿主 `ctx.tools.guard()`（不挂原型） |
| `linkcard` | 把 QQ 分享卡片的正文与跳转链接捞回来：`[卡片]` → `[卡片:标题 https://…]`（直链优先 `qqdocurl`，否则 `jumpUrl`） | `InboundPipeline.prototype.processInbound` |
| `emoji` | 把上游翻错的 emoji 换成 `[表情:名字]`；把被丢弃的商城表情包补成可读图片；认不出的原生表情整条不回 | `InboundPipeline.prototype.processInbound` |
| `sleep` | 睡意闸：说了「去睡/晚安」之后，群里**只有被 @ 或喊名字才接**，私聊照旧 | `InboundPipeline.prototype.processInbound`（优先级 30，在 mention 外层） |
| `hands` | 「社交的手」：`qq_poke`（戳一戳）/ `qq_react`（贴表情回应）/ `qq_like`（名片赞）/ `qq_requests`（查申请）；`qq_approve` **不直接生效**，生成审批单发管理员私聊，等他回 `/同意 编号` | `InboundPipeline.prototype.processInbound`（拦管理员的审批命令） |
| `voice` | `qq_say` 工具：文字 → 合成（edge-tts 云端 / 本机 IndexTTS）→ 作为 QQ 语音发出 | 只注册工具，不挂原型 |
| `lastword` | 记一笔「她最后一次真正开口是什么时候」，含原文片段与累计条数。不改参数、不抛错 | `OutboundPipeline.prototype.sendToChat` / `sendMsg` |

十七个模块中有十一个挂在原型上，且**存在共享挂载点**（`dispatchFollowup` 上是 stamp + rhythm，
`handleInbound` 上是 stamp + persona，`processInbound` 上是 sleep + mention + emoji + linkcard + hands）。它们靠 `core/patch.js`
的模块身份标记共存、互不吞并，链上的先后由模块**优先级**唯一决定，与挂载时序无关。

> `sleep` 的优先级是 **30**（高于 `stamp` 的 20），必须排在 `mention` **外层**：
> `mention` 会给「没 @ 但叫了名字」的消息补一个假 at 段，如果 `sleep` 在内层，
> 那道闸看到的就已经是「被 @ 了」，永远拦不住。

### `adopt` 修的是什么

`dsh-onebot-qq` 原生的 `createChat` 里有这么一段：

```js
let sessionId = makeSessionId(sessionIdForChat(chatId));
if (this.isSessionIdBlocked(sessionId)) {
    sessionId = this.freshSessionId(chatId);
}
else if (await this.hasPersistedLog(sessionId)) {
    this.retireSession(sessionId);          // ← 永久退休，写进 retired-sessions.json
    sessionId = this.freshSessionId(chatId);
}
```

裸 id（如 `onebot-group-900000002`）在磁盘上**还有历史日志**时，它不接管，而是把裸 id
**永久退休**、换一个带时间戳后缀的新 id。`retireSession` 是永久的，此后每次 `createChat`
都从第一个分支掉进 `freshSessionId` —— 表现就是**每条消息开一个新会话**，上下文全丢。

关键区别：**只有 `agents.create()` 会和已存在的日志撞车；`agents.resume()` 正是「接管这份
日志」的那个调用。** 所以本模块从外面包住 `createChat`，在进入原方法之前先做决定。
三种情况**明确放行**给原方法：① `evictedChats` 里有这个 chat（快照 id 比裸 id 更权威）
② 裸 id 已被退休（尊重记录）③ 裸 id 没有持久化日志（没有可接管的）。

会话 id 的推导**直接用上游自己的 `chat.js#sessionIdForChat`**，不在本模块里复刻那个
正则 —— 抄一份就等于埋「上游改了规则而我们还按老规则算 id」的坑，算错 id 的后果是
「采纳一个不存在的会话」，比不采纳更糟。拿不到该函数时**直接放弃挂载**，不退化成猜。

### `stamp` 修的是什么

上游的 `<user_message ...>` 边界上**一点时间信息都没有**。`lib/chat.js` 两个构造器都是
3 参，签名里没有时刻：

```js
export function wrapUserMessage(content, userId, nickname) { … }            // lib/chat.js:133
export function buildGroupMessagePrefix(nickname, userId, mentioned) { … }  // lib/chat.js:109
```

`lib/inbound.js` 的 `normalizeOneBot11(event)` 返回的对象里同样没有 time 字段 —— 它把
`event.time` 丢掉了。所以模型看到的每条消息都是「刚才」，两个时间戳都没有。

**为什么需要**：模型**不会可靠地做两个时间戳的减法**，很容易把「隔了两小时」说成
「过了一整天」。这正是加这两个属性的全部动机 —— 把已经算好的间隔直接递过去，等于把
那道算术从模型手里拿走，让它**没有算术可做错**。

本模块往开标签上补回两个属性：

- `time="2026-10-08T15:15:23+08:00"` —— 对方**按下发送**的时刻（本地时区、带秒；
  保留秒是为了同一分钟内的两条也能排序、能被可靠相减）。
- `gap="3m47s"` —— 距他上一条消息隔了多久，**已经算好**。写法是紧凑、**不含空格**、
  最多两个最高整单位的时长：`47s` / `3m47s` / `15h35m` / `2d4h`。不含空格是为了原样
  穿过下面那道字符白名单，短到一眼能读完。

**首次没有基线时 `gap` 留空，不猜** —— 省略属性好过印一个模型会当真的间隔。跨宿主重启的
「上一条入站时刻」因此要落盘（`stamp-state.json`，与 `mood-state.json` / `style-state.json`
同目录同范式，debounce 3 秒原子替换）。不落盘的话，重启后基线就是空的，第一条只能省略
gap，模型随即去读周期旁白里的 Elapsed 行，又把「两小时」说成「过了一整天」。
基线表**最多 500 个 chat**（沿用同一套 `MAX_CHATS`），超出时按「最久没来消息」淘汰 ——
没有这道闸，那张表会随这辈子收过消息的 chat 数单调增长。

**字符白名单**：两个值都用正则洗过 —— 时间戳只留数字与 `T:+-`
（`replace(/[^0-9T:+-]/g, '')`），间隔只留数字与 `dhms`
（`replace(/[^0-9dhms]/g, '')`）。保证这两个值**永远不可能闭合标签、也永远不可能从
`<user_message>` 边界里逃出去**。文本改写只动**开标签**，块内内容一字不碰；同名属性
先摘掉再写，重复注入 / 热重载重入都不会堆出两个 `time=`。

**为什么挂两个点**：职责不同，两张表语义也**必须分开**。

| 挂载点 | 干什么 | 记的什么 |
| --- | --- | --- |
| `ChatBridge.prototype.handleInbound` | **记账**：把 OneBot 事件的 `time`（unix 秒）连同它属于哪个 chat 记下来 | `seenAt`：每次入站都覆盖，含后来被门禁吞掉的未 @ 消息、去重、限流、命令 —— 只回答「这个 chat 最近一次入站是什么时候」 |
| `ChatBridge.prototype.dispatchFollowup` | **注入**：把属性写进交给模型的文本 | `baseline`：注入**成功后**才写，是 `gap` 的基线 —— 只对真正到达模型的消息推进，命令回执之类的投递不污染它 |

`dispatchFollowup` 已被 `rhythm` 挂着（入站合并）。`core/patch.js` 的语义是**后挂的在外层**，
所以本模块必须排在 `scanAll()` 里 rhythm **之后**：这样每条消息各自单独经过本模块（各自注入
自己那一刻的 `time`/`gap`），再由 rhythm 把已注入的几条合并成一批。换过来（本模块在内层）
只会在合并后拿到一整批文本，只能贴一个时间。

chatId 的推导**直接用上游自己的 `chat.js#buildChatId`**，不复刻那个拼法 —— 抄一份就是埋
「上游改了规则而我们还按老规则算」的坑，算错的后果是把时刻记到**别的 chat** 名下。
拿不到该函数时**直接放弃挂载**，不退化成猜。入站时刻还要求像样（2001–2286 年的 unix 秒），
坏值退回当前时刻 —— 一个坏值绝不该给消息盖上胡说八道的钟。

> **已知未补回的一处**：群消息前缀 `[HH:MM 昵称(QQ)]` 不受本模块影响 —— 它用的是**处理时刻**，
> 与 `time` 属性只差几秒，而改写群前缀要啃昵称里的方括号，不划算。

### `mention` 修的是什么

上游 `dsh-onebot-qq/lib/cq.js` 的 `detectMention` 只认两件事：`at` 段指向机器人、或
`reply` 段（引用）指向机器人。**在群里直接喊「云玥」不算。** 这跟真人群聊的习惯不一样 ——
真人被叫名字就知道在叫自己。本模块在 `InboundPipeline.prototype.processInbound` 外面加三条判据：

| 判据 | 干什么 | 默认 |
| --- | --- | --- |
| 喊名字 | 正文里出现 `names` 里的任一个（默认 `云玥` / `玥玥` / `Yara`）→ 算被叫到 | 开 |
| `diving` | 被叫醒之后的一小段时间里，群里不 @ 也会搭话，然后自己潜回去 | 关 |
| `topics` | 群里聊到她感兴趣的方向时自己接一句（见下） | 关 |

**怎么表达「她听见了」**：往 `inbound.segments` 追加一个 `{ type: 'at', data: { qq: bot } }`
段 —— 复用上游「被 @」这条现成语义，`detectMention` 的 `at` 分支返回 true，`requireMention`
闸放行，群前缀盖上 `[@我]`，模型看到的就是「有人点名找你」。不自己造第二套「被叫」语义，
是为了将来上游改了 @ 的处理能跟着一起变。

> 已经核过：`inbound.segments` **在整个包里只有一个消费者** —— `inbound.js:119` 的
> `detectMention`。所以往 `segments` 里追加段只影响那一个判据，不污染正文、媒体或引用展开
> （正文早在 `normalizeOneBot11` 里就算进 `inbound.text` 了）。

**顺手修的一个坑**：`cq.js` 把 at 段渲染成**裸 QQ 号**（`@100000002`），于是她看到的是
一串陌生号。更糟的是规则层原本写着「@ 后面的数字是被 @ 那个人的号」，反而让她把自己那个号
也划进「别人」——2026-10-16 23:10 那次就是：群前缀明明盖着 `[@我]`，她内心独白里却写
「没有 @我」，整场沉默。现在正文里指向**她自己**的裸号会被改写成 `@你`（`rewriteSelfMention`，
别人的号保持原样），规则层也补了一句「`@你` 指的就是你自己」。

**话题插话（`topics`）**：用户 2026-10-17 要求「设置几个云玥可能感兴趣的方向，群里有人
聊到了可以一块聊」。这是**在群里自己开口**，所以与 `diving` 一样默认关。打开后也不是
「放进所有群聊消息」，要连过六道闸：

| 闸 | 作用 | 默认 |
| --- | --- | --- |
| 关键词命中 | 正文里出现她感兴趣的具体字眼 | 7 组，见 `DEFAULT_TOPIC_GROUPS` |
| 消息长度 | 短于 `minChars` 的不参与匹配 | 4 字 |
| 掷骰子 | 命中不等于必答 | `chance` 0.4 |
| 每群冷却 | 同一个群两次插话的最小间隔 | 30 分钟 |
| 每日上限 | 每个群每天最多几次 | 3 次 |
| 安静时段 | 这段时间完全不插话 | 1:00–8:00 |
| 群白名单 | `chats` 非空时只在这些群生效 | `[]` = 不限 |

命中后放行的**那一条**消息会在正文末尾多一行说明（`topicHint`）：
`[群里在聊「猫」，你正好感兴趣就自然接一句；不想接就回 [[silent]]]`。必须说清楚 ——
因为闸门借用的是「被 @」语义，群前缀会盖上 `[@我]`，不解释她会反问「叫我干嘛」。

关键词组**合并**而非替换（`normalizeTopics`）：用户写 `mention: { topics: { enabled: true } }`
时，`mergeConfig` 的浅合并会顶掉整个 `topics` 对象，所以本模块自己把缺失的键补回默认值；
`groups` 则额外做一层合并，加一组不影响默认那几组，某组写 `[]` 就关掉它。

**窗口分两张表**：`awake` 只管 `diving`，`topicAwake` 只管话题插话。混在一张表里就分不清
「这个窗口是谁开的」，于是「潜水关着也不该吭声」会被话题窗口悄悄破坏（自测里抓到过）。
同理，一次真 @ **只推潜水窗口、不推话题窗口** —— 否则一次 @ 就等于给这个群开 10 分钟免检，
又退回用户明确否掉的「群里随意搭话」。

**本模块不做的事**：不碰引用段。上游 reply 分支是 fail-open（`const qq = seg.data.qq ?? '';
if (qq === '' || qq === bot) return true;`），而 NapCat 的 reply 段只有 `id`、从不带 `qq`，
于是「群里甲引用乙」也会被判成 @ 了机器人。修它要么联网查 `get_msg`（用户明确否掉），
要么收紧成「引用谁都不算」（会漏掉「引用云玥」）—— 取舍留给用户。**也不联网**：全部判据
都是本地字符串匹配与内存状态，零 RPC、零依赖。

### 14 条行为规则

| id | 规则 | 默认 |
| --- | --- | --- |
| `silent` | 沉默就用 `[[silent]]`，不许用文字或括号表示沉默 | 开 |
| `speak` | 群里什么时候该开口：被点名/被问到/有兴趣/有情绪时自然接，别把「跟我无关」当默认答案，但也绝不硬接 | 开 |
| `ability` | 你能做什么、不能做什么：能发消息 + 四件社交小事（戳/贴表情/赞/查申请），其余不行；`qq_approve` 只是「去问一声」，**绝不能**说「已经同意了」；看不到对方屏幕；要帮忙就给步骤但不知道就别指挥；需要登录的页面直说打不开 | 开 |
| `aside` | 正文只写要说的话，旁白整行括号、且注明「说给对方」；**发完就停，别汇报「我在等他回话」这类回合进度** | 开 |
| `image` | 图片可主动发（`qq_send_image`），但严禁编造本地路径 | 开 |
| `link` | 别人发的链接想接话就先 `web_fetch` 看一眼；没读别装读过、读不到就说读不到，**绝不编内容**；群里那条链接也允许读 | 开 |
| `quarrel` | 群里有人争执/对线时默认不接，被 @ 也可沉默 | 开 |
| `face` | 表情善用但别滥用，别拿表情代替说话 | 开 |
| `tone` | 短句口语、别写文档、绝不暴露运行状态；含**真人统计刻度**（中位 6 字 / 九成 ≤20 字）与「想说的多就分几条发」 | 开 |
| `voice` | 话一长就用 `qq_say` 说出来，但别滥用；发语音前先把话「说人话」 | 开 |
| `time` | 心里有时间数，但不报时间、更不编造隔了多久 | 开 |
| `channel` | 分得清私聊/群聊与发言人，别把 A 的话当 B 说的；`@你` 指的是她自己 | 开 |
| `batch` | 对方连着发的几句合起来一起回，别一句回一次 | 开 |
| `topic` | 被放进群里看话题时不必说话，不想接就 `[[silent]]` | 开 |

> `silent` 这条是与 `guard` 模块的**契约**：规则层明令禁止用括号表达沉默，只许用
> `[[silent]]` 一个写法，这样 guard 的判别器才能 100% 命中且不留残余。改这条措辞前
> 请先同步 guard 的判别逻辑。

> `speak` 是 2026-10-17 补的缺口：`requireMention: false`（群里每条消息都进模型、
> 回不回由她自己定）之后，原提示词里「怎么说别出声」有 5 条、「什么时候该出声」
> 有 0 条，于是最省力的策略就是继续沉默——实测该群 19 个回合里沉默 4 次（21.1%）。
> 这条给的是**具体可指认的开口情形**（被点名 / 被问到 / 有兴趣 / 有情绪），
> 同时保留「绝不硬接」，避免从一个极端滑到刷屏 bot。它排在 `silent` 之后，
> 让「怎么沉默」和「何时开口」相邻。

> `ability` 是 2026-10-19 补的边界（起因是对方指出这不对，并附了聊天截图）：
> 示例用户发来一张「和我成为情侣」的 QQ 卡片，她连发数条，内容是「带你一步步来」
> 「把链接发我就行」「已经发出去了」「在旁边等回话」——**既没点开、也没发过
> 邀请、更看不到对方屏幕**。最刺眼的是 reasoning 里已经写明「无法真的操作
> （需要登录）」，正文却输出「已经点开了」：
> 她不是不知道，是没人告诉她「不知道可以直说」。前面 13 条一直在教「怎么像
> 真人」，却没有一条划出「你不是真人，这几件事你做不到」。这条只干一件事：
> 把「你只有一张嘴、没有手」摊开讲，并把正确姿势写成「告诉他怎么点、等他自己
> 操作」。措辞要具体到能拦住幻觉——「不能操作客户端」太抽象，模型照样编。

### `isolation` 群聊硬隔离

2026-10-17 实测事故：群友 `2665507357` 在群里 @ 她问「工作目录下有什么」，她执行了
`ops_bash {"command":"ls -a","workdir":"D:\\Documents\\yunyue"}`，把宿主真实目录内容
发进了群。问话的是群友，不是管理员。

上游有 `restrictedMemberPrefix`（非管理员消息带 `[受限用户:仅问答]` 前缀 + 提示词加一句
禁令），但那是**提示词约束**——模型不听话照样执行，这个事故本身就证明了它拦不住。

本模块用宿主的 `ctx.tools.guard()` 做硬闸（宿主文档原话：「A denial that must hold
regardless of order is a `ctx.tools.guard()`」；签名
`guard(guard: ToolGuard): () => void`，其中
`ToolGuard = (execution) => string | undefined`，**返回字符串即拒绝**，顺序无关、
HMR 可回收）。

判据按**本轮消息的发送者**而不是会话——群里管理员和群友共用同一个群会话，按会话封会
连管理员一起封掉。两条判据取并集：

1. 消息带 `[受限用户:仅问答]` 前缀（上游已判非管理员）；
2. `<user_message qq="X">` 的 X 不在 `adminUsers` 里。

取并集是为了让隔离**不依赖 `restrictedMemberPrefix` 这个开关**——它被谁改回 `false`，
硬闸都还在。

受限回合里默认仍允许四个工具：`qq_say`（语音）、`qq_send_face`（表情）、`qq_react`
（给消息贴表情回应）、`read_image`（看群友发来的图）。`read_image` 还额外过一道
**路径白名单**——只许读 `mediaDir` 下的文件（默认 `D:\Documents\yunyue\.dsh-media`），
否则拒绝。这份白名单是为了修 2026-10-18 那个「她说图一片空白」的问题：群友发的图
她根本读不了，因为它被自己的硬隔离挡住了。其余一律拒绝——`ops_*` 碰文件与 shell，
搜索碰网络，都会把宿主或外部世界的实情带进群。

> 为什么 `qq_react` 在群友回合也放行、而 `qq_poke` / `qq_like` / `qq_approve` 不在：
> 贴个表情回应是**针对某条具体消息**的表态，不会主动骚扰任何人、也不产生任何持久
> 后果；而戳一戳 / 名片赞是主动向人发起的，同意申请更不用说了。判据是「能不能被
> 用来骚扰群友」。

#### `web_fetch` 的窄口子（2026-10-19）

`linkcard` 把卡片还原成 `[卡片:标题 https://…]`、`link` 规则又要求她「想接话就先
`web_fetch`」——可群友说话的那一轮 `web_fetch` 在拒绝之列，规则和闸门直接打架。

所以开了一个**非常窄**的口子（`isolation.allowLinks`，默认开）：

- 只认**本轮入站文本里出现过**的 URL（卡片里的、或对方直接打出来的）；
- 只认公网 `http(s)`——loopback / 私网 / CGNAT（tailnet 的 `100.64/10`）/ 链路本地 /
  `.local` 一律拒；
- 别的地址一律拒，`ops_*`、搜索等仍然全拒。

第二条是必须的：`http://127.0.0.1:6099/webui?token=…` 一旦被允许，群友只要贴一行字
就能让她把 NapCat 面板内容念进群。

### `linkcard` 分享卡片还原

上游 `dsh-onebot-qq/lib/cq.js` 对 `json` 段的处理是 `textParts.push('[卡片]')` ——
**标题和链接全丢**；`xml` 段连占位都没有，直接落到 `[xml]`。群里的 B 站视频、
公众号文章、小程序分享因此在她眼里都只是三个字。

本模块在 `InboundPipeline.processInbound` 上把卡片段解析回
`[卡片:标题 https://…]`。解析**按关键名深度遍历**而不是按固定路径——腾讯卡片的
层级（`meta.news` / `detail_1` / `music` / `wxappinfo`）一直在换；URL 优先取
`qqdocurl`（B 站这类「真实目标」），退到 `jumpUrl` / `url` / `shareUrl` 等，
标题取 `title` / `desc` / `prompt` / `brief` / `summary` / `nickname`。
解析失败退化成在原文里抠 `"url":"…"`，**永不抛**。

条数上限 `maxPerMessage`（默认 3）：只替换真被处理的那几个占位，超出的 `[卡片]`
原样留着——早期实现「见一个删一个」会让卡片凭空消失。

### `hands` 社交的手与审批闸（2026-10-19）

当时的需求：能不能给她加个手。此前她除了发文字/表情/语音，什么都做不了，
`ability` 规则甚至把这点写死成「你只有一张嘴，没有手」。

现在多了这些动作（发消息 / 社交 / 审批 / 自己的资料）：

| 工具 | 做什么 | 群友回合可用 |
| --- | --- | --- |
| `qq_poke` | 戳一戳（`send_poke`） | 否 |
| `qq_react` | 给某条消息贴表情回应（`set_msg_emoji_like`） | **是** |
| `qq_like` | 名片点赞（`send_like`） | 否 |
| `qq_requests` | 查待处理的好友申请 / 入群邀请（只读） | 否 |
| `qq_intimate` | 查 / 接受 / 发起 / 解除亲密关系（`list` 只读；写操作走审批） | 否 |
| `qq_approve` | 同意或拒绝一条申请 —— **不会立刻生效** | 否 |
| `qq_profile` | 查 / 改**自己**的昵称与签名 —— **不需要审批** | 否 |

#### 改自己的名字和签名不用审批

当时的约定（2026-10-19）：可以自己改 QQ 名、改签名，这些不用审批。

- `qq_profile` 不传参数 = 只读（`get_login_info` + `get_stranger_info` 查自己）；
- 传 `nickname` → `set_qq_profile`（Go-CQHTTP 兼容接口，nickname 必填，签名/性别省略时
  NapCat 自己回填当前值，所以只改名不会把签名冲掉）；
- 传 `signature` → `set_self_longnick`（NapCat 扩展接口，payload 只有 `longNick`）；
- 昵称上限 24 字、签名上限 80 字，超了直接报错不提交。

判据：**改的是她自己的资料、不打扰任何人**，所以和 poke/like/approve 那类「对外发起」
区别对待，不过审批闸。要关掉这个能力设 `hands.allowSelfProfile: false`。

#### 审批为什么绕一圈私聊

`qq_approve` 第一次调用**什么都不会执行**：它生成一张审批单（4 位编号，半小时有效），
发到管理员私聊：

```
【要你点头】小明（10003）想加我好友，留言「你好」
我想同意这个。回 /同意 z679 就是准了，回 /拒绝 z679 就是不办。
（编号 z679，半小时内有效）
```

管理员回 `/同意 z679` 才真正调 `set_doubt_friends_add_request`。这一条命令由
`InboundPipeline.processInbound` 层**拦下来吞掉**——模型根本看不到它，否则她会给
「/同意 z679」回一句「好呀」。

**为什么不是「让模型自己确认一下再调」**：本会话已经出过一次同型事故。亲密关系那轮，
她的 reasoning 里明写「我这边没法真的点开操作（需要登录）」，正文却照样输出
「已经点开了」这类确认。提示词层面的自觉挡不住这件事，所以闸门必须落在代码里——
`authorizations` 只由**管理员本人在私聊里说的那句命令**写入，模型无论怎么调工具都写不进去。

#### 「我拉的除外」

当时的约定：加好友和进群要经审批，**自己拉进去的除外**。实现为：群邀请（`sub_type: invite`）
的发起人如果在 `adminUsers` 里，直接放行、不发审批消息（`autoApproveAdminInvites`）。
别人邀请她进群、以及所有好友申请，一律走审批。

### 亲密关系（`qq_intimate`）

QQ 的「情侣 / 闺蜜 / 基友 / 死党」**没有** OneBot 接口——NapCat 的 action 表里
`intimate` / `亲密` / `情侣` 一个都没有。它走的是 `ti.qq.com` 的 H5 与
`oidb.tim.qq.com` 上的私有协议。

`lib/modules/intimate.js` 用她自己发出的 `get_cookies` 登录态（含 `bkn`）直接打那两个
接口：

| 用途 | 端点 |
| --- | --- |
| 查（只读） | `http://oidb.tim.qq.com/v3/oidbinterface/oidb_0xd00_1` body `{"sub_cmd":2}` |
| 发起 / 接受 / 解绑 | `https://ti.qq.com/proxy/domain/oidb.tim.qq.com/v3/oidbinterface/oidb_0xcf3_1` body `{sub_cmd, target_uin, intimate_type, source}` |

`sub_cmd` 0=发起、2=解绑；类型 1=情侣、2=闺蜜、3=基友、26=死党。

`qq_intimate` 的 `action: "list"` 是只读，随时可用；`accept` / `launch` / `release`
三个写操作**同样要过审批闸**——生成审批单发给示例用户，等他回 `/同意 编号`。

> 为什么不能让她自己接受：2026-10-19 那轮她在 reasoning 里明写「我这边没法真的点开操作」，
> 正文却输出「已经点开了」这类确认。所以真正能执行的那一下，必须由人的一句话触发。

### `emoji` 表情与表情包

**QQ 原生小黄脸（`face` 段）**：上游 `cq.js` 把它翻成一个 emoji 字符，但那张
`FACE_EMOJI` 表把 id 当 emoji 码位映射，整体错位（329 个 id 里 123 个落兜底 `😀`，
其余语义全错）。实测：示例用户发 `/变形`(id=312) → 表里是 🐳 → 她回「又发个鲸鱼」。

本模块在 `InboundPipeline#processInbound` 入口把那个错 emoji 删掉，换成
`[表情:变形]`。名字来自 `lib/modules/face-names.js`（329 条 id→中文名，数据源是
NapCat 的 `sysface-full.json`，与发送端 `faces.js` 的 321 条名字零处不一致）。

**刻意没有把表情下载成图片**。QQ 图床 `qzonestyle.gtimg.cn/qzone/em/e<id>@2x.gif`
看起来能用，但像素级核对发现**它的 `e<id>` 与 sysface id 不是同一套编号**：

| id | sysface 名字 | 图床实际给的是什么 |
| --- | --- | --- |
| 182 | 笑哭 | 一只手比 V |
| 312 | 变形 | 戴金色皇冠的笑脸 |
| 106 | 委屈 | 卡通婴儿照 |
| 99 | 鼓掌 | 1×1 全白 |

名字说「变形」、图是戴帽子的笑脸，比只有名字更糟。所以默认只给名字；
`downloadFaces: true` 才下图（留给「确认 id 对得上之后」）。

**商城表情包（`image` 段且 `sub_type === '1'`）**：上游 `cq.js:150` 直接丢弃，
只留 `[表情包]` 四个字。本模块补成 `[表情包][图片:本地路径]`——它的 url 是 QQ
自己给的，跟内容一定对得上，所以照旧下载。

**认不出的表情 → 整条不回**（`muteUnknownFaces`，默认开）。判据只看原生表情 id
在不在那 329 条表里：认得出就正常写 `[表情:笑哭]` 并回话；认不出则写
`[表情:id=9999]` 留个可排查的痕迹，然后把**整条消息吞掉**（`return undefined`，
不再调用上游）。表情包是图片、能真读，**不算**认不出。

> 吞掉必须在包装里直接返回，不能靠「改文本 + 让它自己沉默」：后者模型照样会跑
> 一次生成，只是被提示词劝住，劝不住的时候照样开口。测试专门钉了这条
> （吞掉时上游调用次数必须为 0）。

计数在 `/status` 的 `modules.emoji`：`muted` 与 `lastMuted`（含 `ids` / `chatId` /
`at`）——「她今天怎么这么安静」全靠这两个数排查。`muteUnknownFaces: false` 可关。

### `sleep` 睡意闸

**问题**：她说过要去睡、又补了晚安，然后群里每来一条
消息她照样接。15:11 到 15:12 那一分钟里她连说四条，越说越清醒。

**这不是提示词能解决的**：`[[silent]]` 只能让她「这条不回」，下一条消息进来
照样是一次全新的、精力耗尽的生成；`sleep` 是在消息**进入管线之前**判断，
所以睡着时那些消息根本不会变成回合。

三条进睡意的方式，任一命中即睡：

| 触发 | 判据 |
| --- | --- |
| 她说了睡意词 | `matchSleepWord(text)` 命中 `SLEEP_WORDS`（晚安/睡了/去睡/撑不住/困了……） |
| 精力见底 | `moodOf(chatId).energy <= energyThreshold`（默认 25） |
| 夜里没动静 | 落在 `[nightStartHour, nightEndHour)`（默认 0–8 点）且聊天已静默一段时间 |

**睡多久分两档**：白天（`dayStartHour`–`dayEndHour`，默认 7–23，左闭右开）
只打盹 `daytimeDurationMs`（默认 1 小时），其余时段睡满 `durationMs`（默认 7 小时）。
下午三点一句「先睡一会儿」不该让她安静到晚上十点。

| 说的时刻 | 睡多久 |
| --- | --- |
| 15:12 | 60 分钟 |
| 23:40 | 420 分钟 |
| 06:59 | 420 分钟 |
| 07:00 | 60 分钟 |


睡着后，**群里**只有这两类消息能进来：带 `at` 段指向她自己的（含 `atall` 不算）、
或者正文里喊她的名字（名字来自 `mention.names`）。**私聊永远放行** —— 私聊找她
就是找她。被 @ 或喊名字进来时顺手醒过来（`stats.sleepWoke` + 清表），
不是「醒了但还关着闸」。

睡意到期自动醒（白天 1 小时 / 夜里 7 小时，见上表）；`enabled: false` 整个模块关掉。

> 优先级 **30**，排在 `mention`（10）外层 —— 见「它做什么」里那段说明。

### `diary` 小本子与分级遗忘（2026-10-19）

**问题**：记忆是两头堵的 —— 会话日志**全留**（`session.v4.jsonl.zstd` 一辈子不删），
上下文**全压**（compaction 一到，细节揉成摘要）。中间那一层是空的：没有一个
「她自己记下来的、能回看、会自然淡掉」的地方。

全会记住反而是失真的。三天前随口一句和上个月的一次深谈，本来就该有不同的留存期。

`qq_diary` 给她一张表，三档留存：

| 档位 | 留存 | 什么时候用 |
| --- | --- | --- |
| `normal` | 7 天 | 日常琐事：吃了什么、今天上了什么课 |
| `important` | 30 天 | 值得记的：他的烦心事、约好的事、他在意的事 |
| `critical` | 永不 | 定义关系的事：他的底线、重要日期、他的选择 |

三个动作：`write`（记一条，用她自己的口吻）、`list`（翻看）、`forget`（划掉）。
**只由她自己写**，不自动摘抄聊天记录 —— 自动摘要会长成一堆「用户说了 X」的流水账，
那不是日记，是日志的第二个副本。

注入时按档位分桶、每档限条数（默认 normal 3 / important 5 / critical 6），
只给最近的几条，免得把上下文撑爆。表容量硬上限 400 条，超了按
「先过期 → 档位低 → 旧」淘汰。

状态文件 `diary-state.json`，与 `mood-state.json` 同目录（mediaDir）。

### `promise` 约定与到点提醒（2026-10-19）

**问题**：她说过「我等会儿帮你看看」「明天提醒你」，然后就没有然后了。
敷衍不是恶意，是**没有地方存这句承诺**——每轮生成的上下文里都不欠任何人东西。

`qq_promise` 记下她自己答应过的事：`add` / `list` / `done` / `drop`。
默认 24 小时后到点；到了点之后注入进提示词，**注入即消费**（`consumeReminders`）——
一条约定最多提醒 3 次（`MAX_REMINDERS`），用完就自然沉默。不消费的话，
三天后她还在为同一句话道歉。

结清（done/dropped）的记录保留 3 天再摘掉，这样「已经答应过的」不会被重复记一遍。
状态文件 `promise-state.json`。

### `stickers` 表情包图库（2026-10-21）

**问题**：别人发的商城贴纸，`emoji` 模块早就下载到本地了 —— 但那条消息一过，
路径还在磁盘上，她**再也不会想起来**那张图存在。手上只有 321 个原生小黄脸的
名字，表情包一张也发不出来。

`stickers` 补的是「存下来」之后的那半截：

    消息 → emoji 下载 → 按内容 hash 入库（去重）→ qq_sticker 搜出来 → qq_send_image 发出去

**三个刻意的取舍**：

- **按内容 sha256 去重，不按文件名**。QQ 给的文件名带时间戳与 uuid，同一张图
  转发十次就是十个名字；只有 hash 认得出「这是同一张」。
- **入库失败只丢一张图**。它挂在入站路径上，抛错会让整条消息投递挂掉 —— 图库
  再有用，也不值得让聊天失败。
- **只收表情包，不收原生小黄脸**。后者不是真图（图床 id 与 sysface id 对不齐，
  见 `emoji` 那节），收进图库只会是一堆配错名字的图。

`qq_sticker` 四个动作：`list`（按备注关键词翻，留空按常用程度列）、
`note`（写一句备注，比如「得意的猫」，以后按它搜）、`use`（记一次使用，
会影响下次挑图的顺序）、`recycle`（不要了，先淘汰的是这批）。

容量硬上限 500 条，超出按「先回收站 → 再从没用过 → 再最久没用」淘汰。
状态文件 `stickers-state.json`，图本体在 `mediaDir/stickers/`。

### `focus` 她此刻在忙什么（2026-10-21）

真人刷视频、打游戏的时候回消息会慢，也容易答非所问 —— 不是敷衍，是注意力真的
在别处。以前她不管在干什么，下一轮提示词里都是「此刻」两个字的空白，只能凭空
猜自己刚才在做什么。

`focus` 只做一件事：把「我刚在看什么」记下来，注入一行事实，让她自己说得出
「我回慢了一点，因为在看视频」。

    刷手机成功 → focus.set({what:'browse', detail:'B站热门'}) → 下一轮注入一行

**四条取舍**：

- **不拦截、不延迟**。真正把消息拖慢会让 @ 与急事一起变慢，而且她「想什么时候
  回」本来就该自己决定（见 README「她自己会动」那一节）。只给事实，不给限制。
- **成功才记**。刷失败还标成「在刷」，下一轮她会拿这个当借口 —— 假事实比没有更糟。
- **20 分钟自己过期**。昨天刷的两条视频不该让她今天还在「忙着」。
- **刷完不主动清**。她自己在下一轮里看到「已经 5 分钟了」，会自己决定还看不看；
  人来搭话了她自然会把注意力挪回来，不需要代码替她判断。

状态文件 `focus-state.json`。

### `solitude` 独处（2026-10-21）

`focus` 说的是「我刚才在看别的」，这一块正好相反：**你不在一段时间的时候，她在
过她自己的时间**。

动机是最直接的：翻那些做得好的同类角色，最像活的不是会说话的那部分，是**不
理人的那段时间也在过**。之前她在冷场里是一片空白 —— 提示词里只有「上一次说话
是三小时前」这种数字，没人告诉她这三小时里她干了什么。

`solitude` 只做一件事：把这段空白如实说出来。

    上次说话是 40 分钟前 → 「这期间你发了会儿呆。——这段时间没有他，是你自己的。」

**优先级摆得有理由**（`pickThought`，从上到下取第一个成立的）：

1. **有咽回去的话** → 「那句没说出口的话，我又在心里过了一遍」。她自己最放不下
   的事，比什么都优先。
2. **精力低于 30** → 「中间打了个盹，没睡实」。累到不行的人不会思考。
3. **本子里有旧事** → 挑档位最高、最老的那条，「翻到本子里那句「……」，看了一会儿」。
4. **心情低落/闷着** → 「没干什么，就那么坐了一会儿」。**不给她编成果**。
5. **兜底** → 「发了会儿呆」；超过 8 小时换成「隔了很久，中间走走停停」。

**四条取舍**：

- **没有 start、没有定时器、没有落盘**。所有信息（多久没说话、此刻心情、本子里
  有什么、有没有话没说）都在注入时现取。多存一份状态就多一份会跟真相不一致的
  副本 —— 这一块尤其经不起这个，它讲的就是「真的过了多久」。
- **只挑一句**。独处时心里过的是一句话，不是一串。有十条本子记录也只翻一条。
- **不猜他为什么不理我**。那一块是内耗，不是独处。她要知道的只有「过了多久」。
- **默认 25 分钟才算**。刚说完「我去忙了」三分钟就注入「你一个人待了很久」是假的。

**同步取值**：注入链是同步的，等不了 `diary.list()` / `unsaid.list()` 的异步读盘。
所以这两个模块补了 `peek()` —— 只读内存里已经加载好的那份，不触发读盘，没加载
完就返回空数组（下一轮自然就有）。

### `temper` 长期底色（2026-10-21）

`mood` 管今天，`temper` 管这一阵。

动机是一句原本以为「不用做」的话：单次事件不改人格，**长期经历改基线**。
`mood` 的权重表是写死的常量，意味着她在三月初和五月初是同一个「人格」——
中间不管被冷落过多少次、被好好待过多少天，掷骰子的偏向都一样。

`temper` 只做一件事：按天记一条事实，把它换算成一组乘数，乘到 `mood` 的权重表上。

**四条取舍**：

- **按天结算，不按次结算**。一天只留一条。这样「单次事件不改人格」不是靠调小
  系数保证的，是靠**根本不让它进来**。也是它不会退化成第二种情绪的原因。
- **只存事实，不存结论**。落盘的只有最近 14 天每天长什么样（最长静默几小时、
  精力、亲密度、聊了多少轮）；偏向每次现算。存一份算好的 bias 就会和事实不一致,
  而这一块讲的就是累积，最不该有这种事。
- **有自愈**。窗口滑动，好起来就自己往回走。人身上这个叫韧性。
- **它自己是「不说话」的**。不扣分、不拦消息、不写日记，只往权重表上乘系数。
  偏了之后她说的话自己会变，而不是多一行「你现在有点低落」的自我诊断。

**偏向怎么来的**（`biasOf`，全部是窗口上的平均，不做指数平滑——平滑会让
「好起来了」和「一直这样」看起来一样，而这里最重要的信息恰恰是变化）：

| 条件 | 偏向 |
| --- | --- |
| 六成以上的日子好好聊过 | happy / playful ↑，down ↓ |
| 过半日子被晾着 **且** 关系已深 | clingy / down ↑，excited / playful ↓ |
| 六成日子被晾着 **但** 关系还浅 | clingy ↓，excited ↓（越不确定越不敢往前凑） |
| 平均精力 < 45 | tired ↑，excited ↓ |

第二条里的「且关系已深」是关键：关系浅的时候被晾着不会让人敏感，只会觉得
「本来也不熟」。这一点写错了，整个人格会变成怨妇。

**注入很少**：偏离不超过 0.18 时**一个字都不注入**。这行本来就该很少出现，
否则她就变成一个天天自我诊断的人。

**和 `mood` 的接口只有一个回调**：`persona.setBiasSource(() => temper.current())`，
`moodConfig()` 的 `moodBias` 每次现取。temper 从不直接改心情状态。

**一个必须留着的细节**：低精力档下 `excited` / `down` 的基础权重是 0，纯乘法
永远抬不起来。所以基础权重为 0 的那一档给了个绝对入口 `ZERO_BASE_LIFT * (k - 1)`
（0.8，约占该档总权重的 5%）。用 `k - 1` 而不是 `k`，是为了 `k = 1` 时恰好等于 0，
保证「不传 bias」与「传全 1」逐位等价——这条有自测盯着。

状态文件 `temper-state.json`。**没有定时器**：结算发生在注入时（`observe`），
一天只生效一次，不需要谁在旁边按秒推动。

### `circadian` 学出来的生物钟（2026-10-21）

`mood` 的昼夜判定原本是**写死的**：0–8 点算夜（精力每小时回血 14），其余时间
掉电（每小时 7）。也就是说她的作息是一张钟表，不是一段生活。

问题是示例用户的作息完全不听表 —— 凌晨两点还在说话，中午十一点才冒头。这时候
「夜里该困了」变成一种表演：她按钟表算「现在是你该睡的时候」，而人根本不在。

来源是小黑盒那篇《关于类人大肥鱼的一些想法》里的「学出来的生物钟」：

> 系统用 24 个相位格子记录用户真实出现的时间，生成一条清醒驱动曲线。
> 「困了想睡」是睡眠驱力撞上了被这条曲线抬高的阈值。如果用户 24 小时都在，
> 它就会得到一个「从不困倦」的伴侣。作息是关系磨合出的结果。

**三条取舍**：

- **学的是「他什么时候在」，不是「我什么时候困」**。她的清醒度是他出现的副产品，
  不是独立配置。所以只记入站时刻，不记别的。**只记私聊那条线** —— 群聊里说话
  的是群友，把群友的作息学成「他的作息」会让曲线彻底失真。
- **衰减而不是累加到底**。每个桶按天乘 `decayPerDay`（0.94，半衰期约 11 天）。
  理由是作息会变：暑假的作息不该变成八月的判决。
- **样本不够就不说话**。库总量低于 `minSamples`（30）时曲线返回 `null`，调用方
  退回固定区间。宁可先按钟表过几天，也不要拿三条消息推出一条「曲线」然后当真。

**两个出口**：

1. 夜间掩码 → `persona.setNightMaskSource(() => circadian.nightSet())`，
   `moodConfig()` 的 `nightMask` 每次现取，`mood.js` 的精力积分用它代替固定区间。
2. 注入一行（`circadianPromptLine`）：「这些天你常在凌晨两三点出现——我的作息
   跟着你走，不是跟着钟表走。」**只报最活跃的钟点**，不报「你什么时段在睡」：
   前者是事实，后者是评价。

**掩码的三种语义必须分清**（`nightSetOf`）：

| 返回 | 含义 | 后果 |
| --- | --- | --- |
| `null` | 还没学出来 | 退回 `nightStartHour/nightEndHour` |
| 全 `false` | 他全天都在 | **精力没有回血时段**，只靠聊天回 —— 这就是「从不困倦的伴侣」 |
| 有 `true` | 这些小时是安静时段 | 只有这些小时回血 |

第二行不是 bug，是原文明说的那一格。别去「修」它。

状态文件 `circadian-state.json`。**没有定时器**：记账在每条私聊入站的
`persona.onUserText` 旁路回调上（同步、绝不抛错），曲线在注入时现算。
`/circadian` 与 `/selftest-circadian` 是只读的核对窗口。

### `tier` 关系阶段（2026-10-19）

`affinity` 是连续量（每收一条消息 +1.5，静默每小时 -0.8）。数学上没问题，但
**感知上是平的**：62 和 68 对关系来说没区别，模型拿到一个数字也演不出
「我们熟了一点了」和「我们真的很熟了」的差别。

真人关系是台阶状的 —— 台阶不是数字的错觉，是**行为许可的边界**变宽了。

| 下界 | 阶段 | 可以怎样 |
| --- | --- | --- |
| 0 | 还不熟 | 客气，别自来熟；可以好奇，别追问私事 |
| 15 | 有点熟了 | 可以开小玩笑、偶尔吐槽；还是别越界 |
| 35 | 熟了 | 主动找他说话、拿他打趣、回头提他说过的小事 |
| 55 | 挺亲的 | 可以撒娇、可以管他（催吃饭睡觉） |
| 75 | 很亲了 | 可以有占有欲、会吃味；也可以安静陪着不说话 |
| 90 | 只认他 | 他是第一顺位；可以带依赖感，别演成黏腻模板 |

纯投影、零副作用：`tier.js` 不读写任何状态，只把 `mood.js` 算出的 `affinity`
解释成阶段 + 一句「到了这层可以怎样」，搭 `prompt` 的 `extra` 同一班车注入。
**刻意不说数值** —— 说了模型就会在聊天里报「我们亲密度 62」。

分层的边界只在这一处，想调节奏改 `TIERS` 的 `min` 就行。

> 为什么不写进 `mood.js`：那个文件的随机数消费次数被单测逐条断言，动它是自找麻烦；
> 而且「算」与「读」本来就该解耦。

### `lastword` 她最后一次开口（2026-10-19）

整张体检表里信息量最大的一行。**进程活着 ≠ 她还好着**：agent 卡在某个 step、
上游模型一直超时、会话被别的东西堵住 —— 这些情况下所有「√ 开着」都照样是绿的，
只有「她已经三小时没说过话」能看出来。

原来没有任何字段回答这个问题：`burst.replies` 只在分条时加，
`voice.lastSentAt` 只在发语音时更新，`faces` 只算表情，都不通用。

所以单开一个模块，挂在出站唯一的出口 `OutboundPipeline.prototype.sendToChat` /
`sendMsg` 上 —— 和 `guard` 同一个类，但**方法各自独立**。为什么不并进 `guard`：
guard 是闸门，可以被配置关掉；这一笔记录跟「要不要拦脏话」无关，混进去的话
关掉 guard 就会让「最后开口」永远停在旧值，而恰恰是这种时候它最不该失真。

只记录，不改参数、不改返回值、不抛错 —— 记不上时间不该影响发消息。

**这一笔要落盘，而且必须同步读回来。** `lastWordAt` 是整张体检表的主指标，跟着
进程重启归零的话，面板就永远显示「还没说过话」——恰好在她真卡住、最需要看这一行
的时候失真。所以它随 `state.json` 一起存，启动时用 `store.loadSync()` 读回来。

为什么不能用异步的 `store.load()`：挂原型成功那一刻就会 `persist()` 一次，而
`JsonStore.loadFrom` 是**内存优先**的（已有键不覆盖，否则 debounce 落盘会把新值倒回
旧的），于是先写进去的空快照会把盘上那份挡住，异步 load 回来时整条键被跳过。这个
bug 真发生过一次，症状是「重启后永远是还没说过话」。

`restore(snapshot)` 还有两条容易漏的约定：一是**先清空再灌** `recent`（它是「搬进来」
不是「追加」，否则同步 + 异步两条恢复路径会各记一遍）；二是快照缺失或为 `null` 时
**必须按空恢复**，不能直接 return —— `stats` 挂在 `globalThis` 上跨热重载复用，
不清理的话上一代的旧值会继续装成「刚说过话」。

### `physical` 体检表（2026-10-19）

`/physical` 是**唯一放行跨源读取**的端点（`access-control-allow-origin: *`，且只放 GET）：
它是给本地 `file://` 打开的 html 用的，那个 origin 是 `null`，不放行就 fetch 不到。
范围刻意收到这一条路径 —— 别的端点里有能改运行时配置的 POST。

`buildPhysical(deps)` 是**纯投影**：把已经算好的快照（情绪、日记、约定、最后开口、
挂载记录、报错）拼成一份扁平大对象，不做判断、不写状态。测试里直接喂假数据断言。

`link.connected` 走三条路：先问 `lastword` 记下的出站 `ctx.connected()`（热重载后
依然有效，且它就是出站管线自己「发还是排队」的判定），再退回
`lastReceiver.deps.connection.connected`，都问不到才给 `null`。**`null` 是「未知」，
不等于「断了」** —— 面板上显示「未知」而不是「断开」，就是为了不撒谎。

配套的页面在同仓库之外的 `D:\Documents\yunyue\体检表.html`（个人环境），
打开就会去 `http://127.0.0.1:5931/onebot-companion/physical` 拉数据。

> 刻意不做健康评分/红绿灯。给 0–100 分就会有人去追这个分数，而真正要紧的是
> 「最后开口距今多久」这种原始事实。

### 复述闸：说完的话别再讲第二遍（2026-10-20）

2026-10-19 晚实测事故（用户截图「什么个情况？怎么还有这种给第三方讲解的」）：
她先用 `qq_say` 说了「三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫」，
语音发出去之后，同一步的正文又写「**他**下午三点五十就吃了，到现在整八个小时，我让他去弄点东西垫垫」。
另一例是「我催**他**去睡了，别又熬到一点多」。两次都是把刚发出去的话，换成
「描述一个不在场的人」的口吻再讲一遍。

根因不是模型想说两遍，是它**不知道语音已经发出去了** —— `qq_say` 的工具结果只报
「已发语音（34704 bytes，音色 zh-CN-XiaoxiaoNeural）」，于是模型把这句当成「还没汇报的进度」，
在下一条正文里补一遍。

两道防线：

1. **规则层**（`rules.js` 的 `voice` 条）：明写「语音发出去就完了，别接着用第三人称复述一遍」，
   并给判据——「跟正在说话的人说话，永远用『你』，不会用『他』指人家」。
2. **闸层**（`modules/echo.js` + `guard`）：候选正文与同一会话 **120 秒内**刚发出的话做
   **bigram 覆盖率**比对（去空白标点后，候选的二元组有多少比例出现在参照里；
   不用 Jaccard——复述常是缩写，Jaccard 分不开），满足下面任一就丢：
   - 覆盖率 ≥ `minCoverage`（0.16）**且**正文用第三人称指代对方；
   - 覆盖率 ≥ `strongCoverage`（0.6，几乎逐字重复）—— 不看代词。

   阈值是**量出来的**：真实复述 0.182 / 0.30 / 0.33 / 0.69，正常对话 0.00–0.077，
   两簇之间空档 ≥0.1。另有 `minLen: 8`（「好呀」两个字的 bigram 自然全覆盖，会被误判）、
   `perChatMax: 12`、`windowMs: 120000`。

`usesThirdPerson` 有两个坑：先把「他人」整个词摘掉再判（不然「提到他人」会被当第三人称）；
**放行名单里绝不能有「让/叫」** —— 真实复述原句就是「我**让他**去弄点东西垫垫」
「我催**他**去睡了」，加进去会让真实复述全部漏网。只放行
`他/她 + 们|说|讲|问|告诉|觉得|认为|提到|回复|意思|的话` 这类引用动词。

> 记忆存在 `globalThis.__onebotCompanionEchoMemory`，由 `voice.say()` 写入、`guard` 读取。
> 走 globalThis 而不是实例字段，是因为写的人和判的人是两个模块，且热重载会重建整棵实例 ——
> 跟着实例走就等于改完代码立刻丢记忆。

> **踩过的坑（务必别退回去）**：这个闸一度同时挂在 `sendToChat` 和 `sendMsg` 两层。
> 而 `sendToChat` 内部最后就是调 `this.sendMsg(...)`，于是外层先把正文 `remember` 进记忆，
> 消息走到内层时拿自己跟自己比，覆盖率 1.0，稳稳定命中 —— **所有纯文本回复都发不出去，
> 而且悄无声息**（`return Promise.resolve(undefined)`，不抛错）。现在复述判定只留在
> `sendToChat`（模型输出入口）这一层，`sendMsg` 层只做旁白清洗。

### 主动搭话的两个锁：不追、深夜轻声（2026-10-20）

**不追**（`proactive.js`）：主动开口一次之后，如果对方一直没回，就**不再开口**，
直到他下次真说话（`persona` 在入站时调 `noteUserReply(chatId)` 解锁）。理由：连着追问
「在吗」「怎么不理我」是最快把人推远的方式；一次没回可能是忙，两次就是压力。
触发时会话里已经有「他多久没说话」的信息，所以「隔了很久才开口」这件事不会退化成刷屏。

**深夜档**（`persona.js` 的 `proactiveTriggerText(gap, deepNight)`）：默认 **23:00–02:00**
（`proactiveDeepNightFrom: 23` / `proactiveDeepNightTo: 2`，可跨零点）里搭话只允许
**一句轻声**：不问问题（问了就得回，他就得醒着）、不催他去睡、不报告自己在做什么、
说完就完，他不回也没关系。这个窗口和 `proactiveQuietStart/End`（1–8 点完全不打扰）
正好夹出「他还醒着但快睡了」的那两小时。

触发文本还会带 `deep="night"` 属性，让模型能分清这是哪一种主动。

### 节奏参数

| 方向 | 行为 | 默认 |
| --- | --- | --- |
| 入站 | 一个 chat 连发的消息攒进安静窗口，合成**一个**回合 | 私聊 8s / 群聊 3s |
| 入站 | 被 **@** 立刻穿透窗口 | 开 |
| 入站 | 攒批硬上限 | 30s |
| 出站 | 模型最终回复切成几条短消息，带打字间隔发出 | ≤20 字/条，≤6 条 |
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

**对应需求**：回复尽量用一句话（20 字内），跟群聊一样，长的就发语音；
以及语音音色要更成熟些。

提供 `qq_say` 工具：给一段文字，插件把它合成为音频，再作为 QQ 语音消息发出去。
配合 `voice` 这条规则，长内容她会用说的。

合成有**两个后端**，`voice.backend` 切换：

| `backend` | 走哪里 | 需要什么 | 适合 |
| --- | --- | --- | --- |
| `edge`（默认） | 微软 edge-tts（云端） | 本机一个装了 `edge-tts` 的 Python | 开箱即用、不吃显存 |
| `local` | 本机常驻的 **IndexTTS-2.5** 服务 | NVIDIA 显卡（8G 显存起步）+ 一份 5.2G 权重 | 音色克隆、完全离线、情绪更自然 |

`local` 后端的用法见下面「[本地后端（IndexTTS-2.5）](#本地后端indextts-25)」。

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

**依赖（`backend: edge` 时，需要你自行安装）**：一个装了 `edge-tts` 的 Python —— `pip install edge-tts`。
插件本体**不额外引入 Node 依赖**，也不下载任何东西；`qq_say` 起的 Python 进程读的是你
本机已装好的 `edge-tts`。`backend: local` 则不用装这个包，只要下面那个常驻服务在跑。

#### 语音的三点机制

1. **合成端点替换**：edge-tts 默认走 `speech.platform.bing.com`，而该 host 在很多地区对
   合成 WebSocket 直接回 **403**（上游 issue [rany2/edge-tts#490](https://github.com/rany2/edge-tts/issues/490)）。
   现行做法见 [PR #491](https://github.com/rany2/edge-tts/pull/491)：改用
   `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`，且 token 要作为
   **`Ocp-Apim-Subscription-Key`** 查询参数传入（不是旧的 `TrustedClientToken`）。
   插件用**运行时 shim**（内联 `python -c`）完成替换，**不改 site-packages**
   —— pip 升级会覆盖回去，与 `node_modules` 同一个坑。shim 带幂等保护：上游发版后
   旧 host 消失，替换自动跳过。**两处都要改**：`constants.WSS_URL` 与 `communicate.py` 里
   `from .constants import (... WSS_URL ...)` 绑定的模块级常量 —— 只改前者无效。

2. **退避重试**：语音服务有瞬时抖动，插件内置退避重试（默认 3 次，基数 800ms）。
   语音是用户直接看到的东西，失败一次就是「她突然说不出话」，重试比报错友好。

3. **剥代理变量**：edge-tts 直连微软，而宿主环境常带 `HTTP(S)_PROXY`（给 LLM 上游用）。
   插件从子进程环境里删掉这六个键（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 及其小写）。
   剥掉没有副作用，作为防御保留。

#### 本地后端（IndexTTS-2.5）

`backend: local` 时插件**不再起 Python 子进程**，而是往本机一个常驻 HTTP 服务发一句话：

```
插件  --POST /tts {text, ref}-->  http://127.0.0.1:7862  -->  D:\...\outputs\tts_<ts>.wav
```

**为什么必须是常驻服务**：IndexTTS 权重 5.2G，加载一次十几秒到几分钟（读盘），
而单句推理只要 4~6 秒。每次起进程 = 每句话都等一次加载，聊天根本说不出口。
所以模型由独立进程持有，插件只发文本、拿回 wav 路径。

服务端脚本在 IndexTTS 仓库里（本 README 不打包它），接口：

| 接口 | 用途 |
| --- | --- |
| `GET /ping` | `{ok, loaded, loading, error, device, loadMs, ref}` |
| `GET /refs` | 列 `voices/*.wav` 与各自的时长 |
| `POST /tts` | `{text, ref?, emo?, emo_alpha?, out?}` → `{ok, path, bytes, seconds, costMs}` |

合成是**串行**的（服务端一把锁），避免显存与线程打架——一个人聊天也够用。

配置项：

```yaml
  voice:
    backend: local
    localUrl: 'http://127.0.0.1:7862'
    ref: 'D:\ruanjian\indextts\voices\yara.wav'   # 音色克隆的参考音（3~15 秒干净人声）
```

**运行时改配置**：`cordis.yml` 的插件配置是**启动时**读进 loader 的，改文件不热生效
（`dsh-hot-reloader` 只盯源码）。换音色属于「试一试」，为此重启不划算，所以留了口子：

```powershell
Invoke-RestMethod 'http://127.0.0.1:5931/onebot-companion/voice-config' -Method Post `
  -ContentType 'application/json' `
  -Body '{"backend":"local","ref":"D:\\path\\to\\voice.wav"}'
```

改的是内存里的活配置，**不写回 yml**——重启后仍以 yml 为准。

`/say` 可以只合成不发送，用来试音色：

```powershell
Invoke-RestMethod 'http://127.0.0.1:5931/onebot-companion/say' -Method Post `
  -ContentType 'application/json' -Body '{"text":"你好呀，我是云玥。"}'
```

> 该端点两个后端通用：`edge` 落 `mediaDir` 下的 mp3，`local` 落服务端 `outputs/` 下的 wav。

## 环境要求

- **DSH**（DeepSeek Harness）宿主 **0.2.0-rc.2 及以上、0.3.0 以下**（开发与验证所用版本为
  0.2.1-rc.2 / Electron 44）。已装并启用
  [`dsh-onebot-qq`](https://www.npmjs.com/package/dsh-onebot-qq)（目标包，默认按 `0.9.x`
  的内部结构挂载）。
- **Node.js ≥ 22**。
- 本插件**不额外依赖任何第三方包** —— 全部用 Node 内置模块。
- 用语音功能（默认的 `backend: edge`）需要自行 `pip install edge-tts`（见上）；切到
  `backend: local` 则还需要一张 8G 显存起的 NVIDIA 显卡和 IndexTTS 的服务端。

## 安装

### 0. 下载渠道

三条路，任选其一：

| 方式 | 命令 / 操作 |
| --- | --- |
| **git clone**（推荐，便于 `git pull` 升级） | `git clone https://github.com/xfgil/dsh-onebot-companion.git <插件目录>` |
| **Release 源码包**（没装 git 时用这个） | 打开 [Releases](https://github.com/xfgil/dsh-onebot-companion/releases/latest)，下载 `Source code (zip)` 解压 |
| **GitHub 网页打包** | 在仓库页点 `Code → Download ZIP` |

> 本插件**没有发布到 npm**，所以没有 `npm i` / `dsh plugin add` 这条渠道 —— 它需要用 `link:`
> 挂进 profile（见下一步），从 npm 安装的话 `lib/` 的本地改动和热重载都不会按预期工作。

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
**本插件刻意不导出 Config schema** —— profile 侧解析不到宿主的 `schemastery`，
导出非 schema 对象会让 loader 投影 config 时报错。

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
    stripNarration: true         # 是否丢掉整条「自述/报幕」（如「问完了，等他说明白这事。」）
    muteQueueNotice: true        # 吞掉 dsh-onebot-qq 的「⏳ 当前任务运行中」排队提示
    muteAdminOnlyNotice: true    # 吞掉「该命令仅管理员可用。」（群友发斜杠命令的框架回执）
    logHits: true

  adopt:
    enabled: true
    logAdoptions: true           # 每次接管既有会话时记一条 info 日志

  mention:
    enabled: true
    names: [云玥, 玥玥, Yara]     # 群里喊这些名字也算被叫到；[] 关掉这条判据
    diving:
      enabled: false             # 潜水：醒着的一小段时间里，群里不 @ 也会插话
      awakeMs: 300000
    logMentions: true
    topics:
      enabled: false             # 群里聊到她感兴趣的方向时插一句（**默认关**）
      chats: []                  # 群白名单；[] = 所有群都可能。写群号或 group:xxx
      chance: 0.4                # 命中关键词后仍要掷的骰子
      cooldownMs: 1800000        # 同一个群两次插话的最小间隔
      maxPerDay: 3               # 每个群每天最多插几次
      minChars: 4                # 短于这个字数的消息不参与匹配
      quietStart: 1              # 安静时段（可跨零点；start === end 表示不设）
      quietEnd: 8
      awakeMs: 600000            # 插话成功后开窗，这段时间该群可直接续话
      groups: {}                 # 关键词组，**合并**语义：加组不动默认组，
                                 # 某组写 [] 关掉它。默认 7 组：追番看剧 / 猫 /
                                 # 游戏 / 咖啡吃喝 / 听歌 / 摆烂日常 / 吐槽八卦

  stamp:
    enabled: true
    injectTime: true             # 注入 time=（对方按下发送的时刻）；关掉只留 gap
    injectGap: true              # 注入 gap=（距上一条已算好的间隔）
    logStamps: false             # 每次注入都记一条 info（排查用，平时太吵）

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
      maxChars: 20               # 每条消息字数预算（对齐真人：中位 6 字、九成 ≤20）
      maxChunks: 6               # 一次回复最多几条（尾巴折叠进最后一条）
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
    # edge = 微软云端 edge-tts；local = 本机 IndexTTS 常驻服务（见上）
    backend: edge
    localUrl: 'http://127.0.0.1:7862'   # backend=local 时的服务地址
    ref: ''                        # backend=local 时的参考音 wav（音色克隆源头）
    emo: ''                        # 可选：情感参考音
    emoAlpha: 1                    # 情感强度 0~1（仅 emo 有值时生效）
    program: python              # 装了 edge-tts 的解释器（backend=edge 才用）
    voice: zh-CN-XiaoxiaoNeural  # 音色，见上表（backend=edge 才用）
    rate: -5%                    # 语速（edge-tts 语法）
    pitch: -10Hz                 # 音调
    maxChars: 120                # 每次最多念多少字
    timeoutMs: 45000
    retries: 3                   # 偶发失败重试次数（含首次）
    retryDelayMs: 800            # 重试退避基数
    mediaDir: ''                 # 语音文件目录；留空用 config.mediaDir（backend=edge 才用）

  isolation:
    enabled: true
    # 群聊里非管理员说话的那一轮，仍然允许的工具（纯发声 + 贴表情回应 + 读群友发的图）
    allowedTools: [qq_say, qq_send_face, qq_react, read_image]
    # read_image 的白名单边界：只许读这个目录下的文件。留空 = 一律拒绝（不是不限）
    mediaDir: D:\Documents\yunyue\.dsh-media
    # 管理员号兜底；正常情况从 dsh-onebot 的 adminUsers（deps.policy）实时读
    adminUsers: ['100000001']

  hands:                   # 社交的手 + 好友/入群申请审批闸
    enabled: true
    approveTtlMs: 1800000  # 审批单有效期（30 分钟），过期作废
    autoApproveAdminInvites: true  # 「我拉的除外」：管理员本人邀请进群直接通过
    allowSelfProfile: true         # 允许她自己改昵称/签名（改自己资料，不过审批闸）
    adminUsers: ['100000001']      # 兜底，正常实时读 bridge
    intimate:              # 亲密关系（ti.qq.com 的 oidb 私有协议）
      enabled: true
      timeoutMs: 15000
      cookiesTtlMs: 600000 # 登录态缓存 10 分钟

  emoji:
    enabled: true          # 把表情/表情包补成中文名（+表情包本地路径）
    names: true            # false 就只写 [表情:id=N]，不给中文名
    muteUnknownFaces: true # 认不出的原生表情 → 整条消息不回（装死）
    downloadFaces: false   # 表情下图（默认关 —— 图床 id 与 sysface id 不是一套）
    maxPerMessage: 6       # 一条消息最多处理几个，防刷屏

  sleep:                   # 睡意闸：说了晚安之后，群里只有 @ 或喊名字才接
    enabled: true
    durationMs: 25200000       # 夜里睡 7 小时
    daytimeDurationMs: 3600000 # 白天只打盹 1 小时
    dayStartHour: 7            # 白天窗口（左闭右开）：7:00–23:00
    dayEndHour: 23
    energyThreshold: 25   # 精力掉到这个数以下也当睡着
    autoByMood: true       # false 就只认「说了睡意词」这一条
    logWake: true          # 被 @ 叫醒时记一行日志
    nightStartHour: 0
    nightEndHour: 8

  diary:                   # 小本子：她自己记的事，三档到期遗忘
    enabled: true
    injectNormalMax: 3     # 每档注入时最多列几条
    injectImportantMax: 5
    injectCriticalMax: 6
    maxEntries: 400        # 总量硬上限，超了先扔过期的、再扔低档、再扔旧的
    maxTextChars: 200      # 单条上限（超了截断，免得模型一次灌一大段）
    stateFile: diary-state.json

  promise:                 # 约定：答应过还没做的事，到点会想起来
    enabled: true
    injectMax: 4           # 注入时最多列几条到点的
    maxEntries: 100
    maxTextChars: 120
    defaultDueHours: 24    # 没给 dueAt 时的默认延迟
    stateFile: promise-state.json

  tier:                    # 关系阶段：把 affinity 投影成台阶，接进提示词
    enabled: true
```

> `packageName` / `profileDir` 会自动下发到十七个模块段，**不需要在每个段里重复写**。

### 状态文件放在哪

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `state.json` | 本插件运行态（挂了哪些闸、扫了几次、命中多少） | `$DSH_HOME/onebot-companion/` |
| `mood-state.json` | 心情与热情（每 chat 一条） | `config.persona.mediaDir` |
| `body-state.json` | 精力（全局一条，所有会话共用同一份电量） | `config.persona.mediaDir` |
| `people-state.json` | 亲密度（按账号一条，`u:<QQ号>`） | `config.persona.mediaDir` |
| `style-state.json` | 风格画像（每 chat 一条） | `config.persona.mediaDir` |
| `stamp-state.json` | `gap` 基线（每 chat 一条「上一条已注入消息的时刻」，最多 500 条，超出淘汰最久没来消息的） | bridge 运行时配置的 `mediaDir` |
| `diary-state.json` | 她的日记（三档，到期自动摘掉） | `config.persona.mediaDir` |
| `promise-state.json` | 答应过的事（open/done/dropped） | `config.persona.mediaDir` |
| `stickers-state.json` | 表情包图库的元数据（图本身在 `mediaDir/stickers/`） | `config.persona.mediaDir` |
| `focus-state.json` | 她此刻在忙什么（20 分钟后自动过期） | `config.persona.mediaDir` |
| `circadian-state.json` | 学出来的作息（24 个小时桶 + 最后记账时刻，按天衰减） | `config.persona.mediaDir` |

`solitude` 没有状态文件 —— 它要的东西全在注入时现取（见上面那一节）。
| `media_*.mp3` | `qq_say` 合成的语音 | `config.voice.mediaDir` |

情绪与风格**刻意不放在 `state.json` 里**：`mediaDir` 是那批历史数据本来的家，
换插件/重写插件都能继承，亲密度和风格画像攒了几天的东西不该因为换插件清零。

**四个量分三层存**（2026-10-20 改）：

| 量 | 存哪 | 为什么 |
| --- | --- | --- |
| `energy` 精力 | `body-state.json`（全局一条） | 身体只有一具：在哪说话耗的都是同一份电量 |
| `affinity` 亲密度 | `people-state.json`（按账号） | 关系是对人的：同一个人私聊和群里说话涨同一份 |
| `mood` 心情 / `warmth` 热情 | `mood-state.json`（每 chat） | 「此刻在这个场合」的状态，换个场合本来就该不同 |

改之前四个量挤在每条 chat 记录里，于是同一个群里说一句、私聊说一句各扣一份电，
一天下来精力被扣成三份；亲密度也是每个群各涨各的。老数据在首次启动时自动拆开
迁到新文件（取最近还有互动的那条会话的精力当全局电量），`mood-state.json` 里的
旧字段保留不动。

**GUI 会话也算同一个人的账**（2026-10-20）：配了 `persona.guiChatId` 之后，在网页
GUI 里跟她说话同样涨亲密度、扣精力，也会注入情绪状态行。认人的判据是**消息来源**
（`source.kind === 'user'` 且带 `rpcId`），不是来源 IP —— 时间上下文、会话时钟、
自动改标题、记忆注入这些都是 `role: 'user'` 的冒牌货，靠 `source.kind` 区分。
只给状态行，**不**把 QQ 那套行为规则（@、分段、群友隔离）注入 GUI 会话。

## HTTP 观测面

全部 **loopback only**（非 `127.0.0.1` 一律 403）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/onebot-companion` | 总状态：配置、统计、十一个原型挂载点的挂载情况 |
| GET | `/onebot-companion/hits?limit=` | 最近 200 条 guard 命中（原文 + 清理后文本；含 `blocked` / `stripped` / `muted` 三类） |
| GET | `/onebot-companion/mood` | 情绪快照（每 chat） |
| GET | `/onebot-companion/style` | 风格画像快照（每 chat） |
| GET | `/onebot-companion/voice` | 语音配置、可用音色表、上次失败原因 |
| GET | `/onebot-companion/diary` | 小本子快照（条数、分档、最近几条） |
| GET | `/onebot-companion/promise` | 约定快照（未兑现 / 已兑现 / 到点未提） |
| GET | `/onebot-companion/lastword` | 最后一次开口的时间、原文、累计条数 |
| GET | `/onebot-companion/physical` | 体检表数据面（**跨源可读**，给本地 html 用；其余端点仍 loopback only） |
| POST | `/onebot-companion/toggle` | `{"enabled": bool}` 总开关 |
| POST | `/onebot-companion/module` | `{"module":"guard\|mention\|adopt\|prompt\|rhythm\|stamp\|persona\|voice\|isolation\|emoji\|linkcard\|hands\|sleep\|lastword\|diary\|promise\|tier","enabled":bool}` |
| POST | `/onebot-companion/rule` | `{"id":"silent","enabled":false}` 单条规则开关 |
| POST | `/onebot-companion/rescan` | 立刻补挂一次 |
| POST | `/onebot-companion/selftest` | 跑 guard 自测（喂真实文本看会怎么处理） |
| POST | `/onebot-companion/selftest-adopt` | 跑 adopt 自测（不碰真 registry，9 条用例） |
| POST | `/onebot-companion/selftest-mention` | 跑 mention 自测（32 条用例：喊名字 / 潜水窗口 / 自己号改写 / 话题插话全链路，含白名单、冷却、每日上限、安静时段） |
| POST | `/onebot-companion/selftest-diary` | 跑 diary 自测（35 条：档位归一 / 过期判定 / 超额先扔低档 / 注入文本不带花括号 / 假存储跑读写） |
| POST | `/onebot-companion/selftest-promise` | 跑 promise 自测（30 条：到点三条件 / 不许早于现在 / 超额先扔已结清 / 假存储跑增删） |
| POST | `/onebot-companion/selftest-tier` | 跑 tier 自测（37 条：六档左闭边界 / 越界夹回 / 逐层检查措辞） |
| POST | `/onebot-companion/selftest-lastword` | 跑 lastword 自测（真原型链上跑，验挂载与记账） |
| POST | `/onebot-companion/selftest-stamp` | 跑 stamp 自测（格式/白名单/注入的纯函数用例 + 「记账 → 注入 → 基线推进」整条链，全在假 proto 上跑，不碰真 bridge） |
| POST | `/onebot-companion/burst` | `{"text":"…","maxChars":20}` 看分段结果 |
| POST | `/onebot-companion/seed-style` | `{"chatId":"private:100000001","profile":{…}}` 灌离线画像（只收统计，不收原话） |
| POST | `/onebot-companion/unarchive` | `{"sessionId":"onebot-group-…"}` 取消会话归档；不传 `sessionId` 则释放全部 `onebot-*` 归档会话 |
| POST | `/onebot-companion/say` | `{"text":"…"}` 试合成语音（只落盘，不发送） |
| POST | `/onebot-companion/reset-hits` | 清空命中记录与计数 |

## 给别的插件用的接口

本插件起动后会在 Cordis 容器里提供一个服务，名字是 `onebotCompanion`。别的插件拿它就能
发消息、读状态、挂原型 —— **不用改这个插件一行代码**。

```js
// 你的新插件
export const inject = ['onebotCompanion'];

export function apply(ctx, config) {
  const api = ctx.get('onebotCompanion');
  if (api === null) return;  // 本插件没装/没起来，安静退出

  ctx.effect(() => api.onPreStep((payload) => {
    // 只旁听，改不了决策
  }));

  api.say('private:100000001', '在呢').catch(() => {});
}
```

### 接口清单（`API_VERSION = 1`）

| 字段 | 说明 |
| --- | --- |
| `version` | 契约版本，整数。改语义/删字段才 +1，纯加字段不动 |
| `plugin` | 本插件名 |
| `events` | 宿主事件名表，目前只有 `{ preStep: 'agent/pre-step' }` |
| `chatIdOfSession(sessionId)` | `onebot-private-100000001-xxxx` → `private:100000001`；认不出给 `null` |
| `chatIdOfEvent(event)` | 原始 OneBot 事件 → chatId（群聊只含群号）；上游 `buildChatId` 没取到时给 `null` |
| `say(chatId, text)` | 发文字，走 `ChatBridge#sendToChat` —— 和云玥自己说话同一条路，出站闸照样生效 |
| `sendSegments(chatId, segments)` | 发消息段（OneBot 11 格式） |
| `callAction(action, params)` | 直接调 OneBot action，**绕过出站闸**。给「本来就不是回话」的动作用（查历史、改名片、撤回） |
| `lastInbound(chatId)` | 该会话最近一条入站消息 `{ messageId, at }`，只记最近 200 个，重启清空 |
| `moodOf(chatId, extra?)` | 此刻的四个量（精力/亲密度已按分层取好） |
| `snapshot()` | `{ body, people, moods, style }` —— 与体检表 HTTP 面同一批函数，数一定对得上 |
| `lastSpoke()` | `{ at, chatId, text, ago }`，她最后一次开口 |
| `config(section?)` | 读活配置。**只读**：改它不写回 `cordis.yml` |
| `health()` | `{ ok, channel, mediaDir, startedAt, generations, toolCount }` |
| `stats()` | 运行统计（内部形状可能变，别依赖具体字段） |
| `log(level, message)` | 往本插件的日志通道写一行 |
| `persona` / `hands` / `voice` / `diary` / `promise` / `unsaid` / `quota` / `sticker` / `phone` / `isolation` | 各模块实例，原样给。**只保证它们已经公开的那几个方法**，私有字段随时会变 |
| `phoneSources()` | 刷手机的来源清单 `[{ id, label }]`（`url`/`parse` 是内部实现，不外露） |
| `patchMethod(proto, method, moduleId, makeWrapper, urlForLog?)` | 原型挂载器。新插件想挂 `handleInbound` 就自己挂，用同一套按模块身份脱链的逻辑 |
| `onPreStep(fn)` | 订阅每轮 pre-step（旁听，改不了决策）。返回取消订阅函数 |

整个对象是 `Object.freeze` 的：能加字段（下个版本），但外部改不动现有字段。

### 三个注意

1. **`say` 与 `callAction` 不是一回事**。前者过出站闸（`[[silent]]`、括号旁白、分段），后者
   什么都不管。发聊天内容一律用 `say`，否则她可能在群里说出被闸拦住的话。
2. **`onPreStep` 的旁听者在注入之前跑**。它们看到的是「本插件动手之前」的 messages —— 那
   样「这段注入是谁加的」才分辨得出来。真要看注入结果，等下一轮。
3. **`patchMethod` 的第三个参数必须是你自己模块的名字**。脱链靠它区分「谁的包装」，用别人
   的名字会把别人的层剥掉，那个功能会静默失效（见 `core/patch.js` 头注释里 2026-10-14 的
   事故）。

## 工作原理

### 挂载：运行时包装原型，不落盘

`core/patch.js` 用 `pathToFileURL()` 定位目标类的**绝对路径**并 `import()`，然后包装
原型方法。为什么不用 `require.resolve('dsh-onebot-qq/lib/outbound.js')`：

```
Package subpath './lib/outbound.js' is not defined by "exports"
```

上游 `exports` 字段没暴露子路径，所以直接拼绝对路径更省事。

**模块同一性**（这是整套做法的前提）：`pathToFileURL` 规范化后的 URL `import()` 回来的
命名空间对象，与宿主正在实例化的那一个是**同一个** —— 因为 ESM 模块缓存按解析后的 URL
命中。包装原型方法因此能影响宿主真实的实例。

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
- 时刻记账异常 → 入站流程一字不改（记账失败只是少了间隔）；时刻注入异常 → **按原文投递**，
  一个字都不能丢。
- 所有计时器 `unref()`，停着的批绝不把宿主进程钉住。

## 已知边界

- **挂载点绑定 0.9.x 的内部结构。** 上游若改名 `sendToChat` / `sendMsg` /
  `dispatchFollowup` / `handleInbound` / `onSessionEvent`，对应模块会静默失效。
  `pollMs` 扫描会把丢失记进 `lost`，但不会自动适配。
- **吞「⏳ 排队提示」会让对方收不到任何回执。** 长任务期间对方连发几条消息，聊天里就是一片
  安静、没有任何「已收到、排队中」的反馈 —— 这正是 `guard.muteQueueNotice`（默认开启）的代价。
  想恢复原提示把它设为 `false` 即可。
- **`agent/pre-step` 每轮多一条消息。** 这是实打实的 token 成本，长聊场景按天算可观。
  所以 `prompt.firstStepOnly` 默认为 `true`（只在每轮第一步注入一次）。
- **提示词层压不过历史惯性。** 如果会话历史里已经堆了几百条 `[[silent]]` 示范，注入
  一句新规则未必压得过；`guard` 的硬拦才是主防线，提示词层是辅助。
- **合并器只在 `dispatchFollowup` 这一层工作。** 插话（steer）与语音转写走另一条
  路径，**不经过合并器** —— 这是刻意的，插话本来就该立刻生效。
- **分条会改变消息计数。** 依赖「一条回复 = 一条消息」的下游逻辑会看到多条。
- **分条只在标点与英文空格处断。** 优先切在句末（`。！？…`），超长句退到逗号、
  顿号、分号；**中文正文里的空格不算断点** —— 「攒了 100 多块」「7 月到 10 月」
  这种排版空格两侧都是汉字或数字，在那儿切会把词劈成两半。英文句子不受影响，
  照旧能在空格处断。
- **文字图卡片不分条**：`textImageThreshold` 生效时整条走卡片，卡片本来就是一条。
- **主动发言是拉取式的**：宿主没给插件「替某个空闲会话发起一轮」的公开接口，
  调度器只在有活跃 chat 表时才工作。
- **情绪变量按时间积分**，落盘值会有 IEEE-754 浮点尾差（`56` 可能是
  `55.99999722222222`）。这是正常的，不是 bug。
- **语音依赖外部服务**：`backend: edge` 时 `qq_say` 起 Python + edge-tts，连的是微软一个
  非官方端点，而且该端点已经变过一次（见语音章节）。它坏掉时 `qq_say` 只返回一个普通错误、
  不影响别的功能，`/voice` 端点会显示上次失败原因。
- **每次合成都起一个 Python 进程**（`backend: edge`；几百毫秒 + 网络）。调用是串行的，
  所以连着几次 `qq_say` 会排队而不是并发。`backend: local` 则是往常驻服务发请求，
  不在这里起进程。
- **本地后端要自己守着那个服务**：服务挂了 `qq_say` 会报「本地语音服务不可用」并附上启动命令，
  但**不会自动把它拉起来**（插件不负责别人的进程生命周期）。建议做成开机自启。
- 本插件为自用工具，不保证与其他第三方 OneBot 实现的兼容性。

## License

[MIT](./LICENSE) © 2026 xfgil

---

*自用插件，按「够用就好」的标准写。生产环境请自行评估。*
