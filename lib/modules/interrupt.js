/**
 * dsh-onebot-companion / modules/interrupt.js
 *
 * 「话说了一半被打断」——未完成意图。
 *
 * ## 为什么加这个（2026-10-22）
 *
 * 用户拿来一个叫 HDS-Interlude 的框架，其中一条特别戳人：
 *
 *   「被截断的文字会作为『主角本来想发送，但还没打完字，新消息就到了』的
 *    未完成意图交给替代写作，清晰地区分已说出口的对话与被打断的念头。」
 *
 * 我们这边现在是什么样：`burst` 分条发送时，第一条发出去之后会 `sleep`
 * 一段时间再发第二条；这期间他插话进来，宿主要么等我们发完、要么直接
 * 把剩下几条丢掉 —— 而她是**不知道**自己话被截断的。下一轮她就像从没
 * 想过那半句一样，重新组织语言，甚至跟刚说出去的话自相矛盾。
 *
 * 真人不是这样。真人打下半句、还没来得及发，看到新消息弹出来，会先把
 * 那半句咽回去，或者改口「算了，我刚想说…」。这个「咽回去的半句」
 * 是有记忆的，它会影响下一句的措辞。
 *
 * ## 判据（宁少勿错）
 *
 * 只有**同时**满足才记：
 *
 *   1. 那半句是我们自己没发出去的（`sendBurst` 里中途失败/被截断）；
 *   2. 距它被写下不到 `ttlMs`（默认 10 分钟）—— 半小时前没说完的半句
 *      再翻出来就不叫「被打断」了，那叫「一直惦记着」；
 *   3. 他确实在这之后说过话（`lastUserAt > at`）—— 没有新消息就谈不上打断。
 *
 * ## 它做什么、不做什么
 *
 * 做：把这句话原样留着，在下一轮注入里作为「你本来说到一半的话」出现，
 *     让她自己决定是接着说、还是改口。
 *
 * 不做：绝不自动把它发出去。那是替她做主 —— 他想插话就是想打断，
 *     这时候把旧句子硬塞出去比不说更失礼。
 *
 * @module dsh-onebot/interrupt
 */

export const MODULE_ID = 'interrupt';

export const DEFAULTS = Object.freeze({
  enabled: true,
  stateFile: 'interrupt-state.json',
  /** 一条未完成意图最多留多久（10 分钟）。 */
  ttlMs: 10 * 60 * 1000,
  /** 单个 chat 最多留几条（防止连发多条被截断时堆成一坨）。 */
  maxPerChat: 2,
  /** 注入行里引用原话的最长字数。 */
  maxQuoteChars: 40,
  /** 注入行最长字数。 */
  maxChars: 160,
});

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 一条记录长这样：`{ chatId, text, at, reason }`。 */

/** 剪掉结尾的省略号/标点，方便在注入行里接话。 */
function tidy(text) {
  return String(text).replace(/[\s。！？!?…，、；;：:,.\-—~～]+$/u, '').trim();
}

/**
 * 记一条「没发完的话」。
 *
 * @param {object[]} list - 已有记录（不修改入参）
 * @param {{chatId:string, text:string, at?:number, reason?:string}} entry
 * @param {object} [cfg]
 * @returns {object[]} 新列表
 */
export function noteInterrupted(list, entry, cfg = {}) {
  const c = cfg ?? {};
  if (c.enabled === false) return Array.isArray(list) ? [...list] : [];
  const chatId = typeof entry?.chatId === 'string' ? entry.chatId.trim() : '';
  const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
  if (chatId === '' || text === '') return Array.isArray(list) ? [...list] : [];

  const now = numberOr(entry?.at, Date.now());
  const next = (Array.isArray(list) ? list : []).filter((x) => {
    if (x === null || typeof x !== 'object') return false;
    if (typeof x.chatId !== 'string' || typeof x.text !== 'string') return false;
    return true;
  });

  // 同一条不重复记（同一轮里被截断两次的情况）。
  if (next.some((x) => x.chatId === chatId && x.text === text)) {
    return next;
  }

  next.push({
    chatId,
    text,
    at: now,
    reason: typeof entry?.reason === 'string' ? entry.reason : '',
  });

  // 只留这个 chat 最近的 N 条。
  const max = Math.max(1, Math.trunc(numberOr(c.maxPerChat, DEFAULTS.maxPerChat)));
  const mine = next.filter((x) => x.chatId === chatId);
  if (mine.length > max) {
    const drop = new Set(
      mine
        .slice()
        .sort((a, b) => numberOr(a.at, 0) - numberOr(b.at, 0))
        .slice(0, mine.length - max)
        .map((x) => x),
    );
    return next.filter((x) => !drop.has(x));
  }
  return next;
}

/**
 * 丢掉过期的。纯函数。
 *
 * @param {object[]} list
 * @param {number} now
 * @param {object} [cfg]
 * @returns {object[]}
 */
export function pruneInterrupted(list, now = Date.now(), cfg = {}) {
  const ttl = numberOr(cfg.ttlMs, DEFAULTS.ttlMs);
  const t = Number.isFinite(now) ? now : Date.now();
  const src = Array.isArray(list) ? list : [];
  return src.filter((x) => {
    if (x === null || typeof x !== 'object') return false;
    if (typeof x.chatId !== 'string' || typeof x.text !== 'string' || x.text === '') return false;
    const at = numberOr(x.at, 0);
    if (!(at > 0)) return false;
    return t - at <= ttl;
  });
}

