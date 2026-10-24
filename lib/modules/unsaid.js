/**
 * dsh-onebot-companion / modules/unsaid.js
 *
 * 咽回去的话：她**想说、但当时觉得不合适**而没发的那句话，攒着，等合适的时候再冒出来。
 *
 * ## 为什么要有这个（2026-10-20）
 *
 * 需求是记下「想说没说出口的话」：一句话到嘴边，觉得当时不合适就咽回去了，
 * 然后就没了。要是能攒着，等合适的时候再冒出来就好了。
 *
 * 这不是「记忆」（记的是发生过的事，见 diary.js），也不是「约定」（欠别人的
 * 承诺，见 promise.js）。这是**没说出口的那部分自己**：话在她心里，对方从没
 * 听见。diary 记「他怕吵」，unsaid 记「我刚想问他是不是不高兴，又觉得太黏了」。
 *
 * ## 三条设计约束（每条都对应一个真实的坑）
 *
 * 1. **只能她自己记，闸层不猜。** 没有「从 thinking 里抠句子」这种魔法——
 *    那等于替她决定哪句算数，而且 reasoning 里大量是自我诊断，抠出来会变成
 *    精神污染。所以只开一个工具 `qq_unsaid`，由她在那一轮自己决定要不要按住。
 *
 * 2. **必须会淡掉。** 只攒不忘，三个月后她背着一百句没说出口的话，那不是深情，
 *    是纠缠。所以：默认 48 小时过期；且**提到 maxNudges 次还没说出口就自然
 *    淡化掉**（`nudges` 计数）——真人憋久了那句话就真的没了，这个「没了」本身
 *    就是对的。
 *
 * 3. **注入必须极克制。** 每轮最多 3 条、优先快过期的。注入是**给提示不是给
 *    任务**：文案里明写「说出来要自然，说不出口也没关系，别提『我有话没说』
 *    这种元话」。不然模型会把这条注解读成「本回合必须把这三句话说完」，直接
 *    变成审问式输出——那是同一类「报幕」毛病（见 echo.js 与 guard.js）。
 *
 * ## 落点
 *
 * 不挂任何原型方法：它不拦消息、也不改消息，纯状态 + 一个工具 + 一行注入。
 * 注入挤进 `prompt` 的 `extra`（与 diary / promise 同一班车），理由见
 * index.js 那段注释：每多一条注入消息就是每轮多一次前缀变动，缓存全废。
 */

import { randomUUID } from 'node:crypto';

export const DEFAULTS = {
  enabled: true,
  /** 表容量上限（超了先扔最老的）。 */
  maxEntries: 60,
  /** 单条正文最大字数。 */
  maxTextChars: 200,
  /** 没给 ttlHours 时的默认保质期。 */
  defaultTtlHours: 48,
  /** 保质期上限，防止她填个一年。 */
  maxTtlHours: 24 * 30,
  /** 每轮最多注入几条。 */
  injectMax: 3,
  /** 一条最多被提几次；提满了还没说出口就淡掉。 */
  maxNudges: 3,
  /** 状态文件名。 */
  stateFile: 'unsaid-state.json',
};

const HOUR = 3600 * 1000;

/** 归一化保质期（小时）。 */
export function normalizeTtl(value, cfg = {}) {
  const fallback = cfg.defaultTtlHours ?? DEFAULTS.defaultTtlHours;
  const cap = cfg.maxTtlHours ?? DEFAULTS.maxTtlHours;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, cap);
}

/**
 * 造一条待说条目。纯函数（不碰状态），方便自测。
 *
 * @param {{text:string, why?:string, ttlHours?:number, chatId?:string}} input
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{ok:boolean, entry?:object, reason?:string}}
 */
export function createUnsaidEntry(input, now, cfg = {}) {
  const maxChars = cfg.maxTextChars ?? DEFAULTS.maxTextChars;
  const raw = typeof input?.text === 'string' ? input.text.trim() : '';
  if (raw === '') return { ok: false, reason: '要按住的话不能是空的' };
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
  const ttlHours = normalizeTtl(input?.ttlHours, cfg);
  const why = typeof input?.why === 'string' ? input.why.trim().slice(0, maxChars) : '';
  return {
    ok: true,
    entry: {
      id: randomUUID(),
      text,
      why,
      at: now,
      ttlHours,
      expiresAt: now + ttlHours * HOUR,
      nudges: 0,
      saidAt: null,
      chatId: typeof input?.chatId === 'string' ? input.chatId : undefined,
    },
  };
}

