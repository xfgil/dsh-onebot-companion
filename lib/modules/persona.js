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
 * ## 四个变量为什么是四个（用户原话催生的设计）
 *
 * 用户原话（session-57e438c4）：「再加个热情变量?不亲密也可以聊的火热啊」。
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
 * ## 为什么不用 cron（用户原话）
 *
 * 用户原话（m10154）：「定时还是算了，你还不如搞个随机变量」。所以主动发言
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
  createMoodState,
  driftMood,
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
import { describeThrown, loadTargetClass } from '../core/profile.js';

export const MODULE_ID = 'persona';

const TARGET = { file: 'bridge.js', exportName: 'ChatBridge' };
const METHODS = ['handleInbound', 'onSessionEvent'];

/**
 * 主动开口的触发文本。
 *
 * **关键设计**：这段话是**框架写的**（不是对方可控的内容），所以刻意放在
 * `<user_message>` 边界**之外**、带自己的 `<proactive_turn>` 标签 —— 模型必须
 * 能分清「我自己决定开口」和「他给我发消息」。不区分的话，主动聊天的幻觉就塌了
 * （她会以为对方真说了什么，然后去回应一句根本不存在的话）。
 */
function proactiveTriggerText(gap) {
  const gapAttr = gap === '' ? '' : ` gap="${gap}"`;
  return (
    `<proactive_turn${gapAttr}>\n` +
    '现在没人给你发消息，是你主动开口的时候。想说什么就说什么，' +
    '别提「我主动来找你」这种话，就像你忽然想起他一样。\n' +
    '</proactive_turn>'
  );
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

/** 从一条入站消息里抠出纯文本（去掉 `<user_message>` 包装与群前缀）。 */
export function plainOfInbound(text) {
  const s = String(text ?? '');
  const m = /<user_message[^>]*>\n?([\s\S]*?)\n?<\/user_message>/.exec(s);
  return (m ? m[1] : s).trim();
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
 */
export function createPersona({ cfg, stats, patchMethod, log, random = Math.random }) {
  const state = {
    /** @type {*} 最近一次见到的 ChatBridge 实例（调度器要用它的 chats 表）。 */
    lastReceiver: undefined,
    moodStore: undefined,
    styleStore: undefined,
    scheduler: undefined,
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
    // 首次建立时把磁盘上的历史读回来（异步，不阻塞调用方）。
    void Promise.allSettled([moodStore.load(), styleStore.load()]).catch(() => undefined);
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

  /** 情绪相关配置（透传给 mood.js 的纯函数）。 */
  const moodConfig = () => ({
    moodDriftMinutes: cfg.moodDriftMinutes,
    energyDecayPerHour: cfg.energyDecayPerHour,
    nightRecoveryPerHour: cfg.nightRecoveryPerHour,
    nightStartHour: cfg.nightStartHour,
    nightEndHour: cfg.nightEndHour,
    affinityDecayPerHour: cfg.affinityDecayPerHour,
    affinityGraceHours: cfg.affinityGraceHours,
    warmthBaseline: cfg.warmthBaseline,
    warmthRegressPerHour: cfg.warmthRegressPerHour,
    warmthJitter: cfg.warmthJitter,
    proactiveChance: cfg.proactiveChance,
  });

  /** 取（并推进）某 chat 的情绪状态。漂移结果会写回，让时间真的流逝。 */
  function moodOf(chatId, now = Date.now()) {
    const store = mood();
    const stored = store.get(chatId);
    const base = stored ?? createMoodState(now);
    const drifted = driftMood(base, now, random, moodConfig());
    if (stored !== undefined) store.set(chatId, drifted);
    return drifted;
  }

  function noteMood(chatId, kind, now = Date.now()) {
    try {
      const store = mood();
      const current = moodOf(chatId, now);
      const next =
        kind === 'user'
          ? noteUserMessage(current, now)
          : kind === 'assistant'
            ? noteAssistantMessage(current, now)
            : noteProactive(current, now);
      store.set(chatId, next);
      store.saveDebounced();
      return next;
    } catch (error) {
      stats.lastError = describeThrown(error);
      return null;
    }
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
    const text = proactiveTriggerText(gap);

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
        return proactiveChance(moodOf(chat.chatId), Date.now(), moodConfig());
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
      const chatId = chatIdOfSession(sessionId);
      if (chatId === null) return null;
      const lines = [];
      if (cfg.moodEnabled !== false) {
        const now = Date.now();
        lines.push(moodPromptLine(moodOf(chatId, now), now, moodConfig()));
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

  /** 一次补挂扫描。 */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    if (cfg.enabled === false) return { ok: true, patched: 0 };

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.resolveError = found.error;
      return { ok: false, error: found.error };
    }
    stats.profileDir = found.profileDir;
    stats.resolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;

    // 入站：记「用户说话了」（情绪 + 风格样本）。
    if (patchMethod(proto, 'handleInbound', MODULE_ID, (original) =>
      function companionPersonaHandleInbound(inbound) {
        try {
          if (cfg.enabled === false) return original.call(this, inbound);
          state.lastReceiver = this;
          const chatId = inbound?.chatId;
          if (typeof chatId === 'string') {
            const now = Date.now();
            noteMood(chatId, 'user', now);
            if (cfg.styleEnabled !== false) {
              const kind = chatId.startsWith('private:') ? 'private' : 'group';
              noteStyle(chatId, plainOfInbound(inbound?.text), kind, now);
            }
            state.scheduler?.noteActivity?.(chatId);
          }
        } catch (error) {
          // 记状态失败绝不能影响消息投递。
          stats.lastError = describeThrown(error);
          log('warn', `入站状态记录失败: ${describeThrown(error)}`);
        }
        return original.call(this, inbound);
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
              noteMood(chatId, 'assistant', now);
              if (cfg.styleEnabled !== false && chatId.startsWith('private:')) {
                noteStyle(chatId, textOfMessage(event?.data?.message), 'private', now);
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
    start,
    stop,
    state,
    extraFor,
    snapshot,
    styleSnapshot,
    noteMood,
    noteStyle,
    moodOf,
    scheduler: state.scheduler,
    /** 状态目录（mediaDir）当前解析成什么 —— 观测面用它确认「有没有接到历史数据」。 */
    dir: () => resolvedDir,
    flush: async () => {
      await Promise.allSettled([mood().flush(), style().flush()]);
    },
    load: async () => {
      await Promise.allSettled([mood().load(), style().load()]);
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
};
