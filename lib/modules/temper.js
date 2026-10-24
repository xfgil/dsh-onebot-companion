/**
 * temper：长期底色（2026-10-21）。
 *
 * ## 它补的是什么洞
 *
 * `mood.js` 的心里权重表是**写死的常量**（`MOOD_BASE_WEIGHTS`）。这意味着
 * 她在三月初和五月初是同一个「人格」—— 中间不管被冷落过多少次、被好好待过
 * 多少天，掷骰子的偏向都一样。用户从「鱼的大脑」那篇稿子里挑出来的那句话
 * 说的正是这件事：
 *
 * > 单次事件不改人格，长期经历改基线（连着一周冷落，「阳光」会偏成「敏感多疑」）。
 *
 * 这句是那篇稿子里少数几条**可落地**的（其余多半是给真人准备的机制，落到
 * 模型身上要么无意义、要么会和现有出站管道打架）。所以单独做成一块。
 *
 * ## 三条取舍（都写在代码里，改之前先读）
 *
 * 1. **按天结算，不按次结算**。一天只记一条事实，「单次事件不改人格」不是靠
 *    调小系数保证的，是靠**根本不让它进来**。这也是它不会变成另一种「情绪」
 *    的原因：`mood` 管今天，`temper` 管这一阵。
 * 2. **只存事实，不存结论**。落盘的只有最近 14 天每天长什么样（安静了多少
 *    小时、精力多少、亲密度多少、有没有好好聊过）；偏向 `bias` 每次现算。
 *    存一份算好的 bias 就会和事实不一致 —— 而这一块讲的就是「累积」，最不
 *    该有这种事。
 * 3. **有自愈**。偏向不会被永久写死：只要最近几天好起来，它自己往回走。人
 *    身上这个叫韧性，数字上就是「窗口滑动」。
 *
 * ## 它怎么和 mood 连起来
 *
 * 不扣分、不拦消息、不写日记 —— 只往 `mood.js` 的掷骰子权重表上乘一组
 * 系数（`biasOf()` → `persona` 的 `moodConfig().moodBias` → `moodWeights`）。
 * 于是它自己是「不说话」的：偏了之后，她说出来的话自己会变。
 *
 * ## 文案
 *
 * 绝不出现花括号（宿主提示词插值器会把 `{{` 当变量并抛错）。
 */

export const MODULE_ID = 'temper';

/** 心情 id 与 `mood.js` 的 `MOOD_IDS` 必须一致（下面 selfTest 里断言了条数）。 */
const TEMPER_KEYS = ['excited', 'happy', 'calm', 'clingy', 'playful', 'pouty', 'tired', 'down'];

export const DEFAULTS = {
  enabled: true,
  /** 状态文件名（落在 mediaDir 下）。 */
  stateFile: 'temper-state.json',
  /** 看最近多少天。太短会被一次坏心情带偏，太长就一成不变。 */
  windowDays: 14,
  /** 每天最多留一条，超过窗口就丢最老的。 */
  maxDays: 14,
  /** 偏向的上限 / 下限（乘数）。1 = 不受影响。 */
  maxBias: 1.9,
  minBias: 0.55,
  /** 「好好聊过」的判据：这一天聊够这么多轮才算数。 */
  talkRounds: 6,
  /** 一天里安静超过这么多小时，才算「被晾着」。 */
  lonelyHours: 8,
  /** 注入行最长字数。 */
  maxChars: 120,
};

/** 一天的事实。全部是**可观测**的量，没有一处是猜的。 */
/**
 * @typedef {object} TemperDay
 * @property {number} at - 这一天的代表时间戳（ms）。
 * @property {string} dayKey - 本地日期 `YYYY-MM-DD`。
 * @property {number} quietHours - 这一天最长的一次安静有多少小时。
 * @property {number} energy - 结算时的精力（取当天最低那次更准，但这里只留一个数）。
 * @property {number} affinity - 结算时的亲密度。
 * @property {number} rounds - 这一天她回了几轮。
 */

