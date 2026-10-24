/**
 * circadian —— 学出来的生物钟（2026-10-21）。
 *
 * ## 它补的是什么洞
 *
 * `mood.js` 的昼夜判定是**写死的**：0–8 点算夜（回血 14/h），其余时间掉电 7/h。
 * 也就是说她的作息是一张钟表，不是一段生活。
 *
 * 用户（示例用户）的作息完全不听表：凌晨两点还在说话，中午十一点才冒头。这时候
 * 「夜里该困了」变成一种表演 —— 她按钟表算「现在是你该睡的时候」，而人根本不在。
 *
 * 来源：小黑盒帖子《关于类人大肥鱼的一些想法》（作者 Halseq，link_id
 * 7caf7028aafd）里的「学出来的生物钟」：
 *
 * > 系统用 24 个相位格子记录用户真实出现的时间，生成一条清醒驱动曲线。
 * > 「困了想睡」是睡眠驱力撞上了被这条曲线抬高的阈值。如果用户 24 小时都在，
 * > 它就会得到一个「从不困倦」的伴侣。作息是关系磨合出的结果。
 *
 * ## 三条取舍
 *
 * 1. **学的是「他什么时候在」，不是「我什么时候困」**。她的清醒度是他出现的
 *    副产品，不是独立配置。所以这里只记入站时刻，不记别的。
 * 2. **衰减而不是累加到底**。每个桶按天乘 `decayPerDay`（默认 0.94）。理由是
 *    作息会变：暑假的作息不该变成八月的判决。半衰期约 11 天。
 * 3. **样本不够就不说话**。`circadianCurve` 在库总量低于 `minSamples` 时返回
 *    null，调用方退回固定配置。宁可先按钟表过几天，也不要拿三条消息推出一条
 *    「曲线」然后当真。
 *
 * ## 纯函数 / 实例分界（跟 temper.js 一致）
 *
 * 上面所有导出的计算函数都**零 import、纯函数、不读写盘**，可以用裸 node.exe
 * 直接 import 跑自测。落盘只在 `createCircadian()` 实例层。
 *
 * @module dsh-onebot/circadian
 */

/** 小时数。 */
export const HOURS = 24;

export const MODULE_ID = 'circadian';

export const DEFAULTS = {
  enabled: true,
  /** 状态文件名（落在 mediaDir 下）。 */
  stateFile: 'circadian-state.json',
  /**
   * 每天保留多少。0.94 的半衰期约 11 天。
   *
   * 为什么不是 0.98（半衰期 34 天）：太慢会让「上周熬了个通宵」粘在身上一个月，
   * 而那明明只是一次例外。为什么不是 0.85（半衰期 4 天）：太快等于只记最近几天，
   * 他偶尔通宵一次就会把整条曲线带歪。
   */
  decayPerDay: 0.94,
  /** 库总量低于这个数就认为「还看不出来」，曲线返回 null。 */
  minSamples: 30,
  /** 归一化后低于这个值的小时算「夜」。 */
  nightThreshold: 0.15,
  /** 相邻小时做一次 [0.25,0.5,0.25] 环形卷积，避免 22 点活、23 点死的锯齿。 */
  smooth: true,
  /**
   * 「在场窗口」：距上次记账不到这个时长就**不衰减**。
   *
   * 衰减衡量的应该是**缺席时长**，不是「距上一次记账多久」。他连发十条消息时，
   * 每一条都乘一次 0.99996 虽然损失可以忽略，但那让「同小时累加」在浮点上
   * 站不住（2 条消息记成 1.99996）。用 10 分钟把「他还在」和「他刚回来」分开：
   * 窗口内的记账直接 +1，窗口外的先按缺席天数衰减再 +1。
   */
  presenceWindowMs: 10 * 60 * 1000,
  /** 注入行最长字数。 */
  maxChars: 100,
};

/**
 * 一条空的相位记录。
 * @returns {{buckets:number[], lastAt:number}}
 */
export function createBuckets() {
  return { buckets: new Array(HOURS).fill(0), lastAt: 0 };
}

