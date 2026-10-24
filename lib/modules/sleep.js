/**
 * dsh-onebot-companion / modules/sleep.js
 *
 * 睡意闸：她说「我去睡了」之后，群里**只有被 @ 或喊名字才回**。
 *
 * ## 背景（2026-10-18 群友反馈）
 *
 * 起因：群友反馈她每次说睡觉之后还每次都回复。会话实录：
 *
 * ```
 * 15:11:33  [云玥] <说要去睡的那句>
 * 15:12:14  [云玥] <晚安>                        ← 又回
 * 15:12:22  [云玥] 已经在躺了喵……晚安             ← 又回
 * 15:12:48  [云玥] 那我先睡啦，修好喊我喵           ← 又回
 * ```
 *
 * 10/17 18:44 也来过一次（说过晚安之后 18:49 又接话）。
 *
 * 这不是精力问题（那是另一个 bug，`persona` 拿错 chatId 导致 energy 永久 0，
 * 已修）。这是**行为连续性**问题：话说了要去睡，之后却继续逐条接，
 * 前面那句就成了空话。`silent` 规则管的是「这一条该不该接」，管不了
 * 「我刚刚才说要下线」。
 *
 * ## 双向设计（为什么还要能「醒」）
 *
 * 只说「去睡了就别回」会变成另一个毛病：半夜有人 @ 她也装死。真人是
 * 睡着了但**会被叫醒**。所以：
 *
 * - 睡意状态是**每 chat 一份**，落盘到 `sleep-state.json`（跨重启保留 ——
 *   睡前重启一次第二天就不会不睡）；
 * - 群里非 @ / 非喊名字 → 静默吞掉，**模型完全不会被调用**（省钱且不会
 *   被它自己「礼貌性回一句」带偏）；
 * - 被 @ 或喊名字 → 正常放行，并**清掉睡意**（醒了）。
 *
 * ## 落点与顺序（关键）
 *
 * 挂在 `InboundPipeline.prototype.processInbound`，优先级 **30**——比
 * `mention`(10) 与 `emoji`(10) 都靠外。原因：
 *
 * `mention` 对「喊名字 / 话题插话」命中的消息会**往 segments 里补一个 at 段**，
 * 借用上游「被 @"的语义。如果睡意闸在 `mention` 内层，那个补出来的 at 就会
 * 被当成「有人 @ 我」，于是喊一句名字就把她叫醒、插一句话更会被叫醒 —— 闸
 * 形同虚设。放在外层，判的是**用户原始 segments**，补出来的 at 还没出现。
 *
 * ## 判据为什么不是「匹配模型说了什么」
 *
 * 模型说「去睡了」的措辞无穷无尽（躺了 / 晚安 / 睡了 / 先下了 / 眯一会儿）。
 * 与其列关键词去猜**模型的输出**，不如读她自己的**情绪状态**：`persona` 的
 * `mood` 已经是 `tired` 且精力低于阈值时，她本来就该在说困。这个判据不依赖
 * 她怎么说，只看她当时什么状态。两边都留着：状态判据（低精力 + tired/困）
 * 用来**进入**睡意，硬编码的措辞表只作为「她明确说了晚安」的补充。
 *
 * 注意：`silent` 规则让她「该沉默时输出 `[[silent]]`」，而 `[[silent]]` 是
 * **模型输出**，本模块在**模型之前**就拦 —— 所以睡意期间的静默在 trace 里
 * 看得见（`reason: 'sleeping'`），不会混进 `guard.muted`。被吞的消息文本只留
 * 前 80 字进 `stats.lastSleepBlocked`，不重放给模型（那等于没拦住）。
 *
 * @module dsh-onebot-companion/modules/sleep
 */

import { auditMethods } from '../core/patch.js';
import { JsonStore, stateFilePath } from '../core/jsonstore.js';
import { describeThrown, loadTargetClass, moduleUrl } from '../core/profile.js';

/** 模块 id：出现在日志、`patched` 记录与脱链判定里。 */
export const MODULE_ID = 'sleep';

/** 挂载点：消息进入派发流程之前。 */
const TARGET = { file: 'inbound.js', exportName: 'InboundPipeline' };
const METHODS = ['processInbound'];

/** 上游判定「这条算不算 @ 她」的函数所在模块。 */
const CQ_FILE = 'cq.js';
const CQ_EXPORT = 'detectMention';

