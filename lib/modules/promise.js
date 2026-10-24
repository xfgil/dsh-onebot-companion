/**
 * dsh-onebot-companion / modules/promise.js
 *
 * 约定：她答应过、但还没做的事 —— 到点了会想起来。
 *
 * ## 为什么需要它（2026-10-19）
 *
 * 现状的主动开口只看两件事：静默多久、掷不掷中概率门（`proactive.js`）。它
 * 从来不会去查「我是不是还欠他一句话」。
 *
 * 于是常见的塌陷是这样的：
 *
 * ```
 * 她：等我看完那个再跟你说
 * …… 两天过去 ……
 * （什么都没发生）
 * ```
 *
 * 这不是记性问题，是**没有地方存这件事**。人在答应的时候会往脑子里放一根
 * 线头，回头它自己会冒出来。她这边当时说完就结束了 —— 那句话只是文本，不
 * 是「未结清的事项」。
 *
 * ## 三件事
 *
 *   1. `add` —— 记一条约定（做什么、什么时候算到点）；
 *   2. `due` —— 每到一轮注入时，把**已到点且没结清**的挑出来，写进提示；
 *   3. `done` / `drop` —— 结清 / 作废。
 *
 * ## 为什么「到点」不用 cron
 *
 * 用户的硬约束（历史原话：「定时还是算了，你还不如搞个随机变量」）。所以这里
 * 只有**判定**没有**调度**：约定的 `dueAt` 只是一个时间戳，什么时候被看见取决于
 * 她下一轮说话的时刻 —— 也许是十分钟后，也许是明天早上。真人也是这样想起来的。
 *
 * ## 判据（为什么要写 `dueAt` 而不是「随时提醒」）
 *
 * 不留 `dueAt` 的话，每一条约定都会立刻开始骚扰，第二天就成了噪音源，最后
 * 只能被关掉。给一个明确的到点时间，才能让「等我看完那个」这种话落在合理的
 * 位置。默认 `dueAt = now + 24h`，允许模型自己给更短或更长的。
 *
 * ## 设计约束
 *
 *   1. 纯函数部分零 import（`createPromiseEntry` / `isDue` / `promptLine`），离线单测
 *      可裸 node 直接 import；
 *   2. 时间一律由调用方传入，模块内部不读 `Date.now()`（`createPromiseEntry` 的
 *      `at`/`dueAt` 由工具层补）；
 *   3. 表容量上限硬性生效（默认 100 条），结清的条目不立刻删而是留 3 天，
 *      免得同一件事被反复答应。
 *
 * @module dsh-onebot-companion/modules/promise
 */

/** 约定状态。 */
export const STATUSES = ['open', 'done', 'dropped'];

/** 状态中文名。 */
export const STATUS_LABELS = { open: '还没做', done: '已经做了', dropped: '作废' };

/** 默认到点延迟（毫秒）：一天。 */
export const DEFAULT_DUE_MS = 24 * 3600 * 1000;

/** 结清后的保留期（毫秒）：3 天。留一段是为了让「已经答应的」不重复被记。 */
export const KEEP_AFTER_CLOSE_MS = 3 * 24 * 3600 * 1000;

/** 到点之后最多再提醒几次（防同一条约定连着刷）。 */
export const MAX_REMINDERS = 3;

export const DEFAULTS = {
  enabled: true,
  /** 注入时最多列几条到点的约定。 */
  injectMax: 4,
  /** 表容量上限。 */
  maxEntries: 100,
  /** 单条正文最大字数。 */
  maxTextChars: 120,
  /** 没给 dueAt 时的默认延迟（小时）。 */
  defaultDueHours: 24,
  /** 状态文件名。 */
  stateFile: 'promise-state.json',
};

/**
 * 把任意输入规整成合法状态；认不出来按 open。
 * @param {unknown} value
 * @returns {'open'|'done'|'dropped'}
 */
export function normalizeStatus(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STATUSES.includes(raw) ? raw : 'open';
}

/**
 * 造一条约定。纯函数。
 *
 * @param {object} input - `{ text, dueAt?, chatId? }`。
 * @param {number} now - 当前 ms epoch。
 * @param {object} [cfg]
 * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
 */
