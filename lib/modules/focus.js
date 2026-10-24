/**
 * focus —— 此刻注意力在哪儿（2026-10-21）。
 *
 * ## 为什么要有这个模块
 *
 * 用户在社区看到一份「鱼的大脑」设计稿，里面有一条「注意力机制（Attention）」：
 * 一个人正在刷帖子或打游戏时，对消息的响应会变慢，回话也容易答非所问——因为
 * 算力没放在聊天上。他还说：「我不想给太多硬限制」，所以这里**不做拦截**，
 * 只做一件事：让她自己知道「我刚才在干别的」。
 *
 * 我们没有「延迟发送」这一层（那属于出站节奏，硬改会把 @ 和紧急消息一起拖慢），
 * 但「她在干别的」这个事实本身值钱：她可以从这个事实里自然长出「我回慢了一点，
 * 因为我刚才在看视频」。这是人话，不是参数。
 *
 * ## 设计取舍
 *
 * 1. **不持久化也要能读**：状态是「此刻」，进程重启后一无所有才是对的——
 *    跟精力/亲密度（要跨天连续）不一样。但为了让她下次上电不至于完全失忆，
 *    还是落一个小文件，重启后按「已过期就看一眼时间」处理。
 * 2. **自己会过期**：20 分钟不刷新就当没在干（`ttlMs`）。否则昨天刷的两条
 *    视频会让她今天还在「忙着」。
 * 3. **文案绝不含花括号**：宿主提示词插值器会把双花括号当变量并抛错。
 */

export const MODULE_ID = 'focus';

export const DEFAULTS = {
  enabled: true,
  /** 多久没动作就当作注意力回来了（毫秒）。 */
  ttlMs: 20 * 60 * 1000,
  /** 状态文件名（落在 mediaDir 下）。 */
  stateFile: 'focus-state.json',
  /** 注入行的最长字数（描述太长会顶掉别的东西）。 */
  maxChars: 120,
};

/** 各活动的中文说法（`what` 是活动 id，`detail` 是具体内容）。 */
const WHAT_LABELS = {
  browse: '在刷',
  watch: '在看视频',
  game: '在打游戏',
  music: '在听歌',
  work: '在忙自己的事',
  idle: '在发呆',
};

/**
 * 把任意输入规整成合法的焦点记录。纯函数。
 *
 * @param {{what?:string, detail?:string, at?:number}} input
 * @param {number} now
 * @returns {{what:string, detail:string, at:number}|null}
 */
export function normalizeFocus(input, now) {
  const what = typeof input?.what === 'string' ? input.what.trim() : '';
  if (what === '' || WHAT_LABELS[what] === undefined) return null;
  const detail = typeof input?.detail === 'string' ? input.detail.trim().slice(0, 40) : '';
  const at = Number.isFinite(input?.at) ? input.at : now;
  return { what, detail, at };
}

/**
 * 一条焦点是否还有效。纯函数。
 *
 * @param {{at:number}|null} focus
 * @param {number} now
 * @param {object} [cfg]
 * @returns {boolean}
 */
export function isFresh(focus, now, cfg = {}) {
  if (focus === null || focus === undefined) return false;
  if (!Number.isFinite(focus.at)) return false;
  const ttl = Number.isFinite(cfg.ttlMs) ? cfg.ttlMs : DEFAULTS.ttlMs;
  return now - focus.at < ttl;
}

/**
 * 生成注入用的一行「此刻注意力」。纯函数，恒不返回花括号。
 *
 * @param {object|null} focus
 * @param {number} now
 * @param {object} [cfg]
 * @returns {string|null} 没在干别的事（或已过期）时返回 null。
 */
export function focusPromptLine(focus, now, cfg = {}) {
  if (cfg.enabled === false) return null;
  if (!isFresh(focus, now, cfg)) return null;
  const label = WHAT_LABELS[focus.what];
  if (label === undefined) return null;
  const detail = typeof focus.detail === 'string' && focus.detail !== '' ? `「${focus.detail}」` : '';
  const minutes = Math.max(1, Math.floor((now - focus.at) / 60000));
  const max = Number.isFinite(cfg.maxChars) ? cfg.maxChars : DEFAULTS.maxChars;
  const text = `你此刻的注意力不在这边：你${label}${detail}，已经 ${minutes} 分钟了。`
    + '所以这会儿回话可以慢一点、也可能答得没那么贴题——这不是敷衍，是你真的在看别的。';
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 创建焦点模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - focus 段配置。
 * @param {object} options.stats - 共享统计。
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => string} [options.resolveMediaDir] - 状态目录（延迟解析）。
 * @returns {object}
 */
