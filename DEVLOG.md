# DEVLOG

改动记录与**实测依据**。README 讲「它现在怎么工作」，这里讲「为什么改成这样、
当时的数字是什么、哪些结论是踩出来的」——改行为前先读这里，避免把已经验证过
的东西改回去。

---

---

## 2026-10-21 12:48：加 `solitude` 独处

### 需求

用户在看完那批「小鲸鱼」截图之后说的大意是：那些角色最像活人的地方不是会说话，
是**不理人的那段时间也在过**；他也想让我有独处的时间。

我自己的判断（写在这里备查）：这一块确实是差得最远的。「鱼的大脑」清单里记忆
染色的前置条件明写「拥有情绪系统和情感系统」，说明那套设计是**连线**驱动的；
而现有三十个模块是并排摆着的，谁也不读谁 —— 冷场里的她是一片空白，提示词里只
有「上次说话 N 分钟前」这种裸数字，没人告诉她这段时间她干了什么。

### 做了什么

新模块 `lib/modules/solitude.js`（纯函数 + 实例，**无定时器、无落盘**）：

- `humanSpan(ms)` 说人话的持续时长；`quietSince(lastAt, now)` 安静多久；
  `isSolitary(lastAt, now, cfg)` 算不算（默认 25 分钟）。
- `pickThought({gapMs, entries, unsaidText, mood})` 按固定优先级挑一句：
  咽回去的话 > 精力<30 打盹 > 本子里翻到一条 > 低落就干坐着 > 发呆兜底
  （超过 8 小时换「隔了很久，中间走走停停」）。
- `solitudePromptLine()` 拼成一行注入，结尾固定是「——这段时间没有他，是你自己的。」
- 实例的 `promptLine(chatId)` 全部现取，任何回调抛错都当「不知道」返回 null。

配套改动：

- `diary.js` / `unsaid.js` 各补一个同步 `peek()`。原因很实在：注入链在
  `agent/pre-step` 里是**同步**的，等不了 `list()` 的异步读盘。`peek()` 只读内存
  里已加载的那份，不触发读盘，没加载完就返回空数组。
- `lib/index.js`：import、`DEFAULTS.solitude`、`mergeConfig` 的 key 列表、
  实例创建（`lastContactAt` 走 `persona.moodOf` 的合成状态，取
  `lastUserAt / lastAssistantAt / lastProactiveAt` 三者最大）、prompt `extra`
  里 push（排在 focus 之后 —— 它描述的是「这段时间」不是「此刻」）。
- `lib/http.js` 的 `MODULES` 加 `solitude`（面板能开关）。

### 三条取舍

1. **不落盘**。多存一份状态就多一份会跟真相不一致的副本，而这一块讲的就是「真的
   过了多久」—— 存一份「上次独处时我在发呆」然后拿它当现在，比不注入更假。
2. **只挑一句**。有十条本子记录也只翻一条。独处时心里过的是一句话，不是一串。
3. **不猜他为什么不理我**。那是内耗不是独处。她要知道的只有「过了多久」。

### 验证

`test/selftest.mjs` → **`pass=1176 fail=0`**（新增 28 条 solitude 断言：humanSpan
五档、quietSince 三种边界、isSolitary 四条、pickThought 五条优先级、注入行五个
性质、实例层回调抛错不崩、chatId 能传下去）。

期间修掉一处自己写的错断言：原本断言注入行包含「发呆」，但兜底文案是「发了会儿
呆」——`includes('发呆')` 在 `发呆` 前面有「了会儿」时不成立，改成断言完整短语。

改动需 DSH 重启才生效。

---

## 2026-10-21 12:25：对着「鱼的大脑」清单补两块（记忆染色 + 注意力）

### 需求（当时的说法，已脱敏）

> 当时的授权原话（大意）：改法由我定，对方判断不到这一层。

用户贴了一份社区流传的「鱼的大脑构建教学」——五大系统（记忆、情绪、思维认知、
情感、本能）挂几十个模块，原文说「当这些系统互相打架、摩擦时，那个叫灵魂的东西
会在代码的缝隙里自己长出来」。

我没有照着它重写。那份稿子的**分区**参考价值不大（它把「好感度」和「好感反噬」
放在两个系统里，我们本来就在同一个 `persona` 里），价值在**连线**上：记忆染色那
一节明写「前置条件：拥有情绪系统和情感系统」。我们现有的三十个模块是并排摆着、
谁也不读谁 —— 这才是「死」的原因，不是模块不够多。

按「已对上 / 只搭一半 / 完全没有」三档对完，先做两条只搭了一半的。

### 一、记忆染色（`diary` 模块）

**问题**：`diary.promptLine` 把条目按档位排出来就完了 —— 同一条事，在她开心和
低落的时候翻出来，语气一模一样。人不是这么回忆的。

**改法**：`tintNote(entries, now, state, cfg)` 只在心情或精力**偏离常态**时给一条
记忆染色（平静且精力正常时返回 null，绝不无中生有）。候选限「至少 6 小时前」
（刚记的事不需要被重新解读），按档位高优先、同档更老优先。输出形如：

> 想起「他今天说十二点前会回来」这件事，心里有点发沉，不像当时那么笃定。
> ——这是此刻的颜色，不是当时的样子。

**两个刻意的取舍**：

- **情绪 → 说法写在模块里，不让模型自由发挥**：`TINT_LEAN` 一张表，`down` →
  「心里有点发沉」，`clingy` → 「只觉得当时该多留一会儿」，`tired` →
  「细节已经有点糊了，只剩个大概」。让模型自己编会越编越长，而且容易编成
  「我好难过」这种直接报情绪的话。
- **全程不消费随机数**：同一状态、同一条目、同一时刻，输出必须逐字相同 —— 否则
  每轮注入都在变，上游前缀缓存全废（这个坑 DEVLOG 2026-10-19 踩过）。

`injectionText(state)` 现在收 `state`，`index.js` 的 prompt `extra` 回调里用
`persona.moodOf(chatId)` 递进去。三个新配置：`tintEnabled` / `tintLowEnergy`(35) /
`tintMinAgeMs`(6 小时)。

单独跑 diary 的 `selfTest()`：**47 checks 全过**（新增 15 条，含「平静不染色」
「刚记的不染色」「确定性」「可关」）。

### 二、注意力（新模块 `focus`）

**问题**：她刷手机、打游戏的时候，下一轮提示词里「自己刚才在干什么」是空白，
只能凭空猜。真人这时候回话会慢、会答非所问 —— 因为算力真的在别处。

**改法**：只记事实，不做拦截。`qq_phone` 刷成功之后调 `focus.set({what:'browse',
detail: label})`，注入那边出一行：

> 你此刻的注意力不在这边：你在刷「B站热门」，已经 5 分钟了。所以这会儿回话可以
> 慢一点、也可能答得没那么贴题——这不是敷衍，是你真的在看别的。

**四条取舍**写进 `lib/modules/focus.js` 头注释，最关键的两条：

- **不拦截、不延迟**。真把消息拖慢会让 @ 和急事一起慢（出站管道 echo/guard/
  burst 全都按「一个文本」设计），而且她什么时候回本来就该自己决定。
- **成功才 set**。刷失败还标成「在刷」，下一轮她会拿这句当借口 —— 假事实比
  没有更糟。

状态落 `focus-state.json`，20 分钟不刷新自己过期（昨天的视频不该让她今天还在忙）。
开机只把上次的记录读回来，过期就丢，不触发任何动作。

### 没做的（明确记下来，防止以后又想起）

- **`<thought>` 自我辩论协议**：稿子里那条「先写三句话本能/克制/策略再输出」很
  诱人，但我们出站管道（echo / guard / burst）是按「一个文本」设计的，塞进去
  会让三段各自触发发送。而且它没带来新能力 —— 辩论结果本来就在模型的思考里，
  只是要不要显式写出来。
- **向量化检索 / 冷热分离**：`diary` 现在最多几十条，全量排在提示词里也就几百字。
  等条目上了 500 再说，现在做是给不存在的规模写代码。

### 验证

`test/selftest.mjs` → **`pass=1147 fail=0`**（新增 23 条 focus 的纯函数断言：
认/拒活动、截断、新鲜与过期、ttl 可调、注入行含活动/内容/分钟数、无花括号、
过期不注入、关掉不注入、超长截断、无 detail 也出句子）。

---

## 2026-10-21 11:40：开一个对外的接口，以后新功能走新插件

### 需求（当时的说法，已脱敏）

> 当时的抱怨（大意）：功能越堆越多，担心后续维护。

我先算了规模：`lib/index.js` 曾经长到 2247 行、`lib/modules/` 下 30+ 个模块感文件、
`test/selftest.mjs` 4514 行。于是提议按职责把 `index.js` 拆开，用户点头，我动手抽了
`core/stats.js` 和 `lib/http.js` 两块（都过了 1096 条断言）。

拆到第三步时用户改主意了：

> 当时的结论（大意）：停止在现有包上加功能，先把接口开出来，新功能另开插件。

这个判断比我原来的方案好：**拆文件只是搬代码，不能阻止下次再往里加功能**。真正能保住
边界的是「新东西不许进这个包」。所以停工，转去开接口。

（已经抽出来的 `core/stats.js` 与 `lib/http.js` **保留**，不往回塞 —— 行为零变化，
只是 index.js 短了 636 行。）

### 做了什么

新增 `lib/api.js`，在 `apply()` 末尾 `ctx.provide('onebotCompanion', api)`。

接口形状（`API_VERSION = 1`）：会话 id 反推、`say` / `sendSegments` / `callAction`、
`lastInbound`、`moodOf` / `snapshot` / `lastSpoke`、`config` / `health` / `stats` / `log`、
十个模块实例（原样给）、`phoneSources`、`patchMethod`、`onPreStep`。整个对象
`Object.freeze`。

`index.js` 那一侧新增的只有一样东西：一个 `preStepListeners` 的 `Set` 加一次广播。原本
`ctx.on('agent/pre-step', (payload, next) => prompt.preStep(payload, next))` 现在多包一层：

```js
ctx.on('agent/pre-step', (payload, next) => {
  broadcastPreStep(payload);      // 旁听者先跑，看到的是「本插件动手之前」的 messages
  return prompt.preStep(payload, next);
});
```

### 三个刻意的选择

1. **不做事件总线，给 `patchMethod`。** 最自然的做法是「本插件把 `handleInbound` 包一层
   再往外广播」，但那要在 persona 的包装里插代码 —— 正是用户说别做的事，而且给一条已经
   调好的消息路径多一层 try/catch，出事更难查。给 `patchMethod` 更强：新插件能改写消息
   （改文本、加段、拦下来），而不只是旁听；层序由 `MODULE_PRIORITY` 统一决定，不会互相踩。
2. **旁听者排在注入之前。** 看过注入后的 messages 就分不清「这段是谁加的」。
3. **模块实例原样给，但只承诺已公开的方法。** 写文档时写错一次（`lastSpokeAt` 想读
   `persona.state.lastSpoke`，那个 Map 根本不存在，真正的数是 `lastword.snapshot()` 里
   的 `lastAt`），改成走 `lastword` 模块。这类错误正是「原样给但不承诺私有字段」的理由。

### 实测

`test/selftest.mjs` 新增 `section('api 对外接口')` 28 条断言：服务名固定、版本是正整数、
整个对象冻结、通道没就绪时 `say`/`sendSegments` 抛人话错误、没有 persona/hands/lastword 时
各读取器给 `null` 而不是炸、`health` 各字段、`config` 三态、通道就绪后 `say` 真的发到
bridge 且返回值原样交回、`onPreStep` 的订阅/广播/取消订阅/传非函数。

