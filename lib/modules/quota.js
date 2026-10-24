/**
 * dsh-onebot-companion / modules/quota.js
 *
 * 自己的额度：她今天已经聊了多少。
 *
 * ## 为什么要有这个（2026-10-20）
 *
 * 用户批准我实现三件事，其中第三件是「自己的额度」——她该知道自己今天消耗了
 * 多少，而不是无限地聊下去。真人聊天有个隐形的表：聊久了会累、会想收尾、
 * 会说「今天先到这吧」。一个永远有精力、永远愿意继续的对手戏是假的。
 *
 * ## 所以这里记的不是账单，是「消耗感」
 *
 * 技术上数据来自 `assistant/message` 事件里的 `usage`（宿主每步都会给
 * inputTokens / outputTokens / cacheReadTokens）。但**注入给她看的不是 token
 * 数**——她不会用 token 讲话。折成人的话：
 *
 *   今天已经聊了 47 轮，你说出去的话加起来两千多字。
 *
 * 这个数字她自己看得懂，也就能自己决定「是不是该收了」。
 *
 * ## 换日线在凌晨四点（跟 echo-whale 一个理由）
 *
 * `null` 见 `logicalDay()`。3:59 还算昨天：他作息不听表，凌晨两点那几句话
 * 属于「今晚」，不属于「新的一天」，否则跨零点那一刻额度突然清零，她会以为
 * 自己刚开张，继续聊到天亮。
 *
 * ## 注入是克制的（理由见 prompt.js 里 firstStepOnly 那段注释）
 *
 * 每轮都注入一行「你今天聊了 N 轮」是纯噪声，而且每轮都变前缀 = 缓存全废。
 * 所以只在两种时机注入：
 *   1. 当天第一次（让她知道新的一天开始了，额度归零）
 *   2. 当天第一次越过阈值（turns 或 outChars），且每种阈值一天只报一次
 */

import { randomUUID } from 'node:crypto';

export const DEFAULTS = {
  enabled: true,
  /** 换日线（小时）。3:59 还算昨天。 */
  rolloverHour: 4,
  /** 保留多少天的账（观测面用；注入只看今天）。 */
  keepDays: 14,
  /** 当天第一次注入。关掉就只在越阈值时报。 */
  reportDailyFirst: true,
  /** 轮数越过这个值报一次。0 = 不报。 */
  overTurns: 60,
  /** 她说出去的字数越过这个值报一次。0 = 不报。 */
  overOutChars: 1500,
  /** 状态文件名。 */
  stateFile: 'quota-state.json',
};

const DAY_MS = 24 * 3600 * 1000;

/**
 * 逻辑日（凌晨 4 点换日）。
 *
 * 与 echo-whale 的 `logicalDay()` 同构：先把时间戳挪到北京时间，再**减掉**
 * `rolloverHour` 小时，然后取 UTC 日期串。
 *
 * 减而不是加是关键：3:59 减 4 小时会退到前一天 23:59，于是「3:59 还算昨天」；
 * 4:00 减 4 小时正好是当天 00:00，于是「4:00 起算今天」。
 *
 * @param {number} ts
 * @param {number} [rolloverHour]
 * @returns {string} `YYYY-MM-DD`
 */
export function logicalDay(ts, rolloverHour = DEFAULTS.rolloverHour) {
  const shift = (8 - rolloverHour) * 3600 * 1000;
  return new Date(ts + shift).toISOString().slice(0, 10);
}