/** 她说「我要去睡了」时的措辞表（只用来补充状态判据，不单独承担识别）。 */
export const SLEEP_WORDS = [
  '晚安', '去睡', '睡了', '先睡', '睡觉了', '躺了', '先下', '下线',
  '眯一会', '眯一会儿', '困死了', '撑不住', '不早了',
];

/** 默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** **夜里**睡多久（毫秒）。默认 7 小时 —— 深夜说晚安就是真的睡了。 */
  durationMs: 7 * 60 * 60 * 1000,
  /**
   * **白天**睡多久（毫秒）。默认 1 小时。
   *
   * 2026-10-18 用户要求：「7:00~23:00 间睡 1 小时就行」。白天她说的「困了/
   * 眯一会」是真的打个盹，不是过一个通宵 —— 按夜里的 7 小时算，她下午三点
   * 说完「先睡一会儿」就会一路安静到晚上十点，那是坏掉，不是像人。
   */
  daytimeDurationMs: 60 * 60 * 1000,
  /** 白天窗口（小时，左闭右开）：落在这里用 `daytimeDurationMs`，否则用 `durationMs`。 */
  dayStartHour: 7,
  dayEndHour: 23,
  /** 进入睡意的精力阈值：低于它就认为「快要睡了」。 */
  energyThreshold: 25,
  /** 要不要用 mood/energy 状态自动进入（关掉就只看措辞）。 */
  autoByMood: true,
  /** 被叫醒后要不要记日志。 */
  logWake: true,
  /** 深夜窗口（小时，左闭右开）：只有在这个窗口里才按「困」自动进睡意。 */
  nightStartHour: 0,
  nightEndHour: 8,
};

/**
 * 一条文本里有没有「去睡了」这类说法。
 *
 * 刻意**不做否定判断**（「我不困」也算命中）：睡意闸多睡一次只是安静一整晚，
 * 少睡一次就是继续在群里刷屏 —— 两者的代价不对称。
 *
 * @param {string} text
 * @returns {string|null} 命中的词，没命中返回 null
 */
export function matchSleepWord(text) {
  if (typeof text !== 'string' || text === '') return null;
  for (const word of SLEEP_WORDS) {
    if (text.includes(word)) return word;
  }
  return null;
}

/**
 * 这一刻该不该进入睡意。
 *
 * 两条判据：① 她说的话里有「晚安 / 去睡 / 躺了」这类明确表态 —— **不看精力、
 * 不看几点**，说了就算；② 深夜（`nightStartHour`–`nightEndHour`）且精力见底
 * 且心情是困 —— 她本来就不该再聊了。
 *
 * 第二条**必须带时间窗**：2026-10-18 实测 `group:900000002` 的 `energy` 长期
 * 是 0、`mood` 是 `tired`，若白天也算，她随口回一句天气就会「进入睡意」然后
 * 整晚非 @ 全静默。白天说晚安走第一条，不受影响。
 *
 * @param {{text: string, energy: number|null, mood: string|null, hour?: number}} input
 * @param {object} cfg
 * @returns {string|null} 进入理由；null = 不进入
 */
export function sleepTrigger(input, cfg = DEFAULTS) {
  const text = typeof input?.text === 'string' ? input.text : '';
  const word = matchSleepWord(text);
  // 「晚安」这类明确表白自己要去睡的说法，不看精力也认。
  if (word !== null && ['晚安', '去睡', '睡了', '先睡', '躺了', '睡觉了'].includes(word)) {
    return `word:${word}`;
  }
  if (cfg?.autoByMood === false) return null;

  // 时间窗：只在深夜按状态进。
  const hour = typeof input?.hour === 'number' ? input.hour : null;
  if (hour === null) return null;
  const start = Number.isInteger(cfg?.nightStartHour) ? cfg.nightStartHour : DEFAULTS.nightStartHour;
  const end = Number.isInteger(cfg?.nightEndHour) ? cfg.nightEndHour : DEFAULTS.nightEndHour;
  const inNight = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  if (!inNight) return null;

  const energy = typeof input?.energy === 'number' ? input.energy : null;
  const mood = typeof input?.mood === 'string' ? input.mood : null;
  if (energy === null) return null;
  const low = energy <= (cfg?.energyThreshold ?? DEFAULTS.energyThreshold);
  if (!low) return null;
  if (mood === 'tired' || mood === 'down') return `state:${mood}/${Math.round(energy)}`;
  return null;
}