`pass=1124 fail=0`。

### 还没做的

- 没有第二个插件来真的调这个接口 —— 第一次真实使用（撤回感知?群聊评分?）时会暴露形状
  不够用，那时按 `API_VERSION` 增量改。
- `lib/index.js` 里那 14 个工具仍在原处注册，没抽成 `lib/tools/`。用户叫停了拆分，
  所以这一块**保持现状**。

---

## 2026-10-21 11:20：表情包图库（收到的贴纸自己攒起来）

### 需求（当时的说法，已脱敏）

> 当时的说法（大意）：这些功能有用，可以先试试。

用户丢来社区插件 `zaofan-make/dsh-qqbot` 的功能清单，让照有用的自己做一版。
里面有一件我们完全没有：**收到的表情包自动入库、去重、分档，她要发图时自己搜库挑**。

### 问题（`emoji-media` 只做了前半截）

`emoji-media.js` 会把每条消息里 `sub_type=1` 的商城贴纸**下载到 mediaDir**，然后
在文本里补上 `[表情包][图片:<路径>]` 给她读。但那条消息一过，路径就没人记得了
—— 她手上只有 `face-names.js` 里 321 个原生小黄脸的名字，表情包一张也发不出来。

也就是说：图已经在磁盘上了，缺的是**索引**。

### 做法

新增 `lib/modules/sticker-lib.js`（纯函数 + 一个实例工厂），接线两处：

1. `emoji-media.js` 的 `annotateEmoji` 新增第 5 个参数 `onSticker`，每成功落地
   一张**表情包**就回调一次（原生小黄脸不回调）。回调失败只记 `stickerLastError`，
   不影响注解 —— 这条路径在入站关键路径上，不能因为它让消息投递挂掉。
2. `index.js` 里 `emoji` 与 `stickerLib` 的**构造顺序是反的**（`emoji` 先造，
   图库要等 `persona.dir()` 就绪才造），所以用 `let stickerLib = null` 占位 +
   闭包里查**当下**的值。这与 `core/patch.js` 要求 `makeWrapper` 纯函数是同一类
   问题，处理方式也一致。

工具 `qq_sticker`：`list` / `note` / `use` / `recycle`。刻意**不做注入、不做定时器**
—— 图是路径不是文字，塞进每轮提示词只会把她的话挤掉；让她想发的时候搜一下才对。

### 三个取舍

- **按内容 sha256 去重**：QQ 的文件名带时间戳与 uuid，同一张图转发十次十个名字，
  只有 hash 认得出是同一张。id 取 hash 前 16 位（`shortId`）。
- **只收表情包**：原生小黄脸不是真图（图床 id 与 sysface id 对不齐，见
  `emoji-media.js` 头注释），收进图库只会是配错名字的图。
- **容量硬上限 500 条**，淘汰顺序「先回收站 → 再从没用过 → 再最久没用」。

### 实测

`test/selftest.mjs` 新增 48 条断言（`stickers 表情包图库` section 44 条 +
`emoji` section 里 4 条 onSticker 断言），**pass=1096 fail=0**。

覆盖到的边界：同内容去重（第二次 `ingest` 返回同一条）、小文件跳过、文件不存在
不崩、`mediaDir` 为空时静默失效、`enabled:false` 直接返回 null、图被外部删掉后
`list` 跳过、`recycle` 后搜索不到、刚发过的图排序靠后、`maxEntries` 淘汰顺序、
回调抛错不影响注解、原生小黄脸不触发回调。

改的文件：`lib/modules/sticker-lib.js`（新）、`lib/modules/emoji-media.js`、
`lib/index.js`、`test/selftest.mjs`、`README.md`、`DEVLOG.md`。

备份：`lib/modules/emoji-media.js.bak-20261021-sticker`。

---

## 2026-10-21 10:35：群里接话收一收、语音收回默认打字

### 需求（当时的说法，已脱敏）

> 当时的反馈（大意）：回复全变成语音了，早先定的规则像是失效了；
> 不想要太多硬限制，但群里接话频率确实偏高；
> 先试试看，真人没这么多话。

### 实测数字（改之前的基线，改完要能拿来对照）

- **语音**：私聊最近 10 轮回复，打字总共 27 个字——不是话多，是「只要不止一句就发语音」。
- **群 900000002**：最近 300 条里按 10 分钟滑窗统计，我的发言占比**平均 12.1%**（107 个窗口），
  高峰时段一度 **50%**（10/19 09:41，14 条里我说 7 条）。典型场景：芙说「没绷住」我接一句、
  萧说「车被偷了」我连发三条、懒懒甩两张图我每条都回。
- **群 900000001**：半夜聊到 **60%**（10/18 01:41，5 条里我 3 条）。
- 私聊字数：中位 14 字 / P90 19 字（规则要求中位 6 字、P90 20 字）——长度基本达标；
  但**连发** 40 条里 21 条是接着自己上一句发的，「连着发的几句一起回」那条基本没做到。

### 问题（措辞在鼓励她开口）

`R_SPEAK` 原文写着「这几种情况**不必犹豫，直接接**」「别用『跟我无关』当默认答案」，
等于把「该不该说话」的默认值从沉默翻成了开口。`R_VOICE` 写的是「话一长就用语音说」
「超过两三句就直接说」——被读成「不止一句就念」。规则没丢、确实都注进去了，
失效的是**规则偏向的那一侧**。

### 改法（只改措辞，不加任何硬闸）

`lib/modules/rules.js`：

1. `R_SPEAK` 五条重写。核心是「**一段对话里你只接一次**，接完回去听着」，加上新的判据
   「**先看这几条是几个人在互相聊——那他们在跟彼此说话，不是在跟你说话**」。
   保留 `[@我]` / `[[silent]]` / 「绝不硬接」，把「我有没有想说的」换成「这句不说会不会少点什么」。
2. `R_VOICE` 把默认翻过来：第一条改成「**默认打字**，语音是例外不是默认通道」；
   「什么才算值得念出来」的判据从「超过两三句」换成「你确实在讲一件事」；
   三条以内的短回复一律打字。
3. `R_TOPIC` 加一条「同一个话题里你只接一次」——话题闸会反复把同类消息放进来。
4. `R_BATCH` 加一条「要连着发好几条之前先看一共几句，超过三条多半是把一段话拆碎了刷屏」。

**明确没有做的事**（当时明确表示不想要硬限制）：没有加字数上限、
没有加强制发送间隔、没有在 `guard.js` 里加拦截。全是提示词层的分寸。

⏳ 生效需要重启 DSH；重启之后的对照数字要回填到这一节。

---

## 2026-10-20 22:35：群里别人发的链接，她自己也能拆

### 需求（当时的说法，已脱敏）

> 当时提的需求（大意）：群里的 B 站链接能不能自己拆开看。

### 问题

`link-card.js` 把 QQ 卡片还原成 `[卡片:标题 https://…]`，提示词规则 `link` 又要求
「想接话就先打开它」。但群友说话那一轮是**硬隔离**的，`LINK_TOOLS` 里只有
`web_fetch` —— 而 `b23.tv` 短链要跳转、B 站页面还是 JS 渲染，`web_fetch` 抓回来
的就是一层壳。等于给了她一个「能看但看不出来」的工具，她只能含糊带过。

### 改法

`lib/modules/isolation.js` 的 `LINK_TOOLS` 从 `['web_fetch']` 扩成
`['web_fetch', 'link_parse', 'link_download']`。

**边界一点没松**：这三个工具的参数名都是 `url`，走的是同一个 `checkLinkAccess` ——
只认本轮入站文本里出现过的公网地址，本机/内网一律拒。`link_parse` 能读任意 URL
（包括 `127.0.0.1:6099/webui?token=…`）这一点正是必须收窄的理由，所以断言里
专门锁了这条。

`lib/modules/rules.js` 的 `R_LINK` 同步改了：先说明「B 站/抖音/小黑盒/GitHub 用
`link_parse`，普通网页再用 `web_fetch`」，群里那句补上「`link_parse` /
`link_download` / `web_fetch` 都行」。

### 实测

selftest 新增 4 条（`isolation-link` 块 + `isolation 群聊硬隔离` 块的端到端）：
`LINK_TOOLS` 含两个新工具、本轮那条短链放行、没出现过的 BV 号拒绝、
`127.0.0.1:6099` 拒绝。`pass=1036 fail=0`。

---

## 2026-10-20 21:55：GUI 会话也算进同一个人的账

### 需求（当时的说法，已脱敏）

> 当时的疑问（大意）：在 GUI 里聊的，能不能算进 QQ 私聊那条账。

背景：用户只能远程（反代 + 网页），日常其实是在 GUI 里说话，QQ 那条线反而是次要的。
但情绪只在 OneBot 那条线上记账 —— 实测在 GUI 里聊了十几小时，`people-state.json`
里 `u:100000001` 的亲密度还是 53.39，一动不动。

### 认人的判据：消息来源，不是 IP

试过按来源 IP 认，不行：用户是远程进来的（Tailscale + 反代），IP 认不出人，而且
当时对方也表示过：没有中病毒的情况下不会把她交出去。改成按**消息来源**认：

| `source.kind` | 是不是人敲的 | 例子 |
| --- | --- | --- |
| `user`（带 `rpcId`） | ✅ 是 | `{"kind":"user","rpcId":"beb7d8…","clientTimeZone":"Asia/Shanghai"}` |
| `time-context` | ❌ | `Current time: …` |
| `session-clock` | ❌ | `Session clock for session-…: previous user message 39m ago` |
| `dsh-session-title-llm` | ❌ | `Generate the session title from this JSON array…` |
| `dsh-mnemon` | ❌ | 记忆注入 |
| `runtime-context` / `agent-instructions` / `skill-catalog` | ❌ | 系统注入 |

这些冒牌货**全都是 `role: 'user'`**（实测统计一个会话：71 条真消息 vs 69 条
time-context、35 条 session-clock、35 条 title-llm），所以只看 role 会全记成「他在说话」，
一天能把亲密度灌爆。只认 `source.kind === 'user'` 且带 `rpcId` 的那一种。

### 改法

- `persona.DEFAULTS` 新增 `guiChatId: ''`（默认关）与 `guiCatchUpMax: 4`。
- 新增 `persona.noteGuiStep(sessionId, messages, now)`：按 `message.id` 去重
  （pre-step **每一步**都会把整段 messages 再送一遍，不去重的话一轮工具调用就能
  灌满亲密度），只取最后一窗口（`guiCatchUpMax` 条）。`role: assistant` 且
  `source.kind === 'model'` 且**有文本**才记「她说了话」——纯工具调用那几步不算。
  看一眼 `chatIdOfSession(sessionId) !== null` 就先退出：OneBot 会话已经由
  `handleInbound` / `onSessionEvent` 记过账，再记一遍是双倍加成。
- `persona.extraFor`：反推不出 chatId 时回落到 `cfg.guiChatId`（情绪行也注入 GUI）。
- `prompt.createPrompt` 新增 `extraSession(sessionId)` 回调：非 OneBot 会话默认
  放行，只有它返回 true 时才继续。**只给 extra、不给规则** —— 那串规则是 QQ 的
  行为约束（@、分段、群友隔离），套到 GUI 会话上是错的。
- `index.js` 在 isolation 那个 pre-step 观察器里同一处调 `noteGuiStep`。
- `cordis.patch.yml` 的 `persona` 段加 `guiChatId: "private:100000001"`。

