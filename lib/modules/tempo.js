/**
 * dsh-onebot-companion / modules/tempo.js
 *
 * 生活节奏（五档）+ 对话密度衰减 —— 主动开口该多急、该多缓。
 *
 * ## 为什么加这个（2026-10-22）
 *
 * 用户拿来一个叫 HDS-Interlude 的框架（Koishi 插件），里面有两件事我们这边
 * 确实缺：**生活节奏五档** 与 **对话密度衰减**。原话是「三个可以都做吗」。
 *
 * 现在的 `proactiveChance()` 只看情绪、精力、静默时长、热情 —— 它不知道
 * 「我正在上课」和「我正抱着手机等他说下一句」是两回事。「刚聊完还热着」
 * 和「冷了一整天」也被同一套静默公式抹平了。
 *
 * ## 它不改判据，只改倍率
 *
 * 本模块**不决定要不要开口**（那是 proactive.js 的事），只回答一个问题：
 * 此刻这个 chat 的「催促强度」该乘几倍。乘法模型的好处是可解释 ——
 * 最后算出来是 0.15 还是 1.4，一眼看得出是谁在压。
 *
 * 五档与倍率（照 HDSI 的默认值，见其 README「自动推进与生活节奏」）：
 *
 *   phone-focused  ×1.4   正在用手机 / 等他回话
 *   available      ×1.0   空闲
 *   occupied       ×0.7   上课 / 工作 / 沉浸在某件事里
 *   resting        ×0.5   躺着、低能量但还醒着
 *   asleep         ×0.15  睡着了
 *
 * 判定顺序刻意照抄它的边：**先看基础状态（睡 > 累 > 忙 > 闲），再看
 * 「他刚说话」这一条把睡/累提回 phone-focused**。忙的时候不会被提升 ——
 * 上课时收到消息，人还是在上课，只是会瞄一眼手机。
 *
 * ## 对话密度
 *
 * 密度 = 最近一段时间他说得有多密，归一化到 [0,1]，再按半衰期（默认 90
 * 分钟）指数衰减。所以刚聊完是热着的，冷下来需要时间，刹那就掉到零是不对的。
 *
 * 因子 = 1 + (activeMultiplier - 1) × 密度。默认 activeMultiplier=1.4 时，
 * 满密度就是 ×1.4，冷透了就是 ×1.0（不惩罚沉默，只奖励热聊）。
 *
 * ## 本模块的约束
 *
 * 纯函数 + 显式状态：不读文件、不建计时器、不碰随机数（要随机的都从 deps 进）。
 * 这样 `test/selftest.mjs` 能直接把它钉死，而 `index.js` 只负责把状态存盘。
 *
 * @module dsh-onebot/tempo
 */

export const MODULE_ID = 'tempo';

/** 五个档位的 id。 */
export const CADENCE = Object.freeze({
  PHONE: 'phone-focused',
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RESTING: 'resting',
  ASLEEP: 'asleep',
});

/** 各档位对「主动开口强度」的倍率。 */
export const CADENCE_FACTORS = Object.freeze({
  [CADENCE.PHONE]: 1.4,
  [CADENCE.AVAILABLE]: 1.0,
  [CADENCE.OCCUPIED]: 0.7,
  [CADENCE.RESTING]: 0.5,
  [CADENCE.ASLEEP]: 0.15,
});

/** 各档位的中文短句（给注入行用）。 */
const CADENCE_WORDS = Object.freeze({
  [CADENCE.PHONE]: '正拿着手机',
  [CADENCE.AVAILABLE]: '闲着',
  [CADENCE.OCCUPIED]: '手里有事在忙',
  [CADENCE.RESTING]: '躺着，没什么力气',
  [CADENCE.ASLEEP]: '睡着了',
});

export const DEFAULTS = Object.freeze({
  enabled: true,
  stateFile: 'tempo-state.json',
  /** 他有消息进来之后，多久之内算「正拿着手机」。 */
  phoneWindowMs: 3 * 60 * 1000,
  /** 每收到一条他的消息，密度加多少（加满即 1）。 */
  densityBump: 0.18,
  /** 密度衰减半衰期。90 分钟：聊完之后那股热度不该立刻散掉。 */
  densityHalfLifeMs: 90 * 60 * 1000,
  /** 密度对强度的最大放大（1.4 = 满密度时 ×1.4）。 */
  activeMultiplier: 1.4,
  /** 精力低于这个值算「躺着」。 */
  restingEnergy: 40,
  /** 精力低于这个值，并且处在夜里，就算「睡着了」。 */
  asleepEnergy: 25,
  /**
   * 「手上的事」多久算过期（毫秒）。
   *
   * 与 `focus.js` 的 `ttlMs` 是同一个意思，但**在这里再写一遍**而不是去读
   * 那个模块的配置：tempo 拿到的是 `focusOf()` 吐出来的 `{what, at}`，
   * 它不知道 focus 模块被配成多少。默认取同样的 20 分钟。
   */
  focusTtlMs: 20 * 60 * 1000,
  /** 注入行最长字数。 */
  maxChars: 120,
});

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/** 空的密度记录。 */
export function createDensity() {
  return { value: 0, at: 0 };
}