/**
 * 这一次该睡多久。
 *
 * 白天（`dayStartHour`–`dayEndHour`，默认 7–23）只打盹，用
 * `daytimeDurationMs`；其余时段按 `durationMs`。窗口写反（start > end）时
 * 当作跨零点处理，跟 `sleepTrigger` 里的夜间窗口同一套判法。
 *
 * @param {object} cfg
 * @param {number} at 进入睡意的时刻（毫秒时间戳）
 * @returns {number} 毫秒
 */
export function sleepDuration(cfg, at = Date.now()) {
  const night = Number(cfg?.durationMs) > 0 ? Number(cfg.durationMs) : DEFAULTS.durationMs;
  const day = Number(cfg?.daytimeDurationMs) > 0
    ? Number(cfg.daytimeDurationMs)
    : DEFAULTS.daytimeDurationMs;
  const start = Number.isInteger(cfg?.dayStartHour) ? cfg.dayStartHour : DEFAULTS.dayStartHour;
  const end = Number.isInteger(cfg?.dayEndHour) ? cfg.dayEndHour : DEFAULTS.dayEndHour;
  const hour = new Date(at).getHours();
  const inDay = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
  return inDay ? day : night;
}

/**
 * 睡意状态表。key 是 chatId，value 是 `{ until, reason, at }`。
 *
 * 为什么落盘：她睡前若发生一次热重载 / DSH 重启，内存里的睡意就清零了，
 * 第二天（其实还是同一晚）她就会重新在群里说话。`mood-state.json` 那套
 * debounce + 原子替换的范式直接复用。
 */
export function createSleepState() {
  /** @type {Map<string, {until:number, reason:string, at:number}>} */
  const table = new Map();
  return {
    get: (chatId) => table.get(String(chatId ?? '')),
    set: (chatId, value) => table.set(String(chatId ?? ''), value),
    delete: (chatId) => table.delete(String(chatId ?? '')),
    clear: () => table.clear(),
    size: () => table.size,
    /** 导出成可落盘的对象。 */
    toObject: () => Object.fromEntries(table),
    /** 从盘上读回；坏数据一律跳过。 */
    fromObject: (obj) => {
      table.clear();
      if (obj === null || typeof obj !== 'object') return;
      for (const [key, value] of Object.entries(obj)) {
        const until = Number(value?.until);
        if (!Number.isFinite(until) || until <= 0) continue;
        table.set(key, {
          until,
          reason: typeof value?.reason === 'string' ? value.reason : 'restored',
          at: Number(value?.at) || 0,
        });
      }
    },
  };
}

/**
 * 这一条能不能穿过去。
 *
 * @param {object} inbound 上游规范化后的入站对象（有 chatId / kind / segments / text）
 * @param {object} entry 睡意记录
 * @param {number} now
 * @param {(segments:any[], raw:string, learned:string, configured:string) => boolean} detectMention
 * @param {string[]} names 她的名字
 * @param {{learned:string, configured:string}} ids
 * @returns {{pass: boolean, reason: string}}
 */
export function judgeSleep(inbound, entry, now, detectMention, names, ids) {
  if (entry === undefined || entry === null) return { pass: true, reason: 'no-entry' };
  if (!(now < entry.until)) return { pass: true, reason: 'expired' };

  // 私聊永远放行：只跟她一个人说话时不适用「群里别刷屏」的约束。
  if (inbound?.kind !== 'group') return { pass: true, reason: 'private' };

  // 判据一：用户**原始** segments 里有没有真的 @ 她。
  // 注意用原始 segments —— 本模块挂在外层，此刻 mention 的补 at 还没发生。
  if (typeof detectMention === 'function') {
    try {
      const mentioned = detectMention(
        inbound?.segments, inbound?.raw, ids?.learned ?? '', ids?.configured ?? '',
      ) === true;
      if (mentioned) return { pass: true, reason: 'mentioned' };
    } catch {
      // 判定器炸了就按「没被叫」处理（继续睡）—— 宁可多沉默。
    }
  }

  // 判据二：正文里喊了她的名字。
  const text = typeof inbound?.text === 'string' ? inbound.text : '';
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name === 'string' && name !== '' && text.includes(name)) {
      return { pass: true, reason: `name:${name}` };
    }
  }

  return { pass: false, reason: 'sleeping' };
}