/**
 * 取出这个 chat 此刻真正算「被打断」的那一条。
 *
 * 三个条件同时成立才算（见文件头）：没超期、他在这之后说过话、不是空话。
 *
 * @param {object[]} list
 * @param {string} chatId
 * @param {{now?:number, lastUserAt?:number}} ctx
 * @param {object} [cfg]
 * @returns {{text:string, at:number}|null}
 */
export function interruptedFor(list, chatId, ctx = {}, cfg = {}) {
  const c = cfg ?? {};
  if (c.enabled === false) return null;
  const now = numberOr(ctx.now, Date.now());
  const lastUserAt = numberOr(ctx.lastUserAt, 0);
  const fresh = pruneInterrupted(list, now, c).filter((x) => x.chatId === chatId);
  if (fresh.length === 0) return null;

  // 从新到旧找第一条「他之后说过话」的。没有说话就不算被打断 ——
  // 那只是我们发失败了一条，跟他无关。
  const sorted = fresh.slice().sort((a, b) => numberOr(b.at, 0) - numberOr(a.at, 0));
  for (const item of sorted) {
    const at = numberOr(item.at, 0);
    if (!(at > 0)) continue;
    if (!(lastUserAt > at)) continue;
    const text = tidy(item.text);
    if (text === '') continue;
    return { text, at };
  }
  return null;
}

/**
 * 注入行。恒不返回花括号。
 *
 * 措辞刻意是「你本来想说」，不是「你刚才说了」—— 分清楚已出口与未出口，
 * 正是这条存在的理由。
 *
 * @param {{text:string, at:number}|null} hit
 * @param {object} [cfg]
 * @returns {string} 空串表示不注入
 */
export function interruptPromptLine(hit, cfg = {}) {
  const c = cfg ?? {};
  if (c.enabled === false) return '';
  if (hit === null || hit === undefined || typeof hit.text !== 'string') return '';
  const quoteMax = Math.max(4, Math.trunc(numberOr(c.maxQuoteChars, DEFAULTS.maxQuoteChars)));
  const quote = hit.text.length > quoteMax ? `${hit.text.slice(0, quoteMax)}…` : hit.text;
  const text =
    `你上一句说到「${quote}」就没发出去——他正好在那时候说话了，话被你自己咽了回去。` +
    '这半句还算在你心里：想接着说就接着，想改口就改口，不想提了也可以不提。别假装那句话不存在。';
  const max = numberOr(c.maxChars, DEFAULTS.maxChars);
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 创建 interrupt 模块实例（有状态的那一半）。
 *
 * 数据只有一张表：`{ chatId, text, at, reason }[]`。它**不主动做任何事** ——
 * 记账靠在出站路径上被调，注入靠每轮被问。跟 focus / unsaid 同一范式。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} [options.stats]
 * @param {(level:string,message:string)=>void} [options.log]
 * @param {() => string} [options.resolveMediaDir]
 */
export function createInterrupt({ cfg, stats, log, resolveMediaDir }) {
  /** @type {{chatId:string, text:string, at:number, reason:string}[]} */
  let list = [];
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;

  const enabled = () => cfg?.enabled !== false;

  async function ensureStore() {
    if (store !== null) return store;
    if (loading !== null) return loading;
    let dir = '';
    try {
      dir = typeof resolveMediaDir === 'function' ? resolveMediaDir() : '';
    } catch {
      dir = '';
    }
    if (typeof dir !== 'string' || dir === '') return null;
    const { JsonStore, stateFilePath } = await import('../core/jsonstore.js');
    const file = stateFilePath(dir, cfg?.stateFile ?? DEFAULTS.stateFile);
    if (file === undefined) return null;
    store = new JsonStore({
      file,
      log: say,
      label: 'interrupt',
      normalize: (value) => (Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        list = pruneInterrupted(store.get('list') ?? [], Date.now(), cfg);
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('list', list);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.interruptLastError = String(error?.message ?? error);
    }
  }

  /** 开机只读盘并裁一次过期。 */
  async function start() {
    await ensureStore().catch(() => undefined);
    return { ok: true };
  }

  /**
   * 记一条「没说完的话」。由 rhythm 的出站分段在被打断时调。
   *
   * @param {string} chatId
   * @param {string} text - 没发出去的那部分
   * @param {string} [reason]
   */
  function note(chatId, text, reason) {
    try {
      if (!enabled()) return null;
      list = noteInterrupted(list, { chatId, text, at: Date.now(), reason }, cfg);
      if (stats) stats.interruptNotes = (stats.interruptNotes ?? 0) + 1;
      void ensureStore().then(persist).catch(() => undefined);
      return { ok: true };
    } catch {
      return null;
    }
  }

  /** 注入行。同步、绝不抛错（在 `agent/pre-step` 里被调到）。 */
  function promptLine(chatId, lastUserAt, at = Date.now()) {
    try {
      if (!enabled()) return '';
      const hit = interruptedFor(list, chatId, { now: at, lastUserAt }, cfg);
      return interruptPromptLine(hit, cfg);
    } catch {
      return '';
    }
  }

  function snapshot() {
    return {
      enabled: enabled(),
      pending: pruneInterrupted(list, Date.now(), cfg).length,
      notes: stats?.interruptNotes ?? 0,
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  return { MODULE_ID, start, note, promptLine, snapshot, DEFAULTS };
}