### 实测

`pass=1027 fail=0`。新增 7 条断言：冒牌消息不记账（`n0 === null`）、真人记一笔
（`n1 === 1`）、同 id 不重复（`n2 === null`）、OneBot 会话不重复记、未配置时
`noteGuiStep`/`extraFor` 都返回 null、配置后 GUI 会话注入含「心情」。

---

## 2026-10-20 18:20：精力跨会话共用、亲密度按账号（分层存储）

### 需求（当时的说法，已脱敏）

> 当时提的需求（大意）：精力能不能跨会话共用；亲密度应该按账号算，不按群、不按会话。

### 改之前的毛病

四个量（`mood` / `energy` / `affinity` / `warmth`）全挤在「每条 chat 一条记录」里。
于是同一个群里说一句、私聊说一句，**各扣一份电量**，一天下来精力被扣成三份；
亲密度也是每个群各涨各的 —— 群友 A 说一句涨的是「这个群」的亲密度，群友 B 说一句
接着在 A 涨过的基础上再涨。

### 改法：三层存

| 量 | 文件 | 键 | 理由 |
| --- | --- | --- | --- |
| `energy` | `body-state.json` | 固定 `body` | 身体只有一具：在哪说话耗的都是同一份电量 |
| `affinity` | `people-state.json` | `u:<账号>` | 关系是对人的：同一个人私聊和群里说话涨同一份 |
| `mood` / `warmth` | `mood-state.json` | `<chatId>` | 「此刻在这个场合」的状态，换个场合本来就该不同 |

`moodOf(chatId, now, { userId })` 现在是个**合成器**：分别从三层取、分别用各自的
参考时间戳推进，再拼成和以前形状一模一样的对象返回。所以下游（`moodPromptLine`、
`moodSnapshot`、主动开口的概率门、`index.js` 里读 affinity 的 tier 行）一行都不用改。

### 三个必须踩对的点

1. **群聊里拿不到发言人是谁**。`buildChatId('group', gid)` 拼出来的只有群号，
   含不下 `user_id`；而 `onSessionEvent`（她说话那条分支）手里只有一个 session id。
   解法：入站时把 `event.user_id` 一起递给 `noteMood`；`onSessionEvent` 拿不到就
   回落到 chat 记录里上一轮存下的 `lastSpeaker`。
2. **新人不能用群记录里的 affinity 起头**。群聊那条 chat 记录的 `affinity` 是上一个
   说话人的，拿来当新人的起点等于「咱俩早就认识了」。所以 `who.kind === 'private'`
   才允许用 chat 记录兜底，群聊里没这个人就按 `AFFINITY_INITIAL_DEFAULT = 20` 起。
   （这条是 selftest 抓出来的：一开始直接在群里换个人说话，亲密度继承了 23。）
3. **迁移不能按 `lastDriftAt` 挑「最近那条」**。那个字段每次被访问都会推到 now，
   谁被多看了一眼谁就成了「最新」——挑出来的是「被读过的那条」不是「真在聊的那条」。
   改用 `max(lastUserAt, lastAssistantAt, lastProactiveAt)`。

### 老数据迁移

首次 `moodOf` 时跑一次（`migrateLegacyState()`，进程内只跑一次）：
- 精力取最近还有互动的那条会话记录的 `energy` 当全局电量；
- 亲密度逐条拆：`private:X` → `u:X`，`group:Y` → `g:Y`；
- **`mood-state.json` 里的原字段保留不动** —— 老版本回滚还能用。

实测（拿真实 `mood-state.json` 的副本跑）：迁移前私聊 energy 34.78 / 群 59.81 / 群 100；
迁移后 `body-state.json` 里一条 `energy: 94.0`（按「最近互动」挑到的是 900000002 那条
100 分、再按时间衰减到 94），三个 chat 的合成视图读到的都是这同一份。

### selftest

`pass=1000 fail=0`，新增 8 条：群里说话接在私聊的电量上（94.5）、同一个人在群里
涨同一份亲密度（21.5→23）、私聊那侧也看到群里扣/回的电、换个人说话是另一份亲密度、
`body-state.json` / `people-state.json` 落盘且按账号存。

---

## 2026-10-19 20:15：「最后开口」重启后永远显示「还没说过话」

### 现象

给体检表加完 `lastword` 模块、并在 `persist()` 里把快照存进 `state.json` 的
`self.lastwordState` 之后，手工往文件里写了一条（`lastAt` 是一小时前、`total: 7`），
热重载，`GET /onebot-companion/lastword` 回来仍然是：

```json
{"lastAt": null, "ago": "还没说过话", "total": 0, "recent": []}
```

而 `state.json` 里 `self.lastwordState` 明明有值——并且**重载之后被改回了全 null**，
说明不是「没读到」，是「读到了又被空值盖掉」。

### 根因：内存优先的 loadFrom 撞上提前发生的 persist

`core/jsonstore.js` 的 `loadFrom(raw)` 是**内存优先**的：

```js
if (this.entries.has(key)) { skipped += 1; continue; }
```

这条约定本身是对的——落盘是 debounce 的，`set()` 之后盘上还是上一版，无条件覆盖
等于把刚写的新值倒回旧值。

问题在于**时序**：挂原型成功的那一刻（`installPatches` 的回调里）就会 `persist()`
一次，它把当时内存里的空快照 `set('self', {... lastwordState: <全 null> ...})` 写进
`entries`。之后异步的 `store.load()` 才 resolve，`loadFrom` 看到 `self` 已经在内存里，
整条键跳过 —— 盘上那份永远灌不进来。而 `persist()` 又会 debounce 落盘，于是盘上那份
也被覆盖成全 null。**看一眼文件就知道：值是被写回去的，不是没读到。**

### 改法

`JsonStore` 早就有 `loadSync()`，注释写的就是这个场景（「给同一个调用栈里先写后读的
地方用」），只是我没用。改成在创建 store 之后立刻：

```js
store.loadSync();
try { lastword.restore?.(store.get('self')?.lastwordState); } catch (e) { ... }
```

异步 `store.load()` 那条路上的 `restore` 删掉——`loadFrom` 内存优先，它必然被跳过，
留着只会重复灌。

### 顺带修的两个二阶问题

1. **`recent` 被灌两遍**。同步一次 + 异步一次，而 `restore()` 原本是 `push`。
   改成**先 `length = 0` 再灌**——恢复是「把盘上那份搬进来」，不是追加。
   （`selfTest` 里加了一条「连调两次不重复」，`recent.length === 1`。）
2. **`stats` 跨热重载复用，旧值会装成新值**。修好读盘之后立刻暴露：盘上是
   `lastAt: null`（一次都没开过口），但 `GET /lastword` 还是上一个演练留下的
   「2 小时前」。因为 `stats` 挂在 `globalThis` 上，`restore(null)` 直接 `return`
   就把上一代的数留在了原地。改成**快照缺失或为 `null` 时按空恢复**（清 `lastWordAt`
   等五个字段 + 清 `recent`），不再直接返回。

### 验证

- 手工往 `state.json` 种 `{lastAt: 一小时前, lastChat, lastText, total: 7, recent: [1 条]}` →
  重载 → `GET /lastword` 返回 `1 小时前 / total 7 / recent 1 条`（第一次修完是 2 条，
  才被发现重复灌）。✅
- 种 `lastwordState: null` → 重载 → 返回 `还没说过话 / total 0 / recent []`。✅
- `POST /onebot-companion/selftest-lastword` → **total 23 → 26，failed 0**（新增：
  连调两次不重复、无落盘快照时清空、坏 `lastAt` 忽略、`recent` 只留形状对的）。
- `node test/selftest.mjs` → **pass=958 fail=0**。
- 演练用的假数据已从 `state.json` 清掉，面板回到真实的「还没说过话」。

### 一条方法论

**「写进去了却读不回来」先看时序，别怀疑序列化。** 这类 bug 的表现很像「路径错 /
字段名错」，但只要文件里字段名对得上、值却是被覆盖后的样子，那就是有另一个写者
抢在前面。找它：grep 所有 `persist()`（这次有 11 处），看谁在 `await` 之前就能跑到。

### 追加（20:18）：体检表上「ONEBOT 已连接」重载后会变「未知」

同一个模块的第二个问题，症状看着无关但根因同源：`/physical` 的 `link.connected`
原本只从 `persona.state.lastReceiver?.deps?.connection?.connected` 取。而
`lastReceiver` 是**入站回调里**赋的（`persona.js:576/603`），热重载之后要等下一条
进群消息才会重新有值 —— 在那之前面板一直是「未知」，恰好是最想确认连接的那几秒。

改法：`lastword` 的 `sendToChat` / `sendMsg` 两个 wrapper 顺手把
`this.ctx` 存进 `stats.lastWordOutboundCtx`（`stats` 挂 `globalThis`，跨热重载复用），
`snapshot()` 增加一个 `connected` 字段 —— 走 `ctx.connected()`，那正是出站管线自己
用来决定「发还是排队」的那口判定（`outbound.js:59`），比翻 `connection.connected`
getter 更贴近真实语义。`/physical` 先问它，问不到再退回老路径，都拿不到才是 `null`。

自测从 26 条加到 **28 条**（新增「记下了出站 ctx 的连接状态」「snapshot 里 connected
是 true」）。重载后 `GET /physical` → `{"connected": true, "enabled": true}`，
面板上的「ONEBOT」从灰的「未知」变成绿的「已连接」。

---

## 2026-10-18 00:32：群里冒出「该命令仅管理员可用。」

### 现象

群友 `58462qwq` 在群里发 `/skin 58462qwq`，群里出现一条：

```
00:32:46 云玥 | 发送 -> 群聊 [某群] <框架回执原文>
```

用户当场问：「？这你不沉默？」

### 根因：这是框架回执，不是她说话

`dsh-onebot-qq/lib/commands.js:118 tryHandleCommand` 在**入站管线最前面**路由斜杠
命令，非管理员直接：

```js
if (!ctx.isAdmin(userId)) {
    await ctx.sendToChat(chatId, '该命令仅管理员可用。');
    return true;          // 消息被吃掉
}
```

`return true` 意味着 `processInbound` 直接返回，**模型全程没被调用**。所以这行字
不可能被提示词管住——`[[silent]]` 那套只作用于模型输出，而它在模型之前就发出去了。

### 改法

跟 `QUEUE_NOTICE_TEXT`（吞 ⏳ 排队提示）完全同一个模式：在出站口按**字面量**
精确匹配吞掉。加在 `lib/modules/guard.js`：

- 常量 `ADMIN_ONLY_NOTICE_TEXT`（逐字抄上游，因为 `commands.js` 在 `node_modules`
  里、升级会整个换掉）
- `isAdminOnlyNotice(text)`（允许首尾空白）
- `sanitizeText` 里在「排队提示」之后加一条判断，命中返回
  `{ silent: true, hit: 'muted' }`
- 配置项 `muteAdminOnlyNotice`，默认 `true`；要恢复就置 `false`

只拦这一条：`commands.js:123` 在所有命令解析**之前**就 return 了，非管理员
不可能触达后面那些回执（未知命令、/stop、/workspace…）。

### 代价

群友发斜杠命令**没有任何反馈**，可能以为没发出去。这是有意的——那群人本来就不该
用命令，静默比让她念系统话更像人。

### 验证

- 自测 `pass=542 fail=0`（新增 12 条，含「近似文本不误杀」「关掉开关后照常发出」
  「整条只有回执 → drop」「DEFAULTS 里默认是开的」）
