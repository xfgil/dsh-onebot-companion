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
/** 每收到一条用户消息回复的精力（R2：从 2 提到 8，让「聊天」本身真的能回血）。 */
export const ENERGY_PER_USER_MESSAGE_DEFAULT = 8;
/** 自己每说一句话消耗的精力。 */
export const ENERGY_PER_ASSISTANT_MESSAGE_DEFAULT = 1.5;
/**
 * 每个工具调用额外扣多少精力（2026-10-23）。
 *
 * 0.4 是这么定的：一轮典型对话两三个工具 → 加扣 0.8~1.2，跟「说话」那 1.5
 * 同量级；一轮二十个工具的重活 → 加上封顶能扣到 5.5，是纯聊天的三倍多。
 * 没定成 1 以上是因为**工具数不等于工作量**：查个天气也是一次调用，
 * 跑一次两分钟的构建也是一次调用，两者都按 1 扣会把「查天气」罚得太重。
 */
export const ENERGY_PER_TOOL_CALL_DEFAULT = 0.4;
/** 每轮工具加扣的上限。再忙也不该因为一轮任务把精力当场打到 0。 */
export const TOOL_CALL_ENERGY_CAP_DEFAULT = 4;
/** 每次主动开口消耗的精力（比回话更费劲）。 */
export const ENERGY_PER_PROACTIVE_DEFAULT = 3;
/** 每收到一条用户消息增加的亲密度。 */
export const AFFINITY_PER_USER_MESSAGE = 1.5;
/** 「名单外的人」能涨到的天花板（2026-10-21，用户定 33）。 */
export const AFFINITY_CAP_OTHERS_DEFAULT = 33;
/** 全新关系（或从没见过的人）的初始亲密度。 */
export const AFFINITY_INITIAL_DEFAULT = 20;
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

/**
 * 触发「不装了」的精力阈值：低于这个数，理性那层开始漏风。
 * 取 30 而不是 20 —— 分档文案在 20..44 已经说「有点累」，但真正开始出岔子
 * 是从 30 往下：还撑得住场面，只是撑不住了细节。
 */
export const LOW_ENERGY_THRESHOLD_DEFAULT = 30;

/**
 * 低精力时会漏出来的毛病。每条都是**具体可执行**的，不是「表现得累一点」这种
 * 模型没有刻度的措辞 —— 跟 rules.js 里那套「给尺子不给感觉」的原则一致。
 *
 * `id` 用来做确定性选取（不消费 random()，否则单测里被逐条断言的随机数
 * 消费次数会错位）。
 */
const LOW_ENERGY_SYMPTOMS = [
  { id: 'debate', text: '这轮别再反复权衡了：想说哪句就说哪句，不要先在脑子里过两遍再挑一个最得体的' },
  { id: 'detail', text: '细节可能记错（时间、数字、谁先说的）——别去翻旧记录校对，就按记得的说，说岔了也没关系' },
  { id: 'repeat', text: '可能会把刚说过的话又说一遍，或者一件事讲两遍——这不是你故意的，别为了圆它再补一句解释' },
  { id: 'short', text: '句子短一点，能不凑的话就不凑，接不上就沉默' },
  { id: 'irritable', text: '小事容易让你不耐烦：同一个问题被问第二遍、或者对方敷衍你，可以真的表现出不痛快' },
  { id: 'forget', text: '想不起来某件事就说想不起来，不要顺着话头编一个像样的版本' },
];

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

/**
 * 基础权重为 0 的心情，在长期底色想抬高它时给的绝对入口。
 * 见 `moodWeights` 里最后那段的注释。取值理由：低精力档总权重约 14，
 * 0.8 约占 5%，刚好「偶尔真的沉下去」而不是「一半时间在低谷」。
 */
