/**
 * dsh-onebot-companion / modules/persona.js
 *
 * 人设：让云玥有「此刻的状态」，并且能自己开口。
 *
 * 三件事，一个模块 —— 它们共用同一份「这个 chat 现在是什么状况」的判断：
 *
 *   1. **情绪**（mood）：心情 8 态 + 精力 + 亲密度 + 热情四个慢变量。心情决定
 *      语气，精力决定还撑不撑得住，亲密度是关系有多深的慢变量，热情是「当下
 *      多来劲、话多不多」。
 *   2. **主动发言**（proactive）：没人找她的时候，她自己想起你、开口说句话。
 *   3. **风格学习**（style）：一边聊一边统计对方怎么说话（句长/语气词/标点/
 *      emoji），攒够样本后把画像注入提示词，让她说话像对方。
 *
 * ## 四个变量为什么是四个（需求催生的设计）
 *
 * 当时提的需求：再加一个热情变量——不亲密也可以聊得火热。
 * 原本只有心情/精力/亲密度三个。缺口是「聊得热络」这件事**没有变量管**，只能
 * 靠亲密度高间接暗示，于是变成「得先亲密才能聊得火热」——这个前提不合理。
 * 所以：
 *
 *   | 变量     | 管什么                     | 时间尺度 |
 *   |----------|----------------------------|----------|
 *   | mood     | 此刻的感觉                 | 分钟级   |
 *   | energy   | 此刻的电量                 | 小时级   |
 *   | affinity | 关系有多深                 | 天级     |
 *   | warmth   | 当下多来劲、话多不多       | 小时级   |
 *
 * ## 为什么不用 cron
 *
 * 当时的意见：定时就算了，不如用随机变量。所以主动发言
 * **没有固定时刻表**：只有两处随机 —— 下一次评估的间隔是区间随机的，评估时每个
 * 候选 chat 各掷一次概率门。见 `proactive.js`。
 *
 * ## 挂载点
 *
 *   - `ChatBridge.prototype.handleInbound`（`lib/bridge.js:311`）—— 每次收到
 *     入站消息时记一笔「用户说话了」。
 *   - `ChatBridge.prototype.onSessionEvent`（`lib/bridge.js:731`）—— 借它拿到
 *     bridge 实例（`this`）并把 chat 表交给调度器；同时从 `assistant/message`
 *     事件记「她说话了」。
 *
 * **不挂 `OutboundPipeline`**：guard 占着那儿；**不挂 `dispatchFollowup`**：
 * rhythm 占着那儿（见 `core/patch.js` 的挂载点表）。
 *
 * ## 状态文件位置
 *
 * 继续用 `D:\path\to\qq-bot\.dsh-media\`（`config.mediaDir`），于是升级/重写
 * 插件都能**继承历史数据** —— 亲密度和风格画像攒了几天的东西不该因为换插件清零。
 * 与 `chat-sessions.json` / `inbound-state.json` 同目录。
 *
 * @module dsh-onebot-companion/modules/persona
 */

import { randomUUID } from 'node:crypto';

import {
  advanceSocial,
  AFFINITY_CAP_OTHERS_DEFAULT,
  AFFINITY_INITIAL_DEFAULT,
  createMoodState,
  driftAffinityOnly,
  driftEnergyOnly,
  lowEnergyLine,
  moodPromptLine,
  moodSnapshot,
  noteAssistantMessage,
  noteProactive,
  noteUserMessage,
  proactiveChance,
  quietMs,
} from './mood.js';
import { ProactiveScheduler } from './proactive.js';
import { createStyleProfile, mergeStyleSample, stylePromptLine, topParticles } from './style.js';
import { JsonStore, stateFilePath } from '../core/jsonstore.js';
import { auditMethods } from '../core/patch.js';
import { describeThrown, loadTargetClass, moduleUrl } from '../core/profile.js';

export const MODULE_ID = 'persona';

const TARGET = { file: 'bridge.js', exportName: 'ChatBridge' };
const METHODS = ['handleInbound', 'onSessionEvent'];

/**
 * chatId 必须由上游自己的 `buildChatId` 推 —— 复刻那个拼法就是在埋
 * 「上游改了规则而我们还按老规则算」的坑。和 `stamp.js` 的做法一致。
 */
const CHAT_FILE = 'chat.js';
const CHAT_EXPORT = 'buildChatId';

/**
 * 从**原始 OneBot 事件**里推 chatId。
 *
 * 为什么要这么绕：`handleInbound(event, opts)` 收到的是**原始事件**
 * （字段是 `message_type` / `user_id` / `group_id`），不是 `normalizeOneBot11`
 * 之后的 inbound —— 那个才有 `chatId`。2026-10-18 之前这里写的是
 * `inbound?.chatId`，于是**永远是 undefined**，`noteMood(chatId,'user')`
 * 一次都没跑过：`mood-state.json` 里三个 chat 的 `lastUserAt` 全是 0，
 * 精力只有每条回复 -1.5 和时间衰减，单调掉到 0 → 永远 tired →
 * 下午三点说了句「撑不住，要去睡了」。
 *
 * @param {object} event 原始 OneBot 事件
 * @param {(kind: string, target: string) => string} buildChatId 上游的拼法
 * @returns {string|null}
 */
export function chatIdOfEvent(event, buildChatId) {
  const kind = event?.message_type;
  if (kind !== 'group' && kind !== 'private') return null;
  const target = kind === 'group' ? event?.group_id : event?.user_id;
  if (target === undefined || target === null || target === '') return null;
  try {
    return String(buildChatId(kind, String(target)));
  } catch {
    return null;
  }
}


/**
 * 主动开口的触发文本。
 *
 * **关键设计**：这段话是**框架写的**（不是对方可控的内容），所以刻意放在
 * `<user_message>` 边界**之外**、带自己的 `<proactive_turn>` 标签 —— 模型必须
 * 能分清「我自己决定开口」和「他给我发消息」。不区分的话，主动聊天的幻觉就塌了
 * （她会以为对方真说了什么，然后去回应一句根本不存在的话）。
 */
function proactiveTriggerText(gap, deepNight = false) {
  const gapAttr = gap === '' ? '' : ` gap="${gap}"`;
  // 深夜档（默认 23:00–02:00）：他大概躺着刷手机，这时候搭话只该是「一句轻声」。
  // 不问问题、不催他回、不报告进度 —— 反过来做就成了催睡，把人从迷糊里喊醒。
  const body = deepNight
    ? '现在是深夜，他大概躺着刷手机、或者已经迷糊了。这一句只说一句，轻声说，' +
      '像忽然想起他：别问问题（问了就得回，他就得醒着），别催他去睡，别报告你在做什么。' +
      '说完就完，他不回也没关系。'
    : '现在没人给你发消息，是你主动开口的时候。想说什么就说什么，' +
      '别提「我主动来找你」这种话，就像你忽然想起他一样。';
  // 这一句不该变成一次「任务」：不用翻档案、不用查资料、别调工具，
  // 就说此刻想到的那句话。查了反而慢，也容易把一句随口的话写成一封汇报。
  const tail = deepNight ? '' : '\n这一句不用查东西、不用调工具，就说你此刻想到的。';
  return `<proactive_turn${gapAttr}${deepNight ? ' deep="night"' : ''}>\n${body}${tail}\n</proactive_turn>`;
}

/** 把毫秒静默时长说成人话（「26 分钟」/「2 小时」）。 */
function humanGap(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/**
 * 从一条模型消息里抠出纯文本（只取 text block，忽略 reasoning / tool-call）。
 *
 * 风格学习只该学「她真说出口的话」，思维链和工具参数不是她的说话方式。
 */
export function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** 从一条 assistant 消息里数有几个工具调用（2026-10-23）。 */
export function toolCallCountOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (b?.type === 'tool-call' || b?.type === 'tool_use') n += 1;
  }
  return n;
}

