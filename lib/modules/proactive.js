/**
 * 随机驱动的主动发言调度器（M7 proactive）。
 *
 * 用户原话（m10154）：「定时还是算了，你还不如搞个随机变量」——
 * 所以这里**没有 cron、没有固定时刻**，只有两处随机变量：
 *   1. nextDelayMs()：两次评估之间的间隔是 [min, max] 分钟区间内的一个随机值；
 *   2. evaluate()：对每个候选 chat 掷一次概率门（random() < chance(chat)）。
 *
 * 本模块**零 import**（不引 node 内建、不引 @deepseek-ai/*、不引同目录文件），
 * 以便离线单测用裸 node.exe 直接 import（见 _diag/proactive-test.mjs）；
 * 不读写文件、不打印、不调网络——时间 / 随机数 / 计时器 / 日志全部由 deps 注入。
 * @module dsh-onebot/proactive
 */

/** 随机间隔下限默认值（分钟）。 */
export const PROACTIVE_MIN_MINUTES_DEFAULT = 25;
/** 随机间隔上限默认值（分钟）。 */
export const PROACTIVE_MAX_MINUTES_DEFAULT = 150;
/** 对方静默多久才允许主动搭话的默认值（分钟）。 */
export const PROACTIVE_IDLE_MINUTES_DEFAULT = 20;

/** 每分钟的毫秒数。 */
const MS_PER_MINUTE = 60_000;

/** 取一个有限数字，否则用兜底值（配置缺键 / 被写成字符串时不让调度器炸掉）。 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 把小时数规范到 [0, 24)。 */
function normalizeHour(value) {
  const hour = Math.trunc(numberOr(value, 0));
  return ((hour % 24) + 24) % 24;
}

/**
 * 某个本地小时是否落在安静时段内。
 * 支持跨零点（start=23、end=8 → 23:00..07:59 都算安静）；start === end 视为空区间。
 */