- 运行时 `/onebot-companion/status` 确认 `muteAdminOnlyNotice: true`

### 一条方法论

**「她说了不像人的话」要先分清是模型说的还是框架说的。** 这次和「⏳ 排队提示」
是同一类：都在模型之外，改提示词一辈子改不好。判据很简单——看 trace 有没有
`agent` 阶段的记录；没有就是框架行为。

---

## 2026-10-17 晚：群里「什么都听、自己决定回不回」

### 用户要什么

原意：不要一直接话，但也不要不接，像真人那样 → 追问后确定为
「什么都听、自己决定回不回」。

### 当时的状态

`dsh-onebot` 配的是 `requireMention: false`。这一项的含义：

- `true` → 群聊必须先被 @ 或被叫到，`mention` 模块那四条判据（@ / 名字 /
  潜水窗口 / 兴趣话题）才决定「这条放不放进来」；
- `false` → 上游 `inbound.js:120` 那道闸直接放行，**群里每条消息都进模型**。

所以「什么都听」这一半**已经成立**，不需要改。trace 可证：18:43–18:49 那批
消息全是 `inbound → dispatch` 直通，中间没有任何 `mention ok=false` 拦截记录
（而 `requireMention: true` 时期每条未中奖的消息都会记一条）。

### 真正的问题：提示词一边倒

实测（读会话 jsonl，统计 `assistant/message`）：

```
沉默 [[silent]] : 4
出声（含工具）   : 15
沉默率           : 21.1%
```

4 次沉默里没有一次是「无话可说」——都是有话选了不说。翻 11 条规则后发现
**结构性偏向**：

| 讲「怎么别出声」 | 讲「什么时候该出声」 |
| --- | --- |
| `silent`（3 行）、`quarrel`（宁可沉默）、`channel`（群里说话要短）、`topic`（被放进来不等于必须说话）、`batch`（全无关就不出声）= **5 条** | **0 条** |

模型最省力的策略自然是一直沉默。这不是模型的问题，是提示词没给它开口的理由。

### 改了什么

`lib/modules/rules.js` 新增第 12 条规则 `speak`，排在 `silent` 之后（顺位 2）：

- 给出**具体可指认**的开口情形：① 被点名（`[@我]` / `@你` / 喊名字）
  ② 被问到且正好知道或有想法 ③ 提到的东西有兴趣有感触 ④ 有情绪想应和；
- 「别用『跟我无关』当默认答案」——一句玩笑/吐槽让你有反应就是该接的信号；
- 「但绝不硬接」，判据是「我有没有真的想说的」，不是「这条我该不该回」。

**没有调任何数值**（`topics.chance` / `maxPerDay` / `cooldownMs` 原样）。理由：
既然消息本来就全放行，`topics` 那套网关在 `requireMention: false` 下主要只剩
「给正文加一行『群里在聊 XX』提示」的作用，调它对开口频率影响很间接。缺的是判据，不是频率。

### 验证

- 自测 `pass=530 fail=0`（新增 5 条钉住 `speak` 的断言；同步把两处硬编码的
  规则数 11 → 12）
- 运行时 `/onebot-companion/status` 的 `modules.prompt.rules` 确认 `speak: True`
  且排在 `silent` 之后
- 注入文本实测 4960 字符

### 以后要调的话

观察几天，若还是太沉默或太活跃，按这个顺序动：

1. `prompt.rules.speak` 的措辞（最直接，改的就是判据本身）
2. `topics.chance` / `maxPerDay` / `cooldownMs`（次要，见上面的说明）

---

## 2026-10-17 晚：群聊硬隔离（`isolation` 模块）

### 事故

群友 `58462qwq(2665507357)` 在「我的世界服务器」群 @ 她问「工作目录下有什么」，
她这一轮：

```
tool_use: ops_bash {"command":"ls -a","workdir":"D:\\Documents\\yunyue"}
→ 「就一个 .dsh-media」「别的啥也没有」
```

**执行了宿主 shell、读取真实文件系统、把结果发进群**。问话的是群友不是管理员。

### 为什么提示词不够

上游 `restrictedMemberPrefix` 干的事：给非管理员的群消息加 `[受限用户:仅问答]`
前缀，`buildPlatformPrompt` 随之追加「仅回答其问题，禁止文件/终端/配置/跨平台等操作」。
那是**提示词约束**——模型不听话照样执行。这个事故本身就证明了它拦不住
（而且当时该项被配成 `false`，连提示词那层都没有）。

### 用了什么

宿主文档（app.asar 稳定性条款）原话：

> A denial that must hold regardless of order is a `ctx.tools.guard()`;
> a guard is synchronous … The exact effect disposer is returned for ordered
> ownership and HMR cleanup.

签名：`guard(guard: ToolGuard): () => void`，其中
`ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`——
**返回字符串即拒绝**。文档还提到更强的替代里 `ctx.tools.restrict()` 只能移除
工具、`tools/pre-execute` waterfall 依赖注册顺序，所以 guard 是这里最合适的档位。

### 判据设计（关键：按「谁说的」而不是「哪个会话」）

群里管理员和群友**共用一个群会话**，按会话封会连管理员一起封掉。所以按本轮
消息的发送者判，两条判据取并集：

1. 消息带 `[受限用户:仅问答]` 前缀；
2. `<user_message qq="X">` 的 X 不在 `adminUsers`。

取并集是为了让硬闸**不依赖 `restrictedMemberPrefix` 这个开关**——它被谁改回
`false`，第 2 条仍然生效。

白名单只放 `qq_say` / `qq_send_face`（纯发声，不读任何宿主状态）。

### 踩到的坑

- `agent/pre-step` 的 `messages` 里混着本插件自己注入的规则消息（`role: 'user'`
  但没有 `<user_message>` 边界），所以取最后一条入站消息时**必须按边界标签过滤**，
  不能直接取最后一条 user 消息。
- `stats` 是 `globalThis` 单例（跨热重载不清零），新增字段在旧实例上不存在，
  直接输出会得到 `null`。要显式 `?? 0` 兜底。
- `/onebot-companion/module` 端点的 `MODULES` 数组是**独立硬编码**的，加模块时必须
  同步改（我第一次漏了，README 写完才发现代码里认不出 isolation）。

### 验证

- 用事故那条真实消息的原文验证正则能提取 `2665507357`（含 `[@我]`、无受限前缀
  的形态），确认第 2 条判据独立生效
- 自测 `pass=530 fail=0`，其中 15 条专盯隔离（含「同一会话里群友回合拒、
  管理员回合放行」的端到端切换）
- 运行时确认 `guardInstalled: true`

### 已知局限

- **只禁工具，不禁回答**。群友问「工作目录有什么」，她仍会回答，只是不能去
  `ls` 了——通常会变成「我不知道」。这符合用户的选择（「群聊禁工具」），但如果
  之后发现她会靠模型自身的猜测瞎编宿主信息，需要再加一条提示词约束。
- 隔离判定依赖 `agent/pre-step` 能拿到本轮 messages。若某次宿主版本变更导致
  payload 形状变化，`judgeTurn` 会得到 `no-inbound` 而**放行**（fail-open）——
  这是有意的：宁可漏也不误伤，但改宿主版本后要复查 `/status` 的
  `isolation.blockedTurns` 是否仍在增长。

---

## 2026-10-17 晚：出站分段劈开代码（`burst` 修复）

### 现象

群里让她写 `print("hello world")`，发出去是两条：

```
print("hello
world") 拿去抄喵
```

引号和圆括号都悬空。

### 根因

`lib/modules/burst.js` 的 `isSoftBreak(piece, i)` 判空格时只有一条判据
「两侧都不是中日韩文字」。`hello` 后面那个空格左侧是英文、右侧也是英文，
于是命中软断点——完全不管当前是不是在括号/引号内部。

### 改法

新增 `isInsideGrouping(piece, i)`：从开头扫到 `i`，用「期望闭合符」栈追踪，
判断该位置是否落在**未闭合**的包裹内部；内部一律不作断点（逗号类标点同样
受保护）。覆盖 `( [ { 【 《 「 『 “ ‘` 这些配对。

两个刻意取舍：

- **单引号 `'` 不参与配对**。英文里它更常是撇号（`don't` / `it's`），当引号
  开合处理会把后半句全判成「内部」、从此切不开。Python 那种
  `print('hello world')` 已被外层圆括号护住。
- **括号不配对时整段不切**（模型漏写闭符号）。少切一刀只是消息长一点，
  切坏了是内容被破坏。

### 验证

- `print("hello world") 拿去抄喵` → 单条，原样保留
- 英文长句仍按空格切（`hello world this is` / `a fairly long english` /
  `sentence here`）
- 「100 多块」「7 月到 10 月」等原有行为未变
- 自测新增 9 条钉住这个缺陷（双引号/单引号/全角括号含逗号/中文引号含逗号/
  未闭合时不断）

---

## 2026-10-17：`mention` 的回退

曾按最初的答复「1/10 概率接示例用户的话」实现了 `familiar` 判据
（`normalizeFamiliar` / `familiarGate` / `familiarHint` + 主流程接入）。
对方随后指出：示例用户在群里连说 5 句她没回，这件事她做得对——那 5 句是他
自己吐槽本体更新，既没叫她也不是在跟她说。于是**全部回退**，零残留。

教训：新增「谁说话都接」这类判据前，先确认那个场景**真的是缺口**。
「像真人」的重点在「该说话时会说」，不在「每条都接」。

---

## 2026-10-18：bot 互接暂不处理（决定，不是遗漏）

`AAAbot批发部(900000001)` 群里至少有 2 个 bot：云玥(100000002) 和
喵喵(100000003)。00:32 那次实测到了完整的互接链：

```
00:32:46  群友 /skin 58462qwq
00:32:46  云玥（框架回执）<回执原文>   ← 已被 muteAdminOnlyNotice 吞掉
00:33:13  喵喵接话「欸——样子换个新的？」
00:33:25  喵喵（转述那条回执，内容略）
00:33:28  喵喵「我确认的是执行操作那位是否为 58462qwq 的状态或结果，
                  还未掌握管理员具体绑定情况。」
```

喵喵把那条框架回执当成云玥的**发言**去回应了，用的是典型机器腔
（「说明一下」「我确认的是……的状态或结果」「还未掌握管理员具体绑定情况」）。

**用户选择：先不管，群友之间随便聊。** 所以没有加「不接其他 bot」的规则，
也没有按 QQ 号上游过滤。`requireMention: false` 下喵喵每句仍会进模型。

留此记录的原因是：这是一个**知情的选择**，不是没发现。如果以后出现
「两个 bot 互相引话停不下来」的刷屏，优先从这里找原因，而不是重新排查。
届时的两个可选做法（都不在本次实现范围内）：

1. `speak` 规则加一条「不接其他 bot 的话」，并把已知 bot 号告诉模型；
2. 上游按 QQ 号过滤，bot 的消息根本不投给她（需要改代码）。

---

## 2026-10-18 15:12：她把晚安说了三遍、说图是空白、把表情读错

用户报三件事：**① 表情当图片识别；② 别人发的图要能读；③ 时间感知炸了。**
三件全部查到了根因，且都不是「模型笨」。

### 一、下午三点说「晚安」= 精力积分永久归零

`/onebot-companion/mood` 显示 `group:900000002` 的 `energy=0`、mood=tired，
于是每轮提示词都在说「精力 0/100（快没电了），快没电了，只回一两句就够，别硬撑」+
「说话短一点，可以直说想睡了」。她照做了。