const ZERO_BASE_LIFT = 0.8;

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
 * 把一段真实时间按昼夜**逐段推进**精力，每段单独夹紧（R2）。
 *
 * 为什么不能只看结算时刻的小时：`driftMood` 是离散结算，一次调用要结算
 * `lastDriftAt → now` 的整段跨度。旧实现用 `hourOf(now)` 一个值给整段定性，
 * 于是「白天看一眼」= 整段掉电、「夜里看一眼」= 整段回血，跨天跨度必被夹死在
 * 0 或 100 —— 精力事实上永远归 0。这里改成真正的时间积分：逐小时推进，跨过
 * 夜界就换一次符号。
 *
 * 为什么必须**逐段夹紧**而不是「先算总夜间时长、总白天时长再一次性相减」：
 * 那是线性积分，而日夜收支恰好抵消（夜间 8h×14 = 112，白天 16h×7 = 112，净 0），
 * 于是「从 0 出发永远是 0、从 50 出发永远是 50」—— 精力照样回不来。电量是有
 * 上限的身体，睡满了就不再涨（溢出的回血浪费掉），白天掉到 0 就不再掉。逐段
 * 夹紧才让「睡一觉回满、白天耗光」这个真实作息自然涌现。
 *
 * 精度：以小时为步长，不足一小时的尾巴单独按它那一刻的时段算。
 * @param energy - 起始精力。
 * @param from - 起始 ms epoch（含）。
 * @param to - 结束 ms epoch（不含）。
 * @param nightStartHour - 夜间起始小时（含）。
 * @param nightEndHour - 夜间结束小时（不含）。
 * @param nightRecoveryPerHour - 夜间每小时回血。
 * @param energyDecayPerHour - 白天每小时掉电。
 * @returns 结算后的精力（0..100）。
 */
