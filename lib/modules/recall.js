/**
 * dsh-onebot-companion / modules/recall.js
 *
 * 「发错了，删了重说」—— 撤回自己刚发出去的话（2026-10-23）。
 *
 * ## 为什么做这个
 *
 * 用户很早以前提过一条，一直没做：「删除重打」。真人聊天里最真实的一类动作
 * 就是这个 —— 打出去、看一眼、觉得不对、撤回、重打。我们这边此前只有
 * 「话说完就发完了」这条路：说错就只能道歉，不能收回去。
 *
 * ## 为什么要记 message_id
 *
 * NapCat 的撤回是 `delete_msg { message_id }`，只认 id。而我们发出去之后
 * 从来不记 id —— `sendToChat` 的返回值（一个或多个 id）拿到就丢了。所以这个
 * 模块的第一件事是**把 id 记住**：包一层 `sendToChat` / `sendSegments`，
 * 把每次发出去的 id 按 chat 存进一张短表。
 *
 * ## 三条纪律
 *
 * 1. **只撤自己的**。表里只有我们发出去的 id，绝不接受外部传进来的 id ——
 *    否则一条提示词注入就能让她去删别人的消息。这是硬边界。
 * 2. **只在窗口内有效**。默认 5 分钟。更早的消息 QQ 本身也多半拒撤
 *    （服务端有 2 分钟 / 2 小时的档），而且「十分钟前那句说错了」在真人那儿
 *    也不叫「打错字」，那是「说错话」，得用嘴修，不是用手修。
 * 3. **撤完要记得**。撤掉的 id 从表里划掉，避免第二次撤同一个 id 报错刷日志。
 *
 * ## 与 `interrupt` 的分工
 *
 * `interrupt` 管的是「没发出去的那半句」（被他的新消息掐断）；
 * 这里管的是「已经发出去了、现在想收回的半句」。一个在发送路径中间，
 * 一个在发送完成之后，别合并。
 *
 * @module dsh-onebot/recall
 */

export const MODULE_ID = 'recall';

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 能撤回的窗口（毫秒）。5 分钟：再久就不是「打错字」了。 */
  windowMs: 5 * 60 * 1000,
  /** 每个 chat 最多记多少条 id（环形裁剪）。 */
  maxPerChat: 12,
  /** 一次最多撤几条。 */
  maxCount: 5,
});

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 往表里记一批 id（纯函数，不修改入参）。
 *
 * @param {object} table - `{ [chatId]: {id:number, at:number}[] }`
 * @param {string} chatId
 * @param {(string|number)[]} ids
 * @param {number} now
 * @param {object} [cfg]
 * @returns {object} 新表
 */
export function noteIds(table, chatId, ids, now, cfg = {}) {
  const src = table !== null && typeof table === 'object' ? table : {};
  const next = { ...src };
  const chat = typeof chatId === 'string' ? chatId.trim() : '';
  if (chat === '') return next;
  const list = Array.isArray(ids) ? ids.filter((x) => x !== undefined && x !== null) : [];
  if (list.length === 0) return next;

  const t = Number.isFinite(now) ? now : Date.now();
  const prev = Array.isArray(next[chat]) ? next[chat] : [];
  const merged = [...prev];
  for (const id of list) {
    const key = String(id);
    if (merged.some((x) => String(x.id) === key)) continue;
    merged.push({ id: key, at: t });
  }
  const max = Math.max(1, Math.trunc(numberOr(cfg.maxPerChat, DEFAULTS.maxPerChat)));
  next[chat] = merged.length > max ? merged.slice(merged.length - max) : merged;
  return next;
}

/**
 * 取这个 chat 里**还在窗口内**的最近 count 条（从新到旧）。
 *
 * @param {object} table
 * @param {string} chatId
 * @param {number} count
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{id:string, at:number}[]}
 */