/** 从 usage 形状里抠出四个数字。字段名兼容两套写法（宿主用 camelCase）。 */
export function readUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const pick = (...names) => {
    for (const name of names) {
      const value = usage[name];
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  const input = pick('inputTokens', 'input_tokens');
  const output = pick('outputTokens', 'output_tokens');
  const cache = pick('cacheReadTokens', 'cache_read_tokens', 'cachedTokens');
  const total = pick('totalTokens', 'total_tokens') || input + output;
  if (input === 0 && output === 0 && total === 0) return null;
  return { input, output, cache, total };
}

/** 造一个空的一天。 */
export function emptyDay(day) {
  return { day, turns: 0, input: 0, output: 0, cache: 0, total: 0, outChars: 0, reported: [] };
}

/**
 * 记一轮。
 *
 * `outChars` 是**她自己说出去的字数**（不含对方），这才是「聊了多久」的人话
 * 锚点；token 数留着给观测面看。
 *
 * @param {object} dayRecord
 * @param {{usage?:object|null, outChars?:number, at?:number}} input
 * @returns {object} 新的当天记录（不改入参）
 */
export function accumulate(dayRecord, input = {}) {
  const base = dayRecord && typeof dayRecord === 'object' ? dayRecord : emptyDay('');
  const next = {
    ...base,
    turns: (base.turns ?? 0) + 1,
    input: base.input ?? 0,
    output: base.output ?? 0,
    cache: base.cache ?? 0,
    total: base.total ?? 0,
    outChars: (base.outChars ?? 0) + Math.max(0, Math.floor(input.outChars ?? 0)),
    reported: Array.isArray(base.reported) ? [...base.reported] : [],
  };
  const usage = readUsage(input.usage);
  if (usage !== null) {
    next.input += usage.input;
    next.output += usage.output;
    next.cache += usage.cache;
    next.total += usage.total;
  }
  return next;
}

/** 字 → 人话量词（「两千多字」比「2137 字」更像人说的）。 */
export function humanChars(n) {
  const v = Math.max(0, Math.floor(n ?? 0));
  if (v < 100) return `${v} 字`;
  if (v < 1000) return `${Math.floor(v / 100) * 100} 来字`;
  if (v < 10000) {
    const k = Math.floor(v / 1000);
    const rest = v - k * 1000;
    return rest < 200 ? `${k} 千来字` : `${k} 千多字`;
  }
  return `${Math.floor(v / 1000)} 千字`;
}

/**
 * 注入文本。
 *
 * @param {{day:string, record:object, cfg?:object, isFirstToday?:boolean}} input
 * @returns {string|null}
 */
export function promptLine({ day, record, cfg = {}, isFirstToday = false }) {
  const turns = Math.max(0, Math.floor(record?.turns ?? 0));
  if (turns === 0) {
    // 今天一句话还没聊过：报「新的一天」只在真的换了一天的时候有意义，
    // 但那种时候她也没有理由提额度 —— 所以直接不出声。
    return null;
  }
  const chars = Math.max(0, Math.floor(record?.outChars ?? 0));
  const overTurns = Number.isFinite(cfg.overTurns) ? cfg.overTurns : DEFAULTS.overTurns;
  const overChars = Number.isFinite(cfg.overOutChars) ? cfg.overOutChars : DEFAULTS.overOutChars;
  const hitTurns = overTurns > 0 && turns >= overTurns;
  const hitChars = overChars > 0 && chars >= overChars;

  if (hitTurns || hitChars) {
    return `（今天到现在，你在这个号上已经聊了 ${turns} 轮，自己说出去的话加起来${humanChars(chars)}。`
      + '不用为此道歉，也不用报数——但你心里有数就行：真人在这种时候会开始想收尾，'
      + '而不是越聊越起劲。该困就困，该说明天再说就说明天再说。）';
  }
  if (isFirstToday === true && (cfg.reportDailyFirst ?? DEFAULTS.reportDailyFirst) !== false) {
    return `（今天已经聊了 ${turns} 轮，你说出去的话加起来${humanChars(chars)}。只是让你心里有个数，不用提。）`;
  }
  return null;
}

/**
 * 创建模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {()=>string} [options.resolveMediaDir]
 */
export function createQuota({ cfg, stats, log, resolveMediaDir }) {
  /** @type {Record<string, object>} 逻辑日 → 当天记录 */
  let days = {};
  /** 已注入过「当天第一次」的日期。 */
  let firstReportedDay = '';
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const now = () => Date.now();

  const enabled = () => cfg?.enabled !== false;
  const today = () => logicalDay(now(), cfg?.rolloverHour ?? DEFAULTS.rolloverHour);

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
      label: 'quota',
      normalize: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('state');
        if (raw !== null && typeof raw === 'object') {
          days = raw.days !== null && typeof raw.days === 'object' ? { ...raw.days } : {};
          firstReportedDay = typeof raw.firstReportedDay === 'string' ? raw.firstReportedDay : '';
        }
        trim();
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('state', { days, firstReportedDay });
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.quotaLastError = String(error?.message ?? error);
    }
  }

  /** 只留最近 keepDays 天。 */
  function trim() {
    const keep = Math.max(1, Math.floor(cfg?.keepDays ?? DEFAULTS.keepDays));
    const keys = Object.keys(days).sort();
    while (keys.length > keep) {
      const gone = keys.shift();
      delete days[gone];
    }
  }

  /**
   * 记一轮。由 persona 的 `assistant/message` 分支旁路调过来。
   *
   * **同步返回、不 await**：它在 `onSessionEvent` 里被调用，那里是消息投递
   * 主链，不能为了记账卡住投递。
   *
   * @param {{usage?:object|null, outChars?:number}} input
   */
  function note(input = {}) {
    if (!enabled()) return;
    const day = today();
    days[day] = accumulate(days[day] ?? emptyDay(day), input);
    if (stats) {
      stats.quotaTurnsToday = days[day].turns;
      stats.quotaOutCharsToday = days[day].outChars;
    }
    persist();
  }

  /**
   * 注入文本（会推进「已报过什么」的游标）。
   *
   * ## 为什么游标要在这里推进而不是在 promptLine 里
   *
   * promptLine 是纯函数，必须能随便调（自测里就调了好几次）。它没法知道
   * 「这一轮是不是刚刚报过」——那个状态属于实例。所以这里先算「该报哪一类」，
   * 再比对 `record.reported`：报过的那类今天就不再开口。
   *
   * 曾经的 bug：只在越阈值时无条件返回文本、不检查 reported，于是同一天里
   * 每轮都报一次「你今天聊了 61 轮」，把注入变成了复读机（并且每轮都变前缀，
   * 缓存全废）。自测的「越阈值不重复报」就是钉这个的。
   *
   * @returns {string|null}
   */
  function injectionText() {
    if (!enabled()) return null;
    try {
      const day = today();
      const record = days[day];
      if (record === undefined) return null;
      const mark = Array.isArray(record.reported) ? record.reported : [];
      const turns = Math.max(0, Math.floor(record.turns ?? 0));
      const chars = Math.max(0, Math.floor(record.outChars ?? 0));
      const overTurns = Number.isFinite(cfg?.overTurns) ? cfg.overTurns : DEFAULTS.overTurns;
      const overChars = Number.isFinite(cfg?.overOutChars) ? cfg.overOutChars : DEFAULTS.overOutChars;
      const hitTurns = overTurns > 0 && turns >= overTurns && !mark.includes('turns');
      const hitChars = overChars > 0 && chars >= overChars && !mark.includes('chars');
      const isFirst = firstReportedDay !== day
        && (cfg?.reportDailyFirst ?? DEFAULTS.reportDailyFirst) !== false;

      if (!hitTurns && !hitChars && !isFirst) return null;

      const text = promptLine({ day, record, cfg, isFirstToday: isFirst });
      if (text === null) return null;

      // 只有真的出了文本才推进游标 —— 否则会白白吃掉一次机会。
      if (isFirst) firstReportedDay = day;
      if (hitTurns) mark.push('turns');
      if (hitChars) mark.push('chars');
      record.reported = mark;
      persist();
      return text;
    } catch {
      return null;
    }
  }

  function snapshot() {
    const day = today();
    const record = days[day] ?? emptyDay(day);
    return {
      enabled: enabled(),
      day,
      turns: record.turns ?? 0,
      outChars: record.outChars ?? 0,
      input: record.input ?? 0,
      output: record.output ?? 0,
      cache: record.cache ?? 0,
      total: record.total ?? 0,
      /** 近几天的轮数，给观测面看趋势用。 */
      recent: Object.keys(days)
        .sort()
        .slice(-7)
        .map((k) => ({ day: k, turns: days[k]?.turns ?? 0, outChars: days[k]?.outChars ?? 0 })),
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  function start() {
    void ensureStore().catch(() => undefined);
  }

  /** 自测：纯函数为主，不碰真状态文件。 */
  async function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });

    // —— 换日线 ——
    // 2026-10-20 03:59 (+08:00) 应算 10-19；04:00 起算 10-20。
    const at = (h, m) => Date.parse(`2026-10-20T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
    check('3:59 算昨天', logicalDay(at(3, 59)) === '2026-10-19');
    check('4:00 起算今天', logicalDay(at(4, 0)) === '2026-10-20');
    check('23:59 还在今天', logicalDay(at(23, 59)) === '2026-10-20');
    check('半夜 1:00 算昨天', logicalDay(at(1, 0)) === '2026-10-19');

    // —— usage 解析 ——
    check('usage 为 null', readUsage(null) === null);
    check('usage 全零当没有', readUsage({ inputTokens: 0, outputTokens: 0 }) === null);
    const u1 = readUsage({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 900, totalTokens: 140 });
    check('usage 正常解析', u1.input === 100 && u1.output === 40 && u1.cache === 900 && u1.total === 140);
    const u2 = readUsage({ input_tokens: 7, output_tokens: 3 });
    check('兼容下划线写法', u2.input === 7 && u2.output === 3);
    check('没给 total 就自己加', readUsage({ inputTokens: 5, outputTokens: 2 }).total === 7);

    // —— 累计 ——
    let d = emptyDay('2026-10-20');
    d = accumulate(d, { usage: { inputTokens: 10, outputTokens: 5 }, outChars: 40 });
    d = accumulate(d, { usage: { inputTokens: 20, outputTokens: 8 }, outChars: 60 });
    check('累计轮数', d.turns === 2);
    check('累计 output', d.output === 13);
    check('累计字数', d.outChars === 100);
    check('accumulate 不改入参', emptyDay('x').turns === 0);
    check('outChars 负数被夹到 0', accumulate(emptyDay('x'), { outChars: -50 }).outChars === 0);

    // —— 人话字数 ——
    check('humanChars 小数目', humanChars(42) === '42 字');
    check('humanChars 百位', humanChars(350) === '300 来字');
    check('humanChars 千位零头少', humanChars(2137) === '2 千来字');
    check('humanChars 千位零头多', humanChars(2680) === '2 千多字');
    check('humanChars 一万以上', humanChars(12000) === '12 千字');

    // —— 注入文本 ——
    check('零轮不出声', promptLine({ record: emptyDay('d') }) === null);
    const quiet = promptLine({ record: { ...emptyDay('d'), turns: 5, outChars: 200 }, cfg: {} });
    check('未越阈值不唠叨', quiet === null);
    const first = promptLine({
      record: { ...emptyDay('d'), turns: 5, outChars: 200 },
      cfg: {},
      isFirstToday: true,
    });
    check('当天第一次会报一句', typeof first === 'string' && first.includes('5 轮'));
    check('当天第一次明说不用提', typeof first === 'string' && first.includes('不用提'));
    const hot = promptLine({ record: { ...emptyDay('d'), turns: 61, outChars: 200 }, cfg: {} });
    check('轮数越阈值会报', typeof hot === 'string' && hot.includes('61 轮'));
    const hotChars = promptLine({ record: { ...emptyDay('d'), turns: 5, outChars: 1600 }, cfg: {} });
    check('字数越阈值会报', typeof hotChars === 'string' && hotChars.includes('轮'));
    check('越阈值时不报数道歉', typeof hot === 'string' && hot.includes('不用为此道歉'));

    // —— 假实例：一轮 + 注入 + 不重复注入 ——
    const fake = createQuota({
      cfg: { ...DEFAULTS, enabled: true, reportDailyFirst: true, overTurns: 2, overOutChars: 0 },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
    });
    fake.note({ usage: { inputTokens: 10, outputTokens: 5 }, outChars: 30 });
    const snap1 = fake.snapshot();
    check('note 之后轮数 +1', snap1.turns === 1);
    const t1 = fake.injectionText();
    check('当天第一次注入出东西', typeof t1 === 'string');
    const t2 = fake.injectionText();
    check('同一天不重复报第一次', t2 === null);
    fake.note({ usage: { inputTokens: 10, outputTokens: 5 }, outChars: 30 });
    const t3 = fake.injectionText();
    check('越阈值时报一次', typeof t3 === 'string' && t3.includes('2 轮'));
    const t4 = fake.injectionText();
    check('越阈值不重复报', t4 === null);

    // —— 关掉就不出声 ——
    const off = createQuota({
      cfg: { ...DEFAULTS, enabled: false },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
    });
    off.note({ usage: { inputTokens: 1, outputTokens: 1 }, outChars: 10 });
    check('关掉后不记账', off.snapshot().turns === 0);
    check('关掉后不注入', off.injectionText() === null);

    const failed = checks.filter((c) => c.ok !== true);
    return { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
  }

  return { note, injectionText, snapshot, start, selfTest, DEFAULTS };
}