export function createPromiseEntry(input, now, cfg = {}) {
  const maxChars = Number.isFinite(cfg.maxTextChars) ? cfg.maxTextChars : DEFAULTS.maxTextChars;
  const raw = typeof input?.text === 'string' ? input.text.trim() : '';
  if (raw === '') return { ok: false, reason: 'text 不能为空' };
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
  const dueHours = Number.isFinite(cfg.defaultDueHours) ? cfg.defaultDueHours : DEFAULTS.defaultDueHours;
  // dueAt 允许模型给绝对时间戳（毫秒）；给了就尊重，但**不许早于现在**
  // —— 早于现在的约定会立刻变成「一直没做」，第一次注入就刷屏。
  const fallback = now + dueHours * 3600 * 1000;
  const dueAt = Number.isFinite(input?.dueAt) ? Math.max(now, input.dueAt) : fallback;
  return {
    ok: true,
    entry: {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: now,
      dueAt,
      text,
      status: 'open',
      chatId: typeof input?.chatId === 'string' ? input.chatId : '',
      reminded: 0,
    },
  };
}

/**
 * 一条是否「到点还没做」。纯函数。
 * @param {object} entry
 * @param {number} now
 * @returns {boolean}
 */
export function isDue(entry, now) {
  if (entry?.status !== 'open') return false;
  if (!Number.isFinite(entry?.dueAt)) return false;
  if (entry.dueAt > now) return false;
  return (entry.reminded ?? 0) < MAX_REMINDERS;
}

/**
 * 淘汰到容量上限内。纯函数。
 *
 * 顺序：已结清的优先扔（旧的先扔），再按 `dueAt` 早的扔。**正在 open 且晚到点
 * 的约定要留住** —— 那是唯一有价值的那部分。
 *
 * @param {object[]} entries
 * @param {number} max
 * @param {number} now
 * @returns {object[]}
 */
export function trimToLimit(entries, max, now) {
  const list = Array.isArray(entries) ? entries : [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULTS.maxEntries;
  if (list.length <= cap) return list.slice();
  const weight = (e) => (e?.status === 'open' ? 1 : 0);
  const sorted = list.slice().sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    if (wa !== wb) return wa - wb;
    return (a?.dueAt ?? a?.at ?? 0) - (b?.dueAt ?? b?.at ?? 0);
  });
  void now;
  return sorted.slice(list.length - cap);
}

/**
 * 裁剪整张表：结清超期的摘掉，再压容量。纯函数。
 * @param {object[]} entries
 * @param {number} now
 * @param {object} [cfg]
 * @returns {object[]}
 */
export function prune(entries, now, cfg = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => {
    if (e?.status === 'open') return true;
    const at = Number.isFinite(e?.at) ? e.at : 0;
    return now - at < KEEP_AFTER_CLOSE_MS;
  });
  return trimToLimit(list, cfg.maxEntries ?? DEFAULTS.maxEntries, now);
}

/**
 * 把毫秒差说成「2 小时」「3 天」。纯函数。
 * @param {number} ms
 * @returns {string}
 */
export function humanSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 生成注入用文本。纯函数，**恒不返回花括号**。
 *
 * @param {object[]} entries - 已 prune 过的表。
 * @param {number} now
 * @param {object} [cfg]
 * @returns {string|null}
 */
export function promptLine(entries, now, cfg = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const max = Number.isFinite(cfg.injectMax) ? cfg.injectMax : DEFAULTS.injectMax;
  const due = list.filter((e) => isDue(e, now)).sort((a, b) => a.dueAt - b.dueAt).slice(0, max);
  if (due.length === 0) return null;
  const lines = [];
  for (const e of due) {
    const late = humanSpan(now - e.dueAt);
    const age = humanSpan(now - e.at);
    const lateText = late === '' ? '已经到点了' : `已经过了 ${late}`;
    lines.push(`- 「${e.text}」（${age}前答应的，${lateText}）`);
  }
  return [
    '这些是你之前**答应过、但还没兑现**的事（不是任务清单，是欠着的话；合适就自然提一句，别硬转话题）：',
    ...lines,
  ].join('\n');
}

/**
 * 创建约定模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => string} [options.resolveMediaDir]
 * @returns {object}
 */