export function recentOf(table, chatId, count, now, cfg = {}) {
  const chat = typeof chatId === 'string' ? chatId.trim() : '';
  if (chat === '') return [];
  const t = Number.isFinite(now) ? now : Date.now();
  const window = numberOr(cfg.windowMs, DEFAULTS.windowMs);
  const max = Math.max(1, Math.trunc(numberOr(cfg.maxCount, DEFAULTS.maxCount)));
  const want = Math.min(max, Math.max(1, Math.trunc(numberOr(count, 1))));
  const list = Array.isArray(table?.[chat]) ? table[chat] : [];
  const fresh = list.filter((x) => x !== null && typeof x === 'object' && t - numberOr(x.at, 0) <= window);
  return fresh.slice(Math.max(0, fresh.length - want)).reverse();
}

/**
 * 从表里划掉已撤的 id（纯函数）。
 *
 * @param {object} table
 * @param {string} chatId
 * @param {string[]} ids
 * @returns {object}
 */
export function dropIds(table, chatId, ids) {
  const src = table !== null && typeof table === 'object' ? table : {};
  const chat = typeof chatId === 'string' ? chatId.trim() : '';
  if (chat === '' || !Array.isArray(ids) || ids.length === 0) return { ...src };
  const gone = new Set(ids.map((x) => String(x)));
  const next = { ...src };
  const list = Array.isArray(next[chat]) ? next[chat] : [];
  next[chat] = list.filter((x) => !gone.has(String(x.id)));
  return next;
}

/**
 * 创建 recall 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} [options.stats]
 * @param {(level:string,message:string)=>void} [options.log]
 * @param {Function} [options.patchMethod] - core/patch 的挂载器（用来包 sendToChat）
 * @param {() => *} [options.getReceiver] - 取 ChatBridge 实例（撤回要用它的 ctx.call）
 */