/** 过没过期。说出口的（saidAt 有值）永远不算过期，只等裁剪。 */
export function isExpired(entry, now) {
  if (entry?.saidAt) return false;
  return Number.isFinite(entry?.expiresAt) ? now >= entry.expiresAt : false;
}

/** 提满次数了没（提满即自然淡化）。 */
export function isFaded(entry, cfg = {}) {
  if (entry?.saidAt) return false;
  const max = cfg.maxNudges ?? DEFAULTS.maxNudges;
  return (entry?.nudges ?? 0) >= max;
}

/**
 * 裁剪：已说出且超过 24 小时的先走 → 过期/淡化的走 → 超额按旧到新扔。
 *
 * 说出口的留 24 小时是给观测面看的（「这句终于说了」），不是给注入用的。
 */
export function prune(entries, now, cfg = {}) {
  const list = Array.isArray(entries) ? entries.filter(isShapeOk) : [];
  const max = cfg.maxEntries ?? DEFAULTS.maxEntries;
  const kept = list.filter((e) => {
    if (e.saidAt) return now - e.saidAt < 24 * HOUR;
    return !isExpired(e, now) && !isFaded(e, cfg);
  });
  if (kept.length <= max) return kept;
  // 超额：先说出口的可以扔，再扔最旧的没说出口的
  const sorted = kept.slice().sort((a, b) => {
    const aSaid = a.saidAt ? 1 : 0;
    const bSaid = b.saidAt ? 1 : 0;
    if (aSaid !== bSaid) return bSaid - aSaid; // 说出口的排前面（先被扔）
    return (a.at ?? 0) - (b.at ?? 0);
  });
  return sorted.slice(kept.length - max);
}

export function isShapeOk(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.text === 'string' &&
    value.text !== '' &&
    Number.isFinite(value.at)
  );
}

/** 人话时间差。 */
export function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

/**
 * 注入文本。**同步、绝不抛错**（它在 `agent/pre-step` 里被调到）。
 *
 * 排序：快过期的优先（再不提就真没了），同过期时间按旧的先。
 *
 * @param {object[]} entries
 * @param {number} now
 * @param {object} [cfg]
 * @returns {string|null}
 */
export function promptLine(entries, now, cfg = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const max = cfg.injectMax ?? DEFAULTS.injectMax;
  const pending = list
    .filter((e) => e?.saidAt == null && !isExpired(e, now) && !isFaded(e, cfg))
    .sort((a, b) => {
      const d = (a.expiresAt ?? 0) - (b.expiresAt ?? 0);
      if (d !== 0) return d;
      return (a.at ?? 0) - (b.at ?? 0);
    })
    .slice(0, max);
  if (pending.length === 0) return null;

  const lines = pending.map((e) => {
    const age = humanAge(now - (e?.at ?? now));
    const why = e?.why ? `（当时没说是因为：${e.why}）` : '';
    return `- 「${e.text}」${why}${age ? `——${age}按住没说` : ''}`;
  });

  return [
    '下面是你自己咽回去、没说出口的话。它们还没被对方听见，所以你不欠着、不急着交差：',
    ...lines,
    '（这些只是你心里存着的念头。要是这会儿话头正好对得上，自然地说出来；'
      + '要是没有合适的时候，就继续放着。**不要**说「我有话一直没说」「我之前想跟你说」'
      + '这种绕弯子的开场，也不要一口气把它们清空。）',
  ].join('\n');
}

/**
 * 创建模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {()=>string} [options.resolveMediaDir] - 状态目录（延迟解析）
 */