/**
 * 造 `processInbound` 的包装层。
 *
 * @param {object} options
 * @param {Function} options.original 上游原方法
 * @param {object} options.cfg 本模块配置
 * @param {object} options.state 共享可变状态（含 detectMention / names / ids）
 * @param {object} options.table 睡意状态表
 * @param {object} options.stats 共享统计
 * @param {(level:string, message:string)=>void} options.log
 * @param {() => number} [options.now]
 * @returns {Function}
 */
export function makeSleepProcessInbound({
  original, cfg, state, table, stats, log, now = Date.now,
}) {
  return function companionSleepProcessInbound(inbound) {
    const self = this;

    // 睡意闸必须**同步决定、立即返回**：吞掉的消息根本不该进入异步派发，
    // 否则 rhythm 的合并窗口会等它，反而拖慢下一条真消息。
    try {
      if (cfg?.enabled !== false) {
        const chatId = String(inbound?.chatId ?? '');
        if (chatId !== '') {
          const at = now();
          const entry = table.get(chatId);
          if (entry !== undefined && !(at < entry.until)) {
            // 过期了，顺手清掉，免得表越攒越大。
            table.delete(chatId);
          } else {
            const verdict = judgeSleep(
              inbound, entry, at, state.detectMention, state.names, state.ids,
            );
            if (!verdict.pass) {
              stats.sleepBlocked = (stats.sleepBlocked ?? 0) + 1;
              stats.lastSleepBlocked = {
                at, chatId, reason: verdict.reason,
                text: typeof inbound?.text === 'string' ? inbound.text.slice(0, 80) : '',
              };
              return undefined;
            }
            if (entry !== undefined) {
              // 被叫醒了 —— 睡意作废，之后正常说话。
              table.delete(chatId);
              stats.sleepWoke = (stats.sleepWoke ?? 0) + 1;
              stats.lastSleepWoke = { at, chatId, reason: verdict.reason };
              if (cfg?.logWake !== false) {
                log('info', `sleep: ${chatId} 被叫醒（${verdict.reason}）`);
              }
            }
          }
        }
      }
    } catch (error) {
      // 闸本身出错就放行 —— 宁可多说一句话，也不能把消息卡死。
      stats.lastError = describeThrown(error);
      log('warn', `sleep: 闸门异常，按原流程放行: ${describeThrown(error)}`);
    }

    return original.call(self, inbound);
  };
}

/**
 * 创建 sleep 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - sleep 段配置。
 * @param {object} options.stats - 共享统计对象。
 * @param {Function} options.patchMethod - 来自 core/patch 的挂载器。
 * @param {(level:string, message:string)=>void} options.log
 * @param {() => string} [options.getMediaDir] - 状态文件目录（通常就是 .dsh-media）。
 * @param {() => object|null} [options.moodOf] - 读某 chat 的 `{ energy, mood }`。
 * @param {() => object|null} [options.lastReceiver] - 拿 bridge 实例（读 config / selfId）。
 */