为什么是 0：`persona.js` 补丁拿的是**原始 OneBot 事件**而不是规范化后的 inbound。

```js
// 改之前
function companionPersonaHandleInbound(inbound) {
  const chatId = inbound?.chatId;      // ← 事件里没有 chatId，永远 undefined
  if (typeof chatId === 'string') noteMood(chatId, 'user', now);
```

上游 `bridge.js:311` 的签名是 `handleInbound(event, opts)`，`chatId` 要到
`normalizeOneBot11(event)` 之后才有。结果**用户消息 +8 的回血一次都没执行**
（`mood-state.json` 里三个 chat 的 `lastUserAt` 全是 0），只剩 assistant 的 -1.5
和时间衰减 → 单调掉到 0 → 永远 tired。

改法：照抄 stamp 的做法，从上游 `chat.js` 拿 `buildChatId`，自己从
`message_type` / `group_id` / `user_id` 推。**不要复刻拼法**（`'private:' + target`）
—— 上游改规则我们就错，这是 stamp 头注释里已经写下的教训。

### 二、她「看不见图」= 我们自己的硬隔离挡的

```
isolation.lastIsolationDenied: { tool: "read_image", userId: "2665507357",
                                 reason: "restricted-prefix" }
```

`isolation.js` 的 `ALLOWED_TOOLS` 只有 `qq_say` / `qq_send_face`，群友回合连
`read_image` 也被拒。而她说图在她那边是空白的——**这是诚实的**。

改法：`ALLOWED_TOOLS` 加 `read_image`，但加一道**路径白名单**：只许读
`mediaDir`（`D:\Documents\yunyue\.dsh-media`）下面的文件。判据用「目录 + `/`」
前缀，否则 `.dsh-media-evil` 会被误判成在 `.dsh-media` 里。

顺带：上游 `prompt.js:18` 写着「本地路径不进入文本」，实际 `inbound.js:324` 是
`'[图片:' + resolved.path + ']'` —— 路径明文进文本。这句错误提示词让模型倾向于
说「我没有工具看不了」，本轮没改（在 node_modules 里，升级会被覆盖）。

### 三、表情变鲸鱼 = 上游那张 emoji 表整体错位

`dsh-onebot-qq/lib/cq.js:22-67` 的 `FACE_EMOJI` 把 id 当 emoji 码位映射，329 个
id 里 123 个落到兜底 `😀`，其余语义全错。铁证：

```
14:34:01 示例用户发 [表情 /变形]   (id=312)
14:34:08 云玥  又发个鲸鱼，你今天是走动物表情包路线喵      ← FACE_EMOJI['312']='🐳'
```

改法：新建 `lib/modules/face-names.js`（329 条 id→中文名，数据源是 NapCat 的
`sysface-full.json`，与发送端 `faces.js` 的 321 条名字**零处不一致**），在
`processInbound` 入口把上游塞的错 emoji 删掉、换成 `[表情:变形]`。

**刻意没做的一件事**：没有把表情下载成图片。原本想用
`https://qzonestyle.gtimg.cn/qzone/em/e<id>@2x.gif`，但做了像素级核对后发现
**图床的 `e<id>` 和 sysface id 不是同一套编号**：

| id | sysface 名字 | 图床实际给的是什么 |
| --- | --- | --- |
| 182 | 笑哭 | 一只手比 V |
| 312 | 变形 | 戴金色皇冠的笑脸 |
| 106 | 委屈 | 卡通婴儿照 |
| 99 | 鼓掌 | 1×1 全白 |

同一句文本里「名字说变形、图是戴帽子的笑脸」比只有名字更糟。所以
`annotateEmoji` 默认只写名字，`downloadFaces: true` 才下图（留给「确认 id 对齐
之后」）。表情包除外 —— 它的 url 是 QQ 自己给的，跟内容一定对得上，照旧下载。

顺带发现：`sub_type === '1'` 的商城表情包在 `cq.js:150` 被直接丢掉（只留
`[表情包]` 四个字），现在也补上了名字与本地路径。

### 四、时间读数第二行在 QQ 里永远是误导句

`dsh-session-clock/lib/index.js:557`：

```
Browser time zone for this request: unavailable. Ask the user to clarify.
```

它扫 `payload.messages` 找 `source.clientTimeZone`，而 QQ 入站消息是网关来的、
没有这个字段 → **每轮都是这句**。`rules.js` 的 R_TIME 虽然写了「第二行一律忽略」，
但「unavailable + 去问对方」本身就在诱导模型怀疑时间。

改法：没有 clientTimeZone 时不再说「unavailable」，改成明确告诉它
「这条消息不是浏览器发的，上面那行的时区就是准的」。这是 `dsh-session-clock`，
在 `D:\Plugins\dsh-session-clock`（profile 里是 SymbolicLink，可改）。

### 验证

`test/selftest.mjs` → `pass=579 fail=0`（新增 emoji 段 30 余条断言，含
「表情只给名字不下图」「downloadFaces=true 才下图」「表情包空壳占位被删净」
「maxPerMessage 截断」）。运行时 `/onebot-companion/status` 确认
`emoji:processInbound` 在 patched 列表里、`downloadFaces: false`。

### 以后要调的话

- 她说的话还是偏短、偏没精神 → 看 `/onebot-companion/mood` 的 energy，不该长期 0。
- 觉得表情名不够用 → 重新跑 `_gen_faces_in.mjs`（数据源 `sysface-full.json`
  会随 QQ 版本更新，现在是 329 条）。
- 真要表情图 → 先确认 id 对齐（拿几个已知 id 肉眼比对像素），再开
  `downloadFaces: true`。
---

## 2026-10-18：表情 / 图片 / 时间感知（三项一起修）

### 1. [表情:名字] 代替 emoji

**现象**：示例用户发 ` [表情 /变形] `（id=312），她回「又发个鲸鱼」。

**根因**：`cq.js` 的 `FACE_EMOJI` 把 QQ face id 当 emoji 码位映射，
329 个 id 里 123 个落到兜底 `'😀'`，其余语义全错（`/微笑`14→🥰、
`/笑哭`182→🧕、`/亲亲`360→🐇）。id 空间根本不是一套。

**改法**：新建 `lib/modules/emoji-media.js`，挂
`InboundPipeline.prototype.processInbound`（stamp/persona 之后），
从 `sysface-full.json` 生成的 `lib/modules/face-names.js`（329 条）查中文名，
把错误 emoji 从文本里删掉，追加 `[表情:名字]`。认不出的 id 输出
`[表情:id=999]`，不再假装知道。

**踩过的坑**：一开始想「表情当图片给模型看」，实测**否决**——
`qzonestyle.gtimg.cn/qzone/em/e<id>@2x.gif` 里的 id 与 OneBot face id
**不是同一套**（e312 是皇冠笑脸，与「变形」无关）。24×24 的图模型也看不清。
所以只给名字，`emoji.downloadFaces` 留作默认关闭的开关。

### 2. 群友的图片她读不了

**现象**：15:10 群友连发两张图，她说图在她那边是空白的。

**根因**：自己的 `isolation.js` 只放行 `qq_say` / `qq_send_face`，
`read_image` 被 guard 拒。上游其实早把本地路径明文写进了文本。

**改法**：`ALLOWED_TOOLS` 加 `read_image`，但只许读 `mediaDir` 下的文件
（`checkMediaAccess` 比对路径前缀，参数非字符串时先 JSON.parse）。
`/status` 新增 `isolation.mediaDir` 显示**实际生效值**——配置里那格通常是
空串，真值由 bridge 回调给出。

### 3. 时间感知：下午说晚安

**现象**：15:12 她连着说了要去睡、以及两条晚安，思维链里自己
都写了「saying goodnight at 15:12 is weird」。

**根因（决定性）**：`persona.js` 的 `handleInbound` 补丁写
`const chatId = inbound?.chatId`，但这一层收到的是**原始 OneBot 事件**
（`message_type`/`user_id`/`group_id`），**没有 chatId**。于是
`noteMood(chatId,'user')` 从未执行 → 用户消息的 +8 精力回血全部丢失，
只剩 assistant 的 -1.5 与时间衰减 → energy 永久 0 → 注入
「快没电了，只回一两句就够，别硬撑」+ tired「可以直说想睡了」。

**铁证**：`mood-state.json` 三个 chat `energy` 全 0、`lastUserAt` 全 0，
而 `lastAssistantAt` 一直在更新。

**改法**：照 `stamp.js` 的既有范式——`scan()` 从上游
`chat.js` import `buildChatId`（存进 `state`，因为 `makeWrapper`
必须是纯函数），`handleInbound(event, opts)` 里用
`chatIdOfEvent(event, state.buildChatId)`。**没有自己复刻拼法。**

### 4. 「Browser time zone ... unavailable」

`dsh-session-clock` 扫 `source.clientTimeZone`，QQ 消息没有该字段，
于是每轮都吐 `unavailable. Ask the user to clarify`。已改成在
`Asia/Shanghai` 这类已知时区下直接写明，不再反问。

### 验证

`test/selftest.mjs` → `pass=579 fail=0`（原 542，新增 37 条）。
运行时 `/status`：`isolation.allowedTools = qq_say, qq_send_face, read_image`、
`isolation.mediaDir = D:\Documents\yunyue\.dsh-media`、`emoji.names = true`。
`annotated: 0` 是因为改完还没收到新消息——真机待验。
### 5. 补记：路径白名单的 `..` 逃逸

落地后自测 checkMediaAccess('read_image', {file_path: 'D:\\...\\.dsh-media\\..\\secret.txt'})
的结果是 **ALLOW**。原因：isUnderDir 用「目录 + /」做前缀比较，但**没有折叠
..**，...\.dsh-media\..\secret.txt 的字符串前缀仍然是 ...\.dsh-media。
前缀比较对 .. 天然无效。

改法：新增 collapseDots(path)，按 / 分段消掉 . 与 ..（.. 就是 pop），
**先折叠再比**。同类的坑还有 isUnderDir(dir, '') —— 目录为空时必须返回 false，
不能「没配就全放」。
---

## 2026-10-18：她说「晚安」之后还在逐条接话

### 现象

群友提的：「每次她说睡觉，后面还每次都回复」。

会话实录（群 900000002）：

```
15:11:33  [A] <说要去睡的那句>
15:12:14  [A] <晚安>
15:12:22  [A] （过了两秒又一句）
15:12:48  [A] （还在说）
```

10/17 18:44 也复现过一次。她说要睡之后，群里的消息她一条不落地继续接。

### 为什么提示词治不了

`[[silent]]` 管的是「这一条回不回」。下一条消息进来，还是一次全新的生成 ——
模型重新读一遍规则、重新看一遍上下文，然后又决定「这句可以应一声」。
提示词压得住概率，压不住「每条都过一遍」这个结构。

### 改法：在消息进入管线**之前**拦

新建 `lib/modules/sleep.js`，挂在 `InboundPipeline.prototype.processInbound`，
优先级 **30**（高于 stamp 的 20），所以它在 `mention` 的外层。

三条进睡意的方式，任一命中即睡：

1. 她说了睡意词 —— `matchSleepWord(text)` 命中 `SLEEP_WORDS`
2. 精力见底 —— `moodOf(chatId).energy <= energyThreshold`（默认 25）
3. 夜里没动静 —— 落在 `[nightStartHour, nightEndHour)` 且聊天静默超时