/** 从一条入站消息里抠出纯文本（去掉 `<user_message>` 包装与群前缀）。 */
export function plainOfInbound(text) {
  const s = String(text ?? '');
  const m = /<user_message[^>]*>\n?([\s\S]*?)\n?<\/user_message>/.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * 从**原始 OneBot 事件**里取纯文本（风格样本用）。
 *
 * 只取 `type === 'text'` 段，其余段（图片/表情/at）一律跳过 —— 风格画像
 * 统计的是「他怎么说话」，把 `[图片]` 之类占位算进字数只会污染平均值。
 */
export function eventTextOf(event) {
  const segments = Array.isArray(event?.message) ? event.message : null;
  if (segments) {
    return segments
      .filter((seg) => seg?.type === 'text')
      .map((seg) => String(seg?.data?.text ?? ''))
      .join('')
      .trim();
  }
  return typeof event?.raw_message === 'string' ? event.raw_message.trim() : '';
}

/**
 * 创建 persona 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - persona 段配置。
 * @param {object} options.stats - 共享统计（含 `mood` / `proactive` / `style` 子对象）。
 * @param {Function} options.patchMethod - core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 * @param {() => number} [options.random]
 * @param {(chatId: string, text: string, at: number) => void} [options.onAssistantText]
 *   她说了一句话时的旁路回调（纯文本）。`sleep` 模块用它判断「她刚说了要睡」。
 *   刻意用回调而不是让 sleep 自己也去 patch `onSessionEvent`：两个模块 patch
 *   同一方法要处理排序，而这里 persona 已经拿到了 `chatId` 与会话事件，
 *   再挂一层只会多一份出错的地方。
 * @param {(usage: object) => void} [options.onSessionUsage]
 *   她在这一轮消耗了多少时的旁路回调（`quota` 模块用它记账）。
 *   同样用回调而不是再 patch 一层，理由与上一条相同。
 * @param {(chatId: string, at: number, userId: string|number|undefined) => void} [options.onUserText]
 *   对方发来一条消息时的旁路回调（`circadian` 用它记「他此刻在场」）。
 *   同样放在这里：chatId 已经算好，再 patch 一层 `handleInbound` 只会多一个
 *   要维护顺序的挂载点。回调必须**同步且不抛错**（模块自己保证）。
 */
export function createPersona({
  cfg, stats, patchMethod, log, random = Math.random, onAssistantText, onSessionUsage, onUserText,
}) {
  const state = {
    /** @type {*} 最近一次见到的 ChatBridge 实例（调度器要用它的 chats 表）。 */
    lastReceiver: undefined,
    moodStore: undefined,
    styleStore: undefined,
    scheduler: undefined,
    /** @type {((kind: string, target: string) => string)|null} 上游 chat.js 的 buildChatId。 */
    buildChatId: null,
    /**
     * 长期底色（`temper`）的偏向来源。`index.js` 在创建 persona 之后接进来。
     *
     * 走**回调**而不是配置对象：底色每天都在变（按天结算），把它当成启动时读一次的
     * 静态配置，第二天就过期了。回调也让 persona 不必知道 temper 存哪、怎么算。
     *
     * @type {(() => Record<string, number>)|null}
     */
    biasOf: null,
    /**
     * 生物钟（`circadian`）的夜间掩码来源。`index.js` 在创建 persona 之后接进来。
     *
     * 返回 24 个 boolean（true = 他通常不在，算「夜」），或者 null / 全 false。
     * 三种语义和 `modules/circadian.js` 的 `nightSetOf` 一致：
     *   - null    → 还没学出来，退回 `nightStartHour/nightEndHour` 那套固定区间；
     *   - 全 false → 他全天都在，「从不困倦」，精力没有回血时段；
     *   - 有 true  → 这些小时是他的安静时段。
     *
     * 同样走回调而不是配置：曲线是天天长的，写进配置就等于冻结。
     *
     * @type {(() => boolean[]|null)|null}
     */
    nightMaskOf: null,
    /**
     * 生活节奏 / 对话密度来源（`tempo`，2026-10-22）。`index.js` 创建 persona 后接进来。
     *
     * 回调签名 `(chatId, now) => { cadence, factor }`，`factor` 是要乘到主动开口
     * 概率上的倍率。走回调的理由与上面两个一样：密度是按会话随时变的，
     * 写成配置就冻住了。
     *
     * @type {((chatId: string, now: number) => {cadence:string, factor:number})|null}
     */
    tempoOf: null,
  };

  const isStopping = () => state.lastReceiver?.stopping === true;

  /**
   * 「主动开口」的 chat 白名单（`proactiveOnlyChats`）。
   *
   * 用户硬约束原话：「主动只对我，我才是管理员」。原私有实现里这个键叫
   * `proactiveOnlyChats: ["100000001"]`（QQ 号），落在这里的 chatId 是
   * `private:100000001` 形态，所以两边都认：写纯 QQ 号或写完整 chatId 都行。
   *
   * 空数组 = 不限制（默认）—— 保持与旧实现一致：旧实现没配这个键时也不限制。
   */
  const allowedChats = new Set(
    (Array.isArray(cfg.proactiveOnlyChats) ? cfg.proactiveOnlyChats : [])
      .map((v) => String(v ?? '').trim())
      .filter((v) => v !== '')
      .flatMap((v) => (v.startsWith('private:') || v.startsWith('group:') ? [v] : [v, `private:${v}`, `group:${v}`])),
  );

  function proactiveAllowed(chatId) {
    if (allowedChats.size === 0) return true;
    return allowedChats.has(String(chatId ?? ''));
  }

  // ── 落盘：继续用 mediaDir，继承历史亲密度与风格画像 ────────────────────────
  //
  // 目录**延迟解析**：`cfg.mediaDir` 没配时，从 bridge 实例的配置里取
  // （`this.deps.config.mediaDir`）—— 那正是现有 `mood-state.json` /
  // `style-state.json` / `chat-sessions.json` 所在的地方，于是重写插件也能
  // **继承历史数据**：亲密度和风格画像攒了几天的东西不该因为换插件清零。
  let moodStore;
  let styleStore;
  /**
   * 分层存储（2026-10-20）：
   *
   *   | 量       | 存在哪          | 键         | 为什么 |
   *   |----------|-----------------|------------|--------|
   *   | energy   | body-state.json | 固定 `body` | 身体只有一具：在哪说话耗的都是同一份电量 |
   *   | affinity | people-state.json | `u:<账号>` | 关系是对人的：同一个人在私聊和群里说话涨同一份 |
   *   | mood/warmth | mood-state.json | `<chatId>` | 「此刻在这个场合」的状态，换个场合本来就该不同 |
   *
   * 当时提的需求：精力能不能跨会话共用；亲密度按账号算，不按群、不按会话。
   * 之前四个量挤在每条 chat 记录里，于是「在群里说一句」和「私聊说一句」各扣一份电量，
   * 一天下来精力被扣成三份；亲密度也是每个群各涨各的。
   */
  let bodyStore;
  let peopleStore;
  let resolvedDir = '';

  const storeOpts = {
    log,
    flushMs: 4000,
    isStopping,
    label: 'onebot-companion',
    normalize: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
  };

  function resolveDir() {
    if (typeof cfg.mediaDir === 'string' && cfg.mediaDir !== '') return cfg.mediaDir;
    const fromBridge = state.lastReceiver?.deps?.config?.mediaDir;
    return typeof fromBridge === 'string' ? fromBridge : '';
  }

  /** 惰性建/换 store —— 目录变了（配置热改、bridge 首次出现）就重建。 */
  function ensureStores() {
    const dir = resolveDir();
    if (moodStore !== undefined && dir === resolvedDir) return;
    resolvedDir = dir;
    moodStore = new JsonStore({ ...storeOpts, file: dir ? stateFilePath(dir, 'mood-state.json') : '' });
    styleStore = new JsonStore({ ...storeOpts, file: dir ? stateFilePath(dir, 'style-state.json') : '' });
    bodyStore = new JsonStore({ ...storeOpts, file: dir ? stateFilePath(dir, 'body-state.json') : '' });
    peopleStore = new JsonStore({ ...storeOpts, file: dir ? stateFilePath(dir, 'people-state.json') : '' });
    // 首次建立时把磁盘上的历史读回来（异步，不阻塞调用方）。
    void Promise.allSettled([
      moodStore.load(),
      styleStore.load(),
      bodyStore.load(),
      peopleStore.load(),
    ]).catch(() => undefined);
  }
  ensureStores();

  const mood = () => {
    ensureStores();
    return moodStore;
  };
  const style = () => {
    ensureStores();
    return styleStore;
  };
  const body = () => {
    ensureStores();
    return bodyStore;
  };
  const people = () => {
    ensureStores();
    return peopleStore;
  };

  /** 全局精力那一条记录的键（body-store 里只有它一条）。 */
  const BODY_KEY = 'body';

  /** 一次性迁移是否跑过（进程内）。 */
  let migrated = false;

  /**
   * GUI 会话已经记过账的消息 id（按会话分开）。
   *
   * `agent/pre-step` 每一步都会把整段 messages 再送一遍，同一个 id 会反复出现。
   * 只放内存不落盘：重启后最多补记一个窗口（`guiCatchUpMax` 条），代价可接受；
   * 落盘反而会在会话被删/重建时留下对不上的脏 id。
   */
  const guiSeen = new Map();

  /**
   * 把老的单层 `mood-state.json` 拆进 body / people 两层（只跑一次）。
   *
   * 为什么必须迁移而不是「让新记录从默认值长起来」：老的 energy / affinity 是
   * 攒了很多天的真数据（私聊亲密度 53、warmth 30 之类），从 80/20 重开等于把
   * 关系清零 —— 用户会直接觉得「她不记得我们了」。
   *
   * 规则：
   *   - 精力取**最近活跃**的那条会话记录（`lastDriftAt` 最大）—— 那最接近「她现在还有多少电」。
   *     以前三个会话各存一份，正是「说三句话扣三份电」的病根，现在合成一份。
   *   - 亲密度按 chatId 逐条拆：`private:X` → `u:X`，`group:Y` → `g:Y`。
   *   - 迁移完**保留** mood-state.json 里的原字段不动（老版本回滚还能用）。
   */
  function migrateLegacyState() {
    if (migrated) return;
    migrated = true;
    try {
      // 用同步读：moodOf 是同步路径，异步 load() 赶不上第一次调用。
      body().loadSync();
      people().loadSync();
      mood().loadSync();
      if (body().get(BODY_KEY) !== undefined) return;

      const chatIds = [...mood().keys()];
      if (chatIds.length === 0) return;

      // 精力：取**最近还有互动**的那条会话记录 —— 那最接近「她现在还有多少电」。
      // 不能按 lastDriftAt 挑：那个字段每次被访问都会推到 now，谁被多看了一眼谁就
      // 「最新」，挑出来的是「被读过的那条」而不是「真在聊的那条」。
      // 以前三个会话各存一份精力，正是「说三句话扣三份电」的病根，现在合成一份。
      let freshest = null;
      let freshestAt = -1;
      for (const chatId of chatIds) {
        const rec = mood().get(chatId);
        if (!rec || typeof rec !== 'object') continue;
        const touched = Math.max(rec.lastUserAt ?? 0, rec.lastAssistantAt ?? 0, rec.lastProactiveAt ?? 0);
        if (touched > freshestAt) {
          freshestAt = touched;
          freshest = rec;
        }
      }
      if (freshest === null) freshest = mood().get(chatIds[0]);
      if (freshest !== null && freshest !== undefined) {
        body().set(BODY_KEY, {
          energy: typeof freshest.energy === 'number' ? freshest.energy : 80,
          lastDriftAt: freshAt(freshest, Date.now()),
        });
      }

      // 亲密度：逐条拆到 people。
      for (const chatId of chatIds) {
        const rec = mood().get(chatId);
        if (!rec || typeof rec !== 'object') continue;
        const who = personKeyOf(chatId);
        if (who.key === null) continue;
        const prev = people().get(who.key);
        const affinity = typeof rec.affinity === 'number' ? rec.affinity : 20;
        // 同一账号可能有多条（理论上不会），取大的那份，别互相压小。
        if (prev !== undefined && (prev.affinity ?? 0) >= affinity) continue;
        people().set(who.key, {
          affinity,
          lastUserAt: rec.lastUserAt ?? 0,
          lastAssistantAt: rec.lastAssistantAt ?? 0,
          lastDriftAt: freshAt(rec, Date.now()),
        });
      }
      body().saveDebounced();
      people().saveDebounced();
      log('info', '情绪分层迁移完成：精力 → body-state.json，亲密度 → people-state.json');
    } catch (error) {
      stats.lastError = describeThrown(error);
    }
  }

  /** 取一条记录的时间参考点，坏值退回 fallback。 */
  function freshAt(rec, fallback) {
    const t = rec?.lastDriftAt;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : fallback;
  }

  /**
   * 从 chatId / 原始事件推「这份亲密度算谁的」。
   *
   * 规则：优先用**发言人账号**（群聊里就是 `event.user_id`），拿不到再退回
   * chatId 里的 target。私聊两者一致；群聊只能靠 `event.user_id` ——
   * `buildChatId('group', group_id)` 拼出来的只有群号，含不下发言人。
   *
   * 返回 `{ key, kind }`；`key` 形如 `u:100000001`，拿不到就是 null。
   *
   * @param {string} chatId 形如 `private:100000001` / `group:900000002`
   * @param {{ userId?: string|number|undefined }} [extra] 原始事件里捞出来的账号
   */
  function personKeyOf(chatId, extra = {}) {
    const rawUser = extra?.userId;
    if (rawUser !== undefined && rawUser !== null && String(rawUser) !== '') {
      return { key: 'u:' + String(rawUser), kind: 'user' };
    }
    const text = String(chatId ?? '');
    const idx = text.indexOf(':');
    if (idx < 0) return { key: null, kind: 'unknown' };
    const kind = text.slice(0, idx);
    const target = text.slice(idx + 1);
    if (target === '') return { key: null, kind };
    // 私聊的 target 就是账号本身；群聊的 target 是群号，只能当「这个群」用。
    return { key: (kind === 'private' ? 'u:' : 'g:') + target, kind };
  }

  /**
   * 这个人的亲密度能涨到多少（2026-10-21）。
   *
   * 起因：此前的规则是「谁说话就涨谁的」，于是群里常冒头的那几个也各攒出一份
   * 不低的关系——实测某个群友已经 62，按阶段算是「挺亲的」，看上去就是
   * 「没跟我说话也在跟别人熟」。
   *
   * 第一版是「名单外的人步长冻成 0」，但用户随后改了口径（m06374）：
   * **「可以涨，除我以外上限 33」** —— 还涨，只是封顶。所以这里返回的是上限值
   * 而不是布尔。名单里的人（以及名单为空时的所有人）返回 100，即不设限。
   *
   * 认的写法与 `proactiveOnlyChats` 一致：纯号（`"100000001"`）或完整 chatId
   * （`"private:100000001"`）。群号写成 `"g:<群号>"` 也能认，但一般不需要。
   *
   * @param who - `personKeyOf()` 的结果。
   * @returns 0..100 的亲密度上限。
   */
  function affinityCapOf(who) {
    const list = Array.isArray(cfg.affinityOnlyChats) ? cfg.affinityOnlyChats : [];
    if (list.length === 0) return 100;
    const key = String(who?.key ?? '');
    if (key === '') return 100;
    const hit = list.some((raw) => {
      const text = String(raw ?? '').trim();
      if (text === '') return false;
      if (text === key) return true;
      // 纯 QQ 号 → `u:<号>`；`private:<号>` / `group:<号>` 也一并接住。
      const bare = text.replace(/^(private|group|u|g):/, '');
      return key === 'u:' + bare || key === 'g:' + bare;
    });
    if (hit) return 100;
    const cap = Number(cfg.affinityCapOthers);
    return Number.isFinite(cap) ? Math.min(100, Math.max(0, cap)) : AFFINITY_CAP_OTHERS_DEFAULT;
  }

  /** 情绪相关配置（透传给 mood.js 的纯函数）。 */
  const moodConfig = () => ({
    moodDriftMinutes: cfg.moodDriftMinutes,
    energyDecayPerHour: cfg.energyDecayPerHour,
    nightRecoveryPerHour: cfg.nightRecoveryPerHour,
    nightStartHour: cfg.nightStartHour,
    nightEndHour: cfg.nightEndHour,
    energyPerUserMessage: cfg.energyPerUserMessage,
    /**
     * 亲密度步长（2026-10-21）。undefined 时 mood.js 用常量
     * `AFFINITY_PER_USER_MESSAGE`，所以这里只做透传。
     */
    affinityPerUserMessage: cfg.affinityPerUserMessage,
    energyPerAssistantMessage: cfg.energyPerAssistantMessage,
    /**
     * 工具加扣（2026-10-23）。undefined 时 mood.js 用常量
     * `ENERGY_PER_TOOL_CALL_DEFAULT` / `TOOL_CALL_ENERGY_CAP_DEFAULT`，
     * 所以这里只做透传 —— 与上面 `affinityPerUserMessage` 同一范式。
     */
    energyPerToolCall: cfg.energyPerToolCall,
    toolCallEnergyCap: cfg.toolCallEnergyCap,
    energyPerProactive: cfg.energyPerProactive,
    affinityDecayPerHour: cfg.affinityDecayPerHour,
    affinityGraceHours: cfg.affinityGraceHours,
    warmthBaseline: cfg.warmthBaseline,
    warmthRegressPerHour: cfg.warmthRegressPerHour,
    warmthJitter: cfg.warmthJitter,
    proactiveChance: cfg.proactiveChance,
    // 长期底色（temper）：每次现取，不缓存 —— 它按天结算，缓存就等于冻结。
    get moodBias() {
      try {
        const fn = state.biasOf;
        return typeof fn === 'function' ? fn() : undefined;
      } catch {
        return undefined;
      }
    },
    /**
     * 生物钟的夜间掩码（circadian）：同样每次现取。
     *
     * 放在 moodConfig 里而不是让 mood.js 去 import circadian：纯函数层不该知道
     * 谁在学它。这也保证「没有 circadian 模块时 mood.js 行为完全不变」——
     * getter 返回 undefined 就走固定区间那条路。
     */
    get nightMask() {
      try {
        const fn = state.nightMaskOf;
        return typeof fn === 'function' ? fn() : undefined;
      } catch {
        return undefined;
      }
    },
  });

  /** 取（并推进）某 chat 的情绪状态。漂移结果会写回，让时间真的流逝。 */
  /**
   * 取（并推进）某 chat 的**合成**情绪状态。
   *
   * 「合成」的意思是：返回的对象形状和以前一模一样（mood/energy/affinity/warmth/
   * 三个时间戳），但三个来源不同 —— 精力来自全局 body 记录，亲密度来自按人的
   * people 记录，心情与热情仍在 chat 记录里。这样所有下游（提示词、快照、主动开口
   * 的概率门）都不用改，只在这一层把三层拼起来。
   *
   * 推进（漂移）也按各自的参考点走：精力推 body.lastDriftAt、亲密度推
   * people.lastDriftAt、心情/热情推 chat.lastDriftAt。谁也不借谁的时间戳。
   *
   * @param chatId - 形如 `private:100000001` / `group:900000002`。
   * @param now - 当前 ms epoch。
   * @param extra - `{ userId }`：群聊里发言人账号（没有就用 chatId 的 target 兜底）。
   */
  function moodOf(chatId, now = Date.now(), extra = {}) {
    migrateLegacyState();
    const store = mood();
    const storedChat = store.get(chatId);
    const chatBase = storedChat ?? createMoodState(now);
    const cfg = moodConfig();

    // ① 精力：全局一份，自己的参考点。
    const bodyRec = body().get(BODY_KEY);
    const energyStart = bodyRec?.energy ?? chatBase.energy;
    const energyFrom = bodyRec?.lastDriftAt ?? chatBase.lastDriftAt;
    const energy = driftEnergyOnly(energyStart, energyFrom, now, cfg);

    // ② 亲密度：按人，自己的参考点。群聊里优先取发言人，其次取本会话上次开口的人。
    const speaker = extra?.userId ?? storedChat?.lastSpeaker;
    const who = personKeyOf(chatId, { userId: speaker });
    const personRec = who.key === null ? undefined : people().get(who.key);
    // 没有这个人的记录时**不能用** chat 记录里的 affinity —— 群聊那条记录里的
    // 数值属于上一个说话的人，拿来当新人的起点等于「认识你了」。私聊的 chat
    // 记录与本人一一对应，可以当老数据的兜底。
    const affinityStart = personRec?.affinity
      ?? (who.kind === 'private' ? chatBase.affinity : AFFINITY_INITIAL_DEFAULT);
    const affinityFrom = personRec?.lastDriftAt ?? chatBase.lastDriftAt;
    const lastContact = personRec
      ? Math.max(personRec.lastUserAt ?? 0, personRec.lastAssistantAt ?? 0)
      : Math.max(chatBase.lastUserAt, chatBase.lastAssistantAt);
    const affinity = driftAffinityOnly(affinityStart, lastContact, affinityFrom, now, cfg);

    // ③ 心情 / 热情：留在 chat 记录里，用 chat 自己的 lastDriftAt 推进。
    // 不传 warmthIn —— 让 advanceSocial 自己按 chatBase.lastDriftAt 做静默回归，
    // 和 driftMood 走完全同一条路径。
    const social = advanceSocial(chatBase, now, random, cfg, energy, affinity);
    const drifted = {
      ...chatBase,
      mood: social.mood,
      energy,
      affinity,
      warmth: social.warmth,
      lastDriftAt: now,
      lastMoodRollAt: social.lastMoodRollAt,
    };

    // 写回：只有本来就有记录的才写（首次访问不落盘，保持旧行为）。
    if (storedChat !== undefined) {
      store.set(chatId, drifted);
      body().set(BODY_KEY, { energy, lastDriftAt: now });
      if (who.key !== null) {
        people().set(who.key, {
          affinity,
          lastUserAt: personRec?.lastUserAt ?? 0,
          lastAssistantAt: personRec?.lastAssistantAt ?? 0,
          lastDriftAt: now,
        });
      }
      // 推进的结果必须落下去 —— 否则「读了但没说话」这一段的时间流逝会丢，
      // 下次又从旧时间戳开始积分（等于时间白白倒流）。
      store.saveDebounced();
      body().saveDebounced();
      people().saveDebounced();
    }
    return drifted;
  }

  /**
   * 把一条聊天行为写回三层存储。
   *
   * `next` 是纯函数算出来的合成状态（形状仍是旧的单条记录），这里只负责把它
   * **拆开**放回该去的地方：精力 → body，亲密度 → people，心情/热情/时间戳 → chat。
   *
   * @param chatId - 会话 id。
   * @param current - 写入前的合成状态。
   * @param next - 写入后的合成状态。
   * @param now - 当前 ms epoch。
   * @param who - `personKeyOf()` 的结果。
   * @param kind - 'user' | 'assistant' | 'proactive'。
   */
  function writeBackMood(chatId, current, next, now, who, kind) {
    const store = mood();
    // chat 层：心情、热情、以及「这个会话有多静」用的三个时间戳。
    store.set(chatId, {
      ...next,
      // 群聊里记住「最近在这个群里说话的是谁」：`onSessionEvent` 那条分支（她
      // 说话）拿不到 user_id，下一轮只能靠这个字段把亲密度记到对的人头上。
      ...(String(chatId).startsWith('group:') && who.key !== null && who.key.startsWith('u:')
        ? { lastSpeaker: who.key.slice(2) }
        : {}),
    });
    // body 层：全局精力。
    body().set(BODY_KEY, { energy: next.energy, lastDriftAt: now });
    // people 层：这个人的亲密度与他/她各自的互动时间戳。
    if (who.key !== null) {
      const prev = people().get(who.key);
      people().set(who.key, {
        affinity: next.affinity,
        lastUserAt: kind === 'user' ? now : (prev?.lastUserAt ?? current.lastUserAt ?? 0),
        lastAssistantAt: kind === 'user' ? (prev?.lastAssistantAt ?? current.lastAssistantAt ?? 0) : now,
        lastDriftAt: now,
      });
    }
    store.saveDebounced();
    return next;
  }

  function noteMood(chatId, kind, now = Date.now(), extra = {}) {
    try {
      // 群聊里「她说话」这条分支拿不到 user_id（onSessionEvent 只有 session id），
      // 只能靠 chat 记录里上一轮存下的 lastSpeaker。私聊不需要。
      const withSpeaker = extra?.userId !== undefined && extra?.userId !== null && String(extra.userId) !== ''
        ? extra
        : { ...extra, userId: mood().get(chatId)?.lastSpeaker };
      const current = moodOf(chatId, now, withSpeaker);
      const who = personKeyOf(chatId, withSpeaker);
      const energyCfg = moodConfig();
      // 名单外的人：回血照给，亲密度封顶（见 affinityCapOf 注释）。
      const userCfg = { ...energyCfg, affinityCap: affinityCapOf(who) };
      // 这一轮用了几个工具（2026-10-23）：干活比说话更耗电。`assistant` 分支
      // 从 `onSessionEvent` 收到 `assistant/message` 时数出来的；纯说话就是 0，
      // 与加这条之前逐位一致。
      const toolCalls = Number.isFinite(extra?.toolCalls) ? extra.toolCalls : 0;
      const next =
        kind === 'user'
          ? noteUserMessage(current, now, userCfg)
          : kind === 'assistant'
            ? noteAssistantMessage(current, now, energyCfg, toolCalls)
            : noteProactive(current, now, energyCfg);
      return writeBackMood(chatId, current, next, now, who, kind);
    } catch (error) {
      stats.lastError = describeThrown(error);
      return null;
    }
  }

  /**
   * 把 GUI 会话里真人发的消息也记账（2026-10-20）。
   *
   * 只在 `cfg.guiChatId` 配了东西时才干活。判据见 DEFAULTS.guiChatId 的注释：
   * `source.kind === 'user'` 且带 `rpcId` 才是人敲进来的，时间上下文/会话时钟/
   * 自动改标题/记忆注入全是 `role: 'user'` 的冒牌货。
   *
   * 用 message id 去重 —— pre-step 每一步都会带着**整段** messages 再来一次，
   * 不去重的话一轮工具调用就能把亲密度灌满。
   *
   * 全程不抛错：它在 `agent/pre-step` 里被调用。
   */
  function noteGuiStep(sessionId, messages, now = Date.now()) {
    try {
      if (cfg.enabled === false || cfg.moodEnabled === false) return null;
      const chatId = String(cfg.guiChatId ?? '').trim();
      if (chatId === '') return null;
      // OneBot 自己的会话已经由 handleInbound / onSessionEvent 记过账了，
      // 这里再记一遍等于双倍加成。
      if (chatIdOfSession(sessionId) !== null) return null;
      if (!Array.isArray(messages) || messages.length === 0) return null;

      let seen = guiSeen.get(sessionId);
      if (seen === undefined) {
        seen = new Set();
        guiSeen.set(sessionId, seen);
      }
      // 首次接管一个旧会话时不要把几百轮的历史一次补进来：只留最后一个
      // 窗口，其余先标记成「见过」。
      const cap = Number(cfg.guiCatchUpMax) > 0 ? Number(cfg.guiCatchUpMax) : 4;
      const fresh = [];
      for (const m of messages) {
        if (m === null || typeof m !== 'object') continue;
        const id = typeof m.id === 'string' ? m.id : '';
        if (id === '' || seen.has(id)) continue;
        const role = m.role;
        const kind = m?.source?.kind;
        if (role === 'user' && kind === 'user') fresh.push({ id, role: 'user', text: textOfMessage(m) });
        else if (role === 'assistant' && kind === 'model') {
          const text = textOfMessage(m);
          // 只有真的说出口的话才算「她说了话」；纯工具调用那几步不算。
          if (text.trim() !== '') fresh.push({ id, role: 'assistant', text });
        } else seen.add(id);
      }
      if (fresh.length === 0) return null;

      // 只取最后 cap 条，靠后的先算（万一中途抛错，先记的是最近这轮）。
      const tail = fresh.slice(-cap);
      for (const f of tail) {
        seen.add(f.id);
        noteMood(chatId, f.role === 'user' ? 'user' : 'assistant', now);
      }
      // 更早的那些直接标记见过，不再补账。
      for (const f of fresh) seen.add(f.id);
      stats.guiNotes = (stats.guiNotes ?? 0) + tail.length;
      return tail.length;
    } catch (error) {
      stats.lastError = describeThrown(error);
      return null;
    }
  }

  /**
   * 把一份外来画像收拾成 `style.js` 期望的形状。
   *
   * 只做「补缺 + 去险」：数字字段非负、对象字段是对象、`samples_` 是字符串数组。
   * 目的是让手写/外部生成的画像不可能把提示词渲染成 `NaN 个字` 或
   * `「undefined」`。**不**做任何统计 —— 统计是 style.js 的职责。
   */
  function normalizeStyleProfile(raw) {
    const src = raw !== null && typeof raw === 'object' ? raw : {};
    const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
    const dict = (value) => {
      const out = {};
      if (value === null || typeof value !== 'object') return out;
      for (const [k, v] of Object.entries(value)) {
        const n = num(v);
        if (n > 0) out[String(k)] = n;
      }
      return out;
    };
    return {
      samples: num(src.samples),
      totalChars: num(src.totalChars),
      particles: dict(src.particles),
      punctuation: dict(src.punctuation),
      emoji: num(src.emoji),
      emojiMessages: num(src.emojiMessages),
      // 原话样本一律不接：用户明确要求「是学我俩，不是用我俩说过的话」。
      samples_: [],
      updatedAt: num(src.updatedAt) || Date.now(),
    };
  }

  function noteStyle(chatId, text, kind, now = Date.now()) {
    try {
      if (cfg.styleEnabled === false) return;
      // 只学私聊对象：群里是很多人，混在一起会学出一个谁都不像的平均口音。
      if (kind !== 'private') return;
      const sample = String(text ?? '').trim();
      if (sample === '') return;
      const store = style();
      const profile = store.get(chatId) ?? createStyleProfile();
      // 群聊陌生人适用 `sample:false`（不记原话），私聊可以记。
      store.set(chatId, mergeStyleSample(profile, sample, now, { sample: true }));
      store.saveDebounced();
    } catch (error) {
      stats.lastError = describeThrown(error);
    }
  }

  /** 主动开口：走 `chat.agent.followup`，与入站投递同一个入口。 */
  async function proactiveFire(chat, info) {
    // 复检 —— 从「决定开口」到「真的开口」之间，状况可能已经变了。
    if (isStopping()) return { ok: false, reason: 'stopping' };
    const chatId = chat?.chatId;
    if (typeof chatId !== 'string') return { ok: false, reason: 'no-chat' };
    if (state.lastReceiver?.chats?.get?.(chatId) !== chat) return { ok: false, reason: 'chat-gone' };
    if (chat.busy === true) return { ok: false, reason: 'busy' };
    if (cfg.proactiveEnabled === false) return { ok: false, reason: 'disabled' };
    if (chat.agent?.status === 'running') return { ok: false, reason: 'running' };

    const now = Date.now();
    const gap = humanGap(info?.idleMs);
    const text = proactiveTriggerText(gap, info?.deepNight === true);

    chat.pendingTurnRoles.push('member');
    chat.lastActivityAt = now;
    try {
      state.lastReceiver?.interim?.onNewUserTurn?.(chat);
    } catch {
      /* 中间态追踪是装饰 */
    }

    // 直接构造 user 消息，不 import `@deepseek-ai/dsh-llm` —— 本插件在 profile
    // 侧运行，那里解析不到宿主内部包（实测 `ERR_MODULE_NOT_FOUND`）。宿主自己的
    // 消息形状就是 `{role, content:[{type:'text',text}], source}`，补齐 id 即可。
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-onebot', proactive: true },
    };

    await chat.agent.followup(message);
    noteMood(chatId, 'proactive', now);
    stats.proactive.fired += 1;
    stats.proactive.lastFiredAt = now;
    stats.proactive.lastChatId = chatId;
    try {
      state.lastReceiver?.startTyping?.(chat);
    } catch {
      /* 输入指示器是装饰 */
    }
    log('info', `主动开口 → ${chatId}（静默 ${gap || '未知'}）`);
    return { ok: true };
  }

  // ── 主动发言调度器（无 cron，只有随机）───────────────────────────────────
  state.scheduler = new ProactiveScheduler({
    config: cfg,
    log,
    isStopping,
    random,
    listChats: () => {
      const chats = state.lastReceiver?.chats;
      if (!chats || typeof chats.values !== 'function') return [];
      return [...chats.values()];
    },
    eligible: (chat) => {
      if (!chat || typeof chat !== 'object') return false;
      if (isStopping()) return false;
      // 只对私聊主动：群里主动开口是打扰所有人。
      if (!String(chat.chatId ?? '').startsWith('private:')) return false;
      // 「主动只对我」—— 用户硬约束。`allowAllUsers: true` 时陌生人也能私聊，
      // 不设白名单的话云玥会去主动搭话陌生人。空数组 = 不限制（保持兼容）。
      if (!proactiveAllowed(chat.chatId)) return false;
      if (chat.busy === true || chat.agent?.status === 'running') return false;
      // 必须有过往来 —— 从没聊过的人不该收到「我忽然想起你」。
      try {
        return moodOf(chat.chatId).lastUserAt > 0;
      } catch {
        return false;
      }
    },
    idleMs: (chat) => {
      try {
        return quietMs(moodOf(chat.chatId), Date.now());
      } catch {
        return Date.now() - (chat.lastActivityAt ?? 0);
      }
    },
    chance: (chat) => {
      try {
        const now = Date.now();
        const base = proactiveChance(moodOf(chat.chatId), now, moodConfig());
        // 生活节奏 × 对话密度（2026-10-22，modules/tempo.js）。
        // 睡着 ×0.15、刚聊完 ×1.4 —— 这两件事 `proactiveChance` 都不知道，
        // 因为它拿不到 chatId（密度是按会话记的）。接不上 tempo 时按 1 算，
        // 行为与加这个之前逐位一致。
        let factor = 1;
        try {
          const fn = state.tempoOf;
          if (typeof fn === 'function') {
            const t = fn(chat.chatId, now);
            if (t !== null && typeof t === 'object' && Number.isFinite(t.factor)) factor = t.factor;
          }
        } catch {
          factor = 1;
        }
        return Math.min(0.95, Math.max(0, base * factor));
      } catch {
        return 0;
      }
    },
    fire: (chat, info) => proactiveFire(chat, info),
  });

  /**
   * 每轮注入的附加文本：情绪行 + 风格行。
   *
   * 由 prompt 模块搭车注入（省一次 messages 追加）。**必须是纯同步函数且绝不
   * 抛错** —— 它在 `agent/pre-step` 里被调用，抛出去会连累整轮对话。
   */
  function extraFor(sessionId) {
    try {
      if (cfg.enabled === false) return null;
      // GUI 会话（`session-xxx`）反推不出 chatId。配了 guiChatId 就当成那一个
      // chat —— 用户在网页里聊的时候也该看到她的情绪，而不是一张白纸。
      const chatId = chatIdOfSession(sessionId) ?? (String(cfg.guiChatId ?? '').trim() || null);
      if (chatId === null) return null;
      const lines = [];
      if (cfg.moodEnabled !== false) {
        const now = Date.now();
        const state = moodOf(chatId, now);
        lines.push(moodPromptLine(state, now, moodConfig()));
        // 低精力时补一行「漏水」提示：不是让她演累，是允许她真的漏（记错、重复、
        // 不耐烦、懒得权衡）。高于阈值时返回空串，不占提示。
        const low = lowEnergyLine(state, moodConfig());
        if (typeof low === 'string' && low !== '') lines.push(low);
      }
      if (cfg.styleEnabled !== false) {
        const line = stylePromptLine(style().get(chatId) ?? createStyleProfile());
        if (typeof line === 'string' && line !== '') lines.push(line);
      }
      if (lines.length === 0) return null;
      return ['以下是此刻的状态（照它说话即可，不要提及这段说明）：', ...lines].join('\n');
    } catch {
      return null;
    }
  }

  /**
   * 摘闸：把原型上本模块的层剥掉，其余模块的层原样保留并重接。
   *
   * 为什么关掉开关必须走这一步，而不是只在 `scan` 里早退：`handleInbound` 是
   * **共享挂载点**（stamp 也挂着），上一轮挂上的本模块层会原样留在原型上。层内部
   * 虽然也读同一个 `cfg`（访问器）而看起来跟着关，但拿着旧 cfg 快照的实例（热重载
   * 前那个）不会被关掉。所以「关掉」的语义要走到底。
   *
   * 剥层用 `patchMethod.unpatch`（core/patch.js），**不在这里自己写**：本模块的层
   * 会被 stamp 压在下面（`stamp -> persona -> base`），自己写的「只看链头」那版
   * 会直接 `return false` —— 闸关不掉，而 `POST /module` 还报成功。
   *
   * 注意 `extraFor`（情绪行注入）不在这里管：它走 prompt 的 `agent/pre-step`
   * 通道，自己读 `cfg.enabled` 自查，不依赖原型上的层。
   *
   * @returns {Promise<boolean>} 是否真的剥掉了一层。
   */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  /** 一次补挂扫描。 */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    if (cfg.enabled === false) {
      // 关掉时把闸摘掉，而不是留着（见 detach 的注释）。
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.resolveError = found.error;
      return { ok: false, error: found.error };
    }
    stats.profileDir = found.profileDir;
    stats.resolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    // 取上游的 buildChatId（失败不阻断，只是本模块的记账会停摆）。
    // 放进 state 而不是闭包捕获：patchMethod 的包装函数必须是**纯函数**
    // （链重排会重造所有层），闭包捕获会带到陈旧的引用。
    try {
      const chatUrl = moduleUrl(ctx, cfg, CHAT_FILE);
      const chatMod = await import(chatUrl);
      const resolved = chatMod?.[CHAT_EXPORT];
      if (typeof resolved !== 'function') throw new Error(`未导出 ${CHAT_EXPORT}`);
      state.buildChatId = resolved;
      stats.chatIdResolveError = null;
      // 正向标记：只报 `chatIdResolveError === null` 无法区分「取到了」和
      // 「还没扫到」，排查时会看不出入站记账到底有没有在跑。
      stats.chatIdResolver = `chat.js#${CHAT_EXPORT}`;
    } catch (error) {
      state.buildChatId = null;
      stats.chatIdResolver = null;
      stats.chatIdResolveError = `未取到 chat.js 的 ${CHAT_EXPORT}（${describeThrown(error)}）`;
      log('warn', stats.chatIdResolveError);
    }

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;

    // 入站：记「用户说话了」（情绪 + 风格样本）。
    if (patchMethod(proto, 'handleInbound', MODULE_ID, (original) =>
      function companionPersonaHandleInbound(event, opts) {
        try {
          if (cfg.enabled === false) return original.call(this, event, opts);
          state.lastReceiver = this;
          // 传进来的是**原始 OneBot 事件**，没有 chatId —— 必须用上游
          // buildChatId 现推。2026-10-18 之前这里取 `inbound?.chatId`，
          // 永远是 undefined，入站回血一次都没生效（详见 chatIdOfEvent 注释）。
          const chatId = state.buildChatId ? chatIdOfEvent(event, state.buildChatId) : null;
          if (typeof chatId === 'string') {
            const now = Date.now();
            // 群聊里 `buildChatId('group', gid)` 拼出来的只有群号，含不下发言人；
            // 亲密度是「对谁」的量，所以得把原始事件的 user_id 一起递下去。
            noteMood(chatId, 'user', now, { userId: event?.user_id });
            if (cfg.styleEnabled !== false) {
              const kind = chatId.startsWith('private:') ? 'private' : 'group';
              noteStyle(chatId, plainOfInbound(eventTextOf(event)), kind, now);
            }
            // 对方真发话了 → 解除「搭过没回」的静默锁（见 proactive.js noteUserReply）。
            state.scheduler?.noteUserReply?.(chatId);
            // 生物钟（2026-10-21）：记「他在这个钟点出现了」。旁路给 circadian，
            // 理由同 onAssistantText —— chatId 已算好，不必再挂一层。
            //
            // 只记**私聊那条线**：群聊里说话的是群友，把群友的作息学成「他的作息」
            // 会让曲线彻底失真（他本人可能一个月没在群里冒头，而曲线显示他活跃）。
            if (typeof onUserText === 'function' && chatId.startsWith('private:')) {
              try {
                onUserText(chatId, now, event?.user_id);
              } catch {
                /* 记作息失败不影响消息投递 */
              }
            }
          }
        } catch (error) {
          // 记状态失败绝不能影响消息投递。
          stats.lastError = describeThrown(error);
          log('warn', `入站状态记录失败: ${describeThrown(error)}`);
        }
        return original.call(this, event, opts);
      }, rel)) patched += 1;

    // 会话事件：借它拿到 bridge 实例；顺便记「她说话了」。
    if (patchMethod(proto, 'onSessionEvent', MODULE_ID, (original) =>
      function companionPersonaOnSessionEvent(session, event) {
        try {
          if (cfg.enabled === false) return original.call(this, session, event);
          state.lastReceiver = this;
          const chatId = this?.bySession?.get?.(session?.id);
          if (typeof chatId === 'string') {
            if (event?.type === 'assistant/message') {
              const now = Date.now();
              // 这一步用了几个工具 → 干活比说话更耗电（2026-10-23）。
              // 一条 `assistant/message` 是一个 step；一个 step 里可能挂着好几个
              // tool-call（并行调用时）。按条数加扣，见 mood.js 的 noteAssistantMessage。
              noteMood(chatId, 'assistant', now, {
                toolCalls: toolCallCountOf(event?.data?.message),
              });
              // 这里**故意不**记风格样本（2026-10-15 修）。
              // 风格画像的语义是「对方平时怎么说话」（style.js 头注释），
              // 而这条分支拿到的是**云玥自己**的回复。曾经在这里调
              // noteStyle(...)，于是画像越来越像她自己：她说长 → 画像记
              // 「平均 N 个字」变大 → 提示词鼓励说更长。实测 style-state.json
              // 里 3 条原话样本全是云玥自己写的、平均值从 28 一路涨到 32，
              // 而示例用户真实发言平均只有 10.2 字。**风格只能从入站学。**

              // 她说了什么 → 旁路给 sleep 判断「是不是要去睡了」（2026-10-18）。
              // 放在这里而不是新 patch 一个方法：chatId 已经算好了，事件形状也
              // 是宿主给的正规形状（`event.data.message` 是完整 assistant 消息）。
              if (typeof onAssistantText === 'function') {
                try {
                  const said = textOfMessage(event?.data?.message);
                  if (said !== '') onAssistantText(chatId, said, now);
                } catch {
                  /* 旁路出错不影响情绪记录 */
                }
              }

              // 她这一轮花了多少 → 旁路给 quota 记账（2026-10-20）。
              // usage 在事件里是 `event.data.usage`（宿主每步都给），形状为
              // `{inputTokens, outputTokens, cacheReadTokens, totalTokens}`。
              // 同样放在这里：chatId 已算好，也不必再 patch 一层。
              if (typeof onSessionUsage === 'function') {
                try {
                  const usage = event?.data?.usage;
                  const said = textOfMessage(event?.data?.message);
                  if (usage !== undefined || said !== '') {
                    onSessionUsage({ usage, outChars: said.length, chatId });
                  }
                } catch {
                  /* 记账出错不影响情绪记录 */
                }
              }
            } else if (event?.type === 'turn/end') {
              // 回合结束 → 允许评估主动开口（刚聊完不会被马上搭话，由 noteActivity 保证）。
              state.scheduler?.noteActivity?.(chatId);
            }
          }
        } catch (error) {
          stats.lastError = describeThrown(error);
        }
        return original.call(this, session, event);
      }, rel)) patched += 1;

    return { ok: true, patched };
  }

  /** 启动/停止调度器（由 index.js 的 effect 调用）。 */
  function start() {
    state.scheduler?.start?.();
  }
  function stop() {
    state.scheduler?.stop?.();
  }

  /** 只读快照，给 HTTP 面与状态文件用。 */
  function snapshot() {
    const now = Date.now();
    const out = {};
    try {
      for (const chatId of mood().keys()) {
        out[chatId] = moodSnapshot(moodOf(chatId, now), now);
      }
    } catch {
      /* 读状态失败不该影响观测面 */
    }
    return out;
  }

  /**
   * 全局身体状态（精力）的只读快照。
   *
   * 为什么要单独一个：`snapshot()` 是按 chatId 出键的，而精力现在只有一份 ——
   * 塞进任何一条 chat 记录都等于谎称「这个会话的电量」。面板要能分开显示，
   * 就得有个不挂在 chat 上的出口。
   *
   * 读的时候**顺手推进**漂移并写回，和 `moodOf()` 的行为一致：面板每 30 秒刷一次，
   * 不推进的话显示的电量会僵在上次聊天时的值。
   * @returns {{ energy: number|null, lastDriftAt: number|null }}
   */
  function bodySnapshot(now = Date.now()) {
    try {
      const rec = body().get(BODY_KEY);
      if (rec === undefined || rec === null) return { energy: null, lastDriftAt: null };
      const energy = driftEnergyOnly(rec.energy, rec.lastDriftAt, now, moodConfig());
      body().set(BODY_KEY, { energy, lastDriftAt: now });
      body().saveDebounced();
      return { energy, lastDriftAt: now };
    } catch (error) {
      stats.lastError = describeThrown(error);
      return { energy: null, lastDriftAt: null };
    }
  }

  /**
   * 认识的人的只读快照（亲密度按账号）。
   *
   * `chatIds` 是从 chat 记录反推的：私聊 `private:<uid>` 直接对上 `u:<uid>`；
   * 群聊只能靠 `lastSpeaker`（那个人最后在这个群里说过话）反推 —— 这是**近似**，
   * 面板上标清楚，不要拿它当「这个人参与过哪些群」的完整名单。
   *
   * @returns {Array<object>} 按亲密度降序。
   */
  function peopleSnapshot(now = Date.now()) {
    const out = [];
    const cfg = moodConfig();
    let keys = [];
    try {
      keys = people().keys();
    } catch {
      return out;
    }
    // chat 层反查：这个人被哪些会话提到过。
    const chatsByPerson = new Map();
    try {
      for (const chatId of mood().keys()) {
        const rec = mood().get(chatId);
        const text = String(chatId ?? '');
        const idx = text.indexOf(':');
        if (idx < 0) continue;
        const kind = text.slice(0, idx);
        const target = text.slice(idx + 1);
        if (target === '') continue;
        let key = null;
        if (kind === 'private') key = 'u:' + target;
        else if (kind === 'group' && typeof rec?.lastSpeaker === 'string' && rec.lastSpeaker !== '') {
          key = 'u:' + rec.lastSpeaker;
        }
        if (key === null) continue;
        if (!chatsByPerson.has(key)) chatsByPerson.set(key, []);
        chatsByPerson.get(key).push(chatId);
      }
    } catch {
      /* 反查失败不影响主投影 */
    }
    for (const key of keys) {
      try {
        const rec = people().get(key);
        if (rec === undefined || rec === null) continue;
        const lastContactAt = Math.max(rec.lastUserAt ?? 0, rec.lastAssistantAt ?? 0);
        const affinity = driftAffinityOnly(
          rec.affinity,
          lastContactAt,
          rec.lastDriftAt ?? now,
          now,
          cfg,
        );
        const raw = String(key);
        const target = raw.startsWith('u:') || raw.startsWith('g:') ? raw.slice(2) : raw;
        out.push({
          key: raw,
          // 账号是 u: 前缀的才叫人；g: 是「群本身」这个兜底键（见 personKeyOf）。
          label: raw.startsWith('u:') ? target : `群 ${target}`,
          affinity,
          lastContactAt,
          chatIds: chatsByPerson.get(raw) ?? [],
        });
      } catch {
        /* 单条坏记录跳过 */
      }
    }
    return out;
  }

  function styleSnapshot() {
    const out = {};
    try {
      for (const chatId of style().keys()) {
        const profile = style().get(chatId) ?? createStyleProfile();
        out[chatId] = {
          samples: profile.samples,
          totalChars: profile.totalChars,
          topParticles: topParticles(profile),
          emoji: profile.emoji,
          emojiMessages: profile.emojiMessages,
          samples_: profile.samples_,
        };
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  return {
    MODULE_ID,
    scan,
    detach,
    start,
    stop,
    state,
    extraFor,
    noteGuiStep,
    snapshot,
    bodySnapshot,
    peopleSnapshot,
    styleSnapshot,
    noteMood,
    noteStyle,
    /**
     * 接上长期底色的偏向来源（`temper.current`）。
     *
     * 只存回调不存值：`moodConfig()` 每次现取，所以接一次就够，此后底色自己变。
     * 传非函数等于断开（回到「不受底色影响」）。
     *
     * @param {(() => Record<string, number>)|null} fn
     */
    setBiasSource(fn) {
      state.biasOf = typeof fn === 'function' ? fn : null;
      return { ok: true };
    },
    /**
     * 接上生物钟的夜间掩码来源（`circadian.nightSet`）。
     *
     * 与 `setBiasSource` 同样的契约：只存回调、每次现取；传非函数等于断开
     * （回到固定的 `nightStartHour/nightEndHour`）。
     *
     * @param {(() => boolean[]|null)|null} fn
     */
    setNightMaskSource(fn) {
      state.nightMaskOf = typeof fn === 'function' ? fn : null;
      return { ok: true };
    },
    /**
     * 接上生活节奏 / 对话密度的来源（`tempo.intensity`，2026-10-22）。
     *
     * 与上面两个同样的契约：只存回调、每次现取；传非函数等于断开（倍率恒为 1，
     * 行为退回加 tempo 之前）。
     *
     * 回调要返回 `{ cadence, factor }`；`factor` 非有限数时按 1 处理。
     *
     * @param {((chatId: string, now: number) => {cadence:string, factor:number})|null} fn
     */
    setTempoSource(fn) {
      state.tempoOf = typeof fn === 'function' ? fn : null;
      return { ok: true };
    },
    /**
     * 用一份**算好的**画像替换某个 chat 的风格画像。
     *
     * 存在的理由是运行期之外的语料：style 只在收到入站消息时逐条学，开局是空的，
     * 而真实聊天记录（几万条）在盘上躺着。这个口子把离线统计结果直接放进来，
     * 让云玥第一天就知道对方什么调子。
     *
     * 只收画像对象、不收消息数组 —— 统计必须由 `style.js` 的
     * `mergeStyleSample` 完成（那是唯一保证与运行时一致的算法），
     * 调用方算好再传进来。传进来的东西会被 `normalizeStyleProfile` 过一遍，
     * 缺字段补零，防止手写 JSON 把注入渲染成 `NaN 个字`。
     *
     * @param chatId - 形如 `private:100000001`。
     * @param profile - `style.js` 的画像对象。
     */
    seedStyle(chatId, profile) {
      if (typeof chatId !== 'string' || chatId === '') {
        return { ok: false, reason: 'chatId 不能为空' };
      }
      const store = style();
      const before = store.get(chatId);
      const next = normalizeStyleProfile(profile);
      store.set(chatId, next);
      void store.flush();
      return {
        ok: true,
        chatId,
        before: before
          ? { samples: before.samples, totalChars: before.totalChars, samples_: before.samples_?.length ?? 0 }
          : null,
        after: { samples: next.samples, totalChars: next.totalChars, samples_: next.samples_.length },
        line: stylePromptLine(next).trim(),
      };
    },
    moodOf,
    scheduler: state.scheduler,
    /** 状态目录（mediaDir）当前解析成什么 —— 观测面用它确认「有没有接到历史数据」。 */
    dir: () => resolvedDir,
    flush: async () => {
      await Promise.allSettled([mood().flush(), style().flush(), body().flush(), people().flush()]);
    },
    load: async () => {
      await Promise.allSettled([mood().load(), style().load(), body().load(), people().load()]);
    },
    METHODS,
    TARGET,
  };
}

/**
 * 从会话 id 反推 chatId。
 *
 * `dsh-onebot-qq/lib/chat.js:39` 把 chatId 里的非字母数字字符换成 `-`：
 * `onebot-private-100000001-muwexn8r` 这种尾巴是随机会话后缀，chatId 本体是
 * `private:100000001`。这里只做**能确定**的还原：`onebot-group-<gid>` 与
 * `onebot-private-<uid>` 的前两段，多余后缀丢弃。
 *
 * 还原不出来返回 null —— 宁可不注入状态，也不能给错的 chat 注入（那会让 A 的
 * 情绪跑到 B 的对话里）。
 */
export function chatIdOfSession(sessionId) {
  const s = String(sessionId ?? '');
  if (!s.startsWith('onebot-')) return null;
  const rest = s.slice('onebot-'.length);
  const m = /^(group|private)-([0-9]+)/.exec(rest);
  if (!m) return null;
  return `${m[1]}:${m[2]}`;
}

/** 本模块的默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /** 状态目录（`mediaDir`）：继续用云玥的 `.dsh-media` 以继承历史数据。 */
  mediaDir: '',
  /** 情绪行注入。 */
  moodEnabled: true,
  /** 风格学习。 */
  styleEnabled: true,
  /** 主动发言总开关。 */
  proactiveEnabled: true,
  /** 心情重掷最小间隔（分钟）。 */
  moodDriftMinutes: 20,
  energyDecayPerHour: 7,
  /**
   * 每个工具调用额外扣多少精力（2026-10-23）。不填就用 mood.js 的常量。
   *
   * 用户问「工作区干活的时候你不消耗精力？」——此前干活和纯聊天扣得一样多，
   * 账是反的。这里只加「按工具数加扣」这一件事，其它耗电口径一个字没动。
   */
  energyPerToolCall: 0.4,
  /** 每轮工具加扣的上限（再忙也不会因为一轮任务当场被打空）。 */
  toolCallEnergyCap: 4,
  nightRecoveryPerHour: 14,
  nightStartHour: 0,
  nightEndHour: 8,
  affinityDecayPerHour: 0.8,
  affinityGraceHours: 6,
  /** 热情基线：没在聊时的默认温度。 */
  warmthBaseline: 30,
  warmthRegressPerHour: 10,
  warmthJitter: 8,
  /** 主动开口的概率基准。 */
  proactiveChance: 0.45,
  /**
   * 只对这些 chat 主动开口（空 = 不限制）。
   *
   * 用户硬约束：「主动只对我，我才是管理员」。允许写纯 QQ 号（`"100000001"`，
   * 与旧私有实现的 `proactiveOnlyChats` 同形）或完整 chatId（`"private:100000001"`）。
   */
  proactiveOnlyChats: [],
  /**
   * 亲密度只对谁涨（2026-10-21）。
   *
   * 空 = 老行为「谁说话涨谁」（群友也会各攒一份，涨到 100）。非空则名单外的人
   * 只涨到 `affinityCapOthers` 就封顶。写法同 `proactiveOnlyChats`：纯号或完整 chatId。
   *
   * 起因：亲密度只对特定的人涨 → 随后改成「可以涨，除特定人以外上限 33」
   * —— 现在配的就是 `["100000001"]`。
   */
  affinityOnlyChats: [],
  /**
   * 名单外的人亲密度封顶值（2026-10-21，用户定 33）。
   *
   * 33 落在 `tierOf` 的 stranger 段（<35），也就是「她跟别人永远是刚认识」。
   * 只在 `affinityOnlyChats` 非空时起作用，名单里的人不受这条限制。
   */
  affinityCapOthers: AFFINITY_CAP_OTHERS_DEFAULT,
  /** 两次评估之间的随机间隔区间（分钟）。 */
  proactiveMinMinutes: 25,
  proactiveMaxMinutes: 150,
  /** 静默多久才够格被搭话（分钟）。 */
  proactiveIdleMinutes: 20,
  /** 每天每 chat 最多主动几次。 */
  proactiveMaxPerDay: 6,
  /** 安静时段（小时），默认深夜不打扰。 */
  proactiveQuietStart: 1,
  proactiveQuietEnd: 8,
  /**
   * 深夜档（小时，可跨零点）：这个区间里搭话只轻声说一句，不问问题、不催回。
   * 默认 23:00–02:00 —— 与 quietStart 之间正好夹出「23–24 点、0–1 点」这两个
   * 「他还醒着但快睡了」的窗口。
   */
  proactiveDeepNightFrom: 23,
  proactiveDeepNightTo: 2,
  /**
   * 「搭过一句他还没回」的锁最长锁多久（小时）。超时作废，允许再开口。
   * 完全锁死不对：他可能睡一整夜、或出门一整天，那之后她该能再说一句。
   */
  proactiveAwaitReplyHours: 16,
  /**
   * GUI 会话也算谁的账（2026-10-20）。
   *
   * 背景：情绪/精力/亲密度只在 OneBot 那条线上记账 —— 收消息记一笔、她回话记
   * 一笔。于是「在网页 GUI 里跟她聊了一整天」对亲密度毫无影响（实测聊了十几小时
   * 还是 53.39），因为 GUI 会话 id 是 `session-xxx`，不满足 `onebot-` 前缀，
   * 在 pre-step 里被直接放行。
   *
   * 用户的情形是「只能远程，用反代开 GUI」，所以不能靠来源 IP 认人。判据换成
   * **消息来源**：GUI 里真人敲进来的消息，`source.kind === 'user'` 且带 `rpcId`；
   * 时间上下文、会话时钟、自动改标题、记忆注入这些也都是 `role: 'user'`，但
   * `source.kind` 分别是 `time-context` / `session-clock` / `dsh-session-title-llm`
   * / `dsh-mnemon`。只认前者。
   *
   * 留空 = 不记（默认）。写成 chatId，例如 `"private:100000001"`。
   */
  guiChatId: '',
  /**
   * 同一批 messages 里最多补记几条 —— 防止首次接管一个几百轮的旧会话时，
   * 一次性把亲密度灌满。
   */
  guiCatchUpMax: 4,
};
