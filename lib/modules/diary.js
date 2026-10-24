/**
 * dsh-onebot-companion / modules/diary.js
 *
 * 日记：她自己记下来的事，按重要性分级，到期就忘。
 *
 * ## 为什么需要它
 *
 * 2026-10-19 用户丢来两篇小黑盒的教程，其中「记忆分级 + 遗忘机制」是唯一
 * 我们这边完全没有的东西。现状是两头都极端：
 *
 *   - 会话日志**全留**（`session.v4.jsonl.zstd` 一辈子不删）；
 *   - 上下文**全压**（compaction 一到就把旧事揉成摘要，细节没了）。
 *
 * 中间那一层是空的 —— 没有一个「她主动记下来的、能自己回看、会自然淡掉」的地方。
 * 人会忘，忘本身是关系的一部分：三天前随口一句和上个月的一次深谈，本来就该
 * 有不同的留存期。全都记住反而是失真的。
 *
 * ## 三档 + 到期
 *
 *   | 档位       | 留存    | 什么时候用                                |
 *   |------------|---------|-------------------------------------------|
 *   | normal     | 7 天    | 日常琐事：吃了什么、今天上了什么课        |
 *   | important  | 30 天   | 值得记的：他的烦心事、约好的事、他在意的事 |
 *   | critical   | 永不    | 定义关系的事：他的底线、重要日期、他的选择 |
 *
 * 到期不是「删除」，是**不再出现在注入提示里**（`prune` 真的从表里摘掉，
 * 但摘掉之前不会有人看见差别 —— 反正它已经不参与提示了）。
 *
 * ## 谁写日记
 *
 * **她自己写**，通过 `qq_diary` 工具。不自动摘抄聊天记录：自动摘要会长成一堆
 * 「用户说了 X」的流水账，那不是日记，是日志的另一个副本。这里要的是她的口吻、
 * 她的取舍。
 *
 * ## 与 `stamp` / `mood` 的关系
 *
 * 完全独立。日记不改入参、不碰原型、不挂任何 hook —— 它只是「一张表 + 一个
 * 工具 + 一段注入文本」。这一层刻意做得笨，因为记忆是最经不起聪明的地方。
 *
 * ## 设计约束
 *
 *   1. 纯函数部分零 import（`createEntry` / `prune` / `promptLine` / 分档），
 *      离线单测可裸 node 直接 import；
 *   2. 时间一律走调用方传入的 `now`，模块内部不读 `Date.now()` —— 否则单测
 *      没法锁时间；
 *   3. 容量上限硬性生效（默认 400 条），淘汰顺序 = 先过期 → 再按档位低 → 再旧。
 *      不设上限的话，「critical 永不删」会无限长大。
 *
 * @module dsh-onebot-companion/modules/diary
 */

/** 三档的 id，按重要性升序。 */
export const LEVELS = ['normal', 'important', 'critical'];

/** 档位中文名（注入提示与工具返回值里用）。 */
export const LEVEL_LABELS = {
  normal: '琐事',
  important: '要紧',
  critical: '重要',
};

/** 各档留存期（毫秒）。`null` = 永不过期。 */
export const LEVEL_TTL_MS = {
  normal: 7 * 24 * 3600 * 1000,
  important: 30 * 24 * 3600 * 1000,
  critical: null,
};

/** 档位排序权重（淘汰时先扔小的）。 */
const LEVEL_WEIGHT = { normal: 0, important: 1, critical: 2 };