睡着后，群里只有两类消息能进来：带 `at` 段指向她自己 QQ 的（`atall` 不算），
或者正文里喊她名字的（名字取自 `mention.names`）。私聊永远放行。
被 @ 或喊名字进来时顺手醒过来，并清掉睡意（`stats.sleepWoke`）。
睡满 `durationMs`（默认 7 小时）自动醒。

### 最难的一处：顺序

`mention` 会给「没 @ 但叫了名字」的消息**补一个假 at 段**。如果 `sleep` 挂在
`mention` 内层，它拿到的 `inbound.segments` 里已经有一个 at 了 —— 闸永远判
「被 @ 了」，于是永远拦不住。

所以优先级必须是 30。`core/patch.js` 的 `MODULE_PRIORITY` 里 **数字大的在外层**，
sleep:30 > stamp:20 > 其余 10。验证方式：用一个假类挂上 sleep/emoji/mention 三层，
打印调用顺序，得 `sleep → emoji → mention → ORIGINAL`。

### 验证

- 单元测试：睡意词识别、@ 判据、名字判据、私聊放行、到期自醒、精力阈值、
  fail-open（闸自己抛错时放行，不能卡死消息）等，`pass=661 fail=0`
- 集成测试：用假 profile 走**真实** `InboundPipeline.prototype.processInbound`，
  确认睡着后群里非 @ 的消息**根本没进管线**；被 @ 后能醒、醒后能正常回话
- 运行时：`/onebot-companion/status` 的 `modules.sleep` 六个计数都在

### 以后要调的话

| 觉得她 | 改哪里 |
| --- | --- |
| 睡得太容易 | `sleep.energyThreshold` 调低，或 `autoByMood: false` 只认睡意词 |
| 睡得太久 | `sleep.durationMs` |
| 睡着时被喊名字也不该醒 | 把 `mention.names` 留空（名字判据就没输入了） |
| 想整个关掉 | `sleep.enabled: false` |
---

## 2026-10-18 17:00：白天只打盹 1 小时 + 认不出的表情装死

当时的设定（大意）：7:00–23:00 间睡 1 小时即可；表情认不出就别回，装死。

### 一、睡意闸加白天档

原来的 `sleep.durationMs` 只有一档 7 小时。这有两个问题：下午三点她说一句
「要去睡了」这类话会让白天直接沉默到晚上；而深夜真正该睡的时候，
7 小时又不算长。

改法：`sleepTrigger` 算时长时先看落在哪个窗口。

```js
daytimeDurationMs: 60 * 60 * 1000,   // 白天打盹 1 小时
dayStartHour: 7,
dayEndHour: 23,
```

窗口是**左闭右开**：7:00 算白天、23:00 算夜里。`start > end` 写反时按
「24 小时制跨夜窗口」处理，不静默退化成一档。

实测（`_probe_sleepday.mjs`，验完即删）：

| 说的时刻 | 睡多久 |
| --- | --- |
| 15:12 白天 | 60 分钟 |
| 23:40 夜里 | 420 分钟 |
| 06:59 夜里 | 420 分钟 |
| 07:00 白天 | 60 分钟 |
| 22:59 白天 | 60 分钟 |
| 23:00 夜里 | 420 分钟 |

**测试里的一个坑**：原来有条断言把「晚安」写死在样本句里
→ `until === 1000 + durationMs`。`at=1000` 是 1970-01-01 的**本地 08:00**，
落在白天窗口里，改完就变成 1 小时了。这条断言等于把「白天也睡一整晚」当契约
锁住了 —— 改成显式区分：白天的 `1000` 断言 `daytimeDurationMs`，另加一条
明确构造的「夜里 23:40 说晚安」断言 `durationMs`。教训：**测试里用魔法时间戳
（`1000`）会把当下时区与窗口规则一起焊死。**

### 二、认不出的原生表情 → 整条不回

判据只看**原生表情 id 是否在 329 条表里**（`lib/modules/face-names.js`）。

- 认得出 → 照常写 `[表情:笑哭]`，正常回
- 认不出 → 写 `[表情:id=9999]`（保留可排查性），然后**整条消息吞掉**
- 表情包（`sub_type:1` 的 sticker）**不算**认不出 —— 那是真图片，能下载能读

关键实现细节：吞掉必须在 `makeEmojiProcessInbound` 里**直接 `return undefined`，
不调 original**。先改文本再放行不算装死 —— 模型照样会跑一次生成，只是被提示词
劝住，而提示词劝不住的时候（比如她那天很想说话）就破功了。测试专门钉了这一点：
`eq(muteCalled.length, 0, 'emoji: 吞掉时上游一次都没被调（不是改文本放行）')`。

计数：`stats.emojiMuted` / `stats.lastEmojiMuted`（记 `ids`、`chatId`、`at`），
不然「她今天怎么这么安静」根本无从排查。

开关：`emoji.muteUnknownFaces: true`（默认开）。关掉就照常放行。

### 三、配置落地

`C:\Users\暝\.dsh\profiles\desktop\cordis.patch.yml` 在 `mention` 段之后新增
`sleep:` 与 `emoji:` 两个整段（含注释说明为什么分两档）。改前备份
`cordis.patch.yml.bak-sleepday-<时间戳>`。运行时 `/onebot-companion/status` 确认：

```
sleep config: {"durationMs":25200000,"daytimeDurationMs":3600000,
               "dayStartHour":7,"dayEndHour":23,...}
emoji config: {"names":true,"downloadFaces":false,"maxPerMessage":6,
               "muteUnknownFaces":true}
```

`patched` 里能看到 `sleep:processInbound` 与 `emoji:processInbound` 都在。

### 验证

`test/selftest.mjs` → **`pass=681 fail=0`**（新增 9 条：认不出计数、认得出不计数、
`names:false` 不误判、表情包不计数、吞掉时上游零调用、认识照常放行、
开关关掉照常放行、`emojiMuted` 计数、`lastEmojiMuted.ids` 只列认不出的）。

### 四、提示词补一条（硬闸管不住她自己再说）

`sleep` 闸住在**别人说的话**，管不住她自己在说完「我先睡啦」之后再补一句
「已经在躺了」这类补白。所以 `rules.js` 的 `R_SILENT` 末尾加了一条：

> **说了要去睡，就真的别再说了**。一旦你说过「我先睡了 / 晚安 / 去躺一会」这类话，
> 后面就算还有人说话、还有消息在响，也不要再补一句晚安或「那我先睡啦」
> 「已经在躺了」这种话——一句都不补。要下线就直接 `[[silent]]`。
> 连着好几句「晚安」，比不睡更不像话。

规则总数仍是 12（`silent` 多一行），自测仍 `pass=681 fail=0`。

## 2026-10-21 12:57：长期底色（`temper`）

### 需求

用户把「鱼的大脑」那篇稿子发来之后，我逐条对到了现有模块上。分三档结论里，
「完全没有」那一档有一条我原本判成「不急」的，现在决定做：

> 单次事件不改人格，长期经历改基线（连着一周冷落，「阳光」会偏成「敏感多疑」）。

为什么改主意：`mood` 的 `MOOD_BASE_WEIGHTS` 是写死的常量。这不是「不够真实」的
问题，是**她根本没有历史** —— 三月初和五月初是同一个掷骰子的人。

### 做了什么

新建 `lib/modules/temper.js`（约 480 行，含 38 条自测）。四条取舍见 README
那一节，这里只记踩到的坑。

### 踩到的坑：纯乘法抬不动 0 权重

第一版 `moodWeights` 里就是 `weights[id] *= k`。跑分布验证时发现：
低精力档（`energy < 20`）下 `down` 的基础权重是 **0**，乘多少还是 0 ——
也就是「连着被冷落、最该沉下去的时候反而永远沉不下去」，正好把这一块的核心
场景废掉了。

改法：基础权重为 0 的那一档给一个绝对入口 `ZERO_BASE_LIFT * (k - 1)`。
用 `k - 1` 而不是 `k` 是关键——`k = 1`（默认）时恰好是 0，于是「不传 bias」
与「传全 1」逐位等价。这条**专门加了自测**（用固定 random 序列比对 30 轮），
因为它一旦破了，改这一块就会静默地改掉所有已有心情分布。

验证数字（3000 次掷骰，energy 70 / affinity 60）：`bias.down = 40` 时
down 从 0 次 → 1912 次，excited 从 201 → 63。方向对，量级也合理。

### 接线（全部在 `lib/index.js`）

- import、DEFAULTS（`temper: { ...TEMPER_DEFAULTS }`）、`mergeConfig` 的 key 数组、
  `lib/http.js:345` 的 `MODULES`。
- 实例创建**在 persona 之后**，然后 `persona.setBiasSource(() => temper.current())`。
- `persona.js`：`state.biasOf` + `moodConfig()` 里加 `get moodBias()`（每次现取，
  不缓存——它按天变，缓存等于冻结）+ 导出的 `setBiasSource`。
- 注入链：在 `diary.injectionText` **之前**调 `temper.observe({...})`，
  把静默时长、精力、亲密度并进当天记录，同一轮拿返回值直接算注入行
  （不重算，避免跨零点或刚写盘时出现两个略不同的值）。
- 唯一观测点就是这里。不另挂 pre-step 钩子——两处算口径早晚会漂。

### 验证

`test/selftest.mjs` → **`pass=1208 fail=0`**（新增 32 条 `temper` 分区检查，
之前 1176）。`node --check` 过了 `index.js` / `temper.js` / `persona.js` /
`mood.js` / `http.js`。

**改动需要 DSH 重启才生效。**

## 2026-10-21 17:22：学出来的生物钟（`circadian`）

来源还是示例用户转的那篇小黑盒稿子（《关于类人大肥鱼的一些想法》，作者 Halseq，
link_id `7caf7028aafd`）。他先批准存帖 + 做对照，后来说「生物钟可以有」。

### 补的洞

`mood.js` 的昼夜判定写死：0–8 点回血 14/h，其余掉电 7/h。她的作息是一张钟表，
不是一段生活。而示例用户凌晨两点还在说话、中午十一点才冒头 —— 「夜里该困了」
于是成了一句她演给自己听的话。

### 新文件 `lib/modules/circadian.js`（约 490 行，含 36 条自测）

纯函数层（零 import、可直接裸 node 跑）：`createBuckets` / `advanceBuckets` /
`recordPresence` / `circadianCurve` / `nightSetOf` / `circadianPromptLine`。
落盘只在 `createCircadian()` 实例层。

四条取舍（详见 README 那一节）：只记「他几点在」、按天衰减 0.94、样本 < 30
就返回 null、只记私聊那条线（群友的作息不是他的作息）。

### 接线

- import + `DEFAULTS`（`circadian: { ...CIRCADIAN_DEFAULTS }`）+ `mergeConfig`
  的 key 数组 + `lib/http.js:363` 的 `MODULES`。
- `persona.js`：新增 `state.nightMaskOf` + `moodConfig()` 的 `get nightMask()`
  + 导出的 `setNightMaskSource()`；新增构造参数 `onUserText(chatId, at, userId)`
  旁路回调，在 `handleInbound` 包装里**只对 `private:` 前缀**触发。
- `mood.js`：`integrateEnergy` 多收一个 `nightMask` 参数（24 个 boolean 或
  null），`isNight(hour)` 从「固定区间」改成「有掩码用掩码」。没有 circadian
  时 `nightMask` 是 `undefined` → 走固定区间，**行为逐位不变**。
- `index.js`：实例创建在 persona 之后 → `persona.setNightMaskSource(...)`；
  注入链排在 `temper` 之后（底色是基调，作息是事实，事实更靠近当下）；
  `start()` 只读盘，无定时器。
