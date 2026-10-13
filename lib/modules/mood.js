/**
 * 云玥的情绪状态机：心情 / 精力 / 亲密度 / 热情。
 *
 * 四个量分工不同：
 *   - 心情 mood：此刻的感觉（随机重掷，最小间隔 moodDriftMinutes）；
 *   - 精力 energy：此刻的电量（随时间衰减、夜间回血）；
 *   - 亲密度 affinity：关系有多深的慢变量（涨慢掉慢）；
 *   - 热情 warmth：当下多来劲、话多不多的短期变量（跟聊天走，静默向基线回落）。
 * 亲密度与热情是两件事：生疏也可以聊得火热，很熟也可以懒得说话。
 *
 * 设计约束（契约见 _diag/MOOD-SPEC.md 第 1 节）：
 *   1. 零 import —— 离线单测可用裸 node.exe 直接 import，不必走 stub-loader；
 *   2. 纯函数 —— 不改入参、不读写文件、不打印、不调网络；
 *   3. 心情重掷只由「随机数 + 最小间隔」驱动，禁止 cron / 固定时间表；
 *   4. 随机数消费次数被单测逐条断言，故调用顺序不可调整。
 * @module dsh-onebot/mood
 */

/** 全部心情 id；权重表按此顺序累加取桶。 */
export const MOOD_IDS = ['excited', 'happy', 'calm', 'clingy', 'playful', 'pouty', 'tired', 'down'];
/** 心情重掷的最小间隔（分钟）。 */
export const MOOD_DRIFT_MINUTES_DEFAULT = 20;
/** 清醒时每小时消耗的精力。 */
export const ENERGY_DECAY_PER_HOUR_DEFAULT = 7;
/** 夜间每小时恢复的精力。 */
export const NIGHT_RECOVERY_PER_HOUR_DEFAULT = 14;
/** 每收到一条用户消息增加的亲密度。 */
export const AFFINITY_PER_USER_MESSAGE = 1.5;
/** 长期静默时每小时衰减的亲密度。 */
export const AFFINITY_DECAY_PER_HOUR = 0.8;
/** 亲密度开始衰减前的静默宽限（小时）。 */
export const AFFINITY_DECAY_GRACE_HOURS = 6;
/** 夜间起始小时（含）。 */
export const NIGHT_START_HOUR_DEFAULT = 0;
/** 夜间结束小时（不含）。 */
export const NIGHT_END_HOUR_DEFAULT = 8;
/** 主动搭话概率门的基准值。 */
export const PROACTIVE_CHANCE_DEFAULT = 0.45;
/** 每个 chat 每日主动搭话上限（由 proactive.js 自行记账）。 */
export const PROACTIVE_DAY_CAP_DEFAULT = 6;
/** 热情的初始值（新建会话），同时用作读取旧状态时的回退值。 */
export const WARMTH_INITIAL_DEFAULT = 50;
/** 每收到一条用户消息增加的热情。 */
export const WARMTH_PER_USER_MESSAGE = 6;
/** 热情向基线回归的速率（每小时）。 */
export const WARMTH_REGRESS_PER_HOUR = 10;
/** 热情的回归基线：静默久了会落到这里（偏冷），聊天会把它推上去。 */
export const WARMTH_BASELINE_DEFAULT = 30;
/** 每次心情重掷时叠加的热情随机起伏幅度（正负对称）。 */
export const WARMTH_JITTER_DEFAULT = 8;
/** 热情对主动搭话概率的最小 / 最大系数（warmth=50 时恰为 1）。 */
export const WARMTH_CHANCE_FACTOR_MIN = 0.85;
/** 热情对主动搭话概率的最大系数。 */
export const WARMTH_CHANCE_FACTOR_MAX = 1.15;

/** 心情中文短标签（moodSnapshot().moodLabel 用）。 */
const MOOD_LABELS = {
  excited: '兴奋',
  happy: '开心',
  calm: '平静',
  clingy: '想你',
  playful: '想逗你',
  pouty: '有点小情绪',
  tired: '累了',
  down: '低落',
};

/** 精力分档文案，索引与 energyBand 一致。 */
const ENERGY_BAND_LABELS = ['精神很好', '还行', '有点累', '快没电了'];