export function createSleep({
  cfg, stats, patchMethod, log, getMediaDir, moodOf, lastReceiver, getNames,
}) {
  const table = createSleepState();

  /**
   * 上游 `detectMention` 与她的名字/QQ 号 —— 与 `emoji` 的 `state.faceToEmoji`
   * 同样的理由：`makeWrapper` 必须是纯函数，第一轮扫描拿不到的东西不能闭包进
   * 包装层，必须每次调用时从 state 现读。
   */
  const state = { detectMention: null, names: [], ids: { learned: '', configured: '' } };

  let store = null;
  let storeDir = '';

  /** 首次扫码时把落盘的睡意读回来。 */
  function ensureStore(dir) {
    if (typeof dir !== 'string' || dir === '') return;
    if (store !== null && dir === storeDir) return;
    storeDir = dir;
    store = new JsonStore({
      file: stateFilePath(dir, 'sleep-state.json'),
      log,
      label: `${MODULE_ID}-state`,
      normalize: (value) =>
        value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
    });
    void store
      .load()
      .then(() => table.fromObject(store.get('sleep')))
      .catch(() => undefined);
  }

  /** 写盘（debounce，见 core/jsonstore.js 的约定）。 */
  function persist() {
    if (store === null) return;
    try {
      store.set('sleep', table.toObject());
      store.saveDebounced();
    } catch {
      /* 落盘失败不影响闸本身 */
    }
  }

  /**
   * 她说了一句可能要去睡的话 —— 由 persona 在记录 assistant 消息时调用。
   *
   * 为什么从 persona 那侧推：睡意的两个来源（措辞 / 情绪状态）都在那边现成，
   * 本模块只负责「记住并执行」。这样两模块之间只有这一条单向调用，不互相 patch。
   *
   * @param {string} chatId
   * @param {string} text 她这一轮说的话（纯文本）
   * @param {Date} [now]
   * @returns {boolean} 是否进入了睡意
   */
  function noteSaid(chatId, text, at = Date.now()) {
    if (cfg?.enabled === false) return false;
    const key = String(chatId ?? '');
    if (key === '') return false;
    const mood = typeof moodOf === 'function' ? moodOf(key) : null;
    const reason = sleepTrigger(
      {
        text,
        energy: mood?.energy ?? null,
        mood: mood?.mood ?? null,
        hour: new Date(at).getHours(),
      },
      cfg,
    );
    if (reason === null) return false;
    const duration = sleepDuration(cfg, at);
    table.set(key, { until: at + duration, reason, at });
    stats.sleepEntered = (stats.sleepEntered ?? 0) + 1;
    stats.lastSleepEntered = { at, chatId: key, reason };
    persist();
    log('info', `sleep: ${key} 进入睡意（${reason}，${Math.round(duration / 60000)} 分钟）`);
    return true;
  }

  /** 手动叫醒（诊断 / 运维用）。 */
  function wake(chatId) {
    const key = String(chatId ?? '');
    const existed = table.delete(key);
    if (existed) persist();
    return existed;
  }

  /** 状态快照（`/status` 与 `/mood` 共用）。 */
  function snapshot(at = Date.now()) {
    const out = {};
    for (const [chatId, entry] of Object.entries(table.toObject())) {
      if (!(at < entry.until)) continue;
      out[chatId] = {
        until: new Date(entry.until).toISOString(),
        remainingMs: Math.max(0, entry.until - at),
        reason: entry.reason,
      };
    }
    return out;
  }

  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.sleepEnabled = cfg?.enabled !== false;

    if (cfg?.enabled === false) {
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    // 状态文件目录一般要等 bridge 起来才知道；拿不到就退化成纯内存。
    try {
      const dir = typeof getMediaDir === 'function' ? getMediaDir() : '';
      if (typeof dir === 'string' && dir !== '') ensureStore(dir);
    } catch {
      /* ignore */
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.sleepResolveError = found.error;
      return { ok: false, error: found.error };
    }
    stats.sleepProfileDir = found.profileDir;
    stats.sleepResolveError = null;

    // 喊名字的判据：直接用 mention 模块那份配置（`names`），不从 bridge 猜。
    // 两处各自维护一份名字表，早晚会漂 —— 2026-10-18 这里第一次写就猜错了
    // 键名（bridge 上没有 `mentionNames`）。
    try {
      const names = typeof getNames === 'function' ? getNames() : [];
      state.names = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n !== '') : [];
    } catch {
      state.names = [];
    }

    // 上游 `detectMention`：拿得到就多一条「被 @」判据，拿不到退化成只认名字。
    try {
      const url = moduleUrl(ctx, cfg, CQ_FILE);
      const mod = url === null ? null : await import(url);
      const fn = mod?.[CQ_EXPORT];
      state.detectMention = typeof fn === 'function' ? fn : null;
    } catch {
      state.detectMention = null;
    }

    // 身份号：`selfId()` 是学到的，`config.botQQ` 是配置的，两个都给上游判定器。
    try {
      const receiver = typeof lastReceiver === 'function' ? lastReceiver() : null;
      const bridgeCtx = receiver?.ctx ?? null;
      const learned = typeof bridgeCtx?.selfId === 'function' ? String(bridgeCtx.selfId() ?? '') : '';
      state.ids = { learned, configured: String(bridgeCtx?.config?.botQQ ?? '') };
    } catch {
      state.ids = { learned: '', configured: '' };
    }

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;
    if (patchMethod(proto, 'processInbound', MODULE_ID, (original) =>
      makeSleepProcessInbound({ original, cfg, state, table, stats, log }), rel)) {
      patched += 1;
    }

    return { ok: true, patched };
  }

  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  return {
    MODULE_ID, scan, detach, state, table, noteSaid, wake, snapshot, METHODS, TARGET, DEFAULTS,
  };
}