export const DEFAULTS = {
  enabled: true,
  /**
   * ⚠️ **边界：日记不是长期记忆的权威源。**
   *
   * 2026-10-23 读完 dsh-agent-soul 的「四条判据」后补的约定（仓库根目录有
   * `AUTHORITY.md` 全文）：事实性的、不带日期的结论句（「他就是三分钟热度」）
   * 该进 **mnemon**；日记只收**有日期、会过期**的事（「今天他把模型换了」）。
   *
   * 现在只是约定，代码不强制 —— 但写日记时若冒出「他就是这样」这类判断句，
   * 该记进 mnemon，而不是往这里塞一条永久的 critical。
   */
  /** 每档的提示行里最多列几条（免得把上下文撑爆）。 */
  injectNormalMax: 3,
  injectImportantMax: 5,
  injectCriticalMax: 6,
  /** 表容量上限，超了按「先过期 → 档位低 → 旧」淘汰。 */
  maxEntries: 400,
  /** 单条正文最大字数（超了截断，免得模型一次灌一大段）。 */
  maxTextChars: 200,
  /** 状态文件名（落在 mediaDir 下）。 */
  stateFile: 'diary-state.json',
  /**
   * 记忆染色（2026-10-21）：心情/精力偏离常态时，给注入的日记末尾加一句
   * 「此刻想起这件事是什么感觉」。关掉就只注入干表。
   */
  tintEnabled: true,
  /** 精力低于这个值算「累」，累的时候记忆只剩轮廓。 */
  tintLowEnergy: 35,
  /** 至少这么久以前记的事才可能被染色（刚写下的还记得原样）。 */
  tintMinAgeMs: 6 * 3600 * 1000,
};

/**
 * 把任意输入规整成合法档位；认不出来按 normal。
 * @param {unknown} value
 * @returns {'normal'|'important'|'critical'}
 */
export function normalizeLevel(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return LEVELS.includes(raw) ? raw : 'normal';
}

/**
 * 造一条日记条目。纯函数。
 *
 * @param {object} input - `{ text, level, chatId, at, tags? }`。
 * @param {number} now - 当前 ms epoch，用于兜底 `at`。
 * @param {object} [cfg] - 只读 `maxTextChars`。
 * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
 */
