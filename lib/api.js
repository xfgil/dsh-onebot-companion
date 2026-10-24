/**
 * dsh-onebot-companion / api.js
 *
 * 本插件对**其它插件**开放的那一面。
 *
 * ## 为什么要有这个文件（2026-10-21）
 *
 * 当时的决定（大意）：停止在现有包里加功能，先把接口开出来，
 * 以后有新想法就另开插件。
 *
 * 在此之前，想给云玥加一个新能力（比如「撤回感知」「群聊先评分再唤醒」），只有
 * 一条路：钻进 `lib/index.js` 里改装配、在某个模块里插桩。`index.js` 因此长到
 * 了一千八百多行，改一处要通读上下文，改坏了还得整包回滚 —— 而它承载的是**一
 * 条正在跑的聊天线**，回滚的代价是她在 QQ 上哑掉。
 *
 * 所以这里把「她已经有的能力」按稳定形状交出去：
 *
 *     const api = ctx.get('onebotCompanion');   // 或 ctx.inject(['onebotCompanion'], cb)
 *     await api.say('private:123', '在呢');
 *
 * 新功能自己开一个包，`ctx.inject(['onebotCompanion'])` 拿到这里的东西，用它发
 * 消息、读情绪、挂原型，**一行都不用改本插件**。
 *
 * ## 这个面和「内部模块」的区别
 *
 * 里面那 30 多个模块的导出是**内部**的：`createMood` 返回什么、`noteMood` 收几个
 * 参数，随时可能因为修一个 bug 而变。这个文件是**契约**：改了要写进 `CHANGELOG`
 * 那个 `API_VERSION` 并说明迁移方式。所以：
 *
 * - 这里只放「新插件真的会用到」的东西，不放「内部实现细节」；
 * - 每个模块实例原样递出去（`diary` / `promise` / …），但**只保证它们已经公开的
 *   那几个方法**；想用它的私有字段，那是在赌。
 * - 版本号是整数，只增不减。加字段不改它，改语义或删字段才加一。
 *
 * ## 为什么不做「事件总线挂在原型上」
 *
 * 最自然的入站钩子当然是「本插件把 `handleInbound` 包一层，再往外广播」。但那要
 * 在 `persona` 的包装里插代码 —— 正是用户说别做的事，而且会让一条已经调好的
 * 消息路径多一个 try/catch 和一次函数调用，出事时更难查。
 *
 * 这里给的是**更底层但更干净**的东西：`patchMethod`。新插件想挂 `handleInbound`
 * 就自己挂，用同一套「按模块身份脱链」的逻辑（`core/patch.js`），层序由
 * `MODULE_PRIORITY` 统一决定，不会和本插件的层互相踩。它比事件总线强的地方在于
 * 新插件能**改写**消息（改文本、加段、拦下来），而不只是旁听。
 *
 * 真正「只旁听」的场景也不缺：`agent/pre-step` 有 `onPreStep`（本插件已经挂了
 * 那个钩子，顺手广播一份代价极小），它拿得到本轮全部 messages。
 *
 * @module dsh-onebot-companion/api
 */

import { chatIdOfEvent } from './modules/persona.js';

/** 对外面的契约版本。改语义/删字段才 +1，纯加字段不动它。 */
export const API_VERSION = 1;
/** 暴露给其它插件的服务名（`ctx.get('onebotCompanion')`）。 */
export const SERVICE_NAME = 'onebotCompanion';

/**
 * 造一份对外接口。
 *
 * 全部参数都是「取的时候再取」的函数，不是值 —— 因为 `apply()` 里这些对象是陆
 * 续建起来的，而入站通道（`ChatBridge` 实例）要到第一条消息进来才存在。任何一
 * 个提前拍下来的值都会是 `undefined`。
 *
 * @param {object} deps
 * @param {string} deps.name 插件名（`dsh-onebot-companion`）
 * @param {object} deps.cfg 合并后的活配置（只读用途；改它不写回 yml）
 * @param {object} deps.stats 运行统计
 * @param {(level: string, message: string) => void} deps.log
 * @param {() => string} deps.mediaDir 媒体目录（情绪/日记/表情包都落在它下面）
 * @param {() => any} deps.receiver 最近一次见到的 ChatBridge 实例
 * @param {(sessionId: string) => (string|null)} deps.chatIdOfSession
 * @param {() => any} deps.persona
 * @param {() => any} deps.hands
 * @param {() => any} deps.voice
 * @param {() => any} deps.diary
 * @param {() => any} deps.promise
 * @param {() => any} deps.unsaid
 * @param {() => any} deps.quota
 * @param {() => any} deps.sticker
 * @param {() => any} deps.phone
 * @param {() => any} deps.isolation
 * @param {() => any} deps.sleep
 * @param {() => any} deps.sticker 表情包图库
 * @param {Function} deps.patchMethod 原型挂载器（`core/patch.js`）
 * @param {Function} deps.onPreStep 订阅 agent/pre-step（返回取消订阅函数）
 * @returns {object} 冻结的接口对象
 */