function inQuietHours(hour, start, end) {
  const from = normalizeHour(start);
  const to = normalizeHour(end);
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** 本地日期键 YYYY-MM-DD：每日配额按这个分桶。 */
function localDayKey(t) {
  const date = new Date(t);
  const pad = (value) => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/** 把抛出的任意值描述成一行文本（不引 errors.js，保持零 import）。 */
function describeThrown(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * 主动发言调度器：start() 之后只排一次随机间隔的计时器，之后每轮评估自行续排。
 * 一轮最多 fire 一个 chat，且只挑静默最久的那个。
 */
export class ProactiveScheduler {
  constructor(deps) {
    const source = deps ?? {};
    this.deps = source;
    this.config = source.config ?? {};
    this.log = typeof source.log === 'function' ? source.log : () => {};
    this.isStopping = typeof source.isStopping === 'function' ? source.isStopping : () => false;
    this.listChats = typeof source.listChats === 'function' ? source.listChats : () => [];
    this.eligible = typeof source.eligible === 'function' ? source.eligible : () => false;
    this.idleMs = typeof source.idleMs === 'function' ? source.idleMs : () => 0;
    this.chance = typeof source.chance === 'function' ? source.chance : () => 0;
    this.fire = typeof source.fire === 'function' ? source.fire : async () => {};
    this.random = typeof source.random === 'function' ? source.random : Math.random;
    this.now = typeof source.now === 'function' ? source.now : Date.now;
    this.setTimer = typeof source.setTimer === 'function' ? source.setTimer : setTimeout;
    this.clearTimer = typeof source.clearTimer === 'function' ? source.clearTimer : clearTimeout;
    this.running = false;
    this.timer = undefined;
    /** 本轮计划等待时长；evaluate() 把它原样放进 info.delayMs。 */
    this.delayMs = 0;
    /** chatId → 最近一次有动静的时刻（noteActivity 记录，供 bridge 的 idleMs 参考）。 */
    this.recentActivity = new Map();
    /** chatId → { dayKey, count }：每日主动发言配额。 */
    this.counts = new Map();
  }

  /** 启动调度。已启动时 no-op；proactiveEnabled === false 时直接不启动。 */
  start() {
    if (this.config.proactiveEnabled === false) {
      this.log('info', 'proactive scheduler disabled');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.schedule();
    this.log('info', 'proactive scheduler started (gap '
      + numberOr(this.config.proactiveMinMinutes, PROACTIVE_MIN_MINUTES_DEFAULT) + '-'
      + numberOr(this.config.proactiveMaxMinutes, PROACTIVE_MAX_MINUTES_DEFAULT) + 'min)');
  }

  /** 停止调度：清掉待触发的计时器。可重复调用。 */
  stop() {
    if (!this.running) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.running = false;
    this.log('info', 'proactive scheduler stopped');
  }

  /**
   * 排下一次评估：间隔完全随机（见 nextDelayMs），没有任何固定时刻。
   * 计时器句柄若有 unref 就调用，免得把宿主进程钉住；unref 失败不影响调度。
   */
  schedule() {
    // 停机后不再续排：evaluate() 在途时被 stop() 打断也不会留下僵尸计时器。
    if (!this.running) return;
    const delay = this.nextDelayMs();
    this.delayMs = delay;
    const timer = this.setTimer(() => {
      void this.evaluate().then(
        () => this.schedule(),
        (error) => {
          this.log('warn', 'proactive evaluate failed: ' + describeThrown(error));
          this.schedule();
        },
      );
    }, delay);
    this.timer = timer;
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') {
      try {
        timer.unref();
      } catch {
        // unref 只是省电优化，失败不影响调度
      }
    }
  }

  /**
   * 记录某 chat 刚刚有动静：取消当前待触发的那一次评估并重新随机排程，
   * 这样「刚聊完」不会被马上主动搭话。未启动时只记 Map，不排程。
   */
  noteActivity(chatId) {
    this.recentActivity.set(chatId, this.now());
    if (!this.running) return;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.schedule();
  }

  /**
   * 纯计算：下一次评估的随机间隔（毫秒）。
   * 消费**恰好一次** random()；maxMs < minMs 时自动交换。
   */
  nextDelayMs() {
    const minMs = numberOr(this.config.proactiveMinMinutes, PROACTIVE_MIN_MINUTES_DEFAULT) * MS_PER_MINUTE;
    const maxMs = numberOr(this.config.proactiveMaxMinutes, PROACTIVE_MAX_MINUTES_DEFAULT) * MS_PER_MINUTE;
    const low = Math.min(minMs, maxMs);
    const high = Math.max(minMs, maxMs);
    return low + this.random() * (high - low);
  }

  /**
   * 立即评估一轮，返回被 fire 的 chatId 数组（未命中返回 []）。
   *
   * 随机数消费顺序（测试依赖）：安静时段 0 次；否则按 listChats() 的顺序，
   * 只对通过静态过滤（busy / 不 eligible / 静默不足 / 当日超额）的 chat 各掷一次门。
   */
  async evaluate() {
    if (this.isStopping()) return [];
    const t = this.now();
    const hour = new Date(t).getHours();
    const quietStart = numberOr(this.config.proactiveQuietStart, 1);
    const quietEnd = numberOr(this.config.proactiveQuietEnd, 8);
    if (inQuietHours(hour, quietStart, quietEnd)) {
      this.log('debug', 'proactive skipped: quiet hours ' + quietStart + '-' + quietEnd + ' (now ' + hour + ':00)');
      return [];
    }

    const idleThresholdMs = numberOr(this.config.proactiveIdleMinutes, PROACTIVE_IDLE_MINUTES_DEFAULT) * MS_PER_MINUTE;
    const maxPerDay = numberOr(this.config.proactiveMaxPerDay, 6);
    const dayKey = localDayKey(t);
    const list = this.listChats();
    const chats = Array.isArray(list) ? [...list] : [];

    const hits = [];
    for (const chat of chats) {
      if (chat === null || typeof chat !== 'object') continue;
      if (chat.busy === true) continue;
      if (this.eligible(chat) !== true) continue;
      const idle = this.idleMs(chat, t);
      if (!Number.isFinite(idle) || idle < idleThresholdMs) continue;
      if (this.quotaUsed(chat.chatId, dayKey) >= maxPerDay) continue;
      const gate = numberOr(this.chance(chat), 0);
      if (this.random() < gate) hits.push({ chat, chatId: chat.chatId, idle, chance: gate });
    }
    if (hits.length === 0) return [];

    // 一轮最多 fire 一个：静默最久的优先（同分时保持 listChats() 的先后）
    hits.sort((a, b) => b.idle - a.idle);
    const chosen = hits[0];
    this.quotaAdd(chosen.chatId, dayKey);
    this.log('info', 'proactive → ' + chosen.chatId + ' (idle ' + Math.round(chosen.idle / MS_PER_MINUTE)
      + 'min, chance ' + chosen.chance.toFixed(2) + ')');
    try {
      await this.fire(chosen.chat, {
        delayMs: Number.isFinite(this.delayMs) ? this.delayMs : 0,
        idleMs: chosen.idle,
        chance: chosen.chance,
      });
    } catch (error) {
      // 主动搭话失败绝不能带走调度器
      this.log('warn', 'proactive fire failed for ' + chosen.chatId + ': ' + describeThrown(error));
    }
    return [chosen.chatId];
  }

  /** 某 chat 当日已用的主动发言次数；跨日自动视为 0。 */
  quotaUsed(chatId, dayKey) {
    const entry = this.counts.get(chatId);
    if (entry === undefined || entry.dayKey !== dayKey) return 0;
    return entry.count;
  }

  /** 记一次主动发言；跨日重新开桶。 */
  quotaAdd(chatId, dayKey) {
    const entry = this.counts.get(chatId);
    if (entry === undefined || entry.dayKey !== dayKey) {
      this.counts.set(chatId, { dayKey, count: 1 });
      return;
    }
    entry.count += 1;
  }
}