export function createPromise({ cfg, stats, log, resolveMediaDir }) {
  /** @type {object[]} */
  let entries = [];
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const now = () => Date.now();

  const enabled = () => cfg?.enabled !== false;

  function isShapeOk(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.text === 'string' &&
      value.text !== '' &&
      Number.isFinite(value.at)
    );
  }

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
      label: 'promise',
      normalize: (value) => (Array.isArray(value) ? value.filter(isShapeOk) : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('entries');
        entries = prune(Array.isArray(raw) ? raw.filter(isShapeOk) : [], now(), cfg);
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('entries', entries);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.promiseLastError = String(error?.message ?? error);
    }
  }

  /**
   * 记一条约定。
   * @param {{text:string, dueAt?:number, chatId?:string}} input
   */
  async function add(input) {
    if (!enabled()) return { ok: false, reason: '约定未启用' };
    await ensureStore().catch(() => undefined);
    const made = createPromiseEntry(input, now(), cfg);
    if (made.ok !== true) return { ok: false, reason: made.reason };
    // 同一句话还在 open 里就不重复记（模型很容易同一件事记两遍）。
    const dup = entries.find((e) => e.status === 'open' && e.text === made.entry.text);
    if (dup !== undefined) {
      return { ok: true, entry: dup, duplicate: true, total: openCount() };
    }
    entries = prune([...entries, made.entry], now(), cfg);
    persist();
    if (stats) {
      stats.promiseAdded = (stats.promiseAdded ?? 0) + 1;
      stats.promiseLastAt = made.entry.at;
    }
    say('info', `[promise] 记下约定：${made.entry.text.slice(0, 40)}`);
    return { ok: true, entry: made.entry, total: openCount() };
  }

  function openCount() {
    return entries.filter((e) => e?.status === 'open').length;
  }

  /**
   * 找一条 open 的约定：先按 id 精确匹配，再按正文子串匹配。
   * @param {string} key
   * @returns {object|undefined}
   */
  function findOpen(key) {
    const k = typeof key === 'string' ? key.trim() : '';
    if (k === '') return undefined;
    const byId = entries.find((e) => e.status === 'open' && e.id === k);
    if (byId !== undefined) return byId;
    return entries.find((e) => e.status === 'open' && e.text.includes(k));
  }

  /**
   * 结清一条。
   * @param {string} key - id 或正文片段。
   * @returns {Promise<{ok:boolean, entry?:object, reason?:string}>}
   */
  async function done(key) {
    if (!enabled()) return { ok: false, reason: '约定未启用' };
    await ensureStore().catch(() => undefined);
    const hit = findOpen(key);
    if (hit === undefined) return { ok: false, reason: '没找到这条还在open的约定' };
    hit.status = 'done';
    hit.closedAt = now();
    persist();
    if (stats) stats.promiseDone = (stats.promiseDone ?? 0) + 1;
    return { ok: true, entry: { ...hit } };
  }

  /**
   * 作废一条（不会提了）。
   * @param {string} key
   */
  async function drop(key) {
    if (!enabled()) return { ok: false, reason: '约定未启用' };
    await ensureStore().catch(() => undefined);
    const hit = findOpen(key);
    if (hit === undefined) return { ok: false, reason: '没找到这条还在open的约定' };
    hit.status = 'dropped';
    hit.closedAt = now();
    persist();
    if (stats) stats.promiseDropped = (stats.promiseDropped ?? 0) + 1;
    return { ok: true, entry: { ...hit } };
  }

  /**
   * 列约定。
   * @param {{status?:string, limit?:number}} [query]
   */
  async function list(query = {}) {
    await ensureStore().catch(() => undefined);
    entries = prune(entries, now(), cfg);
    const limit = Number.isFinite(query?.limit) ? Math.max(1, Math.floor(query.limit)) : 20;
    let out = entries;
    if (typeof query?.status === 'string' && query.status !== '') {
      const want = normalizeStatus(query.status);
      out = out.filter((e) => e.status === want);
    }
    return out
      .slice()
      .sort((a, b) => (a?.dueAt ?? a?.at ?? 0) - (b?.dueAt ?? b?.at ?? 0))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /**
   * 到点提醒消费一次：把 `reminded` 加一（同一条约定的提醒次数是有上限的）。
   * 由 index.js 在注入时调 —— 注入即消费，不然同一条会每轮都刷。
   */
  function consumeReminders() {
    if (!enabled()) return 0;
    const t = now();
    let fired = 0;
    for (const e of entries) {
      if (!isDue(e, t)) continue;
      e.reminded = (e.reminded ?? 0) + 1;
      e.lastRemindedAt = t;
      fired += 1;
    }
    if (fired > 0) {
      if (stats) stats.promiseReminded = (stats.promiseReminded ?? 0) + fired;
      persist();
    }
    return fired;
  }

  /** 注入用文本。同步、绝不抛错。 */
  function injectionText() {
    if (!enabled()) return null;
    try {
      const alive = prune(entries, now(), cfg);
      if (alive.length !== entries.length) entries = alive;
      return promptLine(alive, now(), cfg);
    } catch {
      return null;
    }
  }

  function snapshot() {
    const alive = prune(entries, now(), cfg);
    const t = now();
    const due = alive.filter((e) => isDue(e, t));
    return {
      enabled: enabled(),
      open: alive.filter((e) => e.status === 'open').length,
      done: alive.filter((e) => e.status === 'done').length,
      dropped: alive.filter((e) => e.status === 'dropped').length,
      due: due.length,
      dueTexts: due.slice(0, 5).map((e) => e.text),
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  /** 自测：纯函数 + 一张假表跑 add/done/drop。不碰真状态文件。 */
  async function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const T0 = 1_700_000_000_000;
    const HOUR = 3600 * 1000;

    // —— 造约定 ——
    const made = createPromiseEntry({ text: '  帮你查那个番  ' }, T0);
    check('createPromise 成功', made.ok === true);
    check('createPromise 去空白', made.entry?.text === '帮你查那个番');
    check('createPromise 默认 open', made.entry?.status === 'open');
    check('createPromise 默认 24 小时后到点', made.entry?.dueAt === T0 + 24 * HOUR);
    check('createPromise 空文本被拒', createPromiseEntry({ text: ' ' }, T0).ok === false);
    check(
      'createPromise 尊重给定 dueAt',
      createPromiseEntry({ text: 'x', dueAt: T0 + 2 * HOUR }, T0).entry?.dueAt === T0 + 2 * HOUR,
    );
    check(
      'createPromise 不许早于现在',
      createPromiseEntry({ text: 'x', dueAt: T0 - 5 * HOUR }, T0).entry?.dueAt === T0,
    );

    // —— 到点判定 ——
    const entry = createPromiseEntry({ text: 'x', dueAt: T0 + HOUR }, T0).entry;
    check('未到点不算 due', isDue(entry, T0) === false);
    check('刚好到点算 due', isDue(entry, T0 + HOUR) === true);
    check('结清的不算 due', isDue({ ...entry, status: 'done' }, T0 + 2 * HOUR) === false);
    check('作废的不算 due', isDue({ ...entry, status: 'dropped' }, T0 + 2 * HOUR) === false);
    check('提醒次数用尽不算 due', isDue({ ...entry, reminded: MAX_REMINDERS }, T0 + 2 * HOUR) === false);

    // —— 裁剪 ——
    const closed = { ...entry, status: 'done', closedAt: T0 + HOUR };
    const kept = prune([entry, closed], T0 + 2 * HOUR);
    check('prune 留住 open', kept.some((e) => e.status === 'open'));
    check('prune 留住刚结清的', kept.some((e) => e.status === 'done'));
    const stale = { ...entry, status: 'done', at: T0, closedAt: T0 };
    check('prune 摘掉结清很久的', prune([stale], T0 + 10 * 24 * HOUR).length === 0);
    const capped = trimToLimit(
      [{ ...entry, status: 'done', at: T0 }, { ...entry, id: 'b', status: 'open' }],
      1,
      T0,
    );
    check('trimToLimit 超额先扔结清的', capped.length === 1 && capped[0].status === 'open');

    // —— humanSpan ——
    check('humanSpan 30 分', humanSpan(30 * 60_000) === '30 分钟');
    check('humanSpan 5 小时', humanSpan(5 * HOUR) === '5 小时');
    check('humanSpan 2 天', humanSpan(48 * HOUR) === '2 天');

    // —— 注入文本 ——
    check('promptLine 没有到点的返回 null', promptLine([entry], T0) === null);
    const line = promptLine([entry], T0 + 2 * HOUR);
    check('promptLine 到点后有内容', typeof line === 'string' && line.includes('x'));
    check('promptLine 不含花括号', !line.includes('{') && !line.includes('}'));

    // —— 假存储跑真实读写 ——
    const fake = createPromise({
      cfg: { ...DEFAULTS, enabled: true },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
    });
    const a1 = await fake.add({ text: '明天提醒他吃药', dueAt: Date.now() + 60_000 });
    check('add 写入成功', a1.ok === true);
    const a2 = await fake.add({ text: '明天提醒他吃药', dueAt: Date.now() + 60_000 });
    check('add 同一条 open 去重', a2.duplicate === true);
    const open = await fake.list({ status: 'open' });
    check('list 看得到 open', open.length === 1 && open[0].text === '明天提醒他吃药');
    check('done 按正文片段结清', (await fake.done('吃药')).ok === true);
    check('结清后 open 表空', (await fake.list({ status: 'open' })).length === 0);
    check('done 同一个不能结两次', (await fake.done('吃药')).ok === false);
    await fake.add({ text: '帮他看一眼配置' });
    check('drop 作废', (await fake.drop('配置')).ok === true);
    check('drop 后 open 表空', (await fake.list({ status: 'open' })).length === 0);

    const failed = checks.filter((c) => c.ok !== true);
    return { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
  }

  function start() {
    void ensureStore()
      .then(() => {
        entries = prune(entries, now(), cfg);
        persist();
      })
      .catch(() => undefined);
  }

  return { add, done, drop, list, injectionText, consumeReminders, snapshot, start, selfTest, DEFAULTS };
}