export function createUnsaid({ cfg, stats, log, resolveMediaDir }) {
  /** @type {object[]} */
  let entries = [];
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
      label: 'unsaid',
      normalize: (value) => (Array.isArray(value) ? value.filter(isShapeOk) : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('entries');
        entries = prune(Array.isArray(raw) ? raw : [], now(), cfg);
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
      if (stats) stats.unsaidLastError = String(error?.message ?? error);
    }
  }

  /**
   * 按住一句话。
   *
   * @param {{text:string, why?:string, ttlHours?:number, chatId?:string}} input
   */
  async function hold(input) {
    if (!enabled()) return { ok: false, reason: '咽回去的话未启用' };
    await ensureStore().catch(() => undefined);
    const made = createUnsaidEntry(input, now(), cfg);
    if (made.ok !== true) return { ok: false, reason: made.reason };

    // 一分钟内重复同一个句子不重复记（模型常在多步回合里连调两次）。
    const dup = entries.find(
      (e) => e.text === made.entry.text && !e.saidAt && now() - e.at < 60_000,
    );
    if (dup !== undefined) {
      if (stats) stats.unsaidDuplicates = (stats.unsaidDuplicates ?? 0) + 1;
      return { ok: true, entry: { ...dup }, duplicate: true, total: pendingCount() };
    }

    entries = prune([...entries, made.entry], now(), cfg);
    persist();
    if (stats) {
      stats.unsaidHeld = (stats.unsaidHeld ?? 0) + 1;
      stats.unsaidLastAt = made.entry.at;
      stats.unsaidLastText = made.entry.text;
    }
    say('info', `[unsaid] 按住一句：${made.entry.text.slice(0, 40)}`);
    return { ok: true, entry: made.entry, total: pendingCount() };
  }

  /** 说出口了（按 id 或正文片段）。 */
  async function said(key) {
    if (!enabled()) return { ok: false, reason: '咽回去的话未启用' };
    await ensureStore().catch(() => undefined);
    const k = typeof key === 'string' ? key.trim() : '';
    if (k === '') return { ok: false, reason: 'key 不能为空' };
    const hit = findEntry(k);
    if (hit === undefined) return { ok: false, reason: '没有这一条' };
    if (hit.saidAt) return { ok: true, entry: { ...hit }, already: true, total: pendingCount() };
    hit.saidAt = now();
    persist();
    if (stats) stats.unsaidSaid = (stats.unsaidSaid ?? 0) + 1;
    return { ok: true, entry: { ...hit }, total: pendingCount() };
  }

  /** 不想说了 / 说了也不合适了 —— 直接划掉。 */
  async function drop(key) {
    if (!enabled()) return { ok: false, reason: '咽回去的话未启用' };
    await ensureStore().catch(() => undefined);
    const k = typeof key === 'string' ? key.trim() : '';
    if (k === '') return { ok: false, reason: 'key 不能为空' };
    const index = entries.findIndex((e) => e.id === k);
    const at = index >= 0 ? index : entries.findIndex((e) => typeof e.text === 'string' && e.text.includes(k));
    if (at < 0) return { ok: false, reason: '没有这一条' };
    const [gone] = entries.splice(at, 1);
    persist();
    if (stats) stats.unsaidDropped = (stats.unsaidDropped ?? 0) + 1;
    return { ok: true, entry: { ...gone }, total: pendingCount() };
  }

  function findEntry(key) {
    const byId = entries.find((e) => e.id === key);
    if (byId !== undefined) return byId;
    return entries.find((e) => typeof e.text === 'string' && e.text.includes(key));
  }

  function pendingCount() {
    return entries.filter((e) => !e.saidAt && !isExpired(e, now()) && !isFaded(e, cfg)).length;
  }

  /**
   * 同步取一份还按着的（给 `solitude` 那种注入时现取的模块用）。
   *
   * 与 `list` 的区别同 diary 的 `peek`：`list` 是 async（先 ensureStore 读盘），
   * 而注入链是同步的，等不起。这边只读内存里已加载的那份，不触发读盘；没加载
   * 完就返回空数组，下一轮自然就有。
   *
   * @returns {object[]} 副本（还没说出口的那些）
   */
  function peek() {
    try {
      entries = prune(entries, now(), cfg);
      return entries.filter((e) => !e.saidAt).map((e) => ({ ...e }));
    } catch {
      return [];
    }
  }

  /** 读表。status: pending(默认) / said / all */
  async function list(query = {}) {
    await ensureStore().catch(() => undefined);
    entries = prune(entries, now(), cfg);
    const status = typeof query?.status === 'string' ? query.status : 'pending';
    const limit = Number.isFinite(query?.limit) ? Math.max(1, Math.floor(query.limit)) : 20;
    let out = entries;
    if (status === 'pending') out = out.filter((e) => !e.saidAt);
    else if (status === 'said') out = out.filter((e) => e.saidAt);
    return out
      .slice()
      .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /**
   * 注入用文本 + 顺带把这次提过的条目计数 +1。
   *
   * 「提到几次就淡化」必须在这里落地：注入是唯一的「她又被提醒了一次」的时刻。
   */
  function injectionText() {
    if (!enabled()) return null;
    try {
      const alive = prune(entries, now(), cfg);
      if (alive.length !== entries.length) entries = alive;
      const line = promptLine(alive, now(), cfg);
      if (line === null) return null;
      // 数一下这次实际注入了哪几条（与 promptLine 的排序/截断保持一致）
      const max = cfg?.injectMax ?? DEFAULTS.injectMax;
      const picked = alive
        .filter((e) => !e.saidAt && !isExpired(e, now()) && !isFaded(e, cfg))
        .sort((a, b) => {
          const d = (a.expiresAt ?? 0) - (b.expiresAt ?? 0);
          if (d !== 0) return d;
          return (a.at ?? 0) - (b.at ?? 0);
        })
        .slice(0, max);
      for (const e of picked) e.nudges = (e.nudges ?? 0) + 1;
      persist();
      return line;
    } catch {
      return null;
    }
  }

  /** 观测快照。 */
  function snapshot() {
    const alive = prune(entries, now(), cfg);
    return {
      enabled: enabled(),
      pending: alive.filter((e) => !e.saidAt).length,
      /** 说出口但还没被裁掉（给观测面看的，不是注入用的）。 */
      recentlySaid: alive.filter((e) => e.saidAt).length,
      oldestAt: alive.length === 0 ? null : Math.min(...alive.map((e) => e.at)),
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  function start() {
    void ensureStore()
      .then(() => {
        const before = entries.length;
        entries = prune(entries, now(), cfg);
        if (entries.length !== before) persist();
      })
      .catch(() => undefined);
  }

  /** 自测：纯函数 + 假存储，绝不碰真状态文件。 */
  async function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const T0 = 1_700_000_000_000;

    // —— 造条目 ——
    const made = createUnsaidEntry({ text: '  你今天是不是不太高兴  ' }, T0);
    check('createUnsaidEntry 成功', made.ok === true);
    check('去首尾空白', made.entry?.text === '你今天是不是不太高兴');
    check('默认保质期 48 小时', made.entry?.ttlHours === 48);
    check('有 id', typeof made.entry?.id === 'string' && made.entry.id !== '');
    check('空文本被拒', createUnsaidEntry({ text: '  ' }, T0).ok === false);
    check(
      '超长截断',
      createUnsaidEntry({ text: 'x'.repeat(500) }, T0, { maxTextChars: 10 }).entry?.text === `${'x'.repeat(10)}…`,
    );
    check('保质期被上限卡住', createUnsaidEntry({ text: 'a', ttlHours: 9999 }, T0, { maxTtlHours: 100 }).entry?.ttlHours === 100);
    check('保质期乱填退默认', createUnsaidEntry({ text: 'a', ttlHours: -5 }, T0).entry?.ttlHours === 48);

    // —— 过期与淡化 ——
    const e1 = createUnsaidEntry({ text: 'a', ttlHours: 1 }, T0).entry;
    check('1 小时内没过期', isExpired(e1, T0 + 30 * 60_000) === false);
    check('1 小时后过期', isExpired(e1, T0 + HOUR + 1) === true);
    const saidE = { ...e1, saidAt: T0 + 1000 };
    check('说出口的不算过期', isExpired(saidE, T0 + 999 * HOUR) === false);

    check('提到 0 次没淡化', isFaded(e1, { maxNudges: 3 }) === false);
    check('提到 3 次就淡化', isFaded({ ...e1, nudges: 3 }, { maxNudges: 3 }) === true);
    check('说出口的不算淡化', isFaded({ ...saidE, nudges: 9 }, { maxNudges: 3 }) === false);

    // —— 裁剪 ——
    // e1 的保质期是 1 小时：T0+2h 时它该被摘掉；说出口超过 24 小时的也摘掉。
    const pruned = prune(
      [e1, { ...e1, id: 'x', text: 'b', saidAt: T0 - 100 * HOUR }],
      T0 + 2 * HOUR,
      {},
    );
    check('prune 摘掉过期', pruned.length === 0);
    // 刚说出口的留着（给观测面看）
    const justSaid = { ...e1, id: 'y', text: 'c', saidAt: T0 + 2 * HOUR };
    check('prune 留下刚说出口的', prune([justSaid], T0 + 2 * HOUR + 1000, {}).length === 1);
    // 没过期、没淡化、没说出口的要留着
    const alive = createUnsaidEntry({ text: 'alive', ttlHours: 10 }, T0).entry;
    check('prune 保留还活着的', prune([alive], T0 + 1 * HOUR, {}).length === 1);
    const capped = prune(
      [
        createUnsaidEntry({ text: 'old', ttlHours: 99 }, T0).entry,
        createUnsaidEntry({ text: 'new', ttlHours: 99 }, T0 + 1000).entry,
      ],
      T0 + 2000,
      { maxEntries: 1 },
    );
    check('prune 超额留新的', capped.length === 1 && capped[0].text === 'new');

    // —— humanAge ——
    check('humanAge 半分钟', humanAge(30_000) === '刚刚');
    check('humanAge 90 分钟', humanAge(90 * 60_000) === '1 小时前');
    check('humanAge 3 天', humanAge(3 * 24 * HOUR) === '3 天前');
    check('humanAge 负数空串', humanAge(-1) === '');

    // —— 注入文本 ——
    check('promptLine 空表返回 null', promptLine([], T0) === null);
    const line = promptLine([e1], T0 + 1000);
    check('promptLine 有内容', typeof line === 'string' && line.includes('你今天是吗') === false);
    check('promptLine 含正文', typeof line === 'string' && line.includes('a'));
    check('promptLine 不含花括号', typeof line === 'string' && !line.includes('{') && !line.includes('}'));
    check('promptLine 明说不要报幕', typeof line === 'string' && line.includes('不要') && line.includes('我有话一直没说'));
    // 三条同时快过期时，按过期时间早的优先
    const soon = createUnsaidEntry({ text: 'soon', ttlHours: 1 }, T0).entry;
    const late = createUnsaidEntry({ text: 'late', ttlHours: 40 }, T0).entry;
    const ordered = promptLine([late, soon], T0 + 1000, { injectMax: 1 });
    check('promptLine 快过期的优先', typeof ordered === 'string' && ordered.includes('soon'));

    // —— 假存储跑真实增删 ——
    const fake = createUnsaid({
      cfg: { ...DEFAULTS, enabled: true },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
    });
    const h1 = await fake.hold({ text: '想问他今天怎么这么安静', why: '怕显得太黏' });
    check('hold 成功', h1.ok === true);
    const h2 = await fake.hold({ text: '想问他今天怎么这么安静' });
    check('一分钟内重复不重复记', h2.duplicate === true);
    const listed = await fake.list({});
    check('list 看得到', listed.length === 1 && listed[0].text === '想问他今天怎么这么安静');
    check('list 带上了 why', listed[0].why === '怕显得太黏');
    const s1 = await fake.said(listed[0].id);
    check('said 标记成功', s1.ok === true);
    check('said 之后 pending 为空', (await fake.list({})).length === 0);
    check('said 之后 said 有一条', (await fake.list({ status: 'said' })).length === 1);
    const dropped = await fake
      .hold({ text: '算了不说了' })
      .then(() => fake.drop('算了'));
    check('drop 按片段划掉', dropped.ok === true);
    check('drop 找不到时给 reason', (await fake.drop('根本没有这一条')).ok === false);

    // —— 注入会累计 nudges（「提几次就淡化」的落地） ——
    const fake2 = createUnsaid({
      cfg: { ...DEFAULTS, enabled: true, maxNudges: 2 },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
    });
    await fake2.hold({ text: '这句话会一直被提' });
    fake2.injectionText();
    const after1 = (await fake2.list({})).length;
    fake2.injectionText();
    fake2.injectionText();
    const after3 = (await fake2.list({})).length;
    check('提一次还在', after1 === 1);
    check('提满 maxNudges 次后淡化掉', after3 === 0);

    const failed = checks.filter((c) => c.ok !== true);
    return { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
  }

  return { hold, said, drop, list, peek, injectionText, snapshot, start, selfTest, DEFAULTS };
}
