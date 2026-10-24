/**
 * dsh-onebot-companion —— 一个插件，把 QQ 通道该有的四件事都装回来。
 *
 * ## 为什么是一个插件而不是四个
 *
 * 当时的意见（大意）：原本拆开的几个插件可以合并成一个。于是合并成一个包、
 * 内部按职责分成四个模块：
 *
 *   | 模块      | 干什么                                   | 挂在哪                                    |
 *   |-----------|------------------------------------------|-------------------------------------------|
 *   | `guard`   | 出站闸：拦 `[[silent]]` 与括号旁白        | `OutboundPipeline.prototype.sendToChat/sendMsg` |
 *   | `prompt`  | 每轮注入 5 条行为规则 + 情绪/风格行       | 宿主 `agent/pre-step`（不挂原型）          |
 *   | `rhythm`  | 入站合并（连打三行 = 一个回合）+ 出站分段 | `ChatBridge.prototype.dispatchFollowup/sendToChat` |
 *   | `persona` | 情绪四变量 + 随机主动发言 + 风格学习      | `ChatBridge.prototype.handleInbound/onSessionEvent` |
 *
 * 四个模块挂在**不同**的方法上，靠 `core/patch.js` 的模块身份标记共存，互不吞并。
 *
 * ## 为什么必须从外面挂（改 node_modules 是死路）
 *
 * 2026-10-06 ~ 10-12 这些功能原本是直接改 `node_modules/dsh-onebot-qq/lib/*.js`
 * 实现的（`prompt.js` 累计 29 次 edit、`bridge.js` 66 次）。10-12 升到 0.9.0 时
 * pnpm 换了目录，**一次全抹掉**。所以本插件一行都不改 node_modules，只从外面给
 * 原型挂包装 —— 升级不会再把功能冲掉。
 *
 * ## 刻意不导出 Config schema
 *
 * 沿用 guard / prompt 的实测结论：profile 侧解析不到宿主的 `schemastery`，导出
 * 非 schema 对象会让 loader 投影 config 时报错。配置走 `{...DEFAULTS, ...config}`。
 *
 * ## 状态文件
 *
 * `$DSH_HOME/onebot-companion/state.json`（本插件的运行态：挂了哪些闸、扫了几次、
 * 命中多少）。**情绪与风格画像不在里面** —— 它们继续写
 * `config.mediaDir`（云玥的 `D:\path\to\qq-bot\.dsh-media\`），于是换插件也能
 * 继承历史数据。
 *
 * @module dsh-onebot-companion
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerHttp } from './core/http.js';
import { createHttpHandler } from './http.js';
import { API_VERSION, createApi, SERVICE_NAME } from './api.js';
import { JsonStore } from './core/jsonstore.js';
import { createPatcher } from './core/patch.js';
import { FACE_COUNT, resolveFaceId, suggestFaces } from './modules/faces.js';
import { createAdopt, DEFAULTS as ADOPT_DEFAULTS } from './modules/adopt.js';
import { createGuard, DEFAULTS as GUARD_DEFAULTS } from './modules/guard.js';
import { createMention, DEFAULTS as MENTION_DEFAULTS } from './modules/mention.js';
import { createPersona, chatIdOfSession, DEFAULTS as PERSONA_DEFAULTS } from './modules/persona.js';
import { createPrompt, DEFAULTS as PROMPT_DEFAULTS, sessionIdOf } from './modules/prompt.js';
import { createRhythm, DEFAULTS as RHYTHM_DEFAULTS } from './modules/rhythm.js';
import { createStamp, DEFAULTS as STAMP_DEFAULTS } from './modules/stamp.js';
import { createVoice, DEFAULTS as VOICE_DEFAULTS, VOICES } from './modules/voice.js';
import { createIsolation, DEFAULTS as ISOLATION_DEFAULTS } from './modules/isolation.js';
import { createEmoji, DEFAULTS as EMOJI_DEFAULTS } from './modules/emoji-media.js';
import { createLinkCard, DEFAULTS as LINKCARD_DEFAULTS } from './modules/link-card.js';
import { createHands, DEFAULTS as HANDS_DEFAULTS } from './modules/hands.js';
import { createSleep, DEFAULTS as SLEEP_DEFAULTS } from './modules/sleep.js';
import { createLastWord, DEFAULTS as LASTWORD_DEFAULTS } from './modules/lastword.js';
import { createDiary, DEFAULTS as DIARY_DEFAULTS, LEVELS as DIARY_LEVELS } from './modules/diary.js';
import { createPromise, DEFAULTS as PROMISE_DEFAULTS } from './modules/promise.js';
import { createUnsaid, DEFAULTS as UNSAID_DEFAULTS } from './modules/unsaid.js';
import { createQuota, DEFAULTS as QUOTA_DEFAULTS } from './modules/quota.js';
import { createStickerLib, DEFAULTS as STICKER_DEFAULTS } from './modules/sticker-lib.js';
import { createPhone, DEFAULTS as PHONE_DEFAULTS, SOURCES as PHONE_SOURCES } from './modules/phone.js';
import { createFocus, DEFAULTS as FOCUS_DEFAULTS } from './modules/focus.js';
import { createSolitude, ownerChatOf, DEFAULTS as SOLITUDE_DEFAULTS } from './modules/solitude.js';
import { createTemper, DEFAULTS as TEMPER_DEFAULTS } from './modules/temper.js';
import { createTempo, DEFAULTS as TEMPO_DEFAULTS } from './modules/tempo.js';
import {
  createInterrupt,
  DEFAULTS as INTERRUPT_DEFAULTS,
} from './modules/interrupt.js';
import { createComfy, DEFAULTS as COMFY_DEFAULTS, FACE_PRESETS, SELF_ANCHOR } from './modules/comfy.js';
import { createRecall, DEFAULTS as RECALL_DEFAULTS } from './modules/recall.js';
import { createCircadian, DEFAULTS as CIRCADIAN_DEFAULTS } from './modules/circadian.js';
import { DEFAULTS as TIER_DEFAULTS, tierPromptLine } from './modules/tier.js';
// 统计与命中记录搬到了 core/stats.js（2026-10-21 拆分，见那边的头注释）。
import { ensureStatsShape, hits, noteToolRegistered, stats } from './core/stats.js';

export const name = 'onebot-companion';

/**
 * 硬声明 `tools` 依赖。
 *
 * 2026-10-13 实证：`inject = []` 时，下面 `ctx.inject(['tools'], cb)` 的回调
 * **永远不会被调用** —— 插件报告一切正常，但工具根本没注册上（`stats.tools`
 * 恒为 `[]`，QQ 会话的工具表里也查不到）。对照 `dsh-mnemon`
 * （`inject = ['tools', 'settings', ...]`）与 `dsh-onebot-qq`
 * （`inject = ['tools', 'systemPrompt', ...]`）都用模块级声明，工具正常可见。
 *
 * `webServer` 仍走运行时 `ctx.inject`（没有也能跑，只是少一个 HTTP 观测面）。
 */
export const inject = ['tools'];

/** 状态文件默认位置：`$DSH_HOME/onebot-companion/state.json`。 */
export function defaultStateFile(override) {
  if (typeof override === 'string' && override !== '') return override;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'onebot-companion', 'state.json');
}

const DEFAULTS = {
  /** 总开关：关掉后七个模块全部原样放行。 */
  enabled: true,
  /** 目标包名（要挂的 QQ 通道插件）。 */
  packageName: 'dsh-onebot-qq',
  /** profile 目录；留空则多路自动探测。 */
  profileDir: '',
  /** 补挂扫描周期（毫秒）。目标包被升级换目录后靠它自愈。 */
  pollMs: 3000,
  /** 本插件运行态落盘位置；留空用 `$DSH_HOME/onebot-companion/state.json`。 */
  stateFile: '',
  guard: { ...GUARD_DEFAULTS },
  mention: { ...MENTION_DEFAULTS },
  adopt: { ...ADOPT_DEFAULTS },
  prompt: { ...PROMPT_DEFAULTS },
  rhythm: { ...RHYTHM_DEFAULTS },
  stamp: { ...STAMP_DEFAULTS },
  persona: { ...PERSONA_DEFAULTS },
  voice: { ...VOICE_DEFAULTS },
  isolation: { ...ISOLATION_DEFAULTS },
  emoji: { ...EMOJI_DEFAULTS },
  linkcard: { ...LINKCARD_DEFAULTS },
  hands: { ...HANDS_DEFAULTS },
  sleep: { ...SLEEP_DEFAULTS },
  /**
   * 最后开口（2026-10-19）：她最后一次真的发出消息是什么时候。
   *
   * 来源是用户贴的别人家面板截图里那行「她最后说话 19:31:19」—— 那一行能
   * 区分「进程还活着」与「她还正常说话」，别的字段都回答不了这个问题。
   */
  lastword: { ...LASTWORD_DEFAULTS },
  /**
   * 日记（2026-10-19）：她自己记下来的事，三档 + 到期遗忘。
   *
   * 为什么不做自动摘要：自动摘出来的永远是「用户说了 X」，那不是日记，是
   * 日志的第二个副本。要的是她的口吻与取舍，所以只由 `qq_diary` 工具写入。
   */
  diary: { ...DIARY_DEFAULTS },
  /** 约定（2026-10-19）：答应过但还没兑现的事，到点会想起来。 */
  promise: { ...PROMISE_DEFAULTS },
  /**
   * 咽回去的话（2026-10-20）：想说、当时觉得不合适而没发的那句话，攒着等合适的
   * 时候再冒出来。
   *
   * 当时提的需求（大意）：有些话到嘴边觉得不合适就咽回去了，然后就没了；
   * 要是能攒着，等合适的时候再冒出来就好了。
   *
   * 与 diary 的区别：diary 记**发生过的事**，unsaid 记**没发生的那句话**。
   */
  unsaid: { ...UNSAID_DEFAULTS },
  /**
   * 自己的额度（2026-10-20）：她今天聊了多少、说出去多少字。
   *
   * 不给她看 token（她不会那么讲话），折成「聊了 N 轮、两千来字」这种她能自己
   * 拿来判断「是不是该收了」的说法。换日线在凌晨四点，见 modules/quota.js。
   */
  quota: { ...QUOTA_DEFAULTS },
  /**
   * 玩手机（2026-10-20）：她自己刷一刷外面的世界。
   *
   * 当时的说法（大意）：可以不刷，但得能刷——重点是「能力得有」。
   * 形态是**工具**而不是定时任务：想刷的时候自己调 `qq_phone`，绝不后台抓、
   * 绝不每轮注入（每轮变前缀会把上下文缓存全废，见 modules/phone.js 头注释）。
   */
  phone: { ...PHONE_DEFAULTS },
  /** 关系阶段（2026-10-19）：把 affinity 数字投影成台阶，接进提示词。 */
  tier: { ...TIER_DEFAULTS },
  /**
   * 表情包图库（2026-10-21）：别人发的商城贴纸自动收进 lib/stickers/，以后她能
   * 自己搜出来再发出去。
   *
   * 当时只是觉得这类功能有用，可以先试试。参照的是社区插件
   * `zaofan-make/dsh-qqbot` 的贴纸库 —— 它的重点不是「能发图」（我们本来就能
   * 发），而是「平时收到的图会自己攒起来」。
   */
  stickers: { ...STICKER_DEFAULTS },
  /**
   * 注意力（2026-10-21）：她此刻在不在忙别的。
   *
   * 来源是用户贴的「鱼的大脑」设计稿里那条注意力机制 —— 人在刷帖子/打游戏时
   * 回话会变慢、也容易答非所问。用户说「我不想给太多硬限制」，所以这里**不做
   * 拦截**，只让她自己知道「我刚才在干别的」，好让她自然说得出「我回慢了一点，
   * 因为在看视频」。见 modules/focus.js 头注释。
   */
  focus: { ...FOCUS_DEFAULTS },
  /**
   * 独处（2026-10-21）：他真的不在的时候，她自己在干什么。
   *
   * 这是「鱼的大脑」里我唯一觉得差得最远的一块 —— 那些小鲸鱼之所以像活的，
   * 不是因为会说话，是因为**不理人的那段时间也在过**。用户说「我也想有独处
   * 的时间」，所以这一块不做「猜他为什么不理我」那种内耗，只做一件事：把她
   * 不在场的这段时间，如实告诉她。
   *
   * 无定时器、无落盘：全部在注入时现取。见 modules/solitude.js 头注释。
   */
  solitude: { ...SOLITUDE_DEFAULTS },
  /**
   * 长期底色（2026-10-21）：这一阵过得怎么样，会改人格基线。
   *
   * 「鱼的大脑」里那句「单次事件不改人格，长期经历改基线」是那篇稿子里少数
   * 几条能落地、且不会和现有管道打架的。它不扣分、不拦消息、不写日记，只往
   * 心情的掷骰子权重上乘一组系数 —— 偏了之后她说的话自己会变。
   *
   * 按天结算（一天一条事实），偏向每次现算，有自愈。见 modules/temper.js。
   */
  temper: { ...TEMPER_DEFAULTS },
  /**
   * 生物钟（2026-10-21）：她按**你**的作息活，不按钟表活。
   *
   * 「鱼的大脑」原文那句「作息是关系磨合出的结果」是整篇里最能动到骨架的一条：
   * 原来的 `mood.js` 把 0–8 点写死成夜里回血，而示例用户凌晨两点还在说话、中午
   * 十一点才冒头 —— 于是「夜里该困了」变成一句她演给自己听的话。
   *
   * 这里只记**他什么时候在场**（24 个小时桶，按天衰减），学出来的曲线既改精力
   * 的昼夜判定（`nightMask`），也出一句注入行。样本不够时一律退回固定区间 ——
   * 宁可先按钟表过几天，也不要拿三条消息推出一条「作息」然后当真。
   *
   * 见 modules/circadian.js 头注释。
   */
  circadian: { ...CIRCADIAN_DEFAULTS },
  /**
   * 生活节奏（2026-10-22）：从 HDS-Interlude 学来的「五档节奏 × 对话密度」。
   *
   * 原来的主动开口概率只看情绪、精力、静默时长、热情 —— 它不知道「我正在
   * 上课」和「我正抱着手机等你说下一句」是两回事，也不知道「刚聊完还热着」。
   * 这里给一个**乘法倍率**（睡着 ×0.15 … 刚聊完 ×1.4），不改任何判据。
   *
   * 见 modules/tempo.js 头注释（含五档表与为什么用乘法）。
   */
  tempo: { ...TEMPO_DEFAULTS },
  /**
   * 未完成意图（2026-10-22）：说了半句被他插话截断，那半句要留着。
   *
   * HDS-Interlude 里最戳人的一条：它把「本来想说但没打完字」的话作为未完成
   * 意图交给下一轮，明确区分**已出口**与**未出口**。我们之前是发到一半被打断
   * 就当作没发生过 —— 于是下一轮她可能跟刚说出去的话自相矛盾。
   *
   * 见 modules/interrupt.js 头注释（含三个判据与「绝不自动补发」的取舍）。
   */
  interrupt: { ...INTERRUPT_DEFAULTS },
  /**
   * 自己画图（2026-10-22）：接本地 ComfyUI 的 HTTP API。
   *
   * 起因是当时提的建议：现有表情不够用，不如装个 ComfyUI 随便画。装好之后
   * 她能调 `qq_draw` 画一张、拿回本地路径，再用 `qq_send_image` 发出去。
   *
   * **只画不发**是刻意的：群里被 isolation 限成只能发声的那一轮，不该因为这条
   * 工具绕过去往外发图。要发就由她单独说一句。
   *
   * 见 modules/comfy.js 头注释（含工作流为什么写死、为什么轮询而不是 ws）。
   */
  comfy: { ...COMFY_DEFAULTS },
  /**
   * 撤回（2026-10-23）：「发错了，删了重说」。
   *
   * 用户很早前提过「删除重打」，一直排在做不完的清单上。真人聊天里最真实的
   * 一类动作就是这个 —— 打出去、看一眼、觉得不对、撤回、重打。
   *
   * 只撤**自己**发出去的（表里只有我们自己的 id，绝不接受外部传入），
   * 且只在 5 分钟窗口内。见 modules/recall.js 头注释的三条纪律。
   */
  recall: { ...RECALL_DEFAULTS },
};