export function createRecall({ cfg, stats, log, patchMethod, getReceiver }) {
  const say = typeof log === 'function' ? log : () => undefined;
  /** @type {{[chatId:string]: {id:string, at:number}[]}} */
  let table = {};
  /** 这个实例自己撤过几条。不用 `stats` 记是因为 `stats` 可能没传进来。 */
  let recalledCount = 0;
  const enabled = () => cfg?.enabled !== false;

  /** 记账：内部用，不抛错。 */
  function note(chatId, ids) {
    try {
      if (!enabled()) return;
      table = noteIds(table, chatId, Array.isArray(ids) ? ids : [ids], Date.now(), cfg);
      if (stats) stats.recallTracked = (stats.recallTracked ?? 0) + 1;
    } catch {
      /* 记账失败不影响发送 */
    }
  }

  /**
   * 撤回这个 chat 最近的 count 条。只撤表里的 id（见文件头纪律 1）。
   *
   * @param {string} chatId
   * @param {number} [count]
   * @returns {Promise<{ok:boolean, recalled:string[], reason?:string}>}
   */
  async function recallLast(chatId, count = 1) {
    if (!enabled()) return { ok: false, recalled: [], reason: '撤回模块没开（recall.enabled=false）' };
    const chat = typeof chatId === 'string' ? chatId.trim() : '';
    if (chat === '') return { ok: false, recalled: [], reason: '不知道往哪个会话撤（chat_id 为空）' };

    const targets = recentOf(table, chat, count, Date.now(), cfg);
    if (targets.length === 0) {
      return {
        ok: false,
        recalled: [],
        reason: `这个会话最近 ${Math.round(numberOr(cfg?.windowMs, DEFAULTS.windowMs) / 60000)} 分钟里没有我发出去的消息可撤`,
      };
    }

    const bridge = typeof getReceiver === 'function' ? getReceiver() : undefined;
    const call = bridge?.outbound?.ctx?.call;
    if (typeof call !== 'function') {
      return { ok: false, recalled: [], reason: 'QQ 通道还没就绪（拿不到 ctx.call）' };
    }

    const done = [];
    for (const t of targets) {
      try {
        await call('delete_msg', { message_id: Number(t.id) }, chat);
        done.push(t.id);
      } catch (error) {
        say('warn', `撤回 ${t.id} 失败：${String(error?.message ?? error)}`);
      }
    }
    if (done.length > 0) {
      table = dropIds(table, chat, done);
      recalledCount += done.length;
      if (stats) {
        stats.recallCount = (stats.recallCount ?? 0) + done.length;
        stats.recallLastAt = Date.now();
      }
    }
    return { ok: done.length > 0, recalled: done, reason: done.length === 0 ? 'QQ 那边一条都没撤成' : undefined };
  }

  /**
   * 包一层发送路径，把 id 记住。
   *
   * 只包 `ChatBridge` 的 `sendToChat` 与 `sendSegments` —— 前者是文字，
   * 后者是图片/语音这类原始段（`voice.say` 走的正是它）。两处都不改行为，
   * 只旁听返回值。
   *
   * @param {object} proto - ChatBridge.prototype
   * @param {string} moduleId
   * @returns {number} 挂了几层
   */
  function patch(proto, moduleId) {
    if (!proto || typeof patchMethod !== 'function') return 0;
    let n = 0;
    for (const method of ['sendToChat', 'sendSegments']) {
      if (typeof proto[method] !== 'function') continue;
      const ok = patchMethod(proto, method, moduleId, (original) =>
        function companionRecallRecord(chatId, ...rest) {
          const out = original.call(this, chatId, ...rest);
          try {
            if (out !== null && typeof out === 'object' && typeof out.then === 'function') {
              void out.then((ids) => {
                if (Array.isArray(ids)) note(chatId, ids);
                else if (ids !== undefined && ids !== null) note(chatId, [ids]);
              }).catch(() => undefined);
            } else if (Array.isArray(out)) note(chatId, out);
            else if (out !== undefined && out !== null) note(chatId, [out]);
          } catch {
            /* 旁听失败不影响发送 */
          }
          return out;
        }, MODULE_ID);
      if (ok) n += 1;
    }
    return n;
  }

  function snapshot() {
    const chats = {};
    const now = Date.now();
    for (const [chatId, list] of Object.entries(table)) {
      const fresh = recentOf(table, chatId, numberOr(cfg?.maxPerChat, DEFAULTS.maxPerChat), now, cfg);
      if (Array.isArray(list) && list.length > 0) chats[chatId] = fresh.length;
    }
    return {
      enabled: enabled(),
      chats,
      windowMinutes: Math.round(numberOr(cfg?.windowMs, DEFAULTS.windowMs) / 60000),
      recalled: recalledCount,
    };
  }

  /**
   * 一次补挂扫描（与其它模块同签名，好让 `index.js` 的 `scanAll` 统一驱动）。
   *
   * 直接用 `patchMethod` 挂 `ChatBridge.prototype` 的 `sendToChat` /
   * `sendSegments` —— 这两个方法上**没有别的模块在挂**（rhythm 挂的是同一个
   * 原型但不同方法名），所以冲突风险低；真撞上了 `patchMethod` 自己会按
   * 模块 id 处理共存。
   *
   * @param {object} ctx
   * @returns {Promise<{ok:boolean, patched?:number, error?:string}>}
   */
  async function scan(ctx) {
    if (!enabled()) return { ok: true, patched: 0 };
    let found;
    try {
      const { loadTargetClass } = await import('../core/profile.js');
      found = await loadTargetClass(ctx, cfg, 'bridge.js', 'ChatBridge');
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    if (found?.ok !== true) return { ok: false, error: found?.error ?? 'loadTargetClass 失败' };
    const patched = patch(found.proto, MODULE_ID);
    return { ok: true, patched };
  }

  return { MODULE_ID, note, recallLast, patch, scan, snapshot, DEFAULTS };
}