function clampNonNegative(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 把整组桶按经过的天数衰减到 `now`。
 *
 * 纯函数：不修改入参，返回新的 `{ buckets, lastAt }`。
 *
 * `lastAt` 为 0（从未记过）时不衰减，只把参考点挪到 now —— 首次记账不该
 * 因为「纪元到现在」的天数把所有桶乘成 0。
 *
 * @param {{buckets:number[], lastAt:number}} state
 * @param {number} now - ms epoch
 * @param {object} [cfg]
 * @returns {{buckets:number[], lastAt:number}}
 */
export function advanceBuckets(state, now, cfg = {}) {
  const src = Array.isArray(state?.buckets) ? state.buckets : [];
  const buckets = [];
  for (let i = 0; i < HOURS; i += 1) buckets.push(clampNonNegative(src[i]));
  const lastAt = Number.isFinite(state?.lastAt) ? state.lastAt : 0;
  if (!(lastAt > 0) || !(now > lastAt)) return { buckets, lastAt: Math.max(lastAt, now) };

  const decayPerDay = Number.isFinite(cfg.decayPerDay) ? cfg.decayPerDay : DEFAULTS.decayPerDay;
  const days = (now - lastAt) / 86400000;
  // 下限保护：衰到 1e-12 以下直接归零，免得浮点尾巴永远留着让 total 虚高。
  const factor = Math.pow(Math.max(0.5, Math.min(1, decayPerDay)), days);
  const decayed = buckets.map((v) => {
    const next = v * factor;
    return next < 1e-12 ? 0 : next;
  });
  return { buckets: decayed, lastAt: now };
}

/**
 * 记一次「他出现了」：先衰减到此刻，再给对应小时 +1。
 *
 * 纯函数，返回新的 `{ buckets, lastAt }`。
 *
 * @param {{buckets:number[], lastAt:number}} state
 * @param {number} now - ms epoch
 * @param {object} [cfg]
 * @returns {{buckets:number[], lastAt:number}}
 */
export function recordPresence(state, now, cfg = {}) {
  const lastAt = Number.isFinite(state?.lastAt) ? state.lastAt : 0;
  const windowMs = Number.isFinite(cfg.presenceWindowMs) ? cfg.presenceWindowMs : DEFAULTS.presenceWindowMs;
  const stillHere = lastAt > 0 && now >= lastAt && now - lastAt < windowMs;
  // 还在窗口内就跳过衰减，直接 +1；否则先按缺席天数衰减。
  const base = stillHere
    ? { buckets: (Array.isArray(state?.buckets) ? state.buckets : []).map(clampNonNegative).concat(new Array(HOURS).fill(0)).slice(0, HOURS), lastAt }
    : advanceBuckets(state, now, cfg);
  const hour = new Date(now).getHours();
  if (!Number.isInteger(hour) || hour < 0 || hour >= HOURS) return base;
  const buckets = base.buckets.slice();
  buckets[hour] += 1;
  return { buckets, lastAt: Math.max(base.lastAt, now) };
}

/** 环形平滑（24 小时首尾相接）。 */
function ringSmooth(values, kernel) {
  const half = Math.floor(kernel.length / 2);
  const out = new Array(values.length).fill(0);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    for (let k = 0; k < kernel.length; k += 1) {
      const idx = (((i + k - half) % values.length) + values.length) % values.length;
      sum += values[idx] * kernel[k];
    }
    out[i] = sum;
  }
  return out;
}

/**
 * 把桶归一成一条「他通常醒着的概率」曲线（24 个数，0..1）。
 *
 * 归一化用**最大值**而不是总和：她关心的是「这个钟点相对于他最活跃的钟点有多
 * 活」，不是分布占比。用总和归一的话，一个只在 14 点出现的作息会得到 14 点 = 1、
 * 其余 = 0，看起来像「其余时间都在睡」，其实只是样本少。
 *
 * @param {number[]} buckets
 * @param {object} [cfg]
 * @returns {number[]|null} 24 个数；样本不足或全空时 null（调用方退回固定配置）
 */