/** 每种心情的行为建议（文案里绝不能出现花括号）。 */
const MOOD_ADVICE = {
  excited: '语气可以上扬一点，想连着说几句也行',
  happy: '轻快一点，主动接话、开个小玩笑都可以',
  calm: '正常聊天就好，不用刻意用力',
  clingy: '可以主动黏一下，说点想他的话，但别刷屏',
  playful: '可以逗逗对方，抛个小问题或者开个无伤大雅的玩笑',
  pouty: '可以闹点小情绪、嘴上不饶人，但别真的生气',
  tired: '说话短一点，可以直说想睡了',
  down: '语气放软一点，可以示弱，但别一直倒苦水',
};

/** 精力分档对应的行为建议，索引与 energyBand 一致。 */
const ENERGY_ADVICE = [
  '精力很足，可以多聊几句',
  '精力正常，按平时节奏回就好',
  '精力在往下掉，回复尽量短一些',
  '快没电了，只回一两句就够，别硬撑',
];

/** 热情分档文案，索引与 warmthBand 一致。 */
const WARMTH_BAND_LABELS = ['聊得正热', '聊得还行', '有点冷下来了', '不太想说话'];

/**
 * 热情分档对应的行为建议，索引与 warmthBand 一致。
 * 热情只管「话多不多、来不来劲」，与亲密度是两件事：亲密度低也可以聊得火热。
 */
const WARMTH_ADVICE = [
  '可以多说几句、主动接话、开开玩笑，连着发两三条也没关系',
  '正常接话就好，可以稍微主动一点',
  '回复简短些，不必硬找话题',
  '尽量短，一两句就够，不用勉强热络',
];

/**
 * 基础权重表：行 = 心情，列 = 精力分档 [>=75, 45..74, 20..44, <20]。
 * 修正系数在此之上依次相乘（见 moodWeights）。
 */
const MOOD_BASE_WEIGHTS = {
  excited: [3, 1, 0, 0],
  happy: [4, 4, 2, 0],
  calm: [2, 4, 4, 2],
  clingy: [2, 3, 3, 2],
  playful: [4, 3, 1, 0],
  pouty: [1, 1, 2, 2],
  tired: [0, 1, 4, 6],
  down: [0, 0, 1, 3],
};

/** proactiveChance 的心情系数（未列出的心情按 1 处理）。 */
const MOOD_CHANCE_FACTORS = {
  excited: 1.30,
  happy: 1.15,
  playful: 1.20,
  clingy: 1.35,
  calm: 1.00,
  pouty: 0.80,
  tired: 0.45,
  down: 0.50,
};

/**
 * 本地小时数（0..23）。
 * @param now - ms epoch。
 * @returns 小时。
 */
function hourOf(now) {
  return new Date(now).getHours();
}

/**
 * 精力分档索引：0 = >=75，1 = 45..74，2 = 20..44，3 = <20。
 * @param energy - 精力值。
 * @returns 分档索引。
 */
function energyBand(energy) {
  if (energy >= 75)
    return 0;
  if (energy >= 45)
    return 1;
  if (energy >= 20)
    return 2;
  return 3;
}

/**
 * 热情分档索引：0 = >=70，1 = 45..69，2 = 25..44，3 = <25。
 * 与精力分档不同：热情是「当下多来劲、话多不多」的短期量，与亲密度无关。
 * @param warmth - 热情值。
 * @returns 分档索引。
 */
function warmthBand(warmth) {
  if (warmth >= 70)
    return 0;
  if (warmth >= 45)
    return 1;
  if (warmth >= 25)
    return 2;
  return 3;
}

/**
 * 小时是否落在 [start, end) 区间内，支持跨零点（如 23 → 8）。
 * @param hour - 本地小时数。
 * @param start - 起始小时（含）。
 * @param end - 结束小时（不含）。
 * @returns 是否命中。
 */