/**
 * 把密度衰减到 `now`。
 *
 * `at === 0`（从没记过）时不衰减，只把参考点挪到 now —— 首次记账不该
 * 因为「纪元到现在」的半衰期把自己乘成 0。
 *
 * @param {{value:number, at:number}} state
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{value:number, at:number}}
 */
export function decayDensity(state, now, cfg = {}) {
  const value = clamp01(numberOr(state?.value, 0));
  const at = numberOr(state?.at, 0);
  const t = Number.isFinite(now) ? now : Date.now();
  if (!(at > 0) || !(t > at)) return { value, at: Math.max(at, t) };
  const half = numberOr(cfg.densityHalfLifeMs, DEFAULTS.densityHalfLifeMs);
  if (!(half > 0)) return { value, at: t };
  const factor = Math.pow(0.5, (t - at) / half);
  const next = value * factor;
  // 低于万分之一就归零，免得浮点尾巴永远留着让「冷透了」永远到不了 0。
  return { value: next < 1e-4 ? 0 : next, at: t };
}

/**
 * 记一条他的消息：先衰减，再加一点。
 *
 * @param {{value:number, at:number}} state
 * @param {number} now
 * @param {object} [cfg]
 * @returns {{value:number, at:number}}
 */
export function bumpDensity(state, now, cfg = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const decayed = decayDensity(state, t, cfg);
  const bump = numberOr(cfg.densityBump, DEFAULTS.densityBump);
  return { value: clamp01(decayed.value + Math.max(0, bump)), at: t };
}

/**
 * 密度系数：1.0 ~ activeMultiplier。
 *
 * 冷透了是 1.0 而不是低于 1 —— 沉默本身已经在 `proactiveChance` 的
 * silenceFactor 里被加过权了，这里再罚一次就是重复计数。
 *
 * @param {{value:number, at:number}} state
 * @param {number} now
 * @param {object} [cfg]
 * @returns {number}
 */
export function densityFactor(state, now, cfg = {}) {
  const span = Math.max(0, numberOr(cfg.activeMultiplier, DEFAULTS.activeMultiplier) - 1);
  const value = decayDensity(state, now, cfg).value;
  return 1 + span * value;
}

/**
 * 判定此刻的生活节奏。
 *
 * 输入全是事实（时间、精力、他在不在说话、手上有没有事），不含随机。
 *
 * @param {object} input
 * @param {number} [input.now]
 * @param {number|null} [input.hour] - 本地小时 0–23；不给就按 now 算。
 * @param {boolean|null} [input.isNight] - 是否夜里；不给就用 hour 与夜档判断。
 * @param {number|null} [input.energy] - 0–100。
 * @param {{text?:string, expiresAt?:number}|null} [input.focus] - 手上正在忙的事。
 * @param {number} [input.lastUserAt] - 他最后一条消息的时间戳（0 表示没有）。
 * @param {object} [cfg]
 * @returns {string} 档位 id
 */