export function createApi(deps) {
  const {
    name,
    cfg,
    stats,
    log,
    mediaDir,
    receiver,
    chatIdOfSession,
    persona,
    hands,
    voice,
    diary,
    promise,
    unsaid,
    quota,
    sticker,
    phone,
    isolation,
    lastword,
    phoneSourceList,
    patchMethod,
    onPreStep,
  } = deps ?? {};

  /** 取一个「现在可能还没建好」的实例，永远不抛。 */
  const safe = (getter) => {
    try {
      return getter?.() ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 发一条文字。
   *
   * 走的是 `ChatBridge#sendToChat` —— **和云玥自己说话完全同一条路**，于是出站
   * 闸（`[[silent]]`、括号旁白、分段）照样生效。新插件不该绕开这层直接调 OneBot，
   * 除非它明确要发工具不该发的东西（那就用 `callAction`）。
   *
   * @param {string} chatId `private:<QQ号>` 或 `group:<群号>`
   * @param {string} text
   */
  async function say(chatId, text) {
    const bridge = receiver?.() ?? null;
    if (bridge === null || typeof bridge.sendToChat !== 'function') {
      throw new Error('QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试');
    }
    return bridge.sendToChat(chatId, text);
  }

  /**
   * 发一条消息段（图、表情、语音混排都走这里）。
   *
   * 段格式就是 OneBot 11：`[{ type:'text', data:{ text:'…' } }, …]`。
   */
  async function sendSegments(chatId, segments) {
    const bridge = receiver?.() ?? null;
    if (bridge === null || typeof bridge.sendSegments !== 'function') {
      throw new Error('QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试');
    }
    return bridge.sendSegments(chatId, segments);
  }

  /**
   * 直接调一个 OneBot action（不经出站闸）。
   *
   * 给「本来就不是回话」的动作留的：`get_group_msg_history`、`set_group_card`、
   * 撤回、戳一戳之类。**别用它发聊天内容** —— 那样会绕开 `[[silent]]` 与分段。
   */
  async function callAction(action, params) {
    const h = safe(hands);
    if (h === null || typeof h.callAction !== 'function') {
      throw new Error('hands 模块没有 callAction（插件版本过旧？）');
    }
    return h.callAction(action, params);
  }

  /**
   * 某个会话最近一条**入站**消息的 id —— 贴表情、撤回、回复要引用它。
   *
   * 只记最近 200 个会话，重启后清空。返回 `{ messageId, at }` 或 null。
   */
  function lastInbound(chatId) {
    const h = safe(hands);
    const map = h?.lastMessage;
    if (!(map instanceof Map)) return null;
    const item = map.get(String(chatId ?? ''));
    return item === undefined ? null : { messageId: item.messageId, at: item.at };
  }

  /** 此刻这个 chat 的四个量合成值（精力/亲密度已按分层取好）。 */
  function moodOf(chatId, extra = {}) {
    const p = safe(persona);
    if (p === null || typeof p.moodOf !== 'function') return null;
    try {
      return p.moodOf(String(chatId ?? ''), Date.now(), extra) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 三层的快照。与体检表 HTTP 面用的是同一批函数，数一定对得上。
   *
   * - `body`：全局一份精力
   * - `people`：按账号记的亲密度
   * - `moods`：按会话记的心情 / 热情
   */
  function snapshot() {
    const p = safe(persona);
    if (p === null) return { body: null, people: [], moods: {}, style: null };
    const out = { body: null, people: [], moods: {}, style: null };
    try {
      out.body = p.bodySnapshot?.() ?? null;
    } catch {
      /* 单项失败不影响别的 */
    }
    try {
      out.people = p.peopleSnapshot?.() ?? [];
    } catch {
      /* 同上 */
    }
    try {
      out.moods = p.snapshot?.() ?? {};
    } catch {
      /* 同上 */
    }
    try {
      out.style = p.styleSnapshot?.() ?? null;
    } catch {
      /* 同上 */
    }
    return out;
  }

  /** 她最后开口是什么时候、说了什么（`lastword` 模块记的）。 */
  function lastSpoke() {
    const lw = safe(lastword);
    if (lw === null || typeof lw.snapshot !== 'function') return null;
    try {
      const s = lw.snapshot();
      return { at: s.lastAt ?? null, chatId: s.lastChat ?? null, text: s.lastText ?? null, ago: s.ago ?? null };
    } catch {
      return null;
    }
  }

  /**
   * 读一份插件配置。
   *
   * **只读**：这里给的是活配置对象的引用，改它不会写回 `cordis.yml`，重启就没了。
   * 要改运行态请用各自模块的 `applyConfig`（如 `voice.applyConfig`）。
   */
  function config(section) {
    if (section === undefined) return cfg;
    return cfg?.[section] ?? null;
  }

  /** 一次简单的连通性检查：值全在才算活着。 */
  function health() {
    const bridge = receiver?.() ?? null;
    return {
      ok: bridge !== null,
      channel: bridge === null ? 'not-ready' : 'ready',
      mediaDir: (() => {
        try {
          return mediaDir?.() ?? '';
        } catch {
          return '';
        }
      })(),
      startedAt: stats?.startedAt ?? null,
      generations: stats?.generations ?? 0,
      toolCount: Array.isArray(stats?.tools) ? stats.tools.length : 0,
    };
  }

  const api = {
    // ── 身份 ────────────────────────────────────────────────────────────────
    version: API_VERSION,
    plugin: name,
    /** 宿主事件名，新插件照着挂 `ctx.on` 用。 */
    events: { preStep: 'agent/pre-step' },

    // ── 会话 ↔ chatId ───────────────────────────────────────────────────────
    /** `onebot-private-100000001-xxxx` → `private:100000001`；认不出给 null。 */
    chatIdOfSession: (sessionId) => {
      try {
        return chatIdOfSession?.(sessionId) ?? null;
      } catch {
        return null;
      }
    },
    /**
     * 原始 OneBot 事件 → chatId（群聊只含群号，因为 `buildChatId` 拼不进去发言人）。
     *
     * 上游 `buildChatId` 没取到时返回 null —— 宁可给 null 也不凭猜拼一个，拼错了
     * 会让 A 的情绪跑到 B 的账上。
     */
    chatIdOfEvent: (event) => {
      const p = safe(persona);
      const build = p?.state?.buildChatId;
      if (typeof build !== 'function') return null;
      try {
        return chatIdOfEvent(event, build) ?? null;
      } catch {
        return null;
      }
    },

    // ── 说话 ────────────────────────────────────────────────────────────────
    say,
    sendSegments,
    callAction,
    lastInbound,

    // ── 状态 ────────────────────────────────────────────────────────────────
    moodOf,
    snapshot,
    lastSpoke,
    config,
    health,
    stats: () => stats,
    log: (level, message) => {
      try {
        log?.(level, message);
      } catch {
        /* 日志失败不影响业务 */
      }
    },

    // ── 模块实例（原样给，只用它们已经公开的方法）────────────────────────────
    get persona() {
      return safe(persona);
    },
    get hands() {
      return safe(hands);
    },
    get voice() {
      return safe(voice);
    },
    get diary() {
      return safe(diary);
    },
    get promise() {
      return safe(promise);
    },
    get unsaid() {
      return safe(unsaid);
    },
    get quota() {
      return safe(quota);
    },
    get sticker() {
      return safe(sticker);
    },
    get phone() {
      return safe(phone);
    },
    get isolation() {
      return safe(isolation);
    },
    /** 刷手机的来源清单（只给 id 与名字；`url`/`parse` 是内部实现，不外露）。 */
    phoneSources: () => {
      const src = phoneSourceList;
      if (src === null || typeof src !== 'object') return [];
      return Object.entries(src).map(([id, v]) => ({ id, label: v?.label ?? id }));
    },

    // ── 扩展点 ──────────────────────────────────────────────────────────────
    /**
     * 往宿主原型上挂包装 —— 本插件自己也是这么干的。
     *
     * 用法与内部一致：`api.patchMethod(proto, 'handleInbound', 'my-module', (original) => function (...args) { … })`。
     * 第三个参数是**你自己模块的身份**，脱链靠它区分，别用别人的名字。
     */
    patchMethod,
    /** 订阅每轮模型调用前的 pre-step（旁听用，改了不影响决策）。 */
    onPreStep: (fn) => {
      if (typeof fn !== 'function' || typeof onPreStep !== 'function') return () => {};
      return onPreStep(fn);
    },
  };

  return Object.freeze(api);
}

export default { createApi, API_VERSION, SERVICE_NAME };