function integrateEnergy(
  energy,
  from,
  to,
  nightStartHour,
  nightEndHour,
  nightRecoveryPerHour,
  energyDecayPerHour,
  nightMask,
) {
  if (!(to > from))
    return energy;
  // 夜间判定：有学出来的生物钟（24 个 boolean）就用它，否则退回固定的起止小时。
  // 掩码的三种语义（见 modules/circadian.js 的 nightSetOf）：null = 没数据、走固定
  // 区间；全 false = 他从不睡，于是**精力没有回血时段**，只靠聊天回 —— 这正是
  // 「一个从不困倦的伴侣」该有的样子，不是 bug。
  const mask = Array.isArray(nightMask) && nightMask.length === 24 ? nightMask : null;
  const isNight = (hour) => (mask === null ? inHourRange(hour, nightStartHour, nightEndHour) : mask[hour] === true);
  let current = energy;
  let cursor = from;
  // 上限保护：跨度超过 400 天时按 400 天截断，避免异常时间戳把这里跑成死循环。
  const limit = Math.min(to, from + 400 * 24 * 3600000);
  while (cursor < limit) {
    const hour = hourOf(cursor);
    // 距下一个整点还有多久（至少 1 分钟，防止对不齐时步长为 0 空转）。
    const nextHour = new Date(cursor);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const stepEnd = Math.min(limit, Math.max(nextHour.getTime(), cursor + 60000));
    const hours = (stepEnd - cursor) / 3600000;
    const rate = isNight(hour) ? nightRecoveryPerHour : -energyDecayPerHour;
    current = Math.min(100, Math.max(0, current + rate * hours));
    cursor = stepEnd;
  }
  return current;
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
 * @param bias - 长期底色给的乘数表（`temper.biasOf` 的结果，可省略）。
 *   为什么放在**最后一步**乘：上面那些条件都是「此刻」的判断（累了、静了很久、
 *   深夜），底色是「这一阵」的判断，两者是叠加关系不是替代关系。乘在最后还有一个
 *   好处——调这一块不会改变任何一条已有条件的含义。
 * @returns 以 mood id 为键的权重对象。
 */
function moodWeights(energy, affinity, silenceHours, hour, bias) {
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
  // 长期底色（temper）：只在给了表、且值是有限正数时才生效。缺项当 1 处理，
  // 不猜、不补默认值 —— 让 temper 的配置能独立演进。
  //
  // 基础权重为 0 的心情（低精力档下的 excited / down）**乘法永远抬不起来**，
  // 所以这一档要单独处理：给它一个很小的绝对入口（`ZERO_BASE_LIFT * (k - 1)`）。
  // 用 `k - 1` 而不是 `k`，是为了让 k = 1（默认、不偏）时恰好等于 0，
  // 从而保证「不传 bias」与「传全 1」逐位等价——这条有自测盯着。
  //
  // 量级：0.8 相对于低精力档总权重（约 14）是 5% 上下，正合适 ——「这一阵一直
  // 不好过，所以偶尔真的沉下去」，而不是一半时间都在低谷。
  if (bias !== null && typeof bias === 'object') {
    for (const id of MOOD_IDS) {
      const k = bias[id];
      if (!Number.isFinite(k) || k <= 0) continue;
      const base = weights[id];
      if (base > 0) weights[id] = base * k;
      else if (k > 1) weights[id] = ZERO_BASE_LIFT * (k - 1);
    }
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
  const energyDecayPerHour = cfg.energyDecayPerHour ?? ENERGY_DECAY_PER_HOUR_DEFAULT;
  const nightRecoveryPerHour = cfg.nightRecoveryPerHour ?? NIGHT_RECOVERY_PER_HOUR_DEFAULT;
  const nightStartHour = cfg.nightStartHour ?? NIGHT_START_HOUR_DEFAULT;
  const nightEndHour = cfg.nightEndHour ?? NIGHT_END_HOUR_DEFAULT;
  const affinityDecayPerHour = cfg.affinityDecayPerHour ?? AFFINITY_DECAY_PER_HOUR;
  const affinityGraceHours = cfg.affinityGraceHours ?? AFFINITY_DECAY_GRACE_HOURS;

  const elapsedHours = Math.max(0, (now - state.lastDriftAt) / 3600000);

  // 精力：按昼夜**逐段推进并逐段夹紧**（R2）。白天每段掉电、夜间每段回血，各自
  // 乘各自的时长；而不是用结算时刻的 hour 给整段跨度一刀切 —— 后者会让跨天结算
  // 必然撞死在 0 或 100，精力事实上永远归 0。
  const energy = integrateEnergy(
    state.energy,
    state.lastDriftAt,
    now,
    nightStartHour,
    nightEndHour,
    nightRecoveryPerHour,
    energyDecayPerHour,
    cfg.nightMask,
  );

  // 亲密度：静默超过宽限期才衰减；两个时间戳都为 0 视为从未静默。
  let affinity = state.affinity;
  const lastContact = Math.max(state.lastUserAt, state.lastAssistantAt);
  if (lastContact > 0 && (now - lastContact) / 3600000 > affinityGraceHours)
    affinity = Math.min(100, Math.max(0, affinity - elapsedHours * affinityDecayPerHour));

  // 热情：短期量，和精力一样用 elapsedHours 恒定推进 —— 静默时向基线回落（越聊越热、安静就冷），
  // 但不会一路掉到 0：基线就是「没在聊时的默认温度」。回归逻辑在 advanceSocial 里
  // （不传 warmthIn 时它自己按时间回归），随机起伏跟着心情重掷走。
  const social = advanceSocial(state, now, random, cfg, energy, affinity);

  return {
    ...state,
    mood: social.mood,
    energy,
    affinity,
    warmth: social.warmth,
    lastDriftAt: now,
    lastMoodRollAt: social.lastMoodRollAt,
  };
}

/**
 * 心情重掷 + 热情的静默回归（driftMood 的「社交那一半」）。
 *
 * 之所以单独抽出来：精力是**身体**的状态、亲密度是**和某个人**的状态，这两者
 * 的参考点（全局、按人）和会话无关；只有心情与热情是「此刻在这个场合」的。
 * 所以分层存储时要能只推进这两项，而把 energy / affinity 的结算交给调用方。
 *
 * 消费 random 的时机与 driftMood 完全一致（只在真正重掷时消费两次），
 * 这样分层之后 random 流的形状不变。
 *
 * @param state - 当前状态（读 mood / warmth / lastMoodRollAt / lastDriftAt / 三个时间戳）。
 * @param now - 当前 ms epoch。
 * @param random - () => number，返回 [0, 1)。
 * @param config - 可选的漂移参数覆盖。
 * @param energy - 已经结算好的精力（只用于心情权重，不写回）。
 * @param affinity - 已经结算好的亲密度（只用于心情权重，不写回）。
 * @param warmthIn - 已经回归过的热情初值（省略时用 state.warmth 自行回归）。
 * @returns `{ mood, warmth, lastMoodRollAt }`。
 */
export function advanceSocial(state, now, random, config = {}, energy, affinity, warmthIn) {
  const cfg = config ?? {};
  const moodDriftMinutes = cfg.moodDriftMinutes ?? MOOD_DRIFT_MINUTES_DEFAULT;
  const hour = hourOf(now);
  const e = energy ?? state.energy;
  const a = affinity ?? state.affinity;

  // 心情：门控只认 lastMoodRollAt —— 它是个稳定参考点（初始 0 = 从未重掷，
  // 之后只在真正重掷时推进）。绝不退回用 lastDriftAt 起算：宿主每次拼提示都会调用本函数，
  // lastDriftAt 每次被推到 now，退回会让 now - rollRef 恒小于窗口 → 心情永远无法重掷。
  // 间隔不足时原样保留 lastMoodRollAt（0 保持 0），且一个随机数都不消费。
  let mood = state.mood;
  let lastMoodRollAt = state.lastMoodRollAt ?? 0;
  // 热情：短期量，和精力一样按 elapsedHours 恒定推进 —— 静默时向基线回落。
  // 这里只负责「已经传进来一个初值」的情况；没传就自己按时间回归一次。
  let warmth = warmthIn === undefined ? regressWarmth(state, now, cfg) : clamp100(warmthIn);
  if (now - lastMoodRollAt >= moodDriftMinutes * 60000) {
    const silenceHours = quietMs(state, now) / 3600000;
    mood = pickMood(moodWeights(e, a, silenceHours, hour, cfg.moodBias), random);
    // 热情的随机起伏搭在这一次重掷上（重掷时共消费两次 random：一次选心情，一次做抖动）。
    const warmthJitter = cfg.warmthJitter ?? WARMTH_JITTER_DEFAULT;
    warmth = clamp100(warmth + (random() - 0.5) * 2 * warmthJitter);
    lastMoodRollAt = now;
  }
  return { mood, warmth, lastMoodRollAt };
}

/**
 * 热情按静默时长向基线回落（越聊越热，安静就冷，但不会一路掉到 0）。
 * @param state - 当前状态（读 warmth 与 lastDriftAt）。
 * @param now - 当前 ms epoch。
 * @param cfg - 已归一化的配置。
 * @returns 0..100 的热情。
 */
function regressWarmth(state, now, cfg) {
  const elapsedHours = Math.max(0, (now - state.lastDriftAt) / 3600000);
  const warmthBaseline = clamp100(cfg.warmthBaseline ?? WARMTH_BASELINE_DEFAULT);
  const warmthRegressPerHour = cfg.warmthRegressPerHour ?? WARMTH_REGRESS_PER_HOUR;
  let warmth = clamp100(state.warmth ?? WARMTH_INITIAL_DEFAULT);
  if (elapsedHours > 0 && warmth !== warmthBaseline) {
    const step = elapsedHours * warmthRegressPerHour;
    warmth = warmth > warmthBaseline
      ? Math.max(warmthBaseline, warmth - step)
      : Math.min(warmthBaseline, warmth + step);
  }
  return warmth;
}

/**
 * 只把精力从 from 积分到 to（逐段夹紧），不碰其它量。
 *
 * 分层存储时精力是**全局一份**：不管在私聊还是哪个群说话，耗的都是同一份电量，
 * 所以它有自己的参考点，与会话无关。
 *
 * @param energy - 起始精力。
 * @param from - 起始 ms epoch（含）。
 * @param to - 结束 ms epoch（不含）。
 * @param config - 可选的漂移参数覆盖。
 * @returns 0..100 的精力。
 */
export function driftEnergyOnly(energy, from, to, config = {}) {
  const cfg = config ?? {};
  return integrateEnergy(
    energy,
    from,
    to,
    cfg.nightStartHour ?? NIGHT_START_HOUR_DEFAULT,
    cfg.nightEndHour ?? NIGHT_END_HOUR_DEFAULT,
    cfg.nightRecoveryPerHour ?? NIGHT_RECOVERY_PER_HOUR_DEFAULT,
    cfg.energyDecayPerHour ?? ENERGY_DECAY_PER_HOUR_DEFAULT,
    cfg.nightMask,
  );
}

/**
 * 只把亲密度按静默时长衰减，不碰其它量。
 *
 * 分层存储时亲密度是**按人**的（同一个人在私聊和群里说话涨同一份），
 * 所以它的参考点是「这个人上次说话/我上次对他说话」的时刻，与会话无关。
 *
 * @param affinity - 起始亲密度。
 * @param lastContact - 上次互动 ms epoch（0 表示从未互动，不衰减）。
 * @param from - 起始 ms epoch（含）。
 * @param to - 结束 ms epoch（不含）。
 * @param config - 可选的漂移参数覆盖。
 * @returns 0..100 的亲密度。
 */
export function driftAffinityOnly(affinity, lastContact, from, to, config = {}) {
  const cfg = config ?? {};
  if (!(to > from))
    return affinity;
  if (!(lastContact > 0))
    return affinity;
  const graceHours = cfg.affinityGraceHours ?? AFFINITY_DECAY_GRACE_HOURS;
  if ((to - lastContact) / 3600000 <= graceHours)
    return affinity;
  const perHour = cfg.affinityDecayPerHour ?? AFFINITY_DECAY_PER_HOUR;
  return Math.min(100, Math.max(0, affinity - ((to - from) / 3600000) * perHour));
}

/**
 * 记一条用户消息：回血 + 涨亲密度 + 聊热一点，心情不变。
 *
 * R2 起回血量从 2 提到 8：`noteAssistantMessage` 扣 1.5，一条一来一回净 +6.5，
 * 这样「聊天」本身才真的能把精力顶起来 —— 旧值 +2 让日常对话净收支约等于 0，
 * 精力只由时间结算决定，而时间结算的日夜收支又恰好抵消，于是永远归 0。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param config - 可选的回血量覆盖（energyPerUserMessage）。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteUserMessage(state, now, config = {}) {
  const gain = (config ?? {}).energyPerUserMessage ?? ENERGY_PER_USER_MESSAGE_DEFAULT;
  // 亲密度的步长与天花板（2026-10-21）：原先「谁说话涨谁」，导致群里常冒头的
  // 人也跟着涨，于是要求亲密度只对特定的人涨；随后又定为「可以涨，
  // 除特定人以外上限 33」。
  // 名单外的人照样回血、照样记时间戳（她还是要搭理人家），只是关系深度到 33 就停。
  // 用 `??` 而不是 `||` 是有意的 —— 0 是**有效值**，不能被当成「没配」。
  const affinityGain = (config ?? {}).affinityPerUserMessage ?? AFFINITY_PER_USER_MESSAGE;
  const affinityCap = (config ?? {}).affinityCap ?? 100;
  // 只往上夹，不往下削：老数据里已经超过上限的人（历史遗留）停在原地，不被回砍。
  const affinityNext =
    state.affinity >= affinityCap
      ? state.affinity
      : Math.min(affinityCap, state.affinity + affinityGain);
  return {
    ...state,
    energy: Math.min(100, state.energy + gain),
    affinity: clamp100(affinityNext),
    warmth: clamp100((state.warmth ?? WARMTH_INITIAL_DEFAULT) + WARMTH_PER_USER_MESSAGE),
    lastUserAt: now,
    lastDriftAt: now,
  };
}

/**
 * 记一条自己发出的消息：说话耗一点精力，心情不变。
 *
 * **按工具调用数加扣（2026-10-23）**。用户问「工作区干活的时候你不消耗精力？」
 * ——问对了：此前不管这一轮只是回了句「嗯」还是装了 ComfyUI、改了五个模块、
 * 跑了二十次工具，一律扣 1.5。账是反的：真正累的不是说了多少句，是干了多少活。
 *
 * 口径刻意保守：
 *   - 每多一个工具调用加 `energyPerToolCall`（默认 0.4）；
 *   - 但**总加扣封顶** `toolCallEnergyCap`（默认 4），一轮再忙也不会当场被打空
 *     —— 精力是「一天下来慢慢掉」的东西，不该因为一次长任务瞬间归零；
 *   - `toolCalls` 缺席或非有限数时行为与加这条之前**逐位一致**。
 *
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param config - 可选的耗电量覆盖（energyPerAssistantMessage / energyPerToolCall / toolCallEnergyCap）。
 * @param toolCalls - 这一轮用了几个工具（0 或省略 = 纯说话）。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteAssistantMessage(state, now, config = {}, toolCalls = 0) {
  const cfg = config ?? {};
  const cost = cfg.energyPerAssistantMessage ?? ENERGY_PER_ASSISTANT_MESSAGE_DEFAULT;
  const per = Number.isFinite(cfg.energyPerToolCall) ? Math.max(0, cfg.energyPerToolCall) : ENERGY_PER_TOOL_CALL_DEFAULT;
  const cap = Number.isFinite(cfg.toolCallEnergyCap) ? Math.max(0, cfg.toolCallEnergyCap) : TOOL_CALL_ENERGY_CAP_DEFAULT;
  const used = Number.isFinite(toolCalls) && toolCalls > 0 ? toolCalls : 0;
  const extra = Math.min(cap, used * per);
  return {
    ...state,
    energy: Math.max(0, state.energy - cost - extra),
    lastAssistantAt: now,
    lastDriftAt: now,
  };
}

/**
 * 记一次主动搭话：主动开口更耗精力，心情不变。
 * @param state - 当前状态。
 * @param now - 当前 ms epoch。
 * @param config - 可选的耗电量覆盖（energyPerProactive）。
 * @returns 新的 MoodState（不消费随机数）。
 */
export function noteProactive(state, now, config = {}) {
  const cost = (config ?? {}).energyPerProactive ?? ENERGY_PER_PROACTIVE_DEFAULT;
  return {
    ...state,
    energy: Math.max(0, state.energy - cost),
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
 * 低精力的「漏水」提示：精力掉到阈值以下时，人就不再维护那层得体。
 *
 * 与 ENERGY_ADVICE 的分工很清楚：ENERGY_ADVICE 说的是**篇幅**（短一点、别硬撑），
 * 这个说的是**出岔子**（记错、重复、不耐烦、懒得权衡）。前者是自觉收敛，
 * 后者是不自觉漏出来 —— 后者才让人觉得对面是个会累的活人。
 *
 * 不消费 random()：选取只用精力值与 lastUserAt 分钟数做确定性散列。
 * 单测逐条断言了 random 的消费次数，这里多掷一次就会错位。
 *
 * @param state - 当前状态。
 * @param config - 可选 `lowEnergyThreshold` 覆盖阈值。
 * @returns 提示行；精力高于阈值时返回空串。
 */
export function lowEnergyLine(state, config = {}) {
  const cfg = config ?? {};
  const threshold = cfg.lowEnergyThreshold ?? LOW_ENERGY_THRESHOLD_DEFAULT;
  const energy = Math.round(state.energy);
  if (!(energy < threshold))
    return '';
  const pick = (salt) => LOW_ENERGY_SYMPTOMS[
    Math.abs(Math.floor((state.lastUserAt || 0) / 60000) + energy * 7 + salt) % LOW_ENERGY_SYMPTOMS.length
  ];
  const core = LOW_ENERGY_SYMPTOMS.find((s) => s.id === 'debate');
  const extra = pick(0);
  const parts = [core.text];
  if (extra.id !== core.id)
    parts.push(extra.text);
  // 电量见底时再叠一条「记不清就承认」——那是最后一层也守不住的时候。
  if (energy < 15)
    parts.push(LOW_ENERGY_SYMPTOMS.find((s) => s.id === 'forget').text);
  return '- 你现在精力只有 ' + energy + '/100，已经撑不住那个周全的样子了。'
    + parts.join('；') + '。这不是让你演累，是允许你真的漏。';
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
 *
 * **生活节奏与对话密度的倍率不在这里乘**（2026-10-22）：那两个数由
 * `modules/tempo.js` 算，在 `persona.js` 的 `chance` 回调里乘上去。理由是
 * 它们需要 chatId（密度是按会话记的），而本函数拿不到 —— 与其为了传一个
 * chatId 把签名改了、把三个调用点全挑一遍，不如把乘法留在知道 chatId 的那层。
 * 本函数保持**纯**：只吃 state 和时间。
 *
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