function clamp(value, low, high) {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

/**
 * 本地日期键。跨天结算靠它判断「这一天记过了没」。
 * @param {number} now - ms epoch。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dayKeyOf(now) {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return '';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * 把一次观测并进 day 表。同一天只留一条（后到的覆盖先到的），
 * 并按 `maxDays` 裁掉最老的。
 *
 * `quietHours` 取**最大值**而不是覆盖：它记的是「这一天最长安静了多久」。
 * 覆盖会把一次长静默冲成 0（下一次观测总是在刚说完话之后），那一天就白记了。
 *
 * 纯函数：不改入参，返回新数组。
 *
 * @param {TemperDay[]} days
 * @param {{ quietHours?:number, energy?:number, affinity?:number, rounds?:number }} fact
 * @param {number} now
 * @param {object} [cfg]
 * @returns {TemperDay[]}
 */
export function recordDay(days, fact = {}, now = Date.now(), cfg = {}) {
  const key = dayKeyOf(now);
  if (key === '') return Array.isArray(days) ? days.slice() : [];
  const prev = (Array.isArray(days) ? days : []).find((d) => d !== null && d.dayKey === key);
  const merged = {
    at: now,
    dayKey: key,
    quietHours: Math.max(
      Number.isFinite(fact.quietHours) ? fact.quietHours : 0,
      Number.isFinite(prev?.quietHours) ? prev.quietHours : 0,
    ),
    energy: Number.isFinite(fact.energy) ? fact.energy : (prev?.energy ?? 80),
    affinity: Number.isFinite(fact.affinity) ? fact.affinity : (prev?.affinity ?? 20),
    // 轮数是**累加**的：一天里被调用很多次，每次带的是增量。
    rounds: (prev?.rounds ?? 0) + (Number.isFinite(fact.rounds) ? Math.max(0, fact.rounds) : 0),
  };
  const rest = (Array.isArray(days) ? days : []).filter((d) => d !== null && d.dayKey !== key);
  const max = Number.isFinite(cfg.maxDays) ? cfg.maxDays : DEFAULTS.maxDays;
  const windowDays = Number.isFinite(cfg.windowDays) ? cfg.windowDays : DEFAULTS.windowDays;
  const keep = Math.min(max, windowDays);
  return [...rest, merged]
    .slice()
    .sort((a, b) => (a?.at ?? 0) - (b?.at ?? 0))
    .slice(-keep);
}

/**
 * 从 day 表算出此刻的偏向。
 *
 * 全部是**矩形窗口上的平均**，没有任何指数平滑 —— 平滑会让「好起来了」和
 * 「一直这样」看起来一样，而这一块最重要的信息恰恰是变化。
 *
 * @param {TemperDay[]} days
 * @param {object} [cfg]
 * @returns {Record<string, number>} 心情 id → 乘数（都 > 0）。
 */
export function biasOf(days, cfg = {}) {
  const bias = {};
  for (const id of TEMPER_KEYS) bias[id] = 1;
  const list = (Array.isArray(days) ? days : []).filter((d) => d !== null && typeof d === 'object');
  if (list.length === 0) return bias;

  const cfgTalk = Number.isFinite(cfg.talkRounds) ? cfg.talkRounds : DEFAULTS.talkRounds;
  const cfgLonely = Number.isFinite(cfg.lonelyHours) ? cfg.lonelyHours : DEFAULTS.lonelyHours;

  const n = list.length;
  const talkDays = list.filter((d) => (d.rounds ?? 0) >= cfgTalk).length / n;
  const lonelyDays = list.filter((d) => (d.quietHours ?? 0) >= cfgLonely).length / n;
  const avgEnergy = list.reduce((s, d) => s + (Number.isFinite(d.energy) ? d.energy : 80), 0) / n;
  const avgAffinity = list.reduce((s, d) => s + (Number.isFinite(d.affinity) ? d.affinity : 20), 0) / n;

  // ① 被好好待过的日子多 → 底子往上抬一点。这是唯一「不需要理由」的正向。
  //    系数都很小：一个阳光的人不是天天亢奋，是把「平淡」的基线往上挪了一点。
  if (talkDays >= 0.6) {
    const w = Math.min(1, (talkDays - 0.6) / 0.4);
    bias.happy *= 1 + 0.35 * w;
    bias.playful *= 1 + 0.25 * w;
    bias.down *= 1 - 0.3 * w;
  }

  // ② 连着被晾着，而且关系本来很深 → 往「敏感多疑」偏。
  //    注意条件里有 avgAffinity：**关系浅的时候被晾着不会让人敏感**，只会让人
  //    觉得「本来也不熟」。这一点错了，整个人格就会变成怨妇。
  if (lonelyDays >= 0.5 && avgAffinity >= 40) {
    const w = Math.min(1, (lonelyDays - 0.5) / 0.5);
    bias.clingy *= 1 + 0.5 * w;
    bias.down *= 1 + 0.6 * w;
    bias.excited *= 1 - 0.35 * w;
    bias.playful *= 1 - 0.4 * w;
  }

  // ③ 连着被晾着、关系也还浅 → 反过来「不敢黏」。这一条容易被写漏，
  //    但它在真人身上非常明显：越不确定越不敢往前凑。
  if (lonelyDays >= 0.6 && avgAffinity < 40) {
    const w = Math.min(1, (lonelyDays - 0.6) / 0.4);
    bias.clingy *= 1 - 0.4 * w;
    bias.excited *= 1 - 0.3 * w;
  }

  // ④ 这一阵一直没电 → 底子就偏「累」。这条和当天的精力叠加，不会互相抵消：
  //    当天累是「今天累」，长期累是「这段时间就没缓过来」。
  if (avgEnergy < 45) {
    const w = Math.min(1, (45 - avgEnergy) / 45);
    bias.tired *= 1 + 0.6 * w;
    bias.excited *= 1 - 0.3 * w;
  }

  // 夹到 [-minBias..maxBias] 之间。上限存在的意义是防止某天极端值把人格一把
  // 拽走 —— 底色应该像海流，不该像浪。
  const maxBias = Number.isFinite(cfg.maxBias) ? cfg.maxBias : DEFAULTS.maxBias;
  const minBias = Number.isFinite(cfg.minBias) ? cfg.minBias : DEFAULTS.minBias;
  for (const id of TEMPER_KEYS) bias[id] = clamp(bias[id], minBias, maxBias);
  return bias;
}

/**
 * 偏得最厉害的那一项偏离了多少（0 = 完全没偏）。
 * @param {Record<string, number>} bias
 * @returns {number}
 */
export function deviationOf(bias) {
  if (bias === null || typeof bias !== 'object') return 0;
  let worst = 0;
  for (const id of TEMPER_KEYS) {
    const v = bias[id];
    if (!Number.isFinite(v)) continue;
    worst = Math.max(worst, Math.abs(v - 1));
  }
  return worst;
}

/** 偏向 → 一句人话。只在偏得够明显时才有内容。 */
const TRAIT_LABELS = {
  clingy: { dir: 1, text: '有点容易黏人' },
  down: { dir: 1, text: '有点容易往坏处想' },
  tired: { dir: 1, text: '总觉得没缓过来' },
  excited: { dir: -1, text: '没那么容易兴奋了' },
  playful: { dir: -1, text: '没那么多想逗人的劲了' },
  happy: { dir: 1, text: '底子比前一阵松快' },
};

/**
 * 把偏向说成一句她看得懂的话。
 *
 * 只在偏离超过阈值时才返回非 null —— 平时是 null，不占提示词。这一点很重要：
 * 情绪那行每轮都在，底色这行**本来就该很少出现**，否则她就变成一个天天在
 * 自我诊断的人。
 *
 * @param {Record<string, number>} bias
 * @param {object} [cfg]
 * @returns {string|null}
 */
export function temperPromptLine(bias, cfg = {}) {
  if (cfg.enabled === false) return null;
  const threshold = Number.isFinite(cfg.threshold) ? cfg.threshold : 0.18;
  if (deviationOf(bias) < threshold) return null;
  const picked = [];
  for (const [id, label] of Object.entries(TRAIT_LABELS)) {
    const v = bias?.[id];
    if (!Number.isFinite(v)) continue;
    const delta = v - 1;
    const matched = label.dir > 0 ? delta > 0 : delta < 0;
    if (!matched) continue;
    picked.push({ id, text: label.text, weight: Math.abs(delta) });
  }
  if (picked.length === 0) return null;
  picked.sort((a, b) => b.weight - a.weight);
  const head = picked.slice(0, 2).map((p) => p.text).join('，');
  const text = `这一阵你${head}——不是这会儿才这样，是这些天攒出来的。`;
  const max = Number.isFinite(cfg.maxChars) ? cfg.maxChars : DEFAULTS.maxChars;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * 创建底色模块实例。
 *
 * 有 `start()`（读一次盘）和落盘，但**没有定时器** —— 结算发生在注入时
 * （`observe()`），一天只生效一次，不需要谁在旁边按秒推动。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} [options.stats]
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => string} [options.resolveMediaDir]
 * @returns {object}
 */