function inHourRange(hour, start, end) {
  if (start === end)
    return false;
  if (start < end)
    return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/**
 * 把任意数值夹到 [0, 100]；非有限值（NaN / Infinity / undefined 经运算得到）归 0。
 * @param value - 待夹紧的数值。
 * @returns 0..100 的有限数。
 */
function clamp100(value) {
  if (!Number.isFinite(value))
    return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * 热情对主动搭话概率的系数：warmth = 50 时为 1，0 时 0.85，100 时 1.15。
 * 只做小幅缩放 —— 热情主要影响语气，主动性只是顺带。
 * @param warmth - 热情值。
 * @returns 0.85..1.15 的系数。
 */
function warmthChanceFactor(warmth) {
  const w = clamp100(warmth);
  const span = (WARMTH_CHANCE_FACTOR_MAX - WARMTH_CHANCE_FACTOR_MIN) / 2;
  return 1 + ((w - WARMTH_INITIAL_DEFAULT) / WARMTH_INITIAL_DEFAULT) * span;
}

/**
 * 计算心情权重表：基础权重 → 乘修正系数。所有系数恒为正，故总权重恒 > 0。
 * @param energy - 当前精力（夹紧后的新值）。
 * @param affinity - 当前亲密度（夹紧后的新值）。
 * @param silenceHours - 距最后一次互动的小时数。
 * @param hour - 当前本地小时数。
 * @returns 以 mood id 为键的权重对象。
 */
function moodWeights(energy, affinity, silenceHours, hour) {
  const band = energyBand(energy);
  const weights = {};
  for (const id of MOOD_IDS)
    weights[id] = MOOD_BASE_WEIGHTS[id][band];
  // 静默越久越黏人、也越容易低落。
  if (silenceHours > 3 && affinity >= 40) {
    weights.clingy *= 2.2;
    weights.down *= 1.4;
  }
  if (silenceHours > 12) {
    weights.clingy *= 2.5;
    weights.down *= 2.0;
  }
  // 关系还生疏时不敢黏人、也不敢太兴奋。
  if (affinity < 20) {
    weights.clingy *= 0.5;
    weights.excited *= 0.6;
  }
  // 深夜：困、安静下来。
  if (hour >= 23 || hour < 6) {
    weights.tired *= 2.5;
    weights.excited *= 0.3;
    weights.playful *= 0.5;
  }
  // 白天 9..18 点：精神一些。
  if (hour >= 9 && hour < 18) {
    weights.excited *= 1.2;
    weights.happy *= 1.15;
  }
  return weights;
}

/**
 * 按累计权重取桶，消费恰好一次 random()。
 * @param weights - moodWeights 的结果。
 * @param random - () => number，返回 [0, 1)。
 * @returns 命中的 mood id；总权重 <= 0 时返回 'calm' 且不消费随机数。
 */
function pickMood(weights, random) {
  let total = 0;
  for (const id of MOOD_IDS)
    total += weights[id];
  if (total <= 0)
    return 'calm';
  const roll = random() * total;
  let accumulated = 0;
  for (const id of MOOD_IDS) {
    accumulated += weights[id];
    if (roll < accumulated)
      return id;
  }
  return 'calm';
}

/**
 * 构造一个全新的情绪状态。
 * @param now - 当前 ms epoch。
 * @param options - 可选的初始 energy / affinity / mood / warmth。
 * @returns 全新的 MoodState（lastDriftAt = now，其余时间戳为 0，含 lastMoodRollAt = 0 表示从未重掷）。
 */
export function createMoodState(now, options = {}) {
  const opts = options ?? {};
  return {
    mood: opts.mood ?? 'calm',
    energy: opts.energy ?? 80,
    affinity: opts.affinity ?? 20,
    warmth: clamp100(opts.warmth ?? WARMTH_INITIAL_DEFAULT),
    lastDriftAt: now,
    lastMoodRollAt: 0,
    lastUserAt: 0,
    lastAssistantAt: 0,
    lastProactiveAt: 0,
  };
}

/**
 * 按经过的时间推进状态：精力衰减 / 夜间恢复、亲密度静默衰减、心情重掷。
 * 纯函数：不修改 state，返回新对象；只有真正重掷时才消费一次 random()。
 *
 * 两个时间戳分工不同（R1）：
 *   - lastDriftAt 只管精力积分，每次调用恒定推进到 now；
 *   - lastMoodRollAt 只管心情门控，只在真正重掷的那一次推进。
 * 若门控也用 lastDriftAt，宿主每次拼提示都调用会把参考点推到 now，
 * 导致 now - lastDriftAt 永远小于窗口，心情永远无法重掷。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param random - () => number，返回 [0, 1)。
 * @param config - 可选的漂移参数覆盖。
 * @returns 新的 MoodState（lastDriftAt = now）。
 */
export function driftMood(state, now, random, config = {}) {
  const cfg = config ?? {};
  const moodDriftMinutes = cfg.moodDriftMinutes ?? MOOD_DRIFT_MINUTES_DEFAULT;
  const energyDecayPerHour = cfg.energyDecayPerHour ?? ENERGY_DECAY_PER_HOUR_DEFAULT;
  const nightRecoveryPerHour = cfg.nightRecoveryPerHour ?? NIGHT_RECOVERY_PER_HOUR_DEFAULT;
  const nightStartHour = cfg.nightStartHour ?? NIGHT_START_HOUR_DEFAULT;
  const nightEndHour = cfg.nightEndHour ?? NIGHT_END_HOUR_DEFAULT;
  const affinityDecayPerHour = cfg.affinityDecayPerHour ?? AFFINITY_DECAY_PER_HOUR;
  const affinityGraceHours = cfg.affinityGraceHours ?? AFFINITY_DECAY_GRACE_HOURS;

  const elapsedHours = Math.max(0, (now - state.lastDriftAt) / 3600000);
  const hour = hourOf(now);

  // 精力：夜里回血，白天掉电，两端夹紧。
  const rawEnergy = inHourRange(hour, nightStartHour, nightEndHour)
    ? state.energy + elapsedHours * nightRecoveryPerHour
    : state.energy - elapsedHours * energyDecayPerHour;
  const energy = Math.min(100, Math.max(0, rawEnergy));

  // 亲密度：静默超过宽限期才衰减；两个时间戳都为 0 视为从未静默。
  let affinity = state.affinity;
  const lastContact = Math.max(state.lastUserAt, state.lastAssistantAt);
  if (lastContact > 0 && (now - lastContact) / 3600000 > affinityGraceHours)
    affinity = Math.min(100, Math.max(0, affinity - elapsedHours * affinityDecayPerHour));

  // 热情：短期量，和精力一样用 elapsedHours 恒定推进 —— 静默时向基线回落（越聊越热、安静就冷），
  // 但不会一路掉到 0：基线就是「没在聊时的默认温度」。随机起伏不在这里加，跟着心情重掷走。
  let warmth = clamp100(state.warmth ?? WARMTH_INITIAL_DEFAULT);
  const warmthBaseline = clamp100(cfg.warmthBaseline ?? WARMTH_BASELINE_DEFAULT);
  const warmthRegressPerHour = cfg.warmthRegressPerHour ?? WARMTH_REGRESS_PER_HOUR;
  if (elapsedHours > 0 && warmth !== warmthBaseline) {
    const step = elapsedHours * warmthRegressPerHour;
    warmth = warmth > warmthBaseline
      ? Math.max(warmthBaseline, warmth - step)
      : Math.min(warmthBaseline, warmth + step);
  }

  // 心情：门控只认 lastMoodRollAt —— 它是个稳定参考点（初始 0 = 从未重掷，
  // 之后只在真正重掷时推进）。绝不退回用 lastDriftAt 起算：宿主每次拼提示都会调用本函数，
  // lastDriftAt 每次被推到 now，退回会让 now - rollRef 恒小于窗口 → 心情永远无法重掷。
  // 间隔不足时原样保留 lastMoodRollAt（0 保持 0），且一个随机数都不消费。
  let mood = state.mood;
  let lastMoodRollAt = state.lastMoodRollAt ?? 0;
  if (now - lastMoodRollAt >= moodDriftMinutes * 60000) {
    const silenceHours = quietMs(state, now) / 3600000;
    mood = pickMood(moodWeights(energy, affinity, silenceHours, hour), random);
    // 热情的随机起伏搭在这一次重掷上（重掷时共消费两次 random：一次选心情，一次做抖动）。
    const warmthJitter = cfg.warmthJitter ?? WARMTH_JITTER_DEFAULT;
    warmth = clamp100(warmth + (random() - 0.5) * 2 * warmthJitter);
    lastMoodRollAt = now;
  }

  return { ...state, mood, energy, affinity, warmth, lastDriftAt: now, lastMoodRollAt };
}

/**
 * 记一条用户消息：小幅回血 + 涨亲密度 + 聊热一点，心情不变。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteUserMessage(state, now) {
  return {
    ...state,
    energy: Math.min(100, state.energy + 2),
    affinity: Math.min(100, state.affinity + AFFINITY_PER_USER_MESSAGE),
    warmth: clamp100((state.warmth ?? WARMTH_INITIAL_DEFAULT) + WARMTH_PER_USER_MESSAGE),
    lastUserAt: now,
    lastDriftAt: now,
  };
}

/**
 * 记一条自己发出的消息：说话耗一点精力，心情不变。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteAssistantMessage(state, now) {
  return {
    ...state,
    energy: Math.max(0, state.energy - 1.5),
    lastAssistantAt: now,
    lastDriftAt: now,
  };
}

/**
 * 记一次主动搭话：主动开口更耗精力，心情不变。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteProactive(state, now) {
  return {
    ...state,
    energy: Math.max(0, state.energy - 3),
    lastProactiveAt: now,
    lastDriftAt: now,
  };
}

/**
 * 距最后一次互动（用户消息 / 自己说话 / 主动搭话）的毫秒数。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @returns 静默毫秒数；三个时间戳全为 0 时返回 now（视作从纪元起一直安静），负数归 0。
 */
export function quietMs(state, now) {
  const last = Math.max(state.lastUserAt, state.lastAssistantAt, state.lastProactiveAt);
  if (last <= 0)
    return Math.max(0, now);
  return Math.max(0, now - last);
}

/**
 * 给宿主/日志用的只读快照。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @returns { mood, energy, affinity, warmth, quietMs, moodLabel, warmthLabel }，精力 / 亲密度 / 热情取整。
 */
export function moodSnapshot(state, now) {
  const warmth = clamp100(state.warmth ?? WARMTH_INITIAL_DEFAULT);
  return {
    mood: state.mood,
    energy: Math.round(state.energy),
    affinity: Math.round(state.affinity),
    warmth: Math.round(warmth),
    quietMs: quietMs(state, now),
    moodLabel: MOOD_LABELS[state.mood] ?? MOOD_LABELS.calm,
    warmthLabel: WARMTH_BAND_LABELS[warmthBand(warmth)] ?? WARMTH_BAND_LABELS[1],
  };
}

/**
 * 生成注入系统提示的情绪提示行。恒非空，且绝不含花括号 —— 宿主的
 * prompt 插值器会把 {{name}} 当变量引用并抛错。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param config - 预留（当前无可用键）。
 * @returns 单行中文提示。
 */
export function moodPromptLine(state, now, config = {}) {
  // 分档与显示数字都基于取整后的精力，避免出现「75/100（有点累）」这类自相矛盾。
  const rounded = Math.round(state.energy);
  const band = energyBand(rounded);
  const label = MOOD_LABELS[state.mood] ?? MOOD_LABELS.calm;
  const advice = MOOD_ADVICE[state.mood] ?? MOOD_ADVICE.calm;
  // 热情与心情、精力并列：它管「当下话多不多、来不来劲」，和亲密度是两件事。
  const warmth = clamp100(state.warmth ?? WARMTH_INITIAL_DEFAULT);
  const warmthRounded = Math.round(warmth);
  const warmthIdx = warmthBand(warmthRounded);
  return '- 你现在的心情是「' + label + '」，精力 ' + rounded + '/100（'
    + ENERGY_BAND_LABELS[band] + '），热情 ' + warmthRounded + '/100（'
    + WARMTH_BAND_LABELS[warmthIdx] + '）。' + advice + '；' + ENERGY_ADVICE[band]
    + '；' + WARMTH_ADVICE[warmthIdx] + '。';
}

/**
 * 主动搭话的概率门：基准值 × 精力系数 × 静默系数 × 心情系数 × 热情系数，夹在 [0, 0.95]。
 * 热情只做小幅缩放（0.85..1.15）—— 它主要影响语气，主动性只是顺带。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param config - 可选的 proactiveChance 基准值覆盖。
 * @returns 0..0.95 的概率（不消费随机数）。
 */
export function proactiveChance(state, now, config = {}) {
  const cfg = config ?? {};
  const base = cfg.proactiveChance ?? PROACTIVE_CHANCE_DEFAULT;
  const energyFactor = 0.25 + 0.75 * (state.energy / 100);
  const quietHours = quietMs(state, now) / 3600000;
  const silenceFactor = Math.min(1.6, 1 + quietHours / 8);
  const moodFactor = MOOD_CHANCE_FACTORS[state.mood] ?? 1;
  const warmthFactor = warmthChanceFactor(state.warmth ?? WARMTH_INITIAL_DEFAULT);
  return Math.min(0.95, Math.max(0, base * energyFactor * silenceFactor * moodFactor * warmthFactor));
}