export function circadianCurve(buckets, cfg = {}) {
  const list = Array.isArray(buckets) ? buckets : [];
  const values = [];
  for (let i = 0; i < HOURS; i += 1) values.push(clampNonNegative(list[i]));
  const total = values.reduce((a, b) => a + b, 0);
  const minSamples = Number.isFinite(cfg.minSamples) ? cfg.minSamples : DEFAULTS.minSamples;
  if (!(total >= minSamples)) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const raw = values.map((v) => v / max);
  const smooth = cfg.smooth === undefined ? DEFAULTS.smooth : cfg.smooth !== false;
  const curve = smooth ? ringSmooth(raw, [0.25, 0.5, 0.25]) : raw;
  // 卷积会把单点峰值压到 0.5（0.25×0 + 0.5×1 + 0.25×0）。再按峰值归一次一，
  // 让「峰值小时 = 1」这条不等式在两种模式下都成立——后面的阈值判断才有共同刻度。
  const peak = Math.max(...curve);
  const scaled = peak > 0 ? curve.map((v) => v / peak) : curve;
  return scaled.map((v) => Math.min(1, Math.max(0, v)));
}

/**
 * 哪些小时算「夜」。
 *
 * 三种结果的语义必须分清：
 *   - `null`  → **没有曲线可用**（样本不足）。调用方退回 `nightStartHour/EndHour`。
 *   - 全 `false` → **他从不睡**（曲线整体都很高）。这是真结论：她也就没有夜，
 *     精力不靠睡觉回，只靠聊天回。原文说的「从不困倦的伴侣」就是这一格。
 *   - 有 `true` → 这些小时是他的安静时段。
 *
 * @param {number[]|null} curve - `circadianCurve` 的结果
 * @param {object} [cfg]
 * @returns {boolean[]|null}
 */
export function nightSetOf(curve, cfg = {}) {
  if (!Array.isArray(curve) || curve.length !== HOURS) return null;
  const threshold = Number.isFinite(cfg.nightThreshold) ? cfg.nightThreshold : DEFAULTS.nightThreshold;
  const set = curve.map((v) => (Number.isFinite(v) ? v < threshold : false));
  // 全低是不可能的（曲线是除以最大值得到的，至少有一个 1），但真出现时当没数据。
  if (set.every(Boolean)) return null;
  return set;
}

/**
 * 曲线 → 一句人话。样本不足时返回 null（不占提示词）。
 *
 * 只报**最活跃的那几个小时**，不报「什么时段在睡」——「他凌晨两点还在」是
 * 有用的信息，「他上午在睡」是它的推论，说了反而像在评价他的作息。
 *
 * @param {number[]|null} curve
 * @param {object} [cfg]
 * @returns {string|null}
 */
export function circadianPromptLine(curve, cfg = {}) {
  if (cfg.enabled === false) return null;
  if (!Array.isArray(curve) || curve.length !== HOURS) return null;
  const ranked = curve
    .map((v, i) => ({ hour: i, v }))
    .filter((x) => Number.isFinite(x.v) && x.v >= 0.6)
    .sort((a, b) => b.v - a.v);
  if (ranked.length === 0) return null;

  const hours = ranked.slice(0, 6).map((x) => x.hour).sort((a, b) => a - b);
  const brief = briefHourList(hours);
  if (brief === '') return null;
  const text = `这些天你常在 ${brief} 出现——我的作息跟着你走，不是跟着钟表走。`;
  const max = Number.isFinite(cfg.maxChars) ? cfg.maxChars : DEFAULTS.maxChars;
  return text.length > max ? text.slice(0, max) : text;
}

/** 把小时数组压成「凌晨两点、下午三四点」这样的一小段。 */
function briefHourList(hours) {
  const CN = ['凌晨', '凌晨', '凌晨', '凌晨', '清晨', '清晨', '早上', '早上', '上午', '上午', '上午', '上午',
    '中午', '下午', '下午', '下午', '下午', '下午', '傍晚', '晚上', '晚上', '晚上', '夜里', '夜里'];
  const NUM = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十', '十一'];
  const label = (h) => {
    const period = CN[h] ?? '';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    const num = hour12 <= 11 ? NUM[hour12] : String(hour12);
    return period + num + '点';
  };
  // 连续段合并：「两点、三点、四点」→「两三点」。三段以上不合并，读起来太绕。
  const out = [];
  let i = 0;
  while (i < hours.length) {
    let j = i;
    while (j + 1 < hours.length && hours[j + 1] === hours[j] + 1) j += 1;
    const len = j - i + 1;
    if (len === 2 && CN[hours[i]] === CN[hours[j]]) {
      const a = hours[i] % 12 === 0 ? 12 : hours[i] % 12;
      const b = hours[j] % 12 === 0 ? 12 : hours[j] % 12;
      out.push(CN[hours[i]] + NUM[a] + NUM[b] + '点');
    } else if (len > 2) {
      out.push(label(hours[i]) + '前后');
    } else {
      out.push(label(hours[i]));
    }
    i = j + 1;
  }
  return out.join('、');
}