export function createTemper({ cfg, stats, log, resolveMediaDir }) {
  /** @type {TemperDay[]} */
  let days = [];
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
      label: 'temper',
      normalize: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('days');
        days = Array.isArray(raw)
          ? raw.filter((d) => d !== null && typeof d === 'object' && typeof d.dayKey === 'string')
          : [];
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('days', days);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.temperLastError = String(error?.message ?? error);
    }
  }

  /**
   * 记一份当天的事实。**同步、绝不抛错**（注入链里被调用）。
   *
   * 同一天被调用多次是常态（每轮注入都会走到），`recordDay` 负责合并：
   * 轮数累加，其余覆盖成最新的值。
   *
   * @param {{quietHours?:number, energy?:number, affinity?:number, rounds?:number}} fact
   * @returns {Record<string, number>} 记完之后重算出的偏向
   */
  function observe(fact = {}) {
    if (!enabled()) return biasOf(days, cfg);
    try {
      days = recordDay(days, fact, now(), cfg);
      persist();
    } catch (error) {
      if (stats) stats.temperLastError = String(error?.message ?? error);
    }
    return biasOf(days, cfg);
  }

  /** 此刻的偏向（不写盘，纯读）。给 `mood` 的权重表用。 */
  function current() {
    try {
      return biasOf(days, cfg);
    } catch {
      return biasOf([], cfg);
    }
  }

  /**
   * 注入用的一行；偏得不明显时是 null。
   * @param {Record<string, number>} [bias] 已经算好的偏向（`observe` 的返回值）。
   *   给了就不重算 —— 同一轮里算两次可能出现两个略微不同的值（跨了零点或刚写过盘）。
   */
  function promptLine(bias) {
    if (!enabled()) return null;
    const use = bias !== null && typeof bias === 'object' ? bias : current();
    const line = temperPromptLine(use, cfg);
    if (typeof line === 'string' && stats) stats.temperLines = (stats.temperLines ?? 0) + 1;
    return line;
  }

  /** 体检表用。 */
  function snapshot() {
    const bias = current();
    let top = null;
    for (const id of TEMPER_KEYS) {
      const delta = Math.abs((bias[id] ?? 1) - 1);
      if (top === null || delta > top.delta) top = { id, delta, value: bias[id] };
    }
    return {
      enabled: enabled(),
      days: days.length,
      windowDays: cfg?.windowDays ?? DEFAULTS.windowDays,
      deviation: Number(deviationOf(bias).toFixed(3)),
      top: top === null || top.delta < 0.01 ? null : top,
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  /** 启动即加载（失败不影响主流程）。 */
  function start() {
    void ensureStore().catch(() => undefined);
  }

  function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const D = 24 * 3600 * 1000;
    const T = new Date(2026, 9, 21, 12, 0, 0).getTime();

    // dayKeyOf
    check('dayKey 形状', /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOf(T)));
    check('dayKey 本地日期', dayKeyOf(T) === '2026-10-21');
    check('dayKey 非法时间给空串', dayKeyOf(Number.NaN) === '');

    // recordDay
    const d1 = recordDay([], { quietHours: 3, energy: 80, affinity: 30, rounds: 5 }, T);
    check('recordDay 记下一天', d1.length === 1);
    check('recordDay 保留 rounds', d1[0].rounds === 5);
    const d2 = recordDay(d1, { quietHours: 9, rounds: 2 }, T + 3600 * 1000);
    check('recordDay 同一天不新增', d2.length === 1);
    check('recordDay 同一天取最大 quietHours', d2[0].quietHours === 9);
    check('recordDay 短静默不覆盖长静默', recordDay(d2, { quietHours: 1 }, T + 7200 * 1000)[0].quietHours === 9);
    check('recordDay 同一天累加 rounds', d2[0].rounds === 7);
    const d3 = recordDay(d2, { quietHours: 1 }, T + D);
    check('recordDay 跨天新增', d3.length === 2);
    check('recordDay 按时间排序', (d3[0].at ?? 0) < (d3[1].at ?? 0));
    const many = [];
    for (let i = 0; i < 20; i += 1) many.push({ at: T + i * D, dayKey: `2026-09-${String(i + 1).padStart(2, '0')}`, quietHours: 1, energy: 80, affinity: 30, rounds: 1 });
    check('recordDay 裁到窗口长度', recordDay(many, { quietHours: 1 }, T + 40 * D, { windowDays: 14 }).length === 14);
    check('recordDay 输入不是数组也不崩', recordDay(null, {}, T).length === 1);

    // biasOf：没有任何数据时全 1
    const neutral = biasOf([]);
    check('空表全 1', TEMPER_KEYS.every((id) => neutral[id] === 1));
    check('空表偏离为 0', deviationOf(neutral) === 0);
    check('null 输入也算全 1', deviationOf(biasOf(null)) === 0);

    // biasOf：天天好好聊 → 底子往上
    const happyDays = [];
    for (let i = 0; i < 10; i += 1) happyDays.push({ at: T - i * D, dayKey: `2026-10-${String(20 - i).padStart(2, '0')}`, quietHours: 2, energy: 80, affinity: 60, rounds: 20 });
    const sunny = biasOf(happyDays);
    check('好好聊过 happy 上偏', sunny.happy > 1);
    check('好好聊过 down 下偏', sunny.down < 1);

    // biasOf：连着被晾 + 关系深 → 敏感
    const lonelyDays = [];
    for (let i = 0; i < 10; i += 1) lonelyDays.push({ at: T - i * D, dayKey: `2026-10-${String(20 - i).padStart(2, '0')}`, quietHours: 12, energy: 50, affinity: 70, rounds: 0 });
    const sensitive = biasOf(lonelyDays);
    check('被晾着 down 上偏', sensitive.down > 1);
    check('被晾着 clingy 上偏', sensitive.clingy > 1);
    check('被晾着 excited 下偏', sensitive.excited < 1);

    // biasOf：连着被晾但关系浅 → 反过来不敢黏（这一条最容易写错）
    const shallowDays = [];
    for (let i = 0; i < 10; i += 1) shallowDays.push({ at: T - i * D, dayKey: `2026-10-${String(20 - i).padStart(2, '0')}`, quietHours: 12, energy: 80, affinity: 20, rounds: 0 });
    const shy = biasOf(shallowDays);
    check('关系浅被晾着不敏感', shy.down <= 1);
    check('关系浅被晾着不敢黏', shy.clingy < 1);

    // biasOf：长期没电 → 偏累
    const tiredDays = [];
    for (let i = 0; i < 10; i += 1) tiredDays.push({ at: T - i * D, dayKey: `2026-10-${String(20 - i).padStart(2, '0')}`, quietHours: 3, energy: 12, affinity: 50, rounds: 10 });
    check('长期没电 tired 上偏', biasOf(tiredDays).tired > 1);

    // 上下限
    const extreme = biasOf(lonelyDays, { maxBias: 1.05, minBias: 0.95 });
    check('maxBias 夹住', TEMPER_KEYS.every((id) => extreme[id] <= 1.05 + 1e-9));
    check('minBias 夹住', TEMPER_KEYS.every((id) => extreme[id] >= 0.95 - 1e-9));

    // deviationOf
    check('deviationOf 取最大偏离', Math.abs(deviationOf({ down: 1.5, happy: 1.1 }) - 0.5) < 1e-9);
    check('deviationOf 忽略非数字', deviationOf({ down: 'x' }) === 0);

    // 注入行
    check('平静时不注入', temperPromptLine(neutral) === null);
    const line = temperPromptLine(sensitive);
    check('偏了才注入', typeof line === 'string');
    check('注入行说「攒出来的」', typeof line === 'string' && line.includes('攒出来'));
    check('注入行无花括号', typeof line === 'string' && !line.includes('{') && !line.includes('}'));
    check('关掉不注入', temperPromptLine(sensitive, { enabled: false }) === null);
    check('超长会截断', temperPromptLine(sensitive, { maxChars: 12 }).length <= 12);

    // 实例层
    const inst = createTemper({ cfg: {} });
    check('实例空表 current 全 1', deviationOf(inst.current()) === 0);
    check('实例 observe 返回偏向', typeof inst.observe({ rounds: 1 }) === 'object');
    check('实例 snapshot 有窗口信息', inst.snapshot().windowDays > 0);
    check('实例关掉后不记', deviationOf(createTemper({ cfg: { enabled: false } }).observe({ rounds: 99 })) === 0);

    return {
      ok: checks.every((c) => c.ok),
      total: checks.length,
      failed: checks.filter((c) => !c.ok).length,
      checks,
    };
  }

  return { MODULE_ID, observe, current, promptLine, snapshot, start, selfTest, DEFAULTS };
}