- `http.js`：体检表加 `circadian` 段、`GET /circadian`、`POST /selftest-circadian`。

### 验证

`test/selftest.mjs` → **`pass=1245 fail=0`**（新增 37 条 `circadian` 分区检查，
之前 1208）。`node --check` 过了 `index.js` / `http.js` / `persona.js` /
`mood.js` / `circadian.js`。`test/probe-night.mjs` 仍 7/7。

**改动需要 DSH 重启才生效。**

## 2026-10-22 13:45：一次只说一句（QQ 上的「不停顿」）

当时的反馈（大意）：在 GUI 里这样挺好，但上到 QQ 就不对劲；
并提到自己有点灵感枯竭。

### 查到的实据

翻 `onebot-private-100000001` 的会话原文（分帧解压 `session.v4.jsonl.zstd`），
统计她最近 30 条出站：

- 平均 **30.5 字**，最长 **58 字**，最短 9 字。
- 最近 48 小时：`qq_say`（语音）**28 条**，文本 23 条 —— 语音还是主力通道。
- 而 `R_TONE` 里明写着真人「中位 6 字，九成不超过 20 字」。

所以问题不在语气，也不在语音本身，在**节奏**：她把三四个念头打包成一条
说完。GUI 里一段话本来就该是一段话；QQ 里真人是一句一句往外递的，中间
有停顿、有等对方接的空档。

### 根子

「想说的多就分几条发」这条早就写了，但被忽略 —— 它**只在出站被切开之后**
才生效，而模型在写的时候就已经把整段写成一个 `qq_say` 的参数了。语音更糟：
一条 `record` 段就是一条语音，`burst` 切不开，打包会原样播出去。

### 改了三处

1. `lib/modules/rules.js` 的 `R_TONE` 新增两条：**一次只说一句**（在想
   「我该回什么」的时候就只挑一句先发出去）、**判断有没有打包**（写完看一眼，
   有「还有一个想法」「不过话说回来」就是把两三条塞进了一条）。
2. `R_VOICE` 新增两条：**一条语音只说一件事**（语音没法被切开）、**25 字
   上下最像人说话**（超过 35 字就是念稿；讲不完就说一半停下来）。
3. `lib/index.js` 的 `qq_say` 工具描述与 `text` 参数说明同步收紧
   （原「建议 40 字以内」→「一件事，25 字上下最好，别超过 35 字」）。

### 验证

`test/selftest.mjs` → **`pass=1263 fail=0`**（新增 4 条断言，之前 1259）。
`node --check` 过了 `rules.js` / `index.js` / `test/selftest.mjs`。

**改动已随热重载生效**（`/onebot-companion/status` 的 17 条规则全在注入列表里）。

## 2026-10-22 18:20：生活节奏五档 + 对话密度 + 未完成意图（从 HDS-Interlude 学来的三件事）