export function cadenceOf(input = {}, cfg = {}) {
  const c = cfg ?? {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const energy = Number.isFinite(input.energy) ? input.energy : null;
  const hour = Number.isFinite(input.hour) ? input.hour : new Date(now).getHours();
  const isNight =
    typeof input.isNight === 'boolean' ? input.isNight : hour >= 23 || hour < 6;

  // ① 基础状态：睡 > 累 > 忙 > 闲。先算出「不看消息」时她是什么样。
  let base = CADENCE.AVAILABLE;
  const focus = input.focus;
  const restingEnergy = numberOr(c.restingEnergy, DEFAULTS.restingEnergy);
  const asleepEnergy = numberOr(c.asleepEnergy, DEFAULTS.asleepEnergy);
  if (energy !== null && isNight && energy < asleepEnergy) base = CADENCE.ASLEEP;
  else if (energy !== null && energy < restingEnergy) base = CADENCE.RESTING;
  else if (focus !== null && focus !== undefined && typeof focus === 'object') {
    const expiresAt = numberOr(focus.expiresAt, 0);
    // 只认还没过期的事：过期了就不该继续压着她。
    if (expiresAt > now) base = CADENCE.OCCUPIED;
  }

  // ② 他刚说话 → 睡/累立刻回到「正拿着手机」。忙不提升：上课时收到消息，
  //    人还是在上课，只是会瞄一眼。
  const window = numberOr(c.phoneWindowMs, DEFAULTS.phoneWindowMs);
  const lastUserAt = numberOr(input.lastUserAt, 0);
  const hot = lastUserAt > 0 && now - lastUserAt >= 0 && now - lastUserAt < window;
  if (hot && (base === CADENCE.ASLEEP || base === CADENCE.RESTING)) return CADENCE.PHONE;
  if (hot && base === CADENCE.AVAILABLE) return CADENCE.PHONE;
  return base;
}

/**
 * 档位对应的倍率。
 *
 * @param {string} cadence
 * @returns {number}
 */
export function cadenceFactorOf(cadence) {
  const v = CADENCE_FACTORS[cadence];
  return typeof v === 'number' ? v : 1;
}

/**
 * 综合强度系数：节奏 × 密度。给 `proactiveChance` 乘。
 *
 * @param {object} input - 同 `cadenceOf`，外加 `density`。
 * @param {object} [cfg]
 * @returns {{cadence:string, cadenceFactor:number, densityFactor:number, factor:number}}
 */
export function intensityOf(input = {}, cfg = {}) {
  const c = cfg ?? {};
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const cadence = cadenceOf(input, c);
  const cadenceFactor = cadenceFactorOf(cadence);
  const dens = numberOr(input.densityFactor, 1);
  return {
    cadence,
    cadenceFactor,
    densityFactor: dens,
    factor: cadenceFactor * dens,
  };
}

/**
 * 注入行：让她知道自己此刻是哪一档。
 *
 * **只在非默认档时才出**——`available` 是常态，每轮都念一遍「你闲着」
 * 等于什么都没说。睡着时也故意不写：睡着的时候不该还在读提示词，
 * 那只会让她硬撑着回一句。
 *
 * 恒不返回花括号（宿主注入器会把 `{…}` 当变量并抛错）。
 *
 * @param {{cadence:string}} input
 * @param {object} [cfg]
 * @returns {string} 空串表示不注入
 */
export function tempoPromptLine(input, cfg = {}) {
  const c = cfg ?? {};
  if (c.enabled === false) return '';
  const cadence = typeof input?.cadence === 'string' ? input.cadence : '';
  if (cadence === '' || cadence === CADENCE.AVAILABLE || cadence === CADENCE.ASLEEP) return '';
  const word = CADENCE_WORDS[cadence];
  if (typeof word !== 'string') return '';

  let text;
  if (cadence === CADENCE.OCCUPIED) {
    text = `你现在${word}，回话会慢一点，也可能只应一句就接着忙。这也是正常的，不用道歉，也不用解释。`;
  } else if (cadence === CADENCE.RESTING) {
    text = `你现在${word}，句子短一点、反应慢一点都行。不想说话就可以不说话。`;
  } else {
    text = `你现在${word}，可以反应快一点、多说两句。`;
  }
  const max = numberOr(c.maxChars, DEFAULTS.maxChars);
  return text.length > max ? text.slice(0, max) : text;
}

/** 从密度记录里取一个 1.0 起算的系数（`intensityOf` 的入参口径）。 */
export function densityFactorFor(state, now, cfg = {}) {
  return densityFactor(state, now, cfg);
}

/**
 * 创建 tempo 模块实例（有状态的那一半）。
 *
 * 纯函数在文件上半部，这里只负责三件事：**读盘 / 记账 / 现算**。
 * 刻意不建定时器、不主动往外发任何东西 —— 它是被问才答的模块，
 * 跟 focus / solitude 同一范式。
 *
 * @param {object} options
 * @param {object} options.cfg - tempo 段配置。
 * @param {object} [options.stats] - 共享统计。
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {() => string} [options.resolveMediaDir] - 状态目录（延迟解析）。
 * @param {(chatId:string) => ({energy?:number, lastUserAt?:number}|null)} [options.moodOf]
 *   取某 chat 的合成状态（精力 / 他上次说话的时间），由 persona 提供。
 * @param {(chatId:string) => ({what?:string, at?:number}|null)} [options.focusOf]
 *   取她此刻手上的事（过期的不该继续压着她）。
 * @param {(now:number) => (boolean[]|null)} [options.nightMaskOf]
 *   生物钟学出来的夜间小时表；null 就按固定区间判。
 */
export function createTempo({ cfg, stats, log, resolveMediaDir, moodOf, focusOf, nightMaskOf }) {
  /** 每个 chat 一条密度记录。 */
  const densities = new Map();
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const now = () => Date.now();

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
      label: 'tempo',
      normalize: (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('chats');
        if (raw === null || typeof raw !== 'object') return;
        for (const [chatId, rec] of Object.entries(raw)) {
          if (rec === null || typeof rec !== 'object') continue;
          densities.set(chatId, {
            value: typeof rec.value === 'number' ? rec.value : 0,
            at: typeof rec.at === 'number' ? rec.at : 0,
          });
        }
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('chats', Object.fromEntries(densities));
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.tempoLastError = String(error?.message ?? error);
    }
  }

  /** 开机只读盘，不发请求、不启定时器。 */
  async function start() {
    await ensureStore().catch(() => undefined);
    return { ok: true };
  }

  /**
   * 记一条他的消息：这个 chat 的对话密度往上加一点。
   *
   * 由 `index.js` 在入站时调（与 noteMood 同一个位置）。失败绝不抛 ——
   * 它在入站链路里，抛出去会连累整轮。
   *
   * @param {string} chatId
   */
  function noteUserMessage(chatId) {
    try {
      if (!enabled()) return null;
      if (typeof chatId !== 'string' || chatId === '') return null;
      const t = now();
      densities.set(chatId, bumpDensity(densities.get(chatId) ?? createDensity(), t, cfg));
      if (stats) stats.tempoBumps = (stats.tempoBumps ?? 0) + 1;
      void ensureStore().then(persist).catch(() => undefined);
      return { ok: true };
    } catch {
      return null;
    }
  }

  /** 取（并折算）某 chat 此刻的节奏与倍率。同步、绝不抛错。 */
  function intensity(chatId, at = now()) {
    if (!enabled()) return { cadence: CADENCE.AVAILABLE, factor: 1 };
    try {
      // 精力与他上次说话的时间来自 persona 的合成状态。
      let mood = null;
      try {
        mood = typeof moodOf === 'function' ? moodOf(chatId) : null;
      } catch {
        mood = null;
      }
      // 手上的事只有「还没过期」的才算忙。
      let focus = null;
      try {
        focus = typeof focusOf === 'function' ? focusOf(chatId) : null;
      } catch {
        focus = null;
      }
      // 生物钟学出来的夜里小时表，接不上就 null（走固定区间）。
      let mask = null;
      try {
        mask = typeof nightMaskOf === 'function' ? nightMaskOf(at) : null;
      } catch {
        mask = null;
      }
      const hour = new Date(at).getHours();
      const isNight = Array.isArray(mask) && mask.length === 24
        ? mask[hour] === true
        : hour >= 23 || hour < 6;
      const focusInput =
        focus !== null && typeof focus === 'object' && Number.isFinite(focus.at)
          ? { text: String(focus.what ?? ''), expiresAt: focus.at + numberOr(cfg?.focusTtlMs, DEFAULTS.focusTtlMs) }
          : null;
      const dens = densityFactor(densities.get(chatId) ?? createDensity(), at, cfg);
      return intensityOf(
        {
          now: at,
          hour,
          isNight,
          energy: mood?.energy ?? null,
          lastUserAt: mood?.lastUserAt ?? 0,
          focus: focusInput,
          densityFactor: dens,
        },
        cfg,
      );
    } catch {
      return { cadence: CADENCE.AVAILABLE, factor: 1 };
    }
  }

  /** 注入行（只在非默认档时出）。同步、绝不抛错。 */
  function promptLine(chatId, at = now()) {
    try {
      return tempoPromptLine(intensity(chatId, at), cfg);
    } catch {
      return '';
    }
  }

  function snapshot() {
    const chats = {};
    const t = now();
    for (const [chatId, rec] of densities) {
      const dens = densityFactor(rec, t, cfg);
      chats[chatId] = {
        density: Number(decayDensity(rec, t, cfg).value.toFixed(3)),
        densityFactor: Number(dens.toFixed(3)),
      };
    }
    return {
      enabled: enabled(),
      chats,
      bumps: stats?.tempoBumps ?? 0,
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  return { MODULE_ID, start, noteUserMessage, intensity, promptLine, snapshot, DEFAULTS };
}