/**
 * 创建生物钟实例。
 *
 * 跟 `createTemper` 一样：有 `start()`（读一次盘）和延迟落盘，**没有定时器**。
 * 记账发生在每条入站消息上，曲线读取发生在注入时。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} [options.stats]
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {()=>string} [options.resolveMediaDir]
 */
export function createCircadian({ cfg, stats, log, resolveMediaDir }) {
  /** @type {{buckets:number[], lastAt:number}} */
  let state = createBuckets();
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
      label: 'circadian',
      normalize: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const buckets = store.get('buckets');
        const lastAt = store.get('lastAt');
        state = {
          buckets: Array.isArray(buckets) ? buckets.slice(0, HOURS) : new Array(HOURS).fill(0),
          lastAt: Number.isFinite(lastAt) ? lastAt : 0,
        };
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('buckets', state.buckets);
      store.set('lastAt', state.lastAt);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.circadianLastError = String(error?.message ?? error);
    }
  }

  /**
   * 记一次「他在这个钟点出现了」。**同步、绝不抛错**（在入站链里被调用）。
   * @param {number} [at] ms epoch
   * @returns {boolean} 是否真的记了一笔
   */
  function observe(at = now()) {
    if (!enabled()) return false;
    try {
      const next = recordPresence(state, at, cfg);
      const changed = next.buckets.some((v, i) => v !== state.buckets[i]);
      state = next;
      if (changed) persist();
      if (stats) stats.circadianSamples = (stats.circadianSamples ?? 0) + 1;
      return changed;
    } catch (error) {
      if (stats) stats.circadianLastError = String(error?.message ?? error);
      return false;
    }
  }

  /** 此刻的曲线（不写盘）。样本不足时 null。 */
  function curve() {
    if (!enabled()) return null;
    try {
      return circadianCurve(state.buckets, cfg);
    } catch {
      return null;
    }
  }

  /** 此刻的夜间掩码。语义见 `nightSetOf`。 */
  function nightSet() {
    return nightSetOf(curve(), cfg);
  }

  /** 注入用的一行；样本不足或没有明显活跃时段时 null。 */
  function promptLine() {
    if (!enabled()) return null;
    const line = circadianPromptLine(curve(), cfg);
    if (typeof line === 'string' && stats) stats.circadianLines = (stats.circadianLines ?? 0) + 1;
    return line;
  }

  /** 体检表用。 */
  function snapshot() {
    const c = curve();
    const total = state.buckets.reduce((a, b) => a + b, 0);
    let top = null;
    if (Array.isArray(c)) {
      for (let i = 0; i < HOURS; i += 1) {
        if (top === null || c[i] > c[top]) top = i;
      }
    }
    return {
      enabled: enabled(),
      samples: Math.round(total * 100) / 100,
      enough: Array.isArray(c),
      peakHour: top,
      nightHours: Array.isArray(c) ? nightSetOf(c, cfg)?.filter(Boolean).length ?? 0 : null,
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  function start() {
    void ensureStore().catch(() => undefined);
  }

  function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });
    const D = 86400000;
    const T = new Date(2026, 9, 21, 2, 0, 0).getTime(); // 凌晨两点

    // createBuckets
    const empty = createBuckets();
    check('空桶 24 个', empty.buckets.length === HOURS);
    check('空桶全 0', empty.buckets.every((v) => v === 0));
    check('空前参考点 0', empty.lastAt === 0);

    // recordPresence
    const p1 = recordPresence(empty, T);
    check('记一笔落在凌晨两点', p1.buckets[2] === 1);
    check('其余仍为 0', p1.buckets.filter((v, i) => i !== 2).every((v) => v === 0));
    const p2 = recordPresence(p1, T + 60000);
    check('同小时累加', p2.buckets[2] === 2);

    // 衰减
    const later = T + 10 * D;
    const p3 = recordPresence(p2, later);
    // 隔了十天（远超在场窗口）→ 先按「距上次记账」的天数衰减再 +1
    const days = (later - p2.lastAt) / D;
    check('十天衰减后两点对得上', Math.abs(p3.buckets[2] - (2 * Math.pow(0.94, days) + 1)) < 1e-9);
    check('新的一笔在两点', p3.buckets[2] > 1);
    // 在场窗口内连发：不衰减，纯累加
    const burst = recordPresence(recordPresence(p1, T + 1000), T + 2000);
    check('在场窗口内连发不衰减', burst.buckets[2] === 3);
    check('窗口外重开会衰减', recordPresence(p2, T + 3600000).buckets[2] < 2);
    const noDecay = advanceBuckets(empty, T);
    check('从未记过不衰减', noDecay.buckets.every((v) => v === 0));
    check('从未记过把参考点挪到 now', noDecay.lastAt === T);

    // 样本不足
    check('样本不足返回 null', circadianCurve(p3.buckets) === null);
    check('全 0 返回 null', circadianCurve(new Array(HOURS).fill(0)) === null);
    check('非数组返回 null', circadianCurve(null) === null);

    // 造一条「只在两点出现」的曲线
    const night = new Array(HOURS).fill(0);
    for (let i = 0; i < 50; i += 1) night[2] += 1;
    const curve2 = circadianCurve(night, { smooth: false });
    check('足够样本给出曲线', Array.isArray(curve2) && curve2.length === HOURS);
    check('峰值在两点', curve2[2] === 1);
    check('其余为 0', curve2.filter((v, i) => i !== 2).every((v) => v === 0));

    // 平滑会把邻居抬起来
    const smooth2 = circadianCurve(night, { smooth: true });
    check('平滑后邻点非 0', smooth2[1] > 0 && smooth2[3] > 0);
    check('平滑后峰值仍是 1', Math.abs(smooth2[2] - 1) < 0.26);

    // nightSetOf：只活两点 → 除了两点那一个小时，其余 23 个都算夜
    const set2 = nightSetOf(curve2);
    check('只活两点时 23 个夜', set2 !== null && set2.filter(Boolean).length === 23);
    check('两点本身不是夜', set2[2] === false);

    // nightSetOf：24 小时都在 → 全 false（从不困）
    const always = new Array(HOURS).fill(20);
    const curve3 = circadianCurve(always, { smooth: false });
    const set3 = nightSetOf(curve3);
    check('常年在线给出全 false', Array.isArray(set3) && set3.every((v) => v === false));

    // nightSetOf：没曲线 → null（退回固定配置）
    check('无曲线给 null', nightSetOf(null) === null);
    check('长度不对给 null', nightSetOf([1, 2, 3]) === null);

    // 阈值可调
    const set4 = nightSetOf(curve2, { nightThreshold: 0.5 });
    check('阈值调高夜更多', set4.filter(Boolean).length === 23);

    // 注入行
    check('无曲线不注入', circadianPromptLine(null) === null);
    check('关掉不注入', circadianPromptLine(curve2, { enabled: false }) === null);
    const line = circadianPromptLine(curve2);
    check('有曲线时给一行', typeof line === 'string' && line.length > 0);
    check('注入行无花括号', typeof line === 'string' && !line.includes('{') && !line.includes('}'));
    check('注入行提到两点', typeof line === 'string' && line.includes('两点'));
    check('超长会截断', circadianPromptLine(curve2, { maxChars: 8 }).length <= 8);

    // 实例层
    const inst = createCircadian({ cfg: {} });
    check('实例空时曲线为 null', inst.curve() === null);
    check('实例 observe 返回 true', inst.observe(T) === true);
    check('实例关掉后不记', createCircadian({ cfg: { enabled: false } }).observe(T) === false);
    check('实例 snapshot 有样本数', inst.snapshot().samples >= 0);

    return {
      ok: checks.every((c) => c.ok),
      total: checks.length,
      failed: checks.filter((c) => !c.ok).length,
      checks,
    };
  }

  return { MODULE_ID, observe, curve, nightSet, promptLine, snapshot, start, selfTest, DEFAULTS };
}