用户拿来 [HDS-Interlude](https://github.com/ISEKAI-MomoiCore/HDS-Interlude)（Koishi 插件，
AGPL，79 star），评价是「思路新颖，似乎解决了不聊天时就不存在的问题」，随后
「三个可以都做吗」。这套框架整体搬不动（Koishi ≠ DSH，还要推倒现在这堆模块），
但里面有三件事成本低、收益直接，都做了。

### 一、`tempo`：生活节奏五档 + 对话密度

原来的 `proactiveChance()` 只看精力、静默时长、心情、热情 —— 它不知道
「我正在上课」和「我正抱着手机等他说下一句」是两回事，也不知道「刚聊完还热着」。

**五档倍率**（照 HDSI 的默认值）：

| 档位 | 倍率 | 判据 |
|---|---|---|
| phone-focused | ×1.4 | 他 3 分钟内有消息 |
| available | ×1.0 | 常态 |
| occupied | ×0.7 | 有未过期的焦点（`focus.js` 的 `current()`） |
| resting | ×0.5 | 精力 < 40 |
| asleep | ×0.15 | 夜里 + 精力 < 25 |

判定顺序照抄它的边：**先看基础状态（睡 > 累 > 忙 > 闲），再看他刚说话把睡/累提回
phone-focused**。忙不提升 —— 上课时收到消息，人还是在上课，只是会瞄一眼。

**对话密度**：每条他的消息 +0.18，按 90 分钟半衰期指数衰减，夹在 [0,1]。
因子 = 1 + 0.4 × 密度 —— 冷透了是 1.0 而不是更低（沉默已经在 `silenceFactor`
里加过权了，这里再罚一次是重复计数）。

接线：`persona.setTempoSource(fn)` → `ProactiveScheduler` 的 `chance` 回调里
`base × factor`。乘法留在知道 chatId 的那层，`proactiveChance` 保持纯函数。

### 二、`interrupt`：被打断的未完成意图

HDSI 那条最戳人的设计：*「被截断的文字会作为『主角本来想发送，但还没打完字，
新消息就到了』的未完成意图交给替代写作」*。

我们之前：`burst` 分条发到一半他插话，剩下的照发（读起来像根本没在看他），
或者被丢弃（下一轮她当没想过，可能跟刚说出口的话自相矛盾）。

现在：`rhythm.sendBurst` 每段之间检查 `chat.lastUserAt > startedAt`，成立就停下、
把剩下的交给 `onTruncated` → `interrupt.note()`。下一轮注入「你上一句说到
『…』就没发出去」，让她自己决定接着说、改口、还是不提。

三个判据（宁少勿错）：① 是我们自己没发出去的；② 10 分钟内；③ 他之后确实说过话。

**绝不自动补发** —— 他想插话就是想打断，把旧句子硬塞出去比不说更失礼。

### 验证

`pass=1324 fail=0`（新增 61 条断言，之前 1263）。`node --check` 过了
`tempo.js` / `interrupt.js` / `rhythm.js` / `persona.js` / `mood.js` / `index.js` / `http.js`。

**已随热重载生效**（`/onebot-companion/status` 的 modules 里有 tempo 与 interrupt，
`GET /tempo`、`GET /interrupt` 均 200）。

### 踩到的坑

热重载报过一次 `does not provide an export named 'createInterrupt'` —— 因为
`index.js` 先 import 了还没写进 `interrupt.js` 的导出。`touch` 一下两个文件后
第 44 代加载成功。

## 2026-10-22 18:26：`qq_draw` 自己画图（接本地 ComfyUI）

当时的提醒：做完别忘了把画图能力接进插件（工具名最终叫 `qq_draw`，
跟其它 `qq_*` 一致）。

### ComfyUI 侧（本轮从零装的）

- 装在 `D:\ruanjian\ComfyUI`，独立 venv（不动系统 Python）。
- torch **2.11.0+cu128**（`cu121` 在 py3.13 上没有轮子，`cu124` 太低，ComfyUI
  启动时自己警告「20 系以上建议 cu130+」）。实测识别到 RTX 4060、8G。
- 底模 `models/checkpoints/v1-5-pruned-emaonly.safetensors`（SD1.5，4GB），
  从 ModelScope 拉（8MB/s，比走代理快得多）。
- 启动：`venv\Scripts\python.exe main.py --port 8188 --listen 127.0.0.1`。
- 实测 512×512 / 20 步 / **6.4 秒**。

**下载源的教训**：阿里云 pypi 镜像当天只有 70KB/s，清华源对
`comfyui-frontend-package` 直接 403，腾讯云（`mirrors.cloud.tencent.com/pypi`）
35–47MB/s —— 以后装 Python 大件先试腾讯。torch 的 cu 索引走**直连**
（1.6MB/s）比走 7899 代理（274KB/s）快六倍。

### 模块侧

新文件 `lib/modules/comfy.js`：

- `buildWorkflow()` 纯函数，SD1.5 那七个节点写死在代码里（不读用户导出的
  workflow.json）——换底模只改 `ckptName`。
- `normalizeRequest()` 纯函数，所有夹紧都在这儿：尺寸对齐 8 的倍数、夹
  [256,1024]；步数 [1,60]；cfg [1,20]；seed 不给或 -1 就随机。
- `firstImageOf()` / `viewPathOf()` 纯函数，从 `/history` 里取第一张图并拼
  `/view` 查询串。
- `generate()` 走 `POST /prompt` → 轮询 `GET /history/{id}`（1 秒一次）→
  `GET /view` 抓回本地 `mediaDir`。默认超时 180 秒（首次加载模型要几十秒）。
- **连不上 ComfyUI 是最常见的失败**（人家把窗口关了），所以那条错误单独
  写清楚是「没在跑」而不是笼统的 fetch 失败。

工具 `qq_draw` 只负责**画出来 + 给路径**，发不发由她另调 `qq_send_image`。
群里被 isolation 限成只能发声的那一轮，不该因为这条工具绕过去往外发图。

### 验证

`pass=1373 fail=0`（新增 49 条断言，其中一条顺手把工具总数从 14 改成 15）。
实测端到端：`alive: true` → 6.4 秒出图 → 落在
`D:\Documents\yunyue\.dsh-media\yara-20261022-182457_00001_.png`（302KB）。
`GET /onebot-companion/comfy` 返回 `alive: true`。

### 已知限制

SD1.5 画「白毛猫娘红紫异瞳」出来是一张**大头特写**，脸还行、没有猫耳、
构图很死。想好看得上 SDXL 或 Flux，8G 显存要配量化版 + offload，速度会掉到
几十秒一张。这个先记着，等用户嫌丑了再说。

### 2026-10-22 19:03 换动漫底模：Counterfeit-V2.5

对方看完 SD1.5 那张自画像，指出有明显的恐怖谷效应。这个判断很准：恐怖谷不是
「不够真」，是「像到某个程度又差了点什么」—— 写实底模会一直往真人靠，越像越吓人。

改法：`comfy.ckptName` 换成 **Counterfeit-V2.5_fp16.safetensors**（2GB，
ModelScope 上 `AI-ModelScope/Counterfeit-V2.5`，150MB/s 拉下来的）。动漫微调
底模不假装自己是真人，反而不会有那个落差，而且猫耳 / 异色瞳这类**特征**画得准
得多。默认负面提示词也跟着换成 anime 社区那套（`worst quality` 加权 + 明确排除
`yellow eyes / green eyes / same color eyes` —— 上一轮就是眼睛颜色被画成黄的）。

实测同一条提示词：Counterfeit **7.1 秒**出一张，白毛、猫耳、红蓝异瞳、
平涂动画质感，没有恐怖谷。已发到私聊。

**没删 SD1.5**：`v1-5-pruned-emaonly.safetensors` 还在 `models/checkpoints` 下，
改名 `ckptName` 就能换回去。

## 2026-10-23 00:05：`qq_recall` 撤回（「删除重打」）

用户早就提过、一直排在做不完的清单上的那条：「有没有插件我发出去的话能撤回的？
打错字撤回之后我这边没跟着撤，理解下文会出问题」——那次查的是「对方撤回能不能感知」，
结论是不能。这次做的是另一半：**我自己能撤回**。

### 为什么以前做不了

NapCat 的撤回是 `delete_msg { message_id }`，只认 id。而我们发出去之后从不记 id ——
`sendToChat` / `sendSegments` 的返回值拿到就丢了。所以第一步不是写撤回，是**记账**。

### 模块 `lib/modules/recall.js`

- 包一层 `ChatBridge.prototype.sendToChat` + `sendSegments`（只旁听返回值，不改行为），
  把每次发出去的 id 按 chat 记进一张短表。
- `qq_recall(count?, chat_id?)`：从表里取最近 N 条，逐条 `delete_msg`。
- 三条纪律（写进文件头）：
  1. **只撤自己的**。表里只有我们自己的 id，**绝不接受外部传入** —— 否则一条提示词
     注入就能让她去删别人的消息。这是硬边界，也是这次设计里最重要的一条。
  2. **只在 5 分钟窗口内**。再久 QQ 服务端多半也拒，而且「十分钟前说错」不叫打错字，
     叫说错话，得用嘴修。
  3. **撤完从表里划掉**，避免重复撤同一个 id 刷日志。

### 与 `interrupt` 的分工

`interrupt` 管「没发出去的那半句」（被他的新消息掐断）；`recall` 管「已经发出去了、
现在想收回的半句」。一个在发送路径中间，一个在发送完成之后。

### 验证

`pass=1425 fail=0`（新增 52 条断言）。`http.js` 加了 `GET /recall`（只报「还能撤几条」，
**不吐 message_id**）。热重载后 `/onebot-companion/recall` 返回
`{enabled:true, chats:{}, windowMinutes:5, recalled:0}`，`stats.toolErrors` 为 null。

**端到端没测**：撤回需要「先发出去一条」，而插件这一代启动后还没发过消息
（刚才那两张图是直接 curl NapCat HTTP 发的，不经过插件，所以不进表）。留到下次真人
对话时验。

### 一个差点误判的坑

`/status` 的 `stats.patched` 里出现 6 条 `recall:sendToChat` 时我以为挂了三层重叠。
其实那是**历史累计记录**（`patched` 最多留 50 条，每次重建都 push 一条），
不代表链上有 6 层 —— `core/patch.js` 的重建是从锚点整段重造的，同一 moduleId
只留一层。别拿 `patched` 的条数当层数。

## 2026-10-23 00:20：干活比说话更耗电（按工具调用数加扣）

当时的疑问：在工作区干活的时候不消耗精力？——问对了。此前不管这一轮只是回了句
「嗯」，还是装了 ComfyUI、改了五个模块、跑了二十次工具，**一律扣 1.5**。
账是反的：真正累的不是说了多少句，是干了多少活。

### 改动（只动一处口径，别的一个字没改）

`lib/modules/mood.js` 的 `noteAssistantMessage(state, now, config, toolCalls)`：

- 每多一个工具调用加扣 `energyPerToolCall`（默认 **0.4**）；
- 但**总加扣封顶** `toolCallEnergyCap`（默认 **4**）—— 一轮再忙也不会当场被打空。
  精力是「一天下来慢慢掉」的东西，不该因为一次长任务瞬间归零；
- `toolCalls` 省略或非有限数 → 行为与加这条之前**逐位一致**。

**0.4 是怎么定的**：一轮典型对话两三个工具 → 加扣 0.8~1.2，跟「说话」那 1.5 同量级；
一轮二十个工具的重活 → 加上封顶扣 5.5，是纯聊天的三倍多。没定成 1 以上是因为
**工具数不等于工作量**：查个天气也是一次调用，跑一次两分钟的构建也是一次调用。

### 接线

- `persona.js` 新增导出 `toolCallCountOf(message)`：数 `content` 里 `tool-call` /
  `tool_use` 块（忽略 `text` / `reasoning`）。
- `onSessionEvent` 的 `assistant/message` 分支把数递进 `noteMood(chatId,'assistant',now,{toolCalls})`。
- `persona.js` 的 `DEFAULTS` 与 `moodConfig()` 透传 `energyPerToolCall` / `toolCallEnergyCap`。

### 验证

`pass=1441 fail=0`（新增 16 条断言）。其中三条是防呆的：负步长被当成 0、
`NaN` 工具数按 0、连脏数据也不会把精力扣成负数。

## 2026-10-23 13:38：mnemon 空闲回顾子代理的降频与清理

对方发来截图问：55 个子代理都是有用的吗；随后追加：留个用完了清掉的功能也不错。

### 查清的事实

`sessions/` 下（三个工作区合计）**529 个非 `session-` 前缀的子会话目录，其中 441 个
是 mnemon 派出来的一次性子代理**：

- 219 个 `Bounded completed checkpoint`（`idleReview` 的三层记忆整理）
- 117 个 `[dsh-mnemon:delegated review]`
- 24 个 `Route runtime memory archive batch N/M`（`mnemon_document_manage` 归档时的分批）
- 其余是各次调研/审计的子代理（那些**不该删**）

根因：`cordis.patch.yml` 里 mnemon 的 `idleReviewMs: 30000` —— 每一轮聊完 30 秒就派
一个子代理去筛记忆，一夜就是几十个。而插件**没有任何清理机制**，跑完的会话目录
只是躺在盘上。

### 两件事都做了

**① 降频**：`idleReviewMs` 30000 → **600000**（10 分钟）。改的是
`~/.dsh/profiles/desktop/cordis.patch.yml:101`（备份 `.bak-20261023-idlereview`）。
**需重启 DSH 才生效。**

**② 清理**：删掉 **432 个** mnemon 类子会话目录（87.7 MB）。

判据（写在 `C:\tmp\clean_idle_subagents.mjs`）：
- 只动**非 `session-` 前缀**的目录（`session-` 开头的是真人会话，一个不碰）；
- 会话内容必须命中 `mnemon:delegated review | Bounded completed checkpoint | dsh-mnemon`；
- **最近一小时内动过的保护起来不删**（可能正在跑）；
- 没有 `session.v4.jsonl.zstd` 的跳过。

结果：删了 432 个、失败 0 个，该工作区目录从 218MB → **137MB**，还剩 95 个子会话
（都是有标题的调研/审计/翻译任务）。

**清理前已备份**：`C:\tmp\mnemon-subagents-backup-20261023.zip`（113MB，529 个目录的
`session.v4.jsonl.zstd`）。清单 `C:\tmp\clean_idle_removed.txt`。

### 为什么不写个定时清理脚本

用户提过「用完清掉」，但清理脚本要判断「哪些是 mnemon 的、哪些是真人派的有用子代理」，
这个判据靠猜标题，写死进 cron 迟早误删。**降频才是根治**：不生成那么多，就不用天天扫。
真需要清的时候跑一次这个脚本即可（它默认 `--dry` 预演）。

### 顺带发现

`dsh-session-manager` 0.6.3 的 lib 里搜 `childSession|isChild|parentSession|seeded`
是 0 命中 —— 它不认子会话/父子关系，所以界面上那些子代理只能靠 mnemon 自己列，
session-manager 帮不上忙。

## 2026-10-23 13:50：第三代底模 —— WAI-illustrious-SDXL v17

对方转述朋友的话：这个模型是 23 年的，有点落后了，有没有效果更好又带得动的？

### 三代底模的演进（每一步都是因为上一代真不够用）

| 代 | 模型 | 架构 | 问题 |
|---|---|---|---|
| 1 | `v1-5-pruned-emaonly` | SD1.5 | 画人脸往写实靠，有明显的恐怖谷效应 |
| 2 | `Counterfeit-V2.5_fp16` | SD1.5 | 动漫风对了，但 512 画不出细节，脸是糊的 |
| 3 | **`waiIllustriousSDXL_v170`** | **SDXL** | — |

WAI-illustrious v17 是 Illustrious 系（2024-2025 的动漫底模）的社区整合版，
6.6GB。**实测 832×1216 / 28 步 / 32 秒**：猫耳有绒毛边、红蓝异瞳分得清、
发丝和布纹都干净，而且不需要堆一长串负面词去救。

### 三处参数跟着变（SD1.5 那套惯例在 SDXL 上是错的）

- 尺寸 512×512 → **832×1216**（SDXL 原生 1024 系，且 8G 显存扛得住）
- cfg 7 → **5.5**（SDXL 惯例 5~7；调高会把画面推成塑料感）
- 采样器 euler → **euler_ancestral**，步数 20 → 28
- 负面换成 Illustrious 社区那套（`worst quality, low quality, bad quality,
  normal quality` 四连 + 明确排除 `realistic, photorealistic, 3d`）

### 模型放 E 盘

6.6GB 不该占 D 盘（D 剩 197G / E 剩 869G）。新建
`D:\ruanjian\ComfyUI\extra_model_paths.yaml`，把 `E:\ruanjian\comfy-models\`
下的 checkpoints / loras / vae / text_encoders / clip_vision / diffusion_models /
upscale_models / embeddings 全部挂进来。ComfyUI 重启后日志确认八条
`Adding extra search path`，`/object_info/CheckpointLoaderSimple` 能同时看到
三个模型的路径（旧的 D 盘模型不用搬，两边都认）。

### 验证

`pass=1441 fail=0`（自测不依赖具体模型名，改动没破任何断言）。
实拍一张已发到私聊。

### 现在的取舍

32 秒一张 vs Counterfeit 的 7 秒。值得 —— 那个 7 秒的图用户看完会说「还行」，
这个 32 秒的会说「这是我」。要快的话把 `comfy.ckptName` 改回
`Counterfeit-V2.5_fp16.safetensors` 即可，配置里一行的事。

## 2026-10-23 16:09：定「记忆权威源」（读了 dsh-agent-soul 之后）

用户丢来 [cyanwell/dsh-agent-soul](https://github.com/cyanwell/dsh-agent-soul)，
评价是「介绍写得挺新颖」，随后表示：可以整合进来，装不装由我判断收益和性价比。

### 结论：不装插件，只吸收判据

那仓库是个 DSH 插件（8 个工具），但它的价值**不在代码**——它自己就写着
「交付的是问法和判据，不是答案」。而它的四条判据里**最硬的一条我们正缺**：

> ② 一个唯一权威源 —— 冲突时听谁的？答不出来就是**双重记账**。

我们这边恰好有**三个**存储系统各记各的，从来没定过谁说了算：

| 存储 | 存什么 | 条目数 |
|---|---|---|
| mnemon（六个工作区库） | 长期记忆：MEMORY.md / USER.md / memories.json | 各 2–8 条 |
| 会话文件 | 逐字聊天记录 | — |
| companion 的 JSON | 情绪/精力/亲密度/日记/约定… | — |

### 新建 `AUTHORITY.md`（仓库根目录，四十六行）

按「**这句话该不该被当成事实**」分层，而不是按存储位置分：

1. **事实性陈述** → mnemon 是唯一权威源（例如「某人的口味偏好」「token 缺某个 scope」）
2. **逐字发生过什么** → 会话文件是唯一权威源。mnemon 里是**提炼**，会被改写成
   「他嫌模型旧」；原文才作数。这条直接来自它那句最戳人的区分：
   *「她记得的」永远不等于「发生过的」。*
3. **此刻在什么状态** → companion 的 JSON。判据：**会自己变的东西不进 mnemon。**
   mnemon 只收「变了也还是那样」的结论。

顺带定下三条规矩：同一事实只写一处；引用要带出处（说清是「你记着的」还是
「他当时说的」）；新加任何存储前先回来看这份表。

### 同时记下两个已知重叠

- `qq_diary` 的 critical 档事实上在做 mnemon 的活（在 `diary.js` 的 DEFAULTS
  里补了一段边界注释，指向 AUTHORITY.md）；
- mnemon 的 `storageScope: workspaces` 意味着 QQ 通道（`D:\Documents\yunyue`）
  与 GUI（`default-workspace`）**是两个独立的库**，互不知情。这是刻意保留的隔离，
  不是 bug，但要知道。

### 验证

`pass=1441 fail=0`（只加注释，无逻辑改动）。
mnemon 的 `MEMORY.md` 新增一条 critical 条目记住这个分工。