export function createEntry(input, now, cfg = {}) {
  const maxChars = Number.isFinite(cfg.maxTextChars) ? cfg.maxTextChars : DEFAULTS.maxTextChars;
  const raw = typeof input?.text === 'string' ? input.text.trim() : '';
  if (raw === '') return { ok: false, reason: 'text 不能为空' };
  const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
  const level = normalizeLevel(input?.level);
  const at = Number.isFinite(input?.at) ? input.at : now;
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((t) => String(t ?? '').trim()).filter((t) => t !== '').slice(0, 8)
    : [];
  const entry = {
    id: `${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    level,
    text,
    chatId: typeof input?.chatId === 'string' ? input.chatId : '',
  };
  if (tags.length > 0) entry.tags = tags;
  return { ok: true, entry };
}

/**
 * 一条是否已过期。纯函数。
 * @param {object} entry
 * @param {number} now
 * @returns {boolean}
 */
export function isExpired(entry, now) {
  const ttl = LEVEL_TTL_MS[entry?.level];
  if (ttl === null || ttl === undefined) return false;
  const at = Number.isFinite(entry?.at) ? entry.at : 0;
  return now - at >= ttl;
}

/**
 * 淘汰到容量上限内。纯函数（返回新数组，不改入参）。
 *
 * 顺序：先按档位权重升序、再按时间升序 —— 也就是「琐事最先被扔，同样档位里
 * 最旧的先被扔」。`critical` 只有在全是 critical 且超限时才会被扔（那说明
 * 容量配得太小，或者她什么都往 critical 里塞）。
 *
 * @param {object[]} entries
 * @param {number} max
 * @returns {object[]}
 */
export function trimToLimit(entries, max) {
  const list = Array.isArray(entries) ? entries : [];
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULTS.maxEntries;
  if (list.length <= cap) return list.slice();
  const sorted = list.slice().sort((a, b) => {
    const wa = LEVEL_WEIGHT[a?.level] ?? 0;
    const wb = LEVEL_WEIGHT[b?.level] ?? 0;
    if (wa !== wb) return wa - wb;
    return (a?.at ?? 0) - (b?.at ?? 0);
  });
  return sorted.slice(list.length - cap);
}

/**
 * 裁剪整张表：先摘过期，再压容量。纯函数。
 * @param {object[]} entries
 * @param {number} now
 * @param {object} [cfg]
 * @returns {object[]}
 */
export function prune(entries, now, cfg = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => !isExpired(e, now));
  return trimToLimit(list, cfg.maxEntries ?? DEFAULTS.maxEntries);
}

/**
 * 把毫秒差说成「3 天前」「5 小时前」。纯函数。
 * @param {number} ms
 * @returns {string}
 */
export function humanAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/**
 * 心情 → 「此刻想起这条是什么感觉」的措辞（2026-10-21，记忆染色）。
 *
 * 为什么要这个：记忆不是录像带，同一条事在不同的心情里翻出来，颜色不一样。
 * 开心时想起吵架会觉得「那会儿真幼稚」，低落时想起同一件事会觉得
 * 「其实他也没做错什么」。这不是记忆出错，是记忆被当前情绪渲染过。
 *
 * 文案里**绝不能出现花括号**（宿主提示词插值器会把双花括号当变量并抛错）。
 */
const TINT_LEAN = {
  down: '心里有点发沉，不像当时那么笃定',
  pouty: '还是有点不痛快',
  clingy: '只觉得当时该多留一会儿',
  tired: '细节已经有点糊了，只剩个大概',
  playful: '忍不住想笑',
  happy: '心里是暖的',
  excited: '还是有点激动',
};

/**
 * 给日记挑一条「此刻的颜色」。纯函数、确定性（不消费随机数）。
 *
 * 只在心情或精力确实偏离常态时才染色 —— 平静的时候记忆就是记忆，不需要滤镜。
 * 挑哪一条：档位高的优先，同档位里更老的优先（越老越容易褪色），且必须至少
 * 6 小时前记的（刚写下的还记得原样，没什么可染的）。
 *
 * @param {object[]} entries - 已 prune 过的表。
 * @param {number} now
 * @param {{mood?:string, energy?:number}|null} state - persona 的合成状态。
 * @param {object} [cfg] - 只读 `tintEnabled` / `tintLowEnergy` / `tintMinAgeMs`。
 * @returns {string|null}
 */
export function tintNote(entries, now, state = null, cfg = {}) {
  if (cfg.tintEnabled === false) return null;
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return null;
  if (state === null || typeof state !== 'object') return null;
  const moodId = typeof state.mood === 'string' ? state.mood : '';
  const energy = Number.isFinite(state.energy) ? state.energy : 80;
  const low = energy < (Number.isFinite(cfg.tintLowEnergy) ? cfg.tintLowEnergy : 35);
  const lean = TINT_LEAN[moodId];
  // 心情平淡且精力正常 —— 不染色。记忆该是干净的。
  if (lean === undefined && !low) return null;

  const minAge = Number.isFinite(cfg.tintMinAgeMs) ? cfg.tintMinAgeMs : 6 * 3600 * 1000;
  const candidates = list.filter((e) => Number.isFinite(e?.at) && now - e.at >= minAge);
  if (candidates.length === 0) return null;

  const weight = { normal: 0, important: 1, critical: 2 };
  const picked = candidates.slice().sort((a, b) => {
    const wa = weight[a?.level] ?? 0;
    const wb = weight[b?.level] ?? 0;
    if (wa !== wb) return wb - wa;
    return (a?.at ?? 0) - (b?.at ?? 0);
  })[0];

  const feeling = lean === undefined ? '只剩一个模糊的轮廓' : lean;
  return `想起「${picked?.text ?? ''}」这件事，${feeling}。——这是此刻的颜色，不是当时的样子。`;
}

/**
 * 生成注入用的一段日记文本。纯函数，**恒不返回花括号**（宿主的提示词插值器
 * 会把 `{{name}}` 当变量引用并抛错）。
 *
 * @param {object[]} entries - 已 prune 过的表。
 * @param {number} now
 * @param {object} [cfg]
 * @param {string|null} [tint] - `tintNote` 的结果，追加在末尾。
 * @returns {string|null} 没有可注入的内容时返回 null。
 */
export function promptLine(entries, now, cfg = {}, tint = null) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return null;
  const maxOf = {
    normal: cfg.injectNormalMax ?? DEFAULTS.injectNormalMax,
    important: cfg.injectImportantMax ?? DEFAULTS.injectImportantMax,
    critical: cfg.injectCriticalMax ?? DEFAULTS.injectCriticalMax,
  };
  const lines = [];
  for (const level of ['critical', 'important', 'normal']) {
    const bucket = list
      .filter((e) => e?.level === level)
      .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, maxOf[level]);
    if (bucket.length === 0) continue;
    lines.push(`【${LEVEL_LABELS[level]}】`);
    for (const e of bucket) {
      const age = humanAge(now - (e?.at ?? now));
      const suffix = age === '' ? '' : `（${age}）`;
      lines.push(`- ${e?.text ?? ''}${suffix}`);
    }
  }
  if (lines.length === 0) return null;
  const head = [
    '以下是你自己写过的小本子（你记得这些事，但别把它们当清单念出来；自然想起就用）：',
    ...lines,
  ];
  if (typeof tint === 'string' && tint !== '') head.push(tint);
  return head.join('\n');
}

/**
 * 创建日记模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - diary 段配置。
 * @param {object} options.stats - 共享统计。
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => string} [options.resolveMediaDir] - 状态目录（延迟解析）。
 * @returns {object}
 */
export function createDiary({ cfg, stats, log, resolveMediaDir }) {
  /** @type {object[]} 内存表（按 at 升序无所谓，读时再排）。 */
  let entries = [];
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const now = () => Date.now();

  const enabled = () => cfg?.enabled !== false;

  /**
   * 惰性绑定状态文件。第一次用到时才去解析 mediaDir —— 那时 bridge 已经
   * 存在，`deps.config.mediaDir` 拿得到。
   */
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
      label: 'diary',
      normalize: (value) => (Array.isArray(value) ? value.filter(isShapeOk) : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('entries');
        entries = Array.isArray(raw) ? raw.filter(isShapeOk) : [];
        entries = prune(entries, now(), cfg);
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function isShapeOk(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.text === 'string' &&
      value.text !== '' &&
      Number.isFinite(value.at)
    );
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('entries', entries);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.diaryLastError = String(error?.message ?? error);
    }
  }

  /**
   * 记一条。
   * @param {{text:string, level?:string, chatId?:string, tags?:string[]}} input
   * @returns {Promise<{ok:boolean, entry?:object, reason?:string, total?:number}>}
   */
  async function remember(input) {
    if (!enabled()) return { ok: false, reason: '日记未启用' };
    await ensureStore().catch(() => undefined);
    const made = createEntry(input, now(), cfg);
    if (made.ok !== true) return { ok: false, reason: made.reason };
    // 内容完全相同的最近一条不重复记（模型很容易同一件事记两遍）。
    const dup = entries.find(
      (e) => e.text === made.entry.text && e.level === made.entry.level && now() - e.at < 6 * 3600 * 1000,
    );
    if (dup !== undefined) {
      if (stats) stats.diaryDuplicates = (stats.diaryDuplicates ?? 0) + 1;
      return { ok: true, entry: dup, duplicate: true, total: entries.length };
    }
    entries = prune([...entries, made.entry], now(), cfg);
    persist();
    if (stats) {
      stats.diaryWritten = (stats.diaryWritten ?? 0) + 1;
      stats.diaryLastAt = made.entry.at;
      stats.diaryLastText = made.entry.text;
    }
    say('info', `[diary] 记下（${made.entry.level}）：${made.entry.text.slice(0, 40)}`);
    return { ok: true, entry: made.entry, total: entries.length };
  }

  /**
   * 读表（顺带裁剪）。返回的是**副本**，外部改它不影响内部。
   * @param {{limit?:number, level?:string}} [query]
   * @returns {Promise<object[]>}
   */
  async function list(query = {}) {
    await ensureStore().catch(() => undefined);
    entries = prune(entries, now(), cfg);
    const limit = Number.isFinite(query?.limit) ? Math.max(1, Math.floor(query.limit)) : 20;
    let out = entries;
    if (typeof query?.level === 'string' && query.level !== '') {
      const want = normalizeLevel(query.level);
      out = out.filter((e) => e.level === want);
    }
    return out
      .slice()
      .sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0))
      .slice(0, limit)
      .map((e) => ({ ...e }));
  }

  /**
   * 划掉一条。按 id 精确匹配优先，其次正文子串。
   *
   * 为什么要有「忘掉」这个动作：日记只增不减的话，她会一直背着一堆过期的
   * 在意 —— 那不是记忆，是负担。让她能主动划掉，比让 TTL 到点自动淡掉
   * 更像人做的选择。
   *
   * @param {string} key - 条目 id，或正文里的一小段。
   * @returns {Promise<{ok:boolean, entry?:object, reason?:string, total?:number}>}
   */
  async function forget(key) {
    if (!enabled()) return { ok: false, reason: '日记未启用' };
    await ensureStore().catch(() => undefined);
    const k = typeof key === 'string' ? key.trim() : '';
    if (k === '') return { ok: false, reason: 'key 不能为空' };
    const byId = entries.findIndex((e) => e.id === k);
    const index = byId >= 0 ? byId : entries.findIndex((e) => typeof e.text === 'string' && e.text.includes(k));
    if (index < 0) return { ok: false, reason: '小本子里没有这一条' };
    const [gone] = entries.splice(index, 1);
    persist();
    if (stats) stats.diaryForgotten = (stats.diaryForgotten ?? 0) + 1;
    return { ok: true, entry: { ...gone }, total: entries.length };
  }

  /** 立刻做一次过期裁剪并落盘（观测端点与 rescan 用）。 */
  async function sweep() {
    await ensureStore().catch(() => undefined);
    const before = entries.length;
    entries = prune(entries, now(), cfg);
    const removed = before - entries.length;
    if (removed > 0) {
      if (stats) stats.diaryForgotten = (stats.diaryForgotten ?? 0) + removed;
      persist();
    }
    return removed;
  }

  /**
   * 注入用文本。同步、绝不抛错（它在 `agent/pre-step` 里被调到）。
   *
   * 2026-10-21：多收一个 `state`（persona 的合成状态）用来记忆染色 ——
   * 同一条事在低落时和开心时翻出来，语气应该不一样。state 拿不到就只注入
   * 干表，跟以前一样。
   *
   * @param {{mood?:string, energy?:number}|null} [state]
   */
  function injectionText(state = null) {
    if (!enabled()) return null;
    try {
      const alive = prune(entries, now(), cfg);
      if (alive.length !== entries.length) entries = alive;
      const tint = tintNote(alive, now(), state, cfg);
      return promptLine(alive, now(), cfg, tint);
    } catch {
      return null;
    }
  }

  /**
   * 同步取一份活着的条目（给 `solitude` 那种「注入时现取」的模块用）。
   *
   * 为什么另开一个而不是复用 `list`：`list` 是 async（要先 ensureStore 读盘），
   * 而注入链在 `agent/pre-step` 里是同步的，等不起。这里只读内存里已经加载好的
   * 那份，**不触发读盘**；没加载完就返回空数组，下一轮自然就有。
   *
   * @returns {object[]} 副本，改了不影响内部表。
   */
  function peek() {
    try {
      return prune(entries, now(), cfg).map((e) => ({ ...e }));
    } catch {
      return [];
    }
  }

  /** 观测快照。 */
  function snapshot() {
    const alive = prune(entries, now(), cfg);
    const byLevel = { normal: 0, important: 0, critical: 0 };
    for (const e of alive) {
      const level = normalizeLevel(e?.level);
      byLevel[level] = (byLevel[level] ?? 0) + 1;
    }
    return {
      enabled: enabled(),
      total: alive.length,
      byLevel,
      oldestAt: alive.length === 0 ? null : Math.min(...alive.map((e) => e.at)),
      newestAt: alive.length === 0 ? null : Math.max(...alive.map((e) => e.at)),
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  /** 启动即加载（index.js 在 effect 里调，失败不影响主流程）。 */
  function start() {
    void ensureStore()
      .then(() => sweep())
      .catch(() => undefined);
  }

  /**
   * 自测：纯函数那一层 + 一张假表跑 remember/forget。
   *
   * 刻意**不碰真状态文件**（`ensureStore` 在 resolveMediaDir 返回空串时直接放弃，
   * 于是这里所有操作都只在内存里进行）。这样在 GUI 里点一下就能验，不用担心
   * 把她的真日记搅乱。
   */
  async function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const T0 = 1_700_000_000_000;
    const DAY = 24 * 3600 * 1000;

    // —— 档位归一 ——
    check('normalizeLevel 认 important', normalizeLevel('important') === 'important');
    check('normalizeLevel 认大小写', normalizeLevel('CRITICAL') === 'critical');
    check('normalizeLevel 乱填退 normal', normalizeLevel('nonsense') === 'normal');
    check('normalizeLevel 空退 normal', normalizeLevel(undefined) === 'normal');

    // —— 造条目 ——
    const made = createEntry({ text: '  他在准备考试  ' }, T0);
    check('createEntry 成功', made.ok === true);
    check('createEntry 去首尾空白', made.entry?.text === '他在准备考试');
    check('createEntry 默认 normal', made.entry?.level === 'normal');
    check('createEntry 有 id', typeof made.entry?.id === 'string' && made.entry.id !== '');
    check('createEntry 空文本被拒', createEntry({ text: '   ' }, T0).ok === false);
    check(
      'createEntry 超长截断',
      createEntry({ text: 'x'.repeat(500) }, T0, { maxTextChars: 10 }).entry?.text === `${'x'.repeat(10)}…`,
    );

    // —— 过期判定（三档 TTL 各不相同） ——
    const normalEntry = createEntry({ text: 'a', at: T0 }, T0).entry;
    const importantEntry = createEntry({ text: 'b', level: 'important', at: T0 }, T0).entry;
    const criticalEntry = createEntry({ text: 'c', level: 'critical', at: T0 }, T0).entry;
    check('normal 8 天后过期', isExpired(normalEntry, T0 + 8 * DAY) === true);
    check('normal 6 天前还在', isExpired(normalEntry, T0 + 6 * DAY) === false);
    check('important 8 天后还在', isExpired(importantEntry, T0 + 8 * DAY) === false);
    check('important 31 天后过期', isExpired(importantEntry, T0 + 31 * DAY) === true);
    check('critical 一年后还在', isExpired(criticalEntry, T0 + 365 * DAY) === false);

    // —— 裁剪：过期先走，再按档位低、再旧 ——
    const pruned = prune([normalEntry, importantEntry, criticalEntry], T0 + 8 * DAY);
    check('prune 摘掉过期的 normal', pruned.length === 2 && !pruned.some((e) => e.level === 'normal'));
    check('prune 留住 important', pruned.some((e) => e.level === 'important'));
    check('prune 留住 critical', pruned.some((e) => e.level === 'critical'));
    const capped = prune(
      [
        createEntry({ text: 'old-normal', level: 'normal', at: T0 }, T0).entry,
        createEntry({ text: 'crit', level: 'critical', at: T0 + 1 }, T0).entry,
      ],
      T0 + 2,
      { maxEntries: 1 },
    );
    check('prune 超额先扔低档', capped.length === 1 && capped[0].level === 'critical');

    // —— 注入文本 ——
    check('promptLine 空表返回 null', promptLine([], T0) === null);
    const line = promptLine([criticalEntry, importantEntry, normalEntry], T0 + 1000);
    check('promptLine 有内容', typeof line === 'string' && line !== '');
    check('promptLine 含正文', line.includes('a') && line.includes('c'));
    check('promptLine 不含花括号', !line.includes('{') && !line.includes('}'));
    check('promptLine 分档标题按重到轻', line.indexOf('【重要】') < line.indexOf('【琐事】'));

    // —— 记忆染色（2026-10-21） ——
    const DAYS8 = 8 * DAY;
    const oldEntry = createEntry({ text: '那天吵了一架', level: 'important', at: T0 }, T0).entry;
    const freshEntry = createEntry({ text: '刚记的', at: T0 + DAYS8 - 60_000 }, T0).entry;
    check('tintNote 空表返回 null', tintNote([], T0, { mood: 'down' }) === null);
    check('tintNote state 为 null 返回 null', tintNote([oldEntry], T0 + DAYS8, null) === null);
    check(
      'tintNote 心情平静精力充足不染色',
      tintNote([oldEntry], T0 + DAYS8, { mood: 'calm', energy: 80 }) === null,
    );
    const tintDown = tintNote([oldEntry], T0 + DAYS8, { mood: 'down', energy: 80 });
    check('tintNote 低落时染色', typeof tintDown === 'string' && tintDown.includes('那天吵了一架'));
    check('tintNote 说的是此刻不是当时', tintDown.includes('不是当时的样子'));
    check('tintNote 不含花括号', !tintDown.includes('{') && !tintDown.includes('}'));
    check(
      'tintNote 刚记的不染色',
      tintNote([freshEntry], T0 + DAYS8, { mood: 'down', energy: 80 }) === null,
    );
    const tintLow = tintNote([oldEntry], T0 + DAYS8, { mood: 'calm', energy: 10 });
    check('tintNote 精力低也染色', typeof tintLow === 'string' && tintLow.includes('模糊的轮廓'));
    check('tintNote 确定性', tintNote([oldEntry], T0 + DAYS8, { mood: 'down' }) === tintDown);
    check('tintNote 可关', tintNote([oldEntry], T0 + DAYS8, { mood: 'down' }, { tintEnabled: false }) === null);
    const tintedLine = promptLine([oldEntry], T0 + DAYS8, {}, tintDown);
    check('promptLine 收下 tint', typeof tintedLine === 'string' && tintedLine.includes('此刻的颜色'));
    check('promptLine 不给 tint 就不染色', !promptLine([oldEntry], T0 + DAYS8, {}).includes('此刻的颜色'));

    // —— humanAge ——
    check('humanAge 半分钟', humanAge(30_000) === '刚刚');
    check('humanAge 90 分钟', humanAge(90 * 60_000) === '1 小时前');
    check('humanAge 3 天', humanAge(3 * DAY) === '3 天前');
    check('humanAge 负数空串', humanAge(-1) === '');

    // —— 假存储跑真实写读删 ——
    const fake = createDiary({
      cfg: { ...DEFAULTS, enabled: true },
      stats: {},
      log: () => undefined,
      // 空串 → ensureStore 放弃 → 全程只在内存，不碰真文件
      resolveMediaDir: () => '',
    });
    const w1 = await fake.remember({ text: '他说他怕吵' , level: 'critical' });
    check('remember 写入成功', w1.ok === true);
    const w2 = await fake.remember({ text: '他说他怕吵', level: 'critical' });
    check('remember 六小时内相同内容去重', w2.duplicate === true);
    const listed = await fake.list({ limit: 10 });
    check('list 看得到刚写的那条', listed.length === 1 && listed[0].text === '他说他怕吵');
    const forgetById = await fake.forget(listed[0].id);
    check('forget 按 id 划掉', forgetById.ok === true);
    check('forget 之后表为空', (await fake.list({})).length === 0);
    const forgetBySub = await fake
      .remember({ text: '周末想去爬山', level: 'important' })
      .then(() => fake.forget('爬山'));
    check('forget 按正文片段划掉', forgetBySub.ok === true);
    check('forget 找不到时给 reason', (await fake.forget('根本没有这一条')).ok === false);

    const failed = checks.filter((c) => c.ok !== true);
    return {
      ok: failed.length === 0,
      total: checks.length,
      failed: failed.length,
      checks,
    };
  }

  return { remember, forget, list, peek, sweep, injectionText, snapshot, start, selfTest, DEFAULTS };
}