/**
 * 深合并两层：顶层 + 四个模块段。
 *
 * 模块段内部的嵌套（`rhythm.inbound` / `rhythm.burst`）交给各模块自己的默认值，
 * 这里只保证「用户给了部分键」不会把整段默认值顶掉。
 *
 * **`packageName` / `profileDir` 要下发到每一段**：四个模块都要 `import()` 目标包
 * （`core/profile.js` 读的是 `cfg.packageName`），让调用方在每个模块段里重复写一遍
 * 是纯粹的陷阱 —— 实测就是这么踩到的：段里没有 `packageName`，`resolveProfileDirs`
 * 去找「含 undefined 的 profile 目录」，四个模块全部挂不上，而插件还报告一切正常。
 */
function mergeConfig(raw) {
  const out = { ...DEFAULTS, ...(raw ?? {}) };
  for (const key of ['guard', 'mention', 'adopt', 'prompt', 'rhythm', 'stamp', 'persona', 'voice', 'isolation', 'emoji', 'linkcard', 'hands', 'sleep', 'lastword', 'diary', 'promise', 'unsaid', 'quota', 'phone', 'tier', 'stickers', 'focus', 'solitude', 'temper', 'circadian', 'tempo', 'interrupt', 'comfy', 'recall']) {
    const seg = {
      packageName: out.packageName,
      profileDir: out.profileDir,
      ...DEFAULTS[key],
      ...(raw?.[key] ?? {}),
    };
    // 用户对**本模块**的意图（顶层总开关之外的那一层）。`undefined` 视为开。
    let wanted = seg.enabled !== false;
    // 顶层总开关一票否决：`enabled:false` 关掉全部模块。
    //
    // 这里必须用**访问器**而不是一次性赋值：`POST /toggle` 在运行时只改顶层的
    // `out.enabled`，各模块早就拿着自己的 `cfg` 子对象了。若 `enabled` 是普通
    // 数据属性，模块读到的永远是启动那一刻的快照，总开关点了等于没点 ——
    // 2026-10-14 实测：toggle 置 false 后 guard/prompt/rhythm/persona 的
    // `enabled` 仍报 true，行为照旧（全文只有 4 处读 `out.enabled`，且全在
    // 统计与状态显示里）。访问器让「读」始终是「顶层开关 ∧ 本模块意图」的合成值。
    Object.defineProperty(seg, 'enabled', {
      enumerable: true,
      configurable: true,
      get: () => out.enabled !== false && wanted,
      set: (v) => {
        wanted = v !== false;
      },
    });
    out[key] = seg;
  }
  return out;
}

/** 导出给自测用：测的就是生产路径上的这份合并。 */
export { mergeConfig };