export function createFocus({ cfg, stats, log, resolveMediaDir }) {
  /** @type {{what:string, detail:string, at:number}|null} */
  let focus = null;
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const now = () => Date.now();

  const enabled = () => cfg?.enabled !== false;

  async function ensureStore() {
    if (store !== null) return store;
    if (loading !== null) return loading;
    const dir = (() => {
      try {
        return typeof resolveMediaDir === 'function' ? resolveMediaDir() : '';
      } catch {
        return '';
      }
    })();
    if (typeof dir !== 'string' || dir === '') return null;
    const { JsonStore, stateFilePath } = await import('../core/jsonstore.js');
    const file = stateFilePath(dir, cfg?.stateFile ?? DEFAULTS.stateFile);
    if (file === undefined) return null;
    store = new JsonStore({
      file,
      log: say,
      label: 'focus',
      normalize: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('focus');
        const made = normalizeFocus(raw, now());
        // 重启后接手：只要还没过期就认，过期了就丢掉（昨天的视频不该还在忙）。
        focus = isFresh(made, now(), cfg) ? made : null;
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('focus', focus);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.focusLastError = String(error?.message ?? error);
    }
  }

  /**
   * 报告一次活动。同一种活动会刷新时间（「还在刷」），换了活动就覆盖。
   *
   * @param {{what:string, detail?:string}} input
   * @returns {Promise<object|null>}
   */
  async function set(input) {
    if (!enabled()) return null;
    const made = normalizeFocus({ ...input, at: now() }, now());
    if (made === null) return null;
    focus = made;
    if (stats) {
      stats.focusSets = (stats.focusSets ?? 0) + 1;
      stats.focusLastWhat = made.what;
    }
    await ensureStore().catch(() => undefined);
    persist();
    return { ...made };
  }

  /** 注意力回来了（有人跟她说话说了一会儿，或者什么都没做）。 */
  async function clear() {
    if (focus === null) return false;
    focus = null;
    if (stats) stats.focusClears = (stats.focusClears ?? 0) + 1;
    await ensureStore().catch(() => undefined);
    persist();
    return true;
  }

  /** 当前焦点（已过期返回 null）。同步。 */
  function current() {
    if (!isFresh(focus, now(), cfg)) return null;
    return { ...focus };
  }

  /** 注入用文本。同步、绝不抛错（在 `agent/pre-step` 里被调到）。 */
  function promptLine() {
    if (!enabled()) return null;
    try {
      return focusPromptLine(current(), now(), cfg);
    } catch {
      return null;
    }
  }

  function snapshot() {
    const cur = current();
    return {
      enabled: enabled(),
      what: cur?.what ?? null,
      detail: cur?.detail ?? '',
      minutes: cur === null ? null : Math.max(0, Math.floor((now() - cur.at) / 60000)),
      sets: stats?.focusSets ?? 0,
      clears: stats?.focusClears ?? 0,
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  function start() {
    void ensureStore().catch(() => undefined);
  }

  function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const T0 = 1_700_000_000_000;

    check('normalizeFocus 认 browse', normalizeFocus({ what: 'browse', detail: 'B 站热门' }, T0)?.what === 'browse');
    check('normalizeFocus 拒未知活动', normalizeFocus({ what: 'nonsense' }, T0) === null);
    check('normalizeFocus 空活动为 null', normalizeFocus({}, T0) === null);
    check('normalizeFocus 描述截断', normalizeFocus({ what: 'game', detail: 'x'.repeat(80) }, T0)?.detail.length === 40);

    const f = normalizeFocus({ what: 'browse', detail: 'B 站热门', at: T0 }, T0);
    check('isFresh 刚报告是新鲜的', isFresh(f, T0 + 60_000) === true);
    check('isFresh 过期后不新鲜', isFresh(f, T0 + 21 * 60_000) === false);
    check('isFresh null 不新鲜', isFresh(null, T0) === false);

    const line = focusPromptLine(f, T0 + 5 * 60_000);
    check('focusPromptLine 有内容', typeof line === 'string' && line !== '');
    check('focusPromptLine 含活动', line.includes('B 站热门'));
    check('focusPromptLine 含分钟数', line.includes('5 分钟'));
    check('focusPromptLine 不含花括号', !line.includes('{') && !line.includes('}'));
    check('focusPromptLine 过期返回 null', focusPromptLine(f, T0 + 30 * 60_000) === null);
    check('focusPromptLine 可关', focusPromptLine(f, T0 + 60_000, { enabled: false }) === null);
    check('focusPromptLine 太长的截断', focusPromptLine(f, T0 + 60_000, { maxChars: 10 }).length === 10);
    check('没有 detail 也能出句子', focusPromptLine(normalizeFocus({ what: 'idle' }, T0), T0 + 60_000).includes('发呆'));

    return { ok: checks.every((c) => c.ok), checks };
  }

  return { MODULE_ID, set, clear, current, promptLine, snapshot, start, selfTest, DEFAULTS };
}