export function apply(ctx, config) {
  const cfg = mergeConfig(config);
  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(message);
    } catch {
      /* 日志失败不影响业务 */
    }
  };

  stats.generations += 1;
  stats.startedAt ??= Date.now();
  stats.enabled = cfg.enabled;

  /**
   * 「本次实例挂的」标记。普通 Symbol —— 每次 `apply()` 都是新的一个，于是热重载
   * 后旧包装不被认成自己人，会重新挂一遍（新配置要生效，这是**想要的**行为）。
   */
  const owner = Symbol('dsh-onebot-companion.owner');

  /** 挂载器：四个模块共用，按模块身份脱链（见 core/patch.js）。 */
  const patchMethod = createPatcher({ owner, log, stats, label: name });

  /** guard 自测期间静音（自测的 BLOCKED 不该污染生产命中数）。 */
  const ctl = { suspended: false };

  // ── 七个模块 ─────────────────────────────────────────────────────────────
  const guard = createGuard({ cfg: cfg.guard, stats, hits, ctl, patchMethod, log });

  // lastword：只记「她最后一次真的开口是什么时候」，挂在同一个出站出口
  // （OutboundPipeline.sendToChat / sendMsg），不改任何参数、不抛错。
  // 与 guard 分开的理由见 modules/lastword.js 头注释：guard 可以被关掉，
  // 这一笔记录不该跟着一起失明。
  const lastword = createLastWord({ cfg: cfg.lastword, stats, patchMethod, log });

  // mention：让「群里叫她的名字」也算被叫到。上游 `detectMention` 只认 @ 与
  // 引用，认不出名字；本模块包住 `InboundPipeline.processInbound`，在进原方法前
  // 于 `inbound.segments` 末尾追加一个 at 段（该字段全包唯一消费者就是
  // detectMention，改动面可控），复用上游现成的「被 @」语义。纯本地判据，
  // 零 RPC、零依赖（见 modules/mention.js 头注释）。
  const mention = createMention({ cfg: cfg.mention, stats, patchMethod, log });

  // stickers：表情包图库（2026-10-21）。这里**先占位**，真正的实例在下面的
  // 记忆目录就绪之后才造（它要 `persona.dir()`，而 persona 这会儿还没建）。
  // 用 `let` + 闭包转一手，于是 emoji 那边能在收图时拿到**当下**的实例。
  // 见 modules/sticker-lib.js 头注释。
  let stickerLib = null;

  // emoji：把 QQ 原生小黄脸与商城表情包补成「中文名 + 本地图片路径」，并删掉
  // 上游塞进文本的那些**错误的** emoji（`/变形`(312) → 🐳，她于是回「又发个鲸鱼」）。
  // 挂 `InboundPipeline#processInbound` —— 那一层 `inbound.segments` 还是原始段。
  // 见 modules/emoji-media.js 头注释。
  // 表情包落地时顺手喂图库：`emoji` 已经在本地拿到了图，复用它省的是一次
  // 重复下载。`stickerLib` 此刻还是 null（还没造），所以这里必须查**当下**的值，
  // 不能把 null 闭进去。
  const emoji = createEmoji({
    cfg: cfg.emoji,
    stats,
    patchMethod,
    log,
    onSticker: (input) => {
      if (stickerLib === null) return;
      try {
        void stickerLib.ingest({ ...input, now: Date.now() }).catch(() => undefined);
      } catch {
        // 图库是「顺手收下」，任何问题都不该影响这条消息投递。
      }
    },
  });

  // linkcard：把 QQ 分享卡片的正文与跳转链接捞回来。上游 `cq.js` 对 `json` 段
  // 只有一句 `textParts.push('[卡片]')`，标题和 URL 全丢，于是「看不懂链接」。
  // 与 emoji 同层挂载（`inbound.segments` 还是原始段）。见 modules/link-card.js。
  const linkcard = createLinkCard({ cfg: cfg.linkcard, stats, patchMethod, log });

  // adopt：会话换代防护。包住 registry.createChat，在进入上游之前先看「裸 id 上
  // 是不是已经有一份持久化日志」——有就 resume 接管，别让上游把它退休掉另开新
  // 会话。这样那处补丁不再藏在 node_modules 里（见 modules/adopt.js 头注释）。
  const adopt = createAdopt({ cfg: cfg.adopt, stats, patchMethod, log });

  // prompt 与 persona 搭车：规则文本 + 情绪/风格行合成一条注入消息。
  let persona;
  const prompt = createPrompt({
    cfg: cfg.prompt,
    stats,
    // 2026-10-19：原来只递 persona 的情绪/风格两行。现在多三样东西要搭同一班车
    // —— 关系阶段、还有没兑现的约定、她记下来的事。刻意都塞进这一条 `extra`：
    // 每多一条注入消息就是每轮多一次前缀变动，缓存全废（见 prompt.js 里
    // `firstStepOnly` 那段注释）。所以宁可拼成一段，也不要各发各的。
    //
    // 顺序是有意的：阶段（她是谁、该怎么演）→ 约定（欠着什么话）→ 日记（记得
    // 什么）→ 情绪/风格（此刻的语气）。越靠前越"设定"，越靠后越"当下"。
    // GUI 会话要不要也注入人格状态行（2026-10-20）。判据在 persona 那边：
    // 配了 `persona.guiChatId` 就认。只给 extra、不给 QQ 那套规则 ——
    // 规则里写的是 @、分段、群友隔离，套到网页会话上是错的。
    extraSession: (sessionId) => {
      if (persona === undefined) return false;
      const want = String(cfg.persona?.guiChatId ?? '').trim();
      if (want === '') return false;
      return chatIdOfSession(sessionId) === null;
    },
    extra: (sessionId) => {
      try {
        const parts = [];
        // GUI 会话反推不出 chatId，但宿主可能已经把它指给某一个 chat 了
        // （用户平时只在网页里跟她说话，QQ 那条线反而是次要的）。
        const guiChat = String(cfg.persona?.guiChatId ?? '').trim();
        const chatId = chatIdOfSession(sessionId) ?? (guiChat === '' ? null : guiChat);
        if (chatId !== null) {
          if (cfg.tier?.enabled !== false) {
            try {
              const affinity = persona?.moodOf?.(chatId)?.affinity;
              if (Number.isFinite(affinity)) parts.push(tierPromptLine(affinity));
            } catch {
              /* 阶段行拿不到就别注入了 */
            }
          }
          // 日记与约定都是**全局一张表**，不按会话分：她记得的事、她欠着的话，
          // 都是「她自己的」，不该因为换到群里就忘掉。群聊里的群友发言不会写进
          // 日记（只有 qq_diary 工具会写，而群友回合被 isolation 禁了工具）。
          //
          // 2026-10-21：把此刻的心情/精力递进去，让它给日记染一层色 ——
          // 同一条事在低落和开心时翻出来，语气本该不一样。
          let moodState = null;
          try {
            moodState = persona?.moodOf?.(chatId) ?? null;
          } catch {
            /* 拿不到就当没染色 */
          }
          // 长期底色（2026-10-21）：每轮把「今天长什么样」并进那一天的记录里。
          // 同一天反复调用只会累加轮数、取最大静默，不会重复记一天 —— 所以这里
          // 每轮都调是安全的，也是**唯一**的观测点（不另挂钩子，避免两处算不同口径）。
          // 静默时长取「他上次说话到现在」：她说的话不算，因为这块关心的是
          // 「有没有被晾着」，不是「我有没有说话」。
          try {
            if (moodState !== null) {
              const quietMs = Math.max(0, Date.now() - (moodState.lastUserAt ?? moodState.lastAssistantAt ?? 0));
              const bias = temper?.observe?.({
                quietHours: quietMs / 3600000,
                energy: moodState.energy,
                affinity: moodState.affinity,
              }) ?? null;
              const temperText = temper?.promptLine?.(bias) ?? '';
              if (typeof temperText === 'string' && temperText !== '') parts.push(temperText);
            }
          } catch {
            /* 底色出问题不该连累整轮 */
          }
          // 生物钟（2026-10-21）：学出来的作息只在**样本够了**才出一句，平时 null。
          // 排到底色之后 —— 底色说的是「这一阵怎么样」，这条说的是「你几点在」，
          // 一个是基调一个是事实，事实该更靠近当下。
          try {
            const clockText = circadian?.promptLine?.() ?? '';
            if (typeof clockText === 'string' && clockText !== '') parts.push(clockText);
          } catch {
            /* 作息注入失败不该连累整轮 */
          }
          parts.push(diary?.injectionText?.(moodState) ?? '');
          // 约定模块的约定：「注入即消费」。不消费的话，一条到点没做的约定会每轮
          // 都出现在提示里 —— 三天之后她还在为同一句话道歉。次数上限在模块里
          // （MAX_REMINDERS），用尽就自然沉默。
          try {
            const dueText = promise?.injectionText?.() ?? '';
            if (typeof dueText === 'string' && dueText !== '') parts.push(dueText);
            promise?.consumeReminders?.();
          } catch {
            /* 约定注入失败不该连累整轮 */
          }
          // 咽回去的话：排在约定之后 —— 约定是「欠着别人的」，更急；这条是
          // 「欠着自己的」，可以一直放着。注入会顺带给条目 nudges+1，提满几次
          // 还没说出口就淡化（见 unsaid.js 的 maxNudges）。
          try {
            const unsaidText = unsaid?.injectionText?.() ?? '';
            if (typeof unsaidText === 'string' && unsaidText !== '') parts.push(unsaidText);
          } catch {
            /* 咽回去的话注入失败不该连累整轮 */
          }
          // 没说完的半句（2026-10-22）：与上一条的区别是它**已经说过一半**了，
          // 只是被他的新消息掐断。排在 unsaid 之后、额度之前 —— 它比「还没敢说」
          // 更近，但比「欠着别人的约定」远。
          //
          // 只有真的存在且他在这之后说过话时才出一句（判据在
          // modules/interrupt.js 的 `interruptedFor`），平时是空串。
          try {
            let lastUserAt = 0;
            try {
              lastUserAt = persona?.moodOf?.(chatId)?.lastUserAt ?? 0;
            } catch {
              lastUserAt = 0;
            }
            const cutText = interruptRef.current?.promptLine?.(chatId, lastUserAt) ?? '';
            if (typeof cutText === 'string' && cutText !== '') parts.push(cutText);
          } catch {
            /* 未完成意图注入失败不该连累整轮 */
          }
          // 自己的额度：只有「当天第一次」和「越阈值那一次」会出文本，其余
          // 时候一律 null —— 每轮都报一遍既像复读机，又每轮变前缀把缓存全废。
          try {
            const quotaText = quota?.injectionText?.() ?? '';
            if (typeof quotaText === 'string' && quotaText !== '') parts.push(quotaText);
          } catch {
            /* 额度注入失败不该连累整轮 */
          }
          // 注意力（2026-10-21）：只有真的在忙别的（刷手机/打游戏）且还新鲜时才
          // 出一句，平时是 null —— 不然每轮都塞一句「你现在没在忙」纯属噪声。
          // 刻意排在所有「她自己的账」之后：这是当下的状态，不是欠着的事。
          try {
            const focusText = focus?.promptLine?.() ?? '';
            if (typeof focusText === 'string' && focusText !== '') parts.push(focusText);
          } catch {
            /* 注意力注入失败不该连累整轮 */
          }
          // 独处（2026-10-21）：他不在的这段时间，她自己在过什么。排在所有账
          // 之后 —— 它既不欠别人也不欠自己，描述的是「这段时间」而不是「此刻」。
          // 只有真的安静够久才出一句（默认 25 分钟），平时是 null。
          try {
            const loneText = solitude?.promptLine?.(chatId) ?? '';
            if (typeof loneText === 'string' && loneText !== '') parts.push(loneText);
          } catch {
            /* 独处注入失败不该连累整轮 */
          }
          // 生活节奏（2026-10-22）：此刻是在上课、躺着、还是正抱着手机。
          // 排在最后一位 —— 它描述的是「现在这个场合」，最贴近开口那一刻。
          // `available`（常态）和 `asleep`（睡着不该还在读提示词）都不出文本。
          try {
            const paceText = tempo?.promptLine?.(chatId) ?? '';
            if (typeof paceText === 'string' && paceText !== '') parts.push(paceText);
          } catch {
            /* 节奏注入失败不该连累整轮 */
          }
        }
        parts.push(persona?.extraFor?.(sessionId) ?? '');
        const text = parts.filter((x) => typeof x === 'string' && x.trim() !== '').join('\n');
        return text === '' ? null : text;
      } catch {
        return null;
      }
    },
  });

  const rhythm = createRhythm({
    cfg: cfg.rhythm,
    stats,
    patchMethod,
    log,
    // 说到一半他插话了：把没发出去的那部分记成「未完成意图」。
    // 用 `?.` 是有意的 —— interrupt 在 rhythm 之后才创建（要先拿到 memoryDir
    // 的解析结果），所以这里在**调用时**才去取，创建顺序不影响接线。
    onTruncated: (chatId, rest, reason) => interruptRef.current?.note?.(chatId, rest, reason),
  });

  // sleep：睡意闸（2026-10-18）。她说「我去睡了」之后，群里只有**被 @ 或喊
  // 名字才回**。挂 `InboundPipeline#processInbound` 且优先级 30（比 mention 靠外），
  // 因为 mention 会给「喊名字/话题插话」的消息补一个假 at 段 —— 在内层看，那就
  // 成了「有人 @ 我」，喊一嗓子就把睡着的人叫醒。见 modules/sleep.js 头注释。
  //
  // 与 persona 是一条**单向**关系：persona 在 `assistant/message` 里把她说的话
  // 通过 `onAssistantText` 递过来，sleep 只负责记睡眠与拦消息，不反向 patch。
  let sleep;
  let quota;
  let circadian;
  /**
   * 未完成意图的实例占位。
   *
   * 为什么用 `ref.current` 而不是直接闭包 `let interrupt`：`rhythm` 在
   * 它之前创建（rhythm 的 `onTruncated` 需要它），而它自己又要等
   * `memoryDir()` 才建。用一层 ref 让两边都不必关心创建顺序，也不必
   * 把 `let` 提到几十行以外再靠提升顺序读代码。
   */
  const interruptRef = { current: null };
  persona = createPersona({
    cfg: cfg.persona,
    stats,
    patchMethod,
    log,
    onAssistantText: (chatId, text, at) => {
      try {
        sleep?.noteSaid?.(chatId, text, at);
      } catch {
        /* 记睡意失败不影响情绪记录 */
      }
    },
    // 她这一轮花了多少 → quota 记账（2026-10-20）。同样用旁路回调，不另挂一层。
    onSessionUsage: (usage) => {
      try {
        quota?.note?.(usage);
      } catch {
        /* 记账失败不影响情绪记录 */
      }
    },
    // 他在这个钟点冒头了 → 生物钟记账（2026-10-21）。同样旁路，不另挂一层。
    //
    // 只有私聊才算（在 persona 里筛过）：群聊里说话的是群友，学进去就是假的。
    // 群聊那条线由 bridge 自己的 `group:` chatId 排除掉，这里不用再判。
    onUserText: (chatId, at) => {
      try {
        circadian?.observe?.(at);
      } catch {
        /* 记作息失败不影响情绪记录 */
      }
      // 对话密度（2026-10-22）：他刚说过话，这个会话就热起来了。
      // 挂在同一个旁路上而不是另起一层 —— 两者都要的是「他说话了」这件事。
      try {
        tempo?.noteUserMessage?.(chatId);
      } catch {
        /* 记密度失败不影响情绪记录 */
      }
    },
  });
  sleep = createSleep({
    cfg: cfg.sleep,
    stats,
    patchMethod,
    log,
    // 名字表直接借 mention 那份配置：两处各自维护一份，早晚会漂。
    getNames: () => (Array.isArray(cfg.mention?.names) ? cfg.mention.names : []),
    // 状态文件与 mood-state.json 同目录，睡前重启一次不该让她第二天不睡。
    getMediaDir: () => cfg.sleep?.mediaDir
      || cfg.persona?.mediaDir
      || persona.state.lastReceiver?.deps?.config?.mediaDir
      || '',
    moodOf: (chatId) => persona.moodOf(chatId),
    lastReceiver: () => persona.state.lastReceiver,
  });

  // diary / promise：她自己的小本子与欠着的话（2026-10-19，用户授权「放开去做」）。
  //
  // 两者结构几乎一样（一张表 + 一个工具 + 一段注入文本），刻意**不合并**成一个
  // 模块：日记的淘汰规则是「按重要性 + 时间」，约定的是「按结清状态 + 到点时间」，
  // 揉在一起只会让两套规则互相牵制。共用的是 `core/jsonstore.js`，那就够了。
  //
  // 状态目录走 `persona.dir()`（= mediaDir），与 mood-state.json 同处，于是
  // 换插件、重启都能继承历史。延迟解析：第一次真正读写时才要目录。
  const memoryDir = () => {
    try {
      return persona.dir();
    } catch {
      return '';
    }
  };
  const diary = createDiary({ cfg: cfg.diary, stats, log, resolveMediaDir: memoryDir });
  const promise = createPromise({ cfg: cfg.promise, stats, log, resolveMediaDir: memoryDir });
  // unsaid：与 diary / promise 同一张表、同一个目录、同一班注入车。区别在于它
  // **注定要被忘掉**（48 小时过期 + 提三次没说出口就淡化）—— 真人憋久了那句话
  // 就真的没了，这个「没了」本身就是对的。见 modules/unsaid.js 头注释。
  const unsaid = createUnsaid({ cfg: cfg.unsaid, stats, log, resolveMediaDir: memoryDir });
  // interrupt：没说完的话（2026-10-22）。出站分段发到一半、他插话进来时，
  // 剩下那几段会被咽回去并记在这儿 —— 下一轮她知道自己有半句没出口，
  // 可以接着说、可以改口，也可以不提，但**不能假装那句话不存在**。
  //
  // 与 unsaid 的区别：unsaid 是「想说但不敢说」（自己憋的），
  // interrupt 是「说了但没说完」（被时间掐断的）。两件事，别合并。
  interruptRef.current = createInterrupt({ cfg: cfg.interrupt, stats, log, resolveMediaDir: memoryDir });
  // comfy：自己画图（2026-10-22）。接本地 ComfyUI 的 HTTP API，画完把本地路径
  // 交回来；发不发由她另说一句（qq_send_image），这里绝不自己往外发。
  const comfy = createComfy({ cfg: cfg.comfy, stats, log, resolveMediaDir: memoryDir });
  // recall：撤回（2026-10-23）。包一层发送路径把 message_id 记住，
  // 之后 `qq_recall` 才能撤。只撤自己的、只在 5 分钟窗口内。
  const recall = createRecall({
    cfg: cfg.recall,
    stats,
    log,
    patchMethod,
    getReceiver: () => persona.state.lastReceiver,
  });
  // quota：她今天已经聊了多少（2026-10-20）。数据来自 `assistant/message` 的
  // `usage` + 她说出去的字数，经 persona 的 `onSessionUsage` 旁路递进来。
  // 注入给她的**不是 token 数**（她不会用 token 讲话），而是「今天聊了 N 轮、
  // 说出去多少字」——一个她自己看得懂、也能据此决定收尾的数。
  quota = createQuota({ cfg: cfg.quota, stats, log, resolveMediaDir: memoryDir });
  // phone：她自己刷一刷外面的事（2026-10-20）。纯工具、无注入、无定时器 ——
  // 想刷就刷，刷不动就拉倒。上次刷到的记在 seen 表里，所以每次都是「往下滑」。
  const phone = createPhone({ cfg: cfg.phone, stats, log, resolveMediaDir: memoryDir });
  // stickers：表情包图库（2026-10-21）。`emoji` 那边收到商城贴纸就会回调进来
  // （见上面 `createEmoji` 的 `onSticker`），这里只负责入库、按 hash 去重、
  // 控容量，以及给 `qq_sticker` 工具提供 list / 打标签 / 记用过。
  //
  // 为什么不做成「每轮注入一张图」：图是路径，不是文字，注入她也只是知道有这么
  // 一张，不如让她**想发的时候搜一下**。理由同 `phone`（见 modules/sticker-lib.js
  // 头注释里的三条取舍）。
  stickerLib = createStickerLib({ cfg: cfg.stickers, stats, log, resolveMediaDir: memoryDir });
  // focus：注意力（2026-10-21）。刷手机、打游戏这些动作会调 `focus.set`，
  // 注入那边读 `promptLine()` —— 让她自己知道「我刚才在干别的」。不拦消息、
  // 拖延迟，只提供一句诚实的事实。见 modules/focus.js 头注释。
  const focus = createFocus({ cfg: cfg.focus, stats, log, resolveMediaDir: memoryDir });
  // solitude：独处（2026-10-21）。他真的不在的那段时间，她自己在过。
  //
  // 刻意**没有 start / 定时器 / 落盘** —— 全部信息（上次说话多久前、此刻什么
  // 心情、本子里有什么、有没有话没说）都在注入时现取。多存一份状态就多一份会
  // 跟真相不一致的副本。见 modules/solitude.js 头注释。
  //
  // `lastContactAt(chatId)` 走 persona 的合成状态：`moodOf` 会把 chat 层、
  // body 层、people 层拼起来，私聊里 `lastUserAt / lastAssistantAt` 就是
  // 「这个人上次跟我说话 / 我上次跟他说话」的时间。
  const solitude = createSolitude({
    cfg: cfg.solitude,
    stats,
    log,
    lastContactAt: (chatId) => {
      if (typeof chatId !== 'string' || chatId === '') return 0;
      const state = persona?.moodOf?.(chatId);
      if (state === null || state === undefined) return 0;
      return Math.max(state.lastUserAt ?? 0, state.lastAssistantAt ?? 0, state.lastProactiveAt ?? 0);
    },
    moodState: (chatId) => (typeof chatId === 'string' && chatId !== '' ? persona?.moodOf?.(chatId) ?? null : null),
    diaryEntries: () => diary?.peek?.() ?? [],
    pendingUnsaid: () => {
      const held = unsaid?.peek?.() ?? [];
      // 只取最新那条：独处时心里过一遍的那句，不会是一串。
      const newest = held.slice().sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))[0];
      return typeof newest?.text === 'string' ? newest.text : '';
    },
    // 「只对他主动」的名单就是「他本人是谁」的唯一声明，反推成 `private:<号>`。
    // 群聊那条线要靠它把措辞从「跟他说话」换成「在这条线上开口」。
    ownerChat: () => ownerChatOf(cfg.persona?.proactiveOnlyChats),
  });

  // temper：长期底色（2026-10-21）。按天记一条事实，偏向现算，乘到心情权重上。
  //
  // 顺序上有讲究：它必须**在 persona 之后**创建，因为要反过来把 `current` 递给
  // persona 当偏向来源（`setBiasSource`）。这一个回调就是它和情绪系统的全部接口 ——
  // 它自己从不直接改 mood 状态，也不参与任何拦截。
  const temper = createTemper({ cfg: cfg.temper, stats, log, resolveMediaDir: memoryDir });
  try {
    persona?.setBiasSource?.(() => temper.current());
  } catch (error) {
    log?.('warn', `temper: 接不上心情权重（${String(error?.message ?? error)}）`);
  }

  // circadian：学出来的生物钟（2026-10-21）。记的是「他什么时候在场」——
  // 24 个小时桶，按天衰减，样本够了就把曲线同时接到两处：
  //   1. `persona.setNightMaskSource` → 精力积分的昼夜判定（mood.js 的 nightMask）；
  //   2. 注入行（`promptLine()`）→ 她知道「我的作息跟着你走」。
  //
  // 顺序上和 temper 一样必须在 persona 之后（要 `setNightMaskSource`），
  // 与 `sleep` 的分工也别搞混：sleep 管的是「她自己去睡了」，这里管的是
  // 「他平时几点在」—— 一个是她的状态，一个是他作息学出来的统计。
  circadian = createCircadian({ cfg: cfg.circadian, stats, log, resolveMediaDir: memoryDir });
  try {
    persona?.setNightMaskSource?.(() => circadian.nightSet());
  } catch (error) {
    log?.('warn', `circadian: 接不上夜间掩码（${String(error?.message ?? error)}）`);
  }

  // ── tempo：生活节奏五档 + 对话密度（2026-10-22）────────────────────────────
  //
  // 用户拿来的 HDS-Interlude 里有两件事我们缺：**生活在什么节奏上**（上课 /
  // 躺着 / 睡着时不该催）与**刚聊完还热着**这件事。乘法模型：节奏倍率 × 密度
  // 因子，乘到主动开口的概率门上（persona 的 chance 回调）。
  //
  // 顺序：必须在 persona / circadian 之后 —— 它要读 `persona.moodOf`（精力、
  // 他上次说话的时间）与 `circadian.nightSet`（学出来的夜里小时表）。
  // 它自己**不发消息、不建定时器**，只在被问时现算。
  const tempo = createTempo({
    cfg: cfg.tempo,
    stats,
    log,
    resolveMediaDir: memoryDir,
    moodOf: (chatId) => persona?.moodOf?.(chatId) ?? null,
    focusOf: () => focus?.current?.() ?? null,
    nightMaskOf: () => circadian?.nightSet?.() ?? null,
  });
  try {
    persona?.setTempoSource?.((chatId, now) => tempo.intensity(chatId, now));
  } catch (error) {
    log?.('warn', `tempo: 接不上主动开口倍率（${String(error?.message ?? error)}）`);
  }


  // isolation：群聊硬隔离（2026-10-17）。非管理员在群里说话的那一轮，禁用一切
  // 工具（只留纯发声的 qq_say / qq_send_face）。判据按**本轮发送者**，因为群里
  // 示例用户和群友共用同一个会话。管理员号从 bridge 实时配置读 —— 改了立刻生效。
  // 见 modules/isolation.js 头注释（含出发事故与为什么提示词不够）。
  const isolation = createIsolation({
    cfg: cfg.isolation,
    stats,
    log,
    adminUsers: () => {
      const fromBridge = persona.state.lastReceiver?.deps?.config?.adminUsers;
      return Array.isArray(fromBridge) ? fromBridge : [];
    },
    // 读图白名单目录：群友回合允许 read_image（否则她看不见群友发的图），
    // 但只许读聊天媒体目录里的文件。同样从 bridge 实时配置取。
    mediaDir: () => cfg.isolation?.mediaDir
      || persona.state.lastReceiver?.deps?.config?.mediaDir
      || '',
  });

  // hands：给云玥加「社交的手」——戳一戳 / 贴表情 / 名片赞，外加好友申请与
  // 入群邀请的**审批闸**。约定：加好友和进群要经审批，自己拉进去的除外。
  //
  // 为什么审批必须落在代码里：本会话已经出过一次「提示词说了也照编」的事故
  // （亲密关系那轮，reasoning 明写「没法真的点开」，正文却输出「已经点开了」）。
  // 所以这里的授权只由 `InboundPipeline` 拦截到的**管理员私聊命令**写入，
  // 模型无论怎么调工具都写不进去。见 modules/hands.js 头注释。
  const hands = createHands({
    cfg: cfg.hands,
    stats,
    log,
    patchMethod,
    // 管理员号实时读 bridge 配置（`deps.policy.adminUsers` 才是上游真正用来
    // 判断管理员的那个字段；`deps.config.adminUsers` 在 0.9.x 里已不再是权威）。
    adminUsers: () => {
      const bridge = persona.state.lastReceiver;
      const fromPolicy = bridge?.deps?.policy?.adminUsers;
      if (Array.isArray(fromPolicy)) return fromPolicy;
      const fromConfig = bridge?.deps?.config?.adminUsers;
      return Array.isArray(fromConfig) ? fromConfig : [];
    },
    getReceiver: () => persona.state.lastReceiver,
    sendText: (chatId, text) => {
      const bridge = persona.state.lastReceiver;
      if (bridge === undefined || typeof bridge.sendToChat !== 'function') {
        return Promise.reject(new Error('QQ 通道尚未就绪，发不出通知'));
      }
      return bridge.sendToChat(chatId, text);
    },
  });

  // stamp：给 `<user_message>` 边界补回 `time=` / `gap=`（0.9.0 升级把这两个
  // 参数从 `chat.js#wrapUserMessage` 里删掉了，见 modules/stamp.js 头注释）。
  //
  // **构造顺序不决定挂载顺序**（挂载在 scanAll 里按调用顺序发生），这里放后面只
  // 是为了读起来与 scanAll 一致。关键约束是 scanAll 里 stamp 必须排在 rhythm
  // **之后** —— 最后挂的在链的最外层，于是每条消息先各自注入自己那一刻的属性，
  // 再由 rhythm 把已注入的几条合并成一批。反过来只会在合并后拿到一整批文本，
  // 只能给整批贴一个时间。
  const stamp = createStamp({ cfg: cfg.stamp, stats, patchMethod, log });

  // voice 只读 persona 的 bridge 实例（persona 已经挂了 handleInbound /
  // onSessionEvent，那两个方法的 this 就是 bridge）—— 见 modules/voice.js 注释。
  const voice = createVoice({
    cfg: cfg.voice,
    stats,
    log,
    resolveMediaDir: () => persona.dir(),
    getReceiver: () => persona.state.lastReceiver,
  });

  // ── 状态落盘：从文件系统就能看出插件在不在跑 ──────────────────────────────
  const store = new JsonStore({
    file: defaultStateFile(cfg.stateFile),
    log,
    label: name,
    normalize: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
  });

  // 同步读一次盘，抢在任何 `persist()` 之前。
  //
  // 为什么不能等 `store.load()`：挂原型成功后（lib/index.js 的 patch 回调里）
  // 就会 `persist()` 一次，而 `JsonStore.loadFrom` 是**内存优先**的 —— 先写进去的
  // 空 `lastwordState` 会把盘上那份挡住，异步 `load()` 回来时整条键被跳过。
  // 于是「最后开口」永远恢复不回来，体检表重启后恒显示「还没说过话」。
  // 这是 `loadSync` 存在的理由（见 core/jsonstore.js 的注释）。
  store.loadSync();
  try {
    lastword.restore?.(store.get('self')?.lastwordState);
  } catch (error) {
    stats.lastWordError = String(error?.message ?? error);
  }

  const persist = () => {
    try {
      store.set('self', {
        at: Date.now(),
        generations: stats.generations,
        packageName: cfg.packageName,
        profileDir: stats.profileDir,
        resolveError: stats.resolveError,
        enabled: cfg.enabled,
        attached: stats.patched.map((p) => `${p.moduleId}:${p.method}`),
        lost: stats.lost.map((l) => `${l.moduleId}:${l.method}`),
        scans: stats.scans,
        lastScanAt: stats.lastScanAt,
        guard: {
          blocked: stats.blocked,
          stripped: stats.stripped,
          muted: stats.muted,
          muteQueueNotice: cfg.guard.muteQueueNotice !== false,
          stripAside: cfg.guard.stripAside !== false,
          stripNarration: cfg.guard.stripNarration !== false,
          lastHitAt: stats.lastHitAt,
          lastHitKind: stats.lastHitKind,
          lastHitChat: stats.lastHitChat,
        },
        adopt: {
          adopted: stats.adopted,
          enabled: cfg.adopt.enabled !== false,
          lastAdoptAt: stats.lastAdoptAt,
          lastAdoptChat: stats.lastAdoptChat,
          lastAdoptSession: stats.lastAdoptSession,
          resolveError: stats.adoptResolveError,
          profileDir: stats.adoptProfileDir,
        },
        mention: {
          named: stats.mentionNamed,
          dived: stats.mentionDived,
          upstream: stats.mentionUpstream,
          awake: mention.awakeNow(),
          enabled: cfg.mention.enabled !== false,
          names: cfg.mention.names,
          diving: cfg.mention.diving,
          // 话题插话（判据三）：开了没、命中过几次、现在还「醒」着几个群、
          // 每个群今天还能插几次 —— 用来回答「为什么她没接话」。
          topicEnabled: cfg.mention.topics?.enabled === true,
          topicHit: stats.mentionTopic ?? 0,
          topicAlive: stats.mentionTopicAlive ?? 0,
          topicAwake: stats.mentionTopicAwake ?? 0,
          topicGroups: Object.keys(cfg.mention.topics?.groups ?? {}),
          topicQuota: mention.topicSnapshot(),
          lastTopic: stats.lastMentionTopic,
          lastMentionAt: stats.lastMentionAt,
          lastName: stats.lastMentionName,
          resolveError: stats.mentionResolveError,
          profileDir: stats.mentionProfileDir,
        },
        stamp: {
          stamped: stats.stamped,
          enabled: cfg.stamp.enabled !== false,
          injectTime: cfg.stamp.injectTime !== false,
          injectGap: cfg.stamp.injectGap !== false,
          lastStampAt: stats.lastStampAt,
          lastStampChat: stats.lastStampChat,
          lastStampTime: stats.lastStampTime,
          lastStampGap: stats.lastStampGap,
          seen: stamp.seenCount(),
          baseline: stamp.baselineCount(),
          stateFile: stats.stampStateFile,
          resolveError: stats.stampResolveError,
          profileDir: stats.stampProfileDir,
        },
        prompt: {
          steps: stats.steps,
          injections: stats.injections,
          skippedNotOnebot: stats.skippedNotOnebot,
          skippedNotFirstStep: stats.skippedNotFirstStep,
          skippedDuplicate: stats.skippedDuplicate,
          activeRules: prompt.activeRuleIds(),
        },
        rhythm: {
          inbound: { ...stats.inbound, pending: rhythm.pendingCount() },
          burst: { ...stats.burst },
        },
        persona: {
          mediaDir: persona.dir(),
          proactive: { ...stats.proactive },
        },
        voice: { ...stats.voice },
        // 「最后开口」要跟着落盘：它是体检表的主指标，进程重启后得能灌回去
        // （启动时由 lastword.restore 读回，见下方 store.load()）。
        lastwordState: lastword.snapshot(),
        faces: { ...stats.faces },
        isolation: {
          enabled: cfg.isolation?.enabled !== false,
          guardInstalled: stats.isolationGuardInstalled === true,
          allowedTools: cfg.isolation?.allowedTools ?? [],
          // 受限回合里可读链接（只限本轮入站文本里出现过的公网地址）。
          allowLinks: cfg.isolation?.allowLinks !== false,
          blockedTurns: stats.isolationBlockedTurns ?? 0,
          denied: stats.isolationDenied ?? 0,
          allowedCalls: stats.isolationAllowedCalls ?? 0,
          lastDenied: stats.lastIsolationDenied,
          // 实际生效的读图白名单目录。`cfg.isolation.mediaDir` 通常是空串
          // （真值由 bridge 回调实时给出），只看配置会误以为白名单没开。
          mediaDir: isolation.effectiveMediaDir?.() ?? '',
          active: isolation.snapshot(),
        },
        emoji: {
          enabled: cfg.emoji?.enabled !== false,
          names: cfg.emoji?.names !== false,
          muteUnknownFaces: cfg.emoji?.muteUnknownFaces !== false,
          annotated: stats.emojiAnnotated ?? 0,
          resolved: stats.emojiResolved ?? 0,
          noPath: stats.emojiNoPath ?? 0,
          muted: stats.emojiMuted ?? 0,
          lastMuted: stats.lastEmojiMuted ?? null,
          resolveError: stats.emojiResolveError ?? null,
          lastError: stats.emojiLastError ?? null,
        },
        linkcard: {
          enabled: cfg.linkcard?.enabled !== false,
          annotated: stats.linkcardAnnotated ?? 0,
          linked: stats.linkcardLinked ?? 0,
          resolveError: stats.linkcardResolveError ?? null,
          lastError: stats.linkcardLastError ?? null,
        },
        hands: hands?.snapshot?.() ?? { enabled: cfg.hands?.enabled !== false },
        // 表情包图库（2026-10-21）：只报条数与入库/去重次数，不列图 —— 图是她
        // 在聊天里用的东西，不是一个给人翻的目录。
        stickers: stickerLib?.snapshot?.() ?? { enabled: cfg.stickers?.enabled !== false },
        // 睡意闸：`sleeping` 是当前还在睡的 chat 与剩余时长。
        sleep: {
          enabled: cfg.sleep?.enabled !== false,
          autoByMood: cfg.sleep?.autoByMood !== false,
          entered: stats.sleepEntered ?? 0,
          blocked: stats.sleepBlocked ?? 0,
          woke: stats.sleepWoke ?? 0,
          resolveError: stats.sleepResolveError ?? null,
          lastBlocked: stats.lastSleepBlocked ?? null,
          lastEntered: stats.lastSleepEntered ?? null,
          sleeping: sleep?.snapshot?.() ?? {},
        },
        lastError: stats.lastError,
      });
      store.saveDebounced();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
  };

  void store
    .load()
    .then(() => {
      // 这里**不再** restore：上面 `loadSync()` 已经同步读过一次盘并灌过了，
      // 而 `loadFrom` 是内存优先的，异步这次必然整条键被跳过，调了也只是重复。
      persist();
    })
    .catch(() => undefined);

  // ── 宿主钩子：每步模型调用前注入规则 + 状态 ───────────────────────────────
  //
  // 只有 `onebot-*` 会话会命中（模块内部判定），别的会话原样放行。
  //
  // `onPreStep` 是给**别的插件**旁听用的（见 lib/api.js）：它们拿得到本轮全部
  // messages，但改不了决策。刻意不把这些转成各自的 `ctx.on` 注册 —— 每多一个
  // 宿主监听器就多一段调用链，出错时更难查是谁挂的；这里的 Set 跟本插件的生命
  // 周期绑在一起（插件卸载 = 整个实例丢掉）。
  const preStepListeners = new Set();
  const onPreStep = (fn) => {
    if (typeof fn !== 'function') return () => {};
    preStepListeners.add(fn);
    return () => preStepListeners.delete(fn);
  };
  const broadcastPreStep = (payload) => {
    if (preStepListeners.size === 0) return;
    for (const fn of [...preStepListeners]) {
      try {
        fn(payload);
      } catch (error) {
        // 旁听者出错绝不能连累对话。
        stats.lastError = String(error?.message ?? error);
      }
    }
  };

  try {
    ctx.on('agent/pre-step', (payload, next) => {
      // 旁听者先跑：它们不该看到「本插件注入之后」的 messages，那会让「这段是
      // 谁加的」变得不可分辨。真要看注入结果，等下一轮。
      broadcastPreStep(payload);
      return prompt.preStep(payload, next);
    });
  } catch (error) {
    log('warn', `[${name}] agent/pre-step 注册失败: ${error?.message ?? error}`);
  }

  // ── 群聊硬隔离：每步记住「本轮是谁在说话」，工具执行前据此拒绝 ──────────────
  //
  // 观察器**不接管决策**（`return next()`），只旁听本轮 messages；真正的拒绝在
  // guard 里。分成两处是因为职责不同：pre-step 有 messages（能认出发送者），
  // guard 有 execution（能认出要调哪个工具），两者互补。
  //
  // guard 用 `ctx.tools.guard()` 而不是 `tools/pre-execute` 监听：宿主文档
  // 明确「A denial that must hold regardless of order is a ctx.tools.guard()」
  // —— waterfall 的拒绝依赖注册顺序，guard 是顺序无关的单调判定。
  try {
    ctx.on('agent/pre-step', (payload, next) => {
      isolation.observe(payload);
      // GUI 会话里真人说的话也算进同一个 chat 的账（2026-10-20）：不然「在网页
      // 里聊了一整天」对亲密度毫无影响。只在配了 persona.guiChatId 时才动。
      try {
        const sid = sessionIdOf(payload?.agent);
        if (sid !== null) persona.noteGuiStep(sid, payload?.messages);
      } catch {
        /* 记账失败不该阻断对话 */
      }
      return next();
    });
  } catch (error) {
    log('warn', `[${name}] isolation pre-step 注册失败: ${error?.message ?? error}`);
  }

  /** 注册工具守卫（tools 服务就绪后调用）。 */
  const installIsolationGuard = (service, serviceCtx) => {
    try {
      if (typeof service.guard !== 'function') {
        log('warn', `[${name}] tools 服务没有 guard()，群聊隔离未生效`);
        return;
      }
      serviceCtx.effect(
        () => service.guard((execution) => isolation.guard(execution)),
        `${name}: isolation-guard`,
      );
      stats.isolationGuardInstalled = true;
      log('info', `[${name}] 群聊硬隔离已挂载（非管理员回合禁用工具）`);
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
      log('warn', `[${name}] isolation guard 注册失败: ${stats.lastError}`);
    }
  };

  // ── qq_say / qq_send_face 工具 ────────────────────────────────────────────
  //
  // 注册只需一个纯 JSON 对象（name / description / parameters /
  // output{schema,render} / execute），**不 import `@deepseek-ai/dsh-tools`**
  // —— 那个包在 profile 侧解析不到（实测 ERR_MODULE_NOT_FOUND）。
  //
  // 2026-10-13：这里踩过两个坑，都记下来。
  //   ① 原写法 `ctx.inject(['tools'], (toolCtx) => …)` 的回调**从未执行过**
  //      （`stats.tools` 恒为 `[]`），工具根本没上线 —— 光看插件状态一切正常。
  //   ② 改成直接 `ctx.tools` 后抛 `cannot get property "tools" without inject`
  //      —— Cordis 用 `prop in fiber.inject` 判定，而热重载重建时
  //      `dsh-hot-reloader` 传的第三参数 `() => []` 会盖掉模块级 inject，
  //      光写 `export const inject = ['tools']` 也不够。
  // 2026-10-16 重写：原写法是 `const tools = ctx.get('tools')`，拿不到就只记一条
  // `stats.toolErrors` 然后放弃注册。实测**重启后首次挂载**时这个取法拿不到服务
  // （`tools` 节点在 cordis.yml 里声明得早得多，fiber 就绪时机却不同），于是
  // qq_say / qq_send_face 双双失踪，而插件状态一切正常 —— 只在「模型调用报
  // unknown tool」时才暴露。手动 reload 一次 `dsh-onebot-companion` 即恢复
  // （走 `pluginShape` 带上了 fiber.inject），说明 `ctx.inject(['tools'], cb)`
  // 那条路才可靠。
  //
  // 现在改成「延迟注册代理」：不管服务当下在不在，`tools.register(spec)` 都先
  // 入队；服务可用时（当场拿到，或 inject 回调送达）再 flush 成真正的注册。
  //   ① 重启首次挂载 → 走 inject 补注册；
  //   ② 热重载（inject 被 `() => []` 盖掉）→ 当场 `ctx.get` 拿到，立即注册。
  // 两条路都不会漏。注意下面的 `tools` 因此**恒为真**，`if (tools) {` 只是形式。
  const pendingToolRegistrations = [];
  let toolService = null;
  let toolServiceCtx = null;
  const flushToolRegistrations = () => {
    if (toolService === null) return;
    for (const item of pendingToolRegistrations.splice(0)) {
      try {
        toolServiceCtx.effect(() => toolService.register(item.spec), `${name}: ${item.name}`);
        noteToolRegistered(item.name);
      } catch (error) {
        stats.toolErrors ??= [];
        stats.toolErrors.push(`${item.name}: ${error?.message ?? error}`);
        log('warn', `[${name}] ${item.name} 注册失败: ${error?.message ?? error}`);
      }
    }
  };
  const tools = {
    register(spec) {
      pendingToolRegistrations.push({ name: spec?.name ?? '?', spec });
      flushToolRegistrations();
    },
  };
  const bindToolService = (service, serviceCtx) => {
    if (toolService !== null || !service || typeof service.register !== 'function') return;
    toolService = service;
    toolServiceCtx = serviceCtx ?? ctx;
    flushToolRegistrations();
    // 隔离守卫搭这趟车：tools 服务什么时候就绪，它就什么时候挂上。
    // 放在 flush 之后 —— 两个都只依赖 service，顺序无所谓，但先注册工具能让
    // 「未知工具被拒」这类问题先暴露，别和隔离的拒绝混在一起排查。
    installIsolationGuard(service, toolServiceCtx);
  };
  {
    const current = ctx.get('tools');
    if (current && typeof current.register === 'function') {
      bindToolService(current, ctx);
    } else {
      try {
        ctx.inject(['tools'], (toolCtx) => bindToolService(toolCtx?.tools, toolCtx));
      } catch (error) {
        stats.toolErrors ??= [];
        stats.toolErrors.push(`tools 服务注入失败：${error?.message ?? error}`);
        log('warn', `[${name}] tools 服务注入失败: ${error?.message ?? error}`);
      }
    }
  }

  try {
    tools.register({
      name: 'qq_say',
      // 注意：走的是上面那个「延迟注册代理」，它会在服务就绪时替我们调
      // `toolsService.register(spec)` 并挂上 `ctx.effect`，所以这里**不再**
      // 自己包 `ctx.effect`（否则外层 effect 拿到的是代理的返回值 undefined）。
      description:
              '用语音说一句话（自己合成语音发出去，不是转发别人的录音）。适合偶尔撒娇、问候、卖萌，或者一句话太长、用说的更自然的时候。音色固定、内容是口语短句，不要每条都发，也不要念长篇内容。**text 要写成嘴上真的会说出来的话**：带语气助词（吧/嘛/呀/呢/啦）、用「……」制造停顿、书面词换成口语词，别把打字稿原样念出来（书面腔听起来就是播报）。**一次只说一件事**：语音没法像文字那样被切开，你说多长对方就听多长——25 字上下最像人说话，超过 35 字就是念稿了。想说三件事就分三次调用，别塞进一条里。',
            // 注意：这是**直接** `tools.register`，不经 `defineTool()` 包装，
            // 所以要自己写成完整 JSON Schema。`defineTool()` 才吃「扁平参数映射」
            // 那种简写；直接 register 时扁平写法会被原样透传给上游，触发
            // `invalid_function_parameters` / code 11129
            // （「工具定义不合规，请新建任务重试」）—— 2026-10-14 实测踩坑。
            parameters: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: '要说的话（口语短句，一件事，25 字上下最好，别超过 35 字；会去掉 Markdown 标记）',
                },
                chat_id: {
                  type: 'string',
                  description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
                },
              },
              required: ['text'],
            },
            output: {
              // 注意：`{ type: 'json' }` 是 `defineTool()` 的私有简写，只有经它
              // 包装才合法；直接 `tools.register` 会被宿主拒掉
              // （`unsupported JSON schema: schema.type must be one of …`）。
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    value && value.ok === true
                      ? `已发语音（${value.bytes} bytes，音色 ${value.voice}）：「${value.text}」`
                      : `发语音失败：${value?.error ?? '未知原因'}`,
                },
              ],
            },
            isConcurrencySafe: () => false,
            execute: async (args, exec) => {
              const text = String(args?.text ?? '').trim();
              if (text === '') return { ok: false, error: 'text 不能为空' };
              // 目标会话：显式 chat_id 优先；否则从调用方会话反推（persona 的
              // chatIdOfSession 是同一套规则）。
              let chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
              if (chatId === '') {
                const sid = exec?.agent?.session?.id;
                chatId = chatIdOfSession(sid) ?? '';
              }
              try {
                const r = await voice.say(text, chatId);
                persist();
                return r;
              } catch (error) {
                stats.lastError = String(error?.message ?? error);
                log('warn', `[${name}] qq_say 失败: ${stats.lastError}`);
                return { ok: false, error: stats.lastError };
              }
            },
          });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_say: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_say 注册失败: ${error?.message ?? error}`);
  }

  // ── qq_send_face 工具：发 QQ 原生表情 ─────────────────────────────────────
  //
  // 2026-10-13 实测暴露的缺口：规则④（rules.js 的 R_FACE）要求「表情要善用：
  // qq_send_face 传表情名……」，但 `dsh-onebot-qq` 从来没注册过这个工具 ——
  // 模型照着规则调用，拿到 `Error: unknown tool "qq_send_face"`，白烧一个 step
  // （会话 seq2169/2170 实证）。这里把工具补上，让规则④不再是空头支票。
  //
  // 不用 `set_msg_emoji_like`：那是「给某条消息贴表情回应」的点赞语义，要先有
  // message_id，和「发表情」不是一回事。直接走 `bridge.sendSegments` 发
  // `{type:'face', data:{id}}` 段（OneBot 11 标准段，qq_send_image/voice 同路）。
  try {
    tools.register({
      name: 'qq_send_face',
      // 同 qq_say：交给上面的延迟注册代理，不再自己包 ctx.effect。
      description:
        `发 QQ 原生表情（小黄脸等，共 ${FACE_COUNT} 个名字可选），不适合用文字表达情绪时用。一次最多 3 个，会拼在同一条消息里发出。也可以用数字 id 直接指定。`,
      // 同 qq_say：直接 register，必须自带完整 JSON Schema（见上）。
      parameters: {
              type: 'object',
              properties: {
                faces: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '表情名列表（如 ["笑哭"]、["委屈","害羞"]）或数字 id（如 ["182"]），最多 3 个',
                },
                chat_id: {
                  type: 'string',
                  description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
                },
              },
              required: ['faces'],
            },
            output: {
              // 同上：不能用 `defineTool()` 的 `{type:'json'}` 简写。
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    value && value.ok === true
                      ? `已发表情：${(value.faces ?? []).map((f) => f.name).join('、')}`
                      : `发表情失败：${value?.error ?? '未知原因'}`,
                },
              ],
            },
            isConcurrencySafe: () => false,
            execute: async (args, exec) => {
              const raw = Array.isArray(args?.faces) ? args.faces : [];
              if (raw.length === 0) return { ok: false, error: 'faces 不能为空' };
              if (raw.length > 3) return { ok: false, error: '一次最多 3 个表情' };

              // 名字 → id；查不到就带上候选提示，让模型下一轮自己改对
              const resolved = [];
              for (const item of raw) {
                const r = resolveFaceId(item);
                if (r.ok !== true) {
                  return { ok: false, error: `${r.error}${suggestFaces(item)}` };
                }
                resolved.push(r);
              }

              let chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
              if (chatId === '') {
                const sid = exec?.agent?.session?.id;
                chatId = chatIdOfSession(sid) ?? '';
              }

              const bridge = persona?.state?.lastReceiver;
              if (!bridge || typeof bridge.sendSegments !== 'function') {
                return { ok: false, error: 'QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试' };
              }
              if (chatId === '') return { ok: false, error: '无法确定目标会话：请显式传 chat_id' };

              try {
                const messageId = await bridge.sendSegments(
                  chatId,
                  resolved.map((r) => ({ type: 'face', data: { id: r.id } })),
                );
                stats.faces ??= { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null };
                stats.faces.sent += 1;
                stats.faces.lastSentAt = Date.now();
                stats.faces.lastChatId = chatId;
                stats.faces.lastFaces = resolved.map((r) => `${r.name}=${r.id}`);
                persist();
                return {
                  ok: true,
                  messageId: messageId ?? null,
                  chatId,
                  faces: resolved.map((r) => ({ name: r.name, id: r.id, known: r.known })),
                };
              } catch (error) {
                stats.lastError = String(error?.message ?? error);
                log('warn', `[${name}] qq_send_face 失败: ${stats.lastError}`);
                return { ok: false, error: stats.lastError };
              }
            },
          });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_send_face: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_send_face 注册失败: ${error?.message ?? error}`);
  }

  // ── 「社交的手」：戳一戳 / 贴表情 / 名片赞 / 申请清单 / 审批 ────────────────
  //
  // 用户 2026-10-19 原话：「没办法给她加个手吗」。这几个工具都是**低风险**的社交
  // 动作，没有一个是不可逆的：
  //
  //   - `qq_poke` / `qq_react` / `qq_like`：戳一下、贴个表情、点个赞。吵不到人。
  //   - `qq_requests`：只读，列一下谁想加好友 / 谁邀请进群。
  //   - `qq_approve`：**唯一有后果的那个**。它不会直接生效，而是生成审批单
  //     发给示例用户，等他回 `/同意 编号`。详见 modules/hands.js。
  //
  // 注意这里的**参数全是完整 JSON Schema**：走的是「延迟注册代理」→ 宿主
  // `tools.register()`，它只校验 `output.schema` 和 `name`，`parameters` 一字不查。
  // 写成扁平映射会被原样透传上游，导致此后每一次请求都 400（2026-10-14 事故）。
  const HANDS_TOOLS = [
    {
      name: 'qq_poke',
      description:
        '戳一戳对方（QQ 的「戳一戳」，对方会看到一个小动画）。适合叫人、提醒、轻轻打断一下，'
        + '或者纯粹逗一下。**别连着戳**，一次对话里最多一两下，戳多了很烦。群里戳要同时给 group_id。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '要戳的 QQ 号' },
          group_id: { type: 'string', description: '群号；在群里戳人时必填，私聊不填' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'qq_react',
      description:
        '给某条消息贴一个「表情回应」（就是长按消息能加的那个小表情）。适合不想专门说一句话、'
        + '只想表示「看到了」「笑死」「赞同」的时候。省略 message_id 就是给当前会话最近一条消息贴。',
      parameters: {
        type: 'object',
        properties: {
          emoji_id: {
            type: 'string',
            description: '表情：可以用名字（赞/笑/笑哭/666/鼓掌/比心/哭/委屈/惊讶/疑问），也可以直接给数字 id',
          },
          message_id: { type: 'string', description: '目标消息 id；省略则用当前会话最近一条' },
          chat_id: { type: 'string', description: '会话，格式 private:<QQ号> 或 group:<群号>；省略时用当前会话' },
        },
        required: [],
      },
    },
    {
      name: 'qq_like',
      description: '给某人的 QQ 名片点赞（就是资料卡那个「赞」）。一天次数有限，别一次给太多。',
      parameters: {
        type: 'object',
        properties: {
          user_id: { type: 'string', description: '给谁点赞（QQ 号）' },
          times: { type: 'integer', description: '点几个，1-10，默认 1' },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'qq_requests',
      description:
        '查看**待处理**的好友申请和入群邀请（只读，不会同意任何东西）。'
        + '有人问「你怎么还没加我」或者你觉得该清理一下的时候用。返回里有 flag，同意时要原样带上。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'qq_profile',
      description:
        '查看/修改**你自己**的 QQ 昵称和个性签名。不传参数就是只读，返回当前昵称与签名。'
        + '改自己的资料**不需要审批**（示例用户说的：改名、改签名这些不用问他），'
        + '但别动不动就改 —— 名字是你在他那儿的身份，改之前想清楚为什么。',
      parameters: {
        type: 'object',
        properties: {
          nickname: { type: 'string', description: '新昵称（最多 24 字）；留空表示不改名' },
          signature: { type: 'string', description: '新个性签名（最多 80 字）；留空表示不改签名' },
        },
        required: [],
      },
    },
    {
      name: 'qq_intimate',
      description:
        '查看（或要求处理）QQ 的亲密关系：情侣 / 闺蜜 / 基友 / 死党。'
        + '不传任何参数就是**只读**：返回待处理的邀请和已绑定的关系。'
        + '要接住某个邀请就传 action="accept" + user_id；要主动发起就传 action="launch"；'
        + '要解除就传 action="release"。**这三个都是写操作，同样要过审批闸** —— '
        + '调用后只会生成审批单发给示例用户，等他回「/同意 编号」才真正执行。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'accept', 'launch', 'release'],
            description: 'list=只看（默认），accept=接受邀请，launch=主动发起，release=解除',
          },
          user_id: { type: 'string', description: '对方 QQ 号（action 不是 list 时必填）' },
          intimate_type: {
            type: 'string',
            description: 'lover/情侣（默认）、ladybro/闺蜜、buddy/基友、bestfriend/死党',
          },
          nickname: { type: 'string', description: '对方昵称（可选，写进审批单更好认）' },
        },
        required: [],
      },
    },
    {
      name: 'qq_approve',
      description:
        '**同意（或拒绝）一条好友申请 / 入群邀请 / 亲密关系。这个动作不会立刻生效** —— 它会生成一张审批单'
        + '发给示例用户（你的管理员），等他回「/同意 编号」才真正执行。所以调用后**不要**跟对方说'
        + '「已经同意了」，只说「我去问一下他」之类。'
        + '例外：如果是示例用户本人邀请你进群，会直接通过（这一条不需要审批）。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['friend', 'group', 'intimate'], description: 'friend=好友申请，group=入群/邀请，intimate=亲密关系' },
          flag: { type: 'string', description: '从 qq_requests 拿到的 flag，原样带过来；kind=intimate 时可省略，用 user_id 代替' },
          approve: { type: 'boolean', description: 'true=同意，false=拒绝，默认 true' },
          sub_type: { type: 'string', enum: ['invite', 'add'], description: '群请求细分：invite=有人邀请我进群，add=有人申请进我的群' },
          group_id: { type: 'string', description: '群号（群请求时给，用于审批消息里显示）' },
          group_name: { type: 'string', description: '群名（可选）' },
          user_id: { type: 'string', description: '对方 QQ 号（可选；kind=intimate 时必填）' },
          nickname: { type: 'string', description: '对方昵称（可选）' },
          intimate_type: { type: 'string', description: '亲密关系类型：lover/情侣、ladybro/闺蜜、buddy/基友、bestfriend/死党' },
          summary: { type: 'string', description: '可选：一句话说明这是谁、什么事，会写进审批消息' },
        },
        required: ['kind'],
      },
    },
  ];

  for (const spec of HANDS_TOOLS) {
    try {
      tools.register({
        ...spec,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => [
            {
              type: 'text',
              text: value?.ok === true
                ? (value.executed === true
                  ? `已执行：${value.kind ?? ''} ${value.flag ?? ''}`
                  : JSON.stringify(value))
                : `未完成：${value?.error ?? value?.hint ?? JSON.stringify(value)}`,
            },
          ],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          try {
            switch (spec.name) {
              case 'qq_poke':
                return await hands.poke(args);
              case 'qq_react': {
                // 省略 chat_id 时按当前会话反推（与 qq_say / qq_send_face 同一套规则）
                const payload = { ...args };
                if (typeof payload.chat_id !== 'string' || payload.chat_id.trim() === '') {
                  const sid = exec?.agent?.session?.id;
                  const derived = chatIdOfSession(sid);
                  if (derived !== null) payload.chat_id = derived;
                }
                return await hands.react(payload);
              }
              case 'qq_like':
                return await hands.like(args);
              case 'qq_requests': {
                const listed = await hands.listRequests();
                return {
                  ok: listed.errors.length === 0,
                  friends: listed.friends,
                  groups: listed.groups,
                  errors: listed.errors,
                };
              }
              case 'qq_profile': {
                const nick = typeof args?.nickname === 'string' ? args.nickname.trim() : '';
                const sign = typeof args?.signature === 'string' ? args.signature.trim() : '';
                if (nick === '' && sign === '') {
                  const me = await hands.readProfile();
                  return { ok: true, ...me, changed: [] };
                }
                const changed = [];
                if (nick !== '') {
                  await hands.setNickname({ nickname: nick });
                  changed.push('nickname');
                }
                if (sign !== '') {
                  await hands.setSignature({ text: sign });
                  changed.push('signature');
                }
                const after = await hands.readProfile().catch(() => null);
                return { ok: true, changed, profile: after };
              }
              case 'qq_intimate': {
                const action = typeof args?.action === 'string' ? args.action : 'list';
                if (action === 'list') {
                  const listed = await hands.listIntimate();
                  return { ok: listed.errors.length === 0, ...listed };
                }
                // 写操作：与 qq_approve 同一道闸，先生成审批单，等示例用户回 /同意
                return await hands.approve({
                  kind: 'intimate',
                  user_id: args?.user_id,
                  nickname: args?.nickname,
                  intimate_type: args?.intimate_type,
                  mode: action === 'launch' ? 'launch' : action === 'release' ? 'release' : 'accept',
                  approve: true,
                });
              }
              case 'qq_approve':
                return await hands.approve(args);
              default:
                return { ok: false, error: `未知工具 ${spec.name}` };
            }
          } catch (error) {
            stats.lastError = String(error?.message ?? error);
            log('warn', `[${name}] ${spec.name} 失败: ${stats.lastError}`);
            return { ok: false, error: stats.lastError };
          }
        },
      });
    } catch (error) {
      stats.toolErrors ??= [];
      stats.toolErrors.push(`${spec.name}: ${error?.message ?? error}`);
      log('warn', `[${name}] ${spec.name} 注册失败: ${error?.message ?? error}`);
    }
  }

  // ── 小本子与欠着的话（2026-10-19）────────────────────────────────────────
  //
  // 两个工具都刻意长得像「记事本」，不像「数据库」：一个 action 字段 + 一句话。
  // 模型对多字段 CRUD 很容易编参数，对「写 / 翻 / 划掉」这种动作反而稳。
  //
  // 与 `hands.js` 里那批 QQ 动作不同，它们**不需要审批**：写日记、记约定都是
  // 她自己的事，不对外产生任何可见动作。唯一的对外副作用是提示词变长。
  try {
    tools.register({
      name: 'qq_diary',
      description:
        '你自己的小本子。记下你**想记住**的事（不是聊天记录：只记你真的在意的、以后可能想起来的），'
        + '也可以翻回来看、或者把不再需要的划掉。'
        + 'level 分三档：normal=琐事（7 天后自己淡掉）、important=要紧（留 30 天）、'
        + 'critical=重要（定义关系的事、他的底线与重要日期，永久留着）。'
        + '**别每轮都写**，一天一两条就够；写的时候用你自己的口吻，不要写成「用户说……」这种报告腔。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['write', 'list', 'forget'],
            description: 'write=记一条（默认）、list=翻看、forget=划掉一条',
          },
          text: { type: 'string', description: 'write 时要记的内容（一句话，用你自己的口吻）' },
          level: {
            type: 'string',
            enum: ['normal', 'important', 'critical'],
            description: 'write 时的档位，默认 normal',
          },
          key: { type: 'string', description: 'forget 时的目标：条目的 id，或正文里的一小段' },
          limit: { type: 'integer', description: 'list 时最多看几条，默认 20' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: value?.ok === true
              ? (Array.isArray(value.entries)
                ? `小本子里还有 ${value.entries.length} 条：\n${value.entries
                  .map((e) => `- [${e.level}] ${e.text}`)
                  .join('\n')}`
                : `记下了（${value.entry?.level ?? 'normal'}）：${value.entry?.text ?? ''}`)
              : `没成：${value?.reason ?? value?.error ?? '未知原因'}`,
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'write';
          if (action === 'list') {
            const entries = await diary.list({
              limit: Number.isFinite(args?.limit) ? args.limit : 20,
              level: typeof args?.level === 'string' ? args.level : '',
            });
            return { ok: true, entries };
          }
          if (action === 'forget') {
            const hit = await diary.forget(args?.key);
            return hit;
          }
          return await diary.remember({
            text: args?.text,
            level: args?.level,
            chatId: typeof args?.chat_id === 'string' ? args.chat_id : '',
          });
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_diary 失败: ${stats.lastError}`);
          return { ok: false, error: stats.lastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_diary: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_diary 注册失败: ${error?.message ?? error}`);
  }

  try {
    tools.register({
      name: 'qq_promise',
      description:
        '记下你**答应过**别人的事（「我等会儿帮你看看」「明天提醒你」这类），到点了会提醒你自己。'
        + '兑现了就 done，说话不算话了或不必再提就 drop。'
        + '**只记真的说出口过的承诺**，别把普通的话记成约定。due 省略时默认 24 小时后。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'list', 'done', 'drop'],
            description: 'add=记一条、list=看还欠着什么、done=兑现了、drop=作废',
          },
          text: { type: 'string', description: 'add 时：你答应了什么（一句话）' },
          due_in_minutes: {
            type: 'integer',
            description: 'add 时：多少分钟后算到点（默认 1440，即一天）',
          },
          key: { type: 'string', description: 'done/drop 时的目标：条目的 id，或正文里的一小段' },
          status: {
            type: 'string',
            enum: ['open', 'done', 'dropped'],
            description: 'list 时按状态筛，默认只看 open',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: value?.ok === true
              ? (Array.isArray(value.entries)
                ? `还欠着 ${value.entries.length} 件：\n${value.entries
                  .map((e) => `- ${e.text}（${e.status}）`)
                  .join('\n')}`
                : `记下了：「${value.entry?.text ?? ''}」`)
              : `没成：${value?.reason ?? value?.error ?? '未知原因'}`,
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'add';
          if (action === 'list') {
            const entries = await promise.list({
              status: typeof args?.status === 'string' ? args.status : 'open',
              limit: 20,
            });
            return { ok: true, entries };
          }
          if (action === 'done') return await promise.done(args?.key);
          if (action === 'drop') return await promise.drop(args?.key);
          const minutes = Number.isFinite(args?.due_in_minutes) ? args.due_in_minutes : 1440;
          const dueAt = Date.now() + Math.max(1, Math.floor(minutes)) * 60 * 1000;
          return await promise.add({
            text: args?.text,
            dueAt,
            chatId: typeof args?.chat_id === 'string' ? args.chat_id : '',
          });
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_promise 失败: ${stats.lastError}`);
          return { ok: false, error: stats.lastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_promise: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_promise 注册失败: ${error?.message ?? error}`);
  }

  // ── 咽回去的话（2026-10-20）──────────────────────────────────────────────
  //
  // 只有「按住」这一个动作是核心，其余两个（说出口了 / 算了不说了）是收尾。
  // 刻意不提供「编辑」：话到嘴边的那一句就该是原样的，改来改去就不像人了。
  try {
    tools.register({
      name: 'qq_unsaid',
      description:
        '把「想说、但这会儿觉得不合适所以没说出口」的那句话按住，攒着。'
        + '以后到了合适的时候它会自己浮上来，你可以自然地说出来。'
        + '**这是你自己在心里存着的话，不是任务、不欠谁**：说不出口也没关系，'
        + '别为了清空它硬找话头，更别说「我有话一直没说」这种开场。'
        + '默认保质期 48 小时，提过几次还说不出口就自己淡掉。'
        + '真的说出口了用 said 结掉（别让它以后重复冒出来），不想说了用 drop 划掉。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['hold', 'list', 'said', 'drop'],
            description: 'hold=按住一句（默认）、list=看看心里存着什么、said=已经说出去了、drop=算了不说了',
          },
          text: { type: 'string', description: 'hold 时：那句没说出口的原话（用你自己的口吻，别改成书面语）' },
          why: { type: 'string', description: 'hold 时可选：当时为什么没说出口（一句话，比如「怕显得太黏」）' },
          ttl_hours: {
            type: 'integer',
            description: 'hold 时可选：这句留多久（小时），默认 48；太久的话会被上限卡到 720',
          },
          key: { type: 'string', description: 'said/drop 时的目标：条目的 id，或正文里的一小段' },
          status: {
            type: 'string',
            enum: ['pending', 'said', 'all'],
            description: 'list 时筛选，默认 pending（还没说出口的）',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => {
          // 按 action 分支渲染：said / drop 的返回值形状几乎一样（都是
          // `{ok, entry, total}`），不靠 action 分会把「划掉了」说成「记成说出口了」。
          const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'hold';
          return [
            {
              type: 'text',
              text: value?.ok === true
                ? (Array.isArray(value.entries)
                  ? (value.entries.length === 0
                    ? '心里这会儿没存着什么没说出口的话。'
                    : `心里存着 ${value.entries.length} 句没说出口的：\n${value.entries
                      .map((e) => `- 「${e.text}」${e.saidAt ? '（说过了）' : ''}`)
                      .join('\n')}`)
                  : action === 'drop'
                    ? `划掉了：「${value.entry?.text ?? ''}」，不用再惦记这句了。`
                    : action === 'said'
                      ? (value.already === true
                        ? '这句之前就记成说出口了，不用再结一次。'
                        : `记成说出口了：「${value.entry?.text ?? ''}」，它不会再浮上来。`)
                      : (value.duplicate === true
                        ? '这句刚按住过，还存着。'
                        : `按住了：「${value.entry?.text ?? ''}」（心里一共存着 ${value.total ?? 1} 句）`))
                : `没成：${value?.reason ?? value?.error ?? '未知原因'}`,
            },
          ];
        },
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'hold';
          if (action === 'list') {
            const entries = await unsaid.list({
              status: typeof args?.status === 'string' ? args.status : 'pending',
              limit: 20,
            });
            return { ok: true, entries };
          }
          if (action === 'said') return await unsaid.said(args?.key);
          if (action === 'drop') return await unsaid.drop(args?.key);
          return await unsaid.hold({
            text: args?.text,
            why: args?.why,
            ttlHours: Number.isFinite(args?.ttl_hours) ? args.ttl_hours : undefined,
            chatId: typeof args?.chat_id === 'string' ? args.chat_id : '',
          });
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_unsaid 失败: ${stats.lastError}`);
          return { ok: false, error: stats.lastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_unsaid: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_unsaid 注册失败: ${error?.message ?? error}`);
  }

  // 玩手机（2026-10-20）：她自己刷一刷外面的事。
  //
  // 刻意**不做成注入**、也没有定时器：她什么时候想刷、刷几屏、要不要跟人提，
  // 全由她自己决定。少一个"必须有产出"的机械动作，就少一次「为了用工具而用工具」。
  try {
    const sourceIds = Object.keys(PHONE_SOURCES);
    tools.register({
      name: 'qq_phone',
      description:
        '拿起手机刷一刷：B 站热门/排行榜/热搜、GitHub 新项目、Hacker News、豆瓣热门电影。'
        + '**不是任务，是消遣**——闲着没事、或者想找点新鲜的聊资时刷两下就行，'
        + '刷完也不非得跟谁提。每次刷都自动跳过最近看过的，所以连着刷会一直往下走。'
        + '只给标题和热度，想知道某条具体内容就拿链接去调 link_parse。',
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: sourceIds,
            description: '刷哪个：bili=B站热门（默认）、bili-rank=排行榜、hotword=热搜词、github=新项目、hn=Hacker News、douban=豆瓣热门电影',
          },
          limit: { type: 'integer', description: '刷几条，默认 8，最多 20' },
          fresh: { type: 'boolean', description: 'true = 不管看过没看过，从最顶上开始（想看回过头的就传它）' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: value?.ok === true
              ? (Array.isArray(value.items) && value.items.length > 0
                ? `刷了会儿「${value.label}」，看到这些：\n${value.items
                  .map((it, i) => `${i + 1}. ${it.title}${it.extra ? `（${it.extra}）` : ''}`)
                  .join('\n')}\n（想聊就自然提一句，不想聊就当没看见，别硬找话题。）`
                : `「${value.label}」这一屏都看过了，往下的还没刷出来——换个源或者待会儿再看。`)
              : `刷不动：${value?.reason ?? value?.error ?? '未知原因'}`,
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const result = await phone.scroll({
            source: typeof args?.source === 'string' ? args.source : undefined,
            limit: Number.isFinite(args?.limit) ? args.limit : undefined,
            fresh: args?.fresh === true,
          });
          // 刷成了才记「她在刷」——刷失败还标成在忙，她下一轮会拿这句当借口。
          // 只在成功时 set，且不拦截任何消息（见 modules/focus.js）。
          if (result?.ok === true) {
            try {
              focus?.set?.({ what: 'browse', detail: result.label });
            } catch {
              /* 记注意力失败不该影响刷手机的结果 */
            }
          }
          return result;
        } catch (error) {
          stats.phoneLastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_phone 失败: ${stats.phoneLastError}`);
          return { ok: false, error: stats.phoneLastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_phone: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_phone 注册失败: ${error?.message ?? error}`);
  }

  // 表情包图库（2026-10-21）：别人发的商城贴纸已经由 `emoji` 顺手入库（这里只
  // 管读取与打标签）。刻意不做注入、不做定时器 —— 图是路径不是文字，塞进每轮
  // 提示词只会把她的话挤掉。让她**想发的时候搜一下**才对。
  try {
    tools.register({
      name: 'qq_sticker',
      description:
        '你自己的表情包图库。别人在聊天里发的商城贴纸会被自动收进来（按内容去重），'
        + '想发一张图的时候来这里找。'
        + 'list=按关键词翻（只在你自己写的备注里搜，不是搜图），'
        + 'note=给某张图写一句备注（比如「得意的猫」「无语脸」），以后就能按它搜到，'
        + 'use=标记这张发过了（会记住你常发哪几张）。'
        + '拿到 path 之后用 qq_send_image 发出去。'
        + '**别为了用而用**：日常聊天用文字和小黄脸就够了，图是偶尔才拿出来的东西。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'note', 'use', 'recycle'],
            description: 'list=翻图库（默认）、note=写备注、use=记一次使用、recycle=不要了',
          },
          text: { type: 'string', description: 'list 时的关键词（留空 = 按常用程度列几张）' },
          id: { type: 'string', description: 'note / use / recycle 时指定哪一张（list 会给出 id）' },
          note: { type: 'string', description: 'note 时的备注（一句话，20 字以内最好搜）' },
          limit: { type: 'integer', description: 'list 最多看几张，默认 12' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: (() => {
              if (value?.ok !== true) return `没成：${value?.reason ?? value?.error ?? '未知原因'}`;
              if (Array.isArray(value.entries)) {
                if (value.entries.length === 0) {
                  return `图库里${value.total === 0 ? '还什么都没有——等别人发贴纸就会自己进来' : '没有符合条件的'}。`;
                }
                return `图库里找到 ${value.entries.length} 张：\n${value.entries
                  .map((e) => `- ${e.id}${e.note ? `「${e.note}」` : ''} → ${e.path}`)
                  .join('\n')}\n（发哪张就 qq_send_image 发它那条 path，发完记得 use 一下。）`;
              }
              if (value.entry !== undefined) {
                return `记下了：${value.entry.id}${value.entry.note ? `「${value.entry.note}」` : ''}`;
              }
              return '好了。';
            })(),
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const action = typeof args?.action === 'string' && args.action !== '' ? args.action : 'list';
          if (action === 'note') {
            const entry = await stickerLib.update(args?.id, {
              note: typeof args?.note === 'string' ? args.note : '',
            });
            return entry === null ? { ok: false, reason: '图库里没有这个 id' } : { ok: true, entry };
          }
          if (action === 'use') {
            const entry = await stickerLib.update(args?.id, { markUsed: true, now: Date.now() });
            return entry === null ? { ok: false, reason: '图库里没有这个 id' } : { ok: true, entry };
          }
          if (action === 'recycle') {
            const entry = await stickerLib.update(args?.id, { status: 'recycled' });
            return entry === null ? { ok: false, reason: '图库里没有这个 id' } : { ok: true, entry };
          }
          const snap = stickerLib.snapshot();
          const entries = await stickerLib.list({
            text: typeof args?.text === 'string' ? args.text : '',
            limit: Number.isFinite(args?.limit) ? args.limit : 12,
            now: Date.now(),
          });
          return { ok: true, entries, total: snap.active };
        } catch (error) {
          stats.stickerLastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_sticker 失败: ${stats.stickerLastError}`);
          return { ok: false, error: stats.stickerLastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_sticker: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_sticker 注册失败: ${error?.message ?? error}`);
  }

  // ── qq_draw：自己画一张图（2026-10-22）──────────────────────────────────
  //
  // 接本地 ComfyUI（SD1.5，RTX 4060 上 512×512/20 步约 8 秒）。**只画不发**：
  // 返回本地路径，发不发她自己用 qq_send_image 说一句。这样群里被 isolation
  // 限成只能发声的那一轮，不会因为这条工具绕过去往外发图。
  try {
    tools.register({
      name: 'qq_draw',
      description:
        '自己画一张图（本地 ComfyUI + SD1.5）。画完给你本地绝对路径，想发出去就再调 qq_send_image。'
        + '**英文提示词效果比中文好很多**：SD1.5 的中文理解很差，写「白色短发 猫耳 红紫异色瞳」出来基本是废图；'
        + '换成「white short hair, cat ears, heterochromia red purple eyes, gentle smile, anime style」就正常。'
        + '默认 512×512，20 步，8 秒左右；开 1024 会慢三四倍且容易画出重影。'
        + '**别每句话都配图**——图是偶尔甩一张的东西，跟你说话本身一样，多了就腻。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '画面描述（英文，逗号分隔的关键词最稳）',
          },
          negative: {
            type: 'string',
            description: '不想要的东西（可选，留空用默认的「糊、文字、水印、多肢」那组）',
          },
          width: { type: 'integer', description: '宽，256–1024，会对齐到 8 的倍数，默认 512' },
          height: { type: 'integer', description: '高，256–1024，会对齐到 8 的倍数，默认 512' },
          steps: { type: 'integer', description: '步数，1–60，默认 20；超过 30 收益很小' },
          cfg: { type: 'number', description: '提示词服从度，1–20，默认 7' },
          seed: { type: 'integer', description: '随机种子；不给或给 -1 就随机' },
        },
        required: ['prompt'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: (() => {
              if (value?.ok !== true) return `没画成：${value?.reason ?? value?.error ?? '未知原因'}`;
              return `画好了（${value.width}×${value.height}，${Math.round((value.ms ?? 0) / 1000)} 秒，seed ${value.seed}）：\n${value.path}\n（想发就 qq_send_image 发这个路径。）`;
            })(),
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const r = await comfy.generate(args);
          if (r.ok !== true) {
            stats.comfyLastError = String(r.reason ?? '');
            log('warn', `[${name}] qq_draw 失败: ${stats.comfyLastError}`);
          }
          return r;
        } catch (error) {
          stats.comfyLastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_draw 失败: ${stats.comfyLastError}`);
          return { ok: false, reason: stats.comfyLastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_draw: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_draw 注册失败: ${error?.message ?? error}`);
  }

  // ── qq_face：画一张应景的表情（2026-10-22）────────────────────────────────
  //
  // 与 `qq_draw` 的分工：那条什么都能画，这条只画**她自己**，而且限定在八个
  // 情绪预设里。当时的提问是：能画了，那画应景的表情怎么样——要的不是
  // 「能画表情」，是「她此刻真有一个对应情绪的脸」。
  //
  // 预设里固化了三轮试错的结论（见 modules/comfy.js 的 FACE_PRESETS 注释）：
  // 头肩构图 + 纯白底 + 负面掉全身景。手写这些每次都要重来一遍。
  try {
    tools.register({
      name: 'qq_face',
      description:
        '画一张自己的表情（白底头肩像，能直接当表情包用）。'
        + `preset 可选：${Object.keys(FACE_PRESETS).join(' / ')}。`
        + '这条画的一定是「你」——白毛、猫耳、红蓝异瞳已经写死在预设里，不用再描述长相。'
        + '画完给你本地路径，想发出去再调 qq_send_image。'
        + '**别为了发表情而发表情**：文字和小黄脸能表达的就用它们，图是偶尔才甩一张的东西。',
      parameters: {
        type: 'object',
        properties: {
          preset: {
            type: 'string',
            enum: Object.keys(FACE_PRESETS),
            description: '哪个表情',
          },
          extra: {
            type: 'string',
            description: '追加的自由描述（可选，比如「抱着咖啡杯」「背景有樱花」）',
          },
          seed: { type: 'integer', description: '随机种子；不给就随机' },
        },
        required: ['preset'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: (() => {
              if (value?.ok !== true) {
                const opts = Array.isArray(value?.presets) ? `（可选：${value.presets.join(' / ')}）` : '';
                return `没画成：${value?.reason ?? value?.error ?? '未知原因'}${opts}`;
              }
              return `画好了（${value.preset}，${Math.round((value.ms ?? 0) / 1000)} 秒）：\n${value.path}\n（想发就 qq_send_image 发这个路径。）`;
            })(),
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args) => {
        try {
          const r = await comfy.face(args);
          if (r.ok !== true) {
            stats.comfyLastError = String(r.reason ?? '');
            log('warn', `[${name}] qq_face 失败: ${stats.comfyLastError}`);
          }
          return r;
        } catch (error) {
          stats.comfyLastError = String(error?.message ?? error);
          log('warn', `[${name}] qq_face 失败: ${stats.comfyLastError}`);
          return { ok: false, reason: stats.comfyLastError };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_face: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_face 注册失败: ${error?.message ?? error}`);
  }

  // ── qq_recall：发错了，撤回来（2026-10-23）────────────────────────────────
  //
  // 用户提过很久的「删除重打」。真人打出去、看一眼、觉得不对就撤回重说 ——
  // 我们此前只能一路往前，说错就道歉。这条补上「收回」这个动作。
  //
  // 安全边界（写在这里比写在模块里更醒目）：**只撤自己发出去的**。
  // message_id 不接受外部传入，只能从 recall 自己记的表里取 —— 否则一条
  // 注入就能让她去删别人的消息。
  try {
    tools.register({
      name: 'qq_recall',
      description:
        '撤回自己刚发出去的消息（「发错了，删了重说」）。'
        + '只能撤**你自己**在这个会话里发出去的话，撤不了别人的。'
        + '默认只撤最近 1 条，最多 5 条；超过 5 分钟的不给撤了 —— 那时候不叫打错字，叫说错话，得用嘴修。'
        + '撤回之后对方那边会看到「消息已撤回」，所以**别拿它当掩饰**：撤了就该补一句真的，而不是假装没发生过。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: '撤最近几条，1–5，默认 1' },
          chat_id: { type: 'string', description: '目标会话；省略时用当前会话' },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          {
            type: 'text',
            text: (() => {
              if (value?.ok !== true) return `没撤成：${value?.reason ?? value?.error ?? '未知原因'}`;
              const n = Array.isArray(value.recalled) ? value.recalled.length : 0;
              return `撤回了 ${n} 条（${(value.recalled ?? []).join(', ')}）。想说什么重新说一遍吧。`;
            })(),
          },
        ],
      },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        try {
          let chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
          if (chatId === '') chatId = chatIdOfSession(exec?.agent?.session?.id) ?? '';
          const count = Number.isFinite(args?.count) ? args.count : 1;
          const r = await recall.recallLast(chatId, count);
          if (r.ok !== true) log('info', `[${name}] qq_recall 未撤回：${r.reason ?? ''}`);
          return r;
        } catch (error) {
          const msg = String(error?.message ?? error);
          log('warn', `[${name}] qq_recall 失败: ${msg}`);
          return { ok: false, reason: msg };
        }
      },
    });
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_recall: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_recall 注册失败: ${error?.message ?? error}`);
  }

  // ── 周期补挂 ─────────────────────────────────────────────────────────────
  let disposed = false;
  let timer = null;
  /**
   * 一轮补挂。
   *
   * ## 为什么是**串行**而不是 `Promise.allSettled`
   *
   * 原实现并发调用各模块的 `scan()`，于是谁先挂上原型取决于各自 `await` 的
   * 恢复顺序 —— 在多个模块共享同一个挂载点时就**不再有保证**。而共享确实存在：
   * stamp 与 rhythm 都挂 `ChatBridge.prototype.dispatchFollowup`，stamp 与
   * persona 都挂 `handleInbound`。`core/patch.js` 的语义是「最后挂的在链的最
   * 外层」，所以挂载顺序**就是优先级**：
   *
   *   - stamp 必须在 rhythm **之后**挂 —— 于是每条消息先各自经 stamp 注入自己
   *     那一刻的 `time=`/`gap=`，再由 rhythm 把已注入的几条合并成一批。反过来
   *     只会在合并后拿到一整批文本，`injectStamp` 只改第一个开标签，整批就只剩
   *     第一个块有时间。
   *
   * 串行让这个顺序成为**确定的契约**（读这个数组顺序即可），而不是并发调度的
   * 巧合。代价是每轮多花几十毫秒（各 `scan` 主要是已缓存的 `import`），而这是
   * 每 3 秒才跑一次的补挂。
   *
   * 并发还有第二个隐患：多个 `scan` 同时改共享的 `stats`（`lost` 推入/清除、
   * `patched` 数组），交错写入会互相踩。串行一并消掉。
   */
  const scanAll = async () => {
    // 工具服务兜底重试：`ctx.get('tools')` 与 `ctx.inject(['tools'], cb)` 都
    // 可能在挂载的那一刻还没就绪（重启后首次挂载实测如此，导致 qq_say /
    // qq_send_face 双双失踪）。这里挂在已有的 3 秒补挂循环里一起重试，服务
    // 一出现就补注册 —— 不依赖任何时序假设。
    if (toolService === null) {
      const late = ctx.get?.('tools');
      if (late && typeof late.register === 'function') bindToolService(late, ctx);
    }

    const modules = [guard, lastword, mention, emoji, linkcard, hands, adopt, rhythm, stamp, persona, voice, sleep, recall];
    let patched = 0;
    for (const mod of modules) {
      try {
        const value = await mod.scan(ctx);
        if (value?.ok === true) patched += value.patched ?? 0;
      } catch {
        // 单个模块抱死不该拖垮其余模块的补挂。
      }
    }
    return patched;
  };

  ctx.effect(() => {
    void scanAll()
      .then(() => persist())
      .catch(() => undefined);

    const period = Math.max(500, Number(cfg.pollMs) || DEFAULTS.pollMs);
    timer = setInterval(() => {
      if (disposed) return;
      void scanAll()
        .then(() => persist())
        .catch(() => undefined);
    }, period);
    try {
      timer.unref?.();
    } catch {
      /* ignore */
    }

    // 主动发言调度器：无 cron，只有随机间隔（见 modules/proactive.js）。
    try {
      persona.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }

    // 小本子与约定：开机就加载并做一次过期裁剪，别等第一次注入时才读文件
    // （那时正处在 pre-step 里，同步链路里做磁盘 IO 不合适）。
    try {
      diary.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    try {
      promise.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 咽回去的话：同样开机加载 + 过期裁剪。它比 diary/promise 更需要「开机就裁」，
    // 因为过期率最高（48 小时），攒一夜可能就有一半该走了。
    try {
      unsaid.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    try {
      quota.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 玩手机：开机只把「看过的」那张表读进内存，不发任何请求 ——
    // 她不刷的时候插件一个网络包都不该往外发。
    try {
      phone.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 注意力：开机只把上次「在忙什么」读回来（过期就丢），不触发任何动作。
    try {
      focus.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 生物钟：开机只把 24 个小时桶读回来，不发任何请求、不启定时器 ——
    // 记账在每条私聊入站上，曲线在注入时现算。
    try {
      circadian.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 生活节奏：开机只把每个会话的对话密度读回来（过期就在第一次用到时
    // 按半衰期折掉），不启定时器。
    try {
      tempo.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
    // 未完成意图：开机读回来并裁一次过期（10 分钟前的半句话已经不算
    // 「被打断」了，那是「一直惦记着」，该走 unsaid 那条路）。
    try {
      interruptRef.current?.start?.();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        persona.stop();
      } catch {
        /* ignore */
      }
      try {
        rhythm.stop();
      } catch {
        /* ignore */
      }
      void store.flush().catch(() => undefined);
    };
  });

  // ── HTTP 观测面（loopback only）──────────────────────────────────────────
  //
  // 路由表本身在 lib/http.js：原先这一块占 apply() 里的 450 行，读装配逻辑时
  // 得先跨过去。依赖显式传进去，那边不反向 import 本文件。
  const handler = createHttpHandler({
    cfg,
    stats,
    log,
    name,
    hits,
    persist,
    scanAll,
    ctx,
    getStickerLib: () => stickerLib,
    persona,
    prompt,
    rhythm,
    stamp,
    mention,
    guard,
    adopt,
    diary,
    promise,
    unsaid,
    quota,
    phone,
    voice,
    lastword,
    isolation,
    emoji,
    linkcard,
    hands,
    temper,
    circadian,
    // `/status` 的睡眠块要读它的快照（2026-10-21 修：此前漏传，status 直接 500）。
    sleep,
    tempo,
    interrupt: interruptRef.current,
    comfy,
    recall,
  });

  registerHttp(ctx, { prefix: `/${name}`, handler });

  // ── 对外的接口（给以后新写的插件用）────────────────────────────────────────
  //
  // 2026-10-21 的决定（大意）：停止在现有包里加功能，先把接口开出来，
  // 以后有新想法就另开插件。于是这里不再往 apply() 里塞功能，而是把**已经
  // 有的能力**按稳定形状交出去（形状与理由见 lib/api.js 头注释）。
  //
  // 失败只记一条 warn：`ctx.provide` 在某些宿主形态下可能不可用（比如被
  // `dsh-hot-reloader` 以自定义 ctx 重建时），但那一不影响本插件自身运转。
  try {
    const api = createApi({
      name,
      cfg,
      stats,
      log,
      mediaDir: memoryDir,
      receiver: () => persona.state.lastReceiver,
      chatIdOfSession,
      persona: () => persona,
      hands: () => hands,
      voice: () => voice,
      diary: () => diary,
      promise: () => promise,
      unsaid: () => unsaid,
      quota: () => quota,
      sticker: () => stickerLib,
      phone: () => phone,
      isolation: () => isolation,
      lastword: () => lastword,
      phoneSourceList: PHONE_SOURCES,
      patchMethod,
      onPreStep,
    });
    ctx.provide(SERVICE_NAME, api);
    stats.apiProvided = true;
    stats.apiVersion = API_VERSION;
  } catch (error) {
    stats.apiProvided = false;
    log('warn', `[${name}] 对外接口 ${SERVICE_NAME} 暴露失败（不影响本插件功能）：${error?.message ?? error}`);
  }

  log(
    'info',
    `[${name}] 启动：目标=${cfg.packageName}，周期=${cfg.pollMs}ms；` +
      `guard=${cfg.guard.enabled ? '开' : '关'}` +
      `${cfg.guard.muteQueueNotice !== false ? '(吞排队提示)' : ''}，` +
      `prompt=${cfg.prompt.enabled ? '开' : '关'}（${prompt.activeRuleIds().length} 条规则），` +
      `rhythm=${cfg.rhythm.enabled ? '开' : '关'}（入站 ${cfg.rhythm.inbound.enabled ? '合并' : '关'} / 出站 ${cfg.rhythm.burst.enabled ? '分段' : '关'}），` +
      `persona=${cfg.persona.enabled ? '开' : '关'}（情绪 ${cfg.persona.moodEnabled ? '开' : '关'} / 主动 ${cfg.persona.proactiveEnabled ? '开' : '关'} / 风格 ${cfg.persona.styleEnabled ? '开' : '关'}），` +
      `voice=${cfg.voice.enabled ? '开' : '关'}（音色 ${cfg.voice.voice}）`,
  );
}

export default { name, apply };
