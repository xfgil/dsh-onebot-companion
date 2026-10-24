/**
 * dsh-onebot-companion / modules/stamp.js
 *
 * 给 `<user_message>` 边界补回 `time=` / `gap=` 两个属性。
 *
 * ## 为什么需要（这不是新功能，是补回被升级冲掉的东西）
 *
 * 2026-10-08 在私有分支里给 `dsh-onebot-qq` 加过这两个属性
 * （`_yy_privfork/inbound.edits.txt` EDIT 3~9 + `chat.edits.txt` EDIT 3~5）：
 *
 *   - `time="2026-10-08T15:15:23+08:00"` —— 对方**按下发送**的时刻；
 *   - `gap="15h35m"` —— 距他上一条消息隔了多久，**已经算好**。
 *
 * 加 `gap` 的理由写在当年 `formatElapsed` 的注释里，值得原样保留：
 * **模型不会可靠地做两个时间戳的减法**。15:14 那次实测就是它把「两小时」说成
 * 「过了一整天」。把已经算好的间隔直接递过去，等于把那道算术从模型手里拿走。
 * 而 `time` 的作用是让**每个**块都带时钟（而不是只在一段周期旁白里），这样模型
 * 扫一眼就能看出对方多久没来。
 *
 * 0.9.0 升级把 `chat.js#wrapUserMessage` 的第 4、5 个参数整个删了，签名退回
 * `(content, userId, nickname)` —— 全库搜 `gap=` / `formatElapsed` 是 0 命中。
 * 手改 node_modules 正是被冲掉的那套做法，所以这次从外面挂。
 *
 * ## 挂载点与顺序（有个必须踩对的顺序）
 *
 * 挂 `ChatBridge` 的两个原型方法：
 *
 *   1. `handleInbound(event, opts)`（`lib/bridge.js:311`）—— 只**记账**：把
 *      OneBot 事件的 `time`（unix 秒）连同它属于哪个 chat 记下来。事件对象里有
 *      `message_type` / `user_id` / `group_id`，chatId 用上游自己的
 *      `chat.js#buildChatId` 推 —— **不复刻那个拼法**。
 *   2. `dispatchFollowup(chatId, text, role, nickname)`（`lib/bridge.js:375`）——
 *      入站管线唯一的门禁后出口（`inbound.js:208`）；在这里把属性写进文本。
 *
 * `dispatchFollowup` 已被 rhythm 挂着（入站合并）。`core/patch.js` 的
 * `patchMethod` 是**后挂的在外层**，所以本模块必须排在 `scanAll()` 里 rhythm
 * **之后**（见 index.js）：这样每条消息各自单独经过本模块（各自注入自己那一刻的
 * time/gap），再由 rhythm 把已注入的几条合并成一批。换过来（本模块在内层）只会
 * 在合并后拿到一整批文本，只能贴一个时间。
 *
 * ## 两个 Map，语义必须分开
 *
 *   - `seenAt`：`handleInbound` 写入，**每次入站都覆盖**（包括后来被门禁吞掉的
 *     未 @ 消息、去重、限流、命令）——它只回答「这个 chat 最近一次入站是什么时候」。
 *   - `baseline`：`dispatchFollowup` **注入成功后**才写，是 `gap` 的基线 —— 只
 *     对真正到达模型的消息推进，命令回执之类的投递不污染它。
 *
 * 合并成一个 Map 会让 gap 变成「距上一条入站消息」（含被吞掉的），与当年
 * `gapFor` 的语义不符。
 *
 * ## 时间基准的取法（以及为什么不怕「被门禁吞掉的消息」）
 *
 * 读的是 `seenAt`：`handleInbound` 刚记下的那条消息自己的时刻。同刻并发多条时
 * 后一条会覆盖前一条，差几秒 —— 可接受。真要精确到 messageId 做不到：
 * `dispatchFollowup` 的签名里没有 messageId，硬凑一个「队列 + 按块数弹出」的
 * 对应关系只会因为「进了 handleInbound 却没走到 dispatch」而整体错位。
 *
 * `baseline` **落盘**（`stamp-state.json`，与当年 `inbound-state.js` 同一范式）：
 * 当年不落盘的教训是宿主一重启基线就空，重启后第一条只能省略 gap，模型随即去读
 * time-context 旁白里的 Elapsed 行，把「两小时」说成「过了一整天」。
 *
 * ## 边界安全
 *
 * `time` / `gap` 的值由本模块生成（框架侧），但注入前仍按当年的字母表重过滤
 * 一遍（`[^0-9T:+-]` / `[^0-9dhms]`），保证它永远不可能闭合标签、也永远不可能
 * 从 `<user_message>` 边界里逃出去。文本改写只动**开标签**，块内内容一字不碰。
 *
 * 已知未补回的一处：群消息前缀 `[HH:MM 昵称(QQ)]` 当年也改成用发送时刻了
 * （`chat.edits.txt` EDIT 4），本模块不动它 —— 它用的是处理时刻，与 `time`
 * 属性只差几秒，而改写群前缀要啃昵称里的方括号，不划算。
 *
 * @module dsh-onebot-companion/modules/stamp
 */

import { JsonStore, stateFilePath } from '../core/jsonstore.js';
import { auditMethods, MODULE as MODULE_TAG } from '../core/patch.js';
import { describeThrown, loadTargetClass, moduleUrl } from '../core/profile.js';

export const MODULE_ID = 'stamp';

/** 挂载点。 */
const TARGET = { file: 'bridge.js', exportName: 'ChatBridge' };
const METHODS = ['handleInbound', 'dispatchFollowup'];

/** chatId 推导用的上游模块与导出（绝不自己复刻拼法）。 */
const CHAT_FILE = 'chat.js';
const CHAT_EXPORT = 'buildChatId';

/** 只匹配 `<user_message ...>` 开标签；块内内容不碰。 */
const OPEN_TAG_RE = /<user_message\b([^>]*)>/;

/**
 * 基线最多记多少个 chat —— 逐字沿用当年 `inbound-state.js` 的 `MAX_CHATS = 500`。
 *
 * 没有这道闸，`stamp-state.json` 会随「这辈子收过消息的 chat 数」单调增长，
 * 而每个条目只在对方**下一次来消息**时才有用。500 个不同 chat 对个人 bot 是
 * 天文数字，真撞上时淘汰最久没来消息的那些，代价只是那个 chat 丢一次 gap。
 */
const MAX_CHATS = 500;

/**
 * 淘汰最久没来消息的 chat，直到回到 `MAX_CHATS` 以内。
 *
 * 抽成模块级纯函数（不闭包在 `createStamp` 里）是为了**能被直接单测** ——
 * 这条路径要 500 条以上才触发，靠真实聊天永远等不到，不给它一个入口就等于
 * 没验证过。
 *
 * **按 `lastAt` 的值挑，不靠 `Map` 的插入序**：落盘文件里的键序是上一次写的
 * 顺序，与时间新旧无关（手工编辑过、或换过时钟都会乱）；按值挑才对得上
 * 「淘汰最不可能再用的那条」这个意图。
 *
 * `keep`（本次刚记下的 chat）永不淘汰 —— 缺基线就少一次 gap，而它是最可能
 * 马上要用的那一条。`store` 可以没有（`mediaDir` 没配）：那时只淘汰内存。
 *
 * @param {Map<string, number>} baseline - 内存基线表，原地删改。
 * @param {{keys(): string[], get(k): any, forget(k): void}} [store] - 落盘仓库。
 * @param {string} keep - 永不淘汰的 chatId。
 * @returns {number} 实际淘汰的条数（0 表示没到上限）。
 */
export function evictOldest(baseline, store, keep) {
  const keys = new Set(baseline.keys());
  if (store !== undefined && store !== null) {
    for (const key of store.keys()) keys.add(key);
  }
  const excess = keys.size - MAX_CHATS;
  if (excess <= 0) return 0;

  const atOf = (key) => {
    const fromMemory = baseline.get(key);
    if (typeof fromMemory === 'number') return fromMemory;
    const entry = store?.get(key);
    return typeof entry?.lastAt === 'number' ? entry.lastAt : 0;
  };

  const ordered = [...keys].sort((a, b) => atOf(a) - atOf(b));
  let removed = 0;
  for (const key of ordered) {
    if (removed >= excess) break;
    if (key === keep) continue;
    baseline.delete(key);
    store?.forget(key);
    removed += 1;
  }
  return removed;
}

/** 上限值本身也导出，供自测断言与文档引用（避免测试里硬编码 500 漂移）。 */
export const MAX_CHAT_BASELINES = MAX_CHATS;

/**
 * 把一个时刻格式化成边界用的紧凑本地时间戳：`2026-10-08T15:15:23+08:00`。
 *
 * 逐字来自当年的 `chat.js#formatMessageTime`（`_yy_privfork/chat.edits.txt`
 * EDIT 5）。保留秒：同一分钟内的两条消息也要能排序、能被可靠相减。
 * 输入不可用时返回 `''`，调用方据此整个省略属性 —— 宁可没有，也不印一个错的钟。
 *
 * @param {Date|number} when - Date、epoch 毫秒，或不传（取当前）。
 * @returns {string} 本地 ISO 形状的时间戳，或 `''`。
 */
export function formatMessageTime(when) {
  const date = when instanceof Date ? when : new Date(when ?? Date.now());
  const epoch = date.getTime();
  if (!Number.isFinite(epoch)) return '';
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes()) +
    ':' +
    pad(date.getSeconds()) +
    sign +
    pad(Math.floor(absolute / 60)) +
    ':' +
    pad(absolute % 60)
  );
}

/**
 * 把非负毫秒间隔说成紧凑、**不含空格**的时长：`47s` / `3m47s` / `15h35m` / `2d4h`。
 *
 * 逐字来自当年的 `chat.js#formatElapsed`（`_yy_privfork/chat.edits.txt` EDIT 5）。
 * 不含空格是为了让这个值原样穿过边界属性的字符白名单；只取整单位、最多两个
 * 有效位，是为了短到一眼能读完。输入不可用返回 `''`。
 *
 * @param {number} elapsedMs - 间隔毫秒数。
 * @returns {string} 紧凑时长，或 `''`。
 */
export function formatElapsed(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return '';
  let seconds = Math.floor(elapsedMs / 1000);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days > 0) {
    parts.push(days + 'd');
    if (hours > 0) parts.push(hours + 'h');
  } else if (hours > 0) {
    parts.push(hours + 'h');
    if (minutes > 0) parts.push(minutes + 'm');
  } else if (minutes > 0) {
    parts.push(minutes + 'm');
    if (seconds > 0) parts.push(seconds + 's');
  } else {
    parts.push(seconds + 's');
  }
  return parts.join('');
}

/** 当年那套字符白名单：时间戳只留数字与 `T:+-`。 */
export function safeTimeValue(raw) {
  return typeof raw === 'string' ? raw.replace(/[^0-9T:+-]/g, '') : '';
}

/** gap 只留数字与 `dhms`。 */
export function safeGapValue(raw) {
  return typeof raw === 'string' ? raw.replace(/[^0-9dhms]/g, '') : '';
}

/**
 * 把 `time` / `gap` 写进文本里**第一个** `<user_message>` 开标签。
 *
 * 已存在的同名属性先摘掉再写（重复注入 / 热重载重入都不会堆出两个 `time=`）。
 * 两个值都为空、或文本里根本没有这个标签时原样返回 —— 调用方据此判断这条投递
 * 是不是入站消息，从而决定要不要动 gap 基线。
 *
 * @param {string} text
 * @param {{time?: string, gap?: string}} attrs
 * @returns {string}
 */
export function injectStamp(text, attrs = {}) {
  if (typeof text !== 'string' || text === '') return text;
  const time = safeTimeValue(attrs.time);
  const gap = safeGapValue(attrs.gap);
  if (time === '' && gap === '') return text;
  if (!OPEN_TAG_RE.test(text)) return text;
  return text.replace(OPEN_TAG_RE, (_full, rawAttrs) => {
    const kept = String(rawAttrs)
      .replace(/\s+time="[^"]*"/g, '')
      .replace(/\s+gap="[^"]*"/g, '');
    const stamp = (time === '' ? '' : ` time="${time}"`) + (gap === '' ? '' : ` gap="${gap}"`);
    return `<user_message${kept}${stamp}>`;
  });
}

/**
 * 从 OneBot 事件取「发送时刻」。
 *
 * `time` 是 unix **秒**。只在它像样的时候才认（2001..2286 年），否则退回当前
 * 时刻 —— 一个坏值绝不该给消息盖上胡说八道的钟。逐字来自当年
 * `inbound.edits.txt` EDIT 2 的判断。
 *
 * @param {object} event - OneBot 事件。
 * @returns {Date}
 */
export function sentAtOf(event) {
  const raw = typeof event?.time === 'number' ? event.time : Number(event?.time);
  if (Number.isFinite(raw) && raw >= 1e9 && raw <= 1e10) return new Date(raw * 1000);
  return new Date();
}

/**
 * 由 OneBot 事件推 chatId。
 *
 * **必须**用上游自己的 `buildChatId`（由 `scan` 取到后闭包传进来）——复刻那个
 * 拼法就是在埋「上游改了规则而我们还按老规则算」的坑，算错的后果是把时刻记到
 * 别的 chat 名下。事件形状不合法时返回 `null`。
 *
 * @param {object} event
 * @param {(kind: string, target: string) => string} buildChatId
 * @returns {string|null}
 */
export function chatIdOfEvent(event, buildChatId) {
  const kind = event?.message_type;
  if (kind !== 'group' && kind !== 'private') return null;
  const target = kind === 'group' ? event?.group_id : event?.user_id;
  if (target === undefined || target === null || target === '') return null;
  try {
    return String(buildChatId(kind, String(target)));
  } catch {
    return null;
  }
}

/**
 * 造 `handleInbound` 的包装（纯记账，入站流程一字不改）。
 *
 * 抽成独立工厂是为了可测（自测不必复刻这段逻辑）。
 *
 * @param {object} options
 * @param {Function} options.original
 * @param {object} options.cfg
 * @param {Map<string, number>} options.seenAt
 * @param {(kind: string, target: string) => string} options.buildChatId
 * @param {object} options.stats
 * @param {Function} options.log
 * @returns {Function}
 */
export function makeStampHandleInbound({ original, cfg, seenAt, buildChatId, stats, log }) {
  return function companionStampHandleInbound(event, opts) {
    try {
      if (cfg.enabled !== false) {
        const chatId = chatIdOfEvent(event, buildChatId);
        if (chatId !== null) {
          const at = sentAtOf(event).getTime();
          if (Number.isFinite(at)) seenAt.set(chatId, at);
        }
      }
    } catch (error) {
      // 记账失败绝不能影响入站流程。
      stats.lastError = describeThrown(error);
      log('warn', `入站时刻记账失败: ${describeThrown(error)}`);
    }
    return original.call(this, event, opts);
  };
}

/**
 * 造 `dispatchFollowup` 的包装（把属性写进文本）。
 *
 * @param {object} options
 * @param {Function} options.original
 * @param {object} options.cfg
 * @param {Map<string, number>} options.seenAt
 * @param {(receiver: object, chatId: string) => number|undefined} options.previousFor
 * @param {(receiver: object, chatId: string, at: number) => void} options.remember
 * @param {(receiver: object, chatId: string, text: string, nowMs: number) => {text: string, time: string, gap: string}|null} options.apply
 * @param {object} options.stats
 * @param {Function} options.log
 * @returns {Function}
 */
export function makeStampDispatchFollowup({ original, cfg, seenAt, apply, stats, log }) {
  return function companionStampDispatchFollowup(chatId, text, role, nickname) {
    try {
      if (cfg.enabled !== false && typeof text === 'string' && text.includes('<user_message')) {
        const seen = seenAt.get(chatId);
        const at = typeof seen === 'number' ? seen : Date.now();
        const result = apply(this, chatId, text, at);
        if (result !== null && result.text !== text) {
          stats.stamped += 1;
          stats.lastStampAt = Date.now();
          stats.lastStampKind = 'stamped';
          stats.lastStampChat = chatId;
          stats.lastStampTime = result.time || null;
          stats.lastStampGap = result.gap || null;
          if (cfg.logStamps === true) {
            log('info', `时刻注入 ${chatId}：time=${result.time} gap=${result.gap || '（无基线）'}`);
          }
          return original.call(this, chatId, result.text, role, nickname);
        }
      }
    } catch (error) {
      // 注入失败按原文投递，一个字都不能丢。
      stats.lastError = describeThrown(error);
      log('warn', `时刻注入失败，按原文投递: ${describeThrown(error)}`);
    }
    return original.call(this, chatId, text, role, nickname);
  };
}

/**
 * 创建 stamp 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - stamp 段配置。
 * @param {object} options.stats - 共享统计。
 * @param {Function} options.patchMethod - core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 */
export function createStamp({ cfg, stats, patchMethod, log }) {
  /** chatId → 最近一次**看到**的入站时刻（epoch ms）。覆盖式。 */
  const seenAt = new Map();

  /** chatId → 上一次**真正注入过**的时刻。gap 的基线。 */
  const baseline = new Map();

  /** bridge 实例 → 该实例的基线落盘仓库（目录可能随热重载变，按实例分开）。 */
  const stores = new WeakMap();

  /** mediaDir 从 bridge 的运行时配置里取（与 mood/style 的状态文件同目录）。 */
  function mediaDirOf(receiver) {
    const dir = receiver?.deps?.config?.mediaDir;
    return typeof dir === 'string' && dir !== '' ? dir : '';
  }

  /** 惰性建/换 store —— 目录变了就重建（配置热改、bridge 首次出现）。 */
  function storeFor(receiver) {
    const dir = mediaDirOf(receiver);
    if (typeof dir !== 'string' || dir === '') return undefined;
    const file = stateFilePath(dir, 'stamp-state.json');
    const existing = stores.get(receiver);
    if (existing !== undefined && existing.file === file) return existing;
    const store = new JsonStore({
      file,
      label: 'companion/stamp',
      log,
      normalize: (value) => {
        const raw = typeof value === 'number' ? value : value?.lastAt;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
        return { lastAt: raw };
      },
    });
    stores.set(receiver, store);
    // 同步读：`previousFor()` 就在同一个调用栈里读它，异步 load 永远赶不上，
    // 重启/热重载后的第一条会拿不到基线、gap 白丢（落盘层的全部理由）。
    store.loadSync();
    stats.stampStateFile = file;
    return store;
  }

  /** 基线：内存优先，其次落盘（重启后第一条也能拿到真实间隔）。 */
  function previousFor(receiver, chatId) {
    const fresh = baseline.get(chatId);
    if (typeof fresh === 'number') return fresh;
    const store = storeFor(receiver);
    store?.loadSync();
    const entry = store?.get(chatId);
    return typeof entry?.lastAt === 'number' ? entry.lastAt : undefined;
  }

  /** 推进基线（内存 + 落盘），并淘汰最久没来消息的 chat（见 `MAX_CHATS`）。 */
  function remember(receiver, chatId, at) {
    baseline.set(chatId, at);
    const store = storeFor(receiver);
    if (store === undefined) return;
    store.set(chatId, { lastAt: at });
    evictOldest(baseline, store, chatId);
    store.saveDebounced();
  }

  /**
   * 计算并写入一条投递的属性；返回改写后的文本（没改动时返回 null）。
   *
   * 拿不到基线时 **gap 留空** —— 当年就是这么定的：省略属性好过猜一个模型会
   * 当真的间隔。
   */
  function apply(receiver, chatId, text, atMs) {
    const previous = previousFor(receiver, chatId);
    const time = cfg.injectTime === false ? '' : formatMessageTime(new Date(atMs));
    const gap =
      cfg.injectGap === false ||
      typeof previous !== 'number' ||
      !Number.isFinite(previous) ||
      atMs <= previous
        ? ''
        : formatElapsed(atMs - previous);
    const next = injectStamp(text, { time, gap });
    if (next === text) return null;
    remember(receiver, chatId, atMs);
    return { text: next, time, gap };
  }

  /**
   * 周期补挂（与其余模块同构）。
   *
   * 目标包被升级换目录后靠它自愈；`enabled:false` 时走 detach 把闸摘掉。
   */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.stampEnabled = cfg.enabled !== false;

    if (cfg.enabled === false) {
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.stampResolveError = found.error;
      return { ok: false, error: found.error };
    }

    // chatId 必须由上游自己的 buildChatId 推 —— 复刻那个拼法就是在埋「上游改了
    // 规则而我们还按老规则算」的坑，算错的后果是把时刻记到别的 chat 名下。
    let buildChatId;
    try {
      const chatUrl = moduleUrl(ctx, cfg, CHAT_FILE);
      if (chatUrl === null) throw new Error('未找到 profile 目录');
      const chatMod = await import(chatUrl);
      buildChatId = chatMod?.[CHAT_EXPORT];
      if (typeof buildChatId !== 'function') throw new Error(`未导出 ${CHAT_EXPORT}`);
    } catch (error) {
      stats.stampResolveError = `未取到 chat.js 的 ${CHAT_EXPORT}（${describeThrown(error)}），拒绝凭猜推导 chatId`;
      return { ok: false, error: stats.stampResolveError };
    }

    const proto = found.proto;
    stats.stampResolveError = null;
    stats.stampProfileDir = found.profileDir;
    stats.lost = stats.lost.filter(
      (item) => !(METHODS.includes(item?.method) && item?.moduleId === MODULE_ID),
    );
    for (const missing of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ method: missing, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.shift();
    }

    let patched = 0;
    const rel = found.url;

    if (
      patchMethod(
        proto,
        'handleInbound',
        MODULE_ID,
        (original) =>
          makeStampHandleInbound({ original, cfg, seenAt, buildChatId, stats, log }),
        rel,
      )
    ) {
      patched += 1;
    }

    if (
      patchMethod(
        proto,
        'dispatchFollowup',
        MODULE_ID,
        (original) =>
          makeStampDispatchFollowup({
            original,
            cfg,
            seenAt,
            apply,
            stats,
            log,
          }),
        rel,
      )
    ) {
      patched += 1;
    }

    return { ok: true, patched };
  }

  /**
   * 摘闸：把原型上本模块的层剥掉，其余层原样保留。
   *
   * 必须存在 —— 2026-10-14 在 adopt 上实测过：`enabled:false` 只让 `scan` 早退
   * 的话，**上一轮挂的闸还留在原型上**。闸内部读的是同一份 cfg（访问器）行为会
   * 跟着变，但拿着旧 cfg 快照的实例（热重载前那个）关掉就不生效。
   *
   * 剥层用 `patchMethod.unpatch`（core/patch.js）而**不在这里自己写**：本模块的
   * 层在 `handleInbound` 上会被 persona 压在下面、在 `dispatchFollowup` 上会被
   * rhythm 压在下面，自己写的「只看链头」那一版会直接 `return false` —— 闸关不
   * 掉，而 `POST /module` 还报成功。
   */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  /**
   * 自测：格式/白名单/注入的纯函数用例 + 「记账 → 注入 → 基线推进」整条链。
   *
   * 走**生产用的同一批工厂函数**（`makeStampHandleInbound` /
   * `makeStampDispatchFollowup`）造包装，只是在假 proto 上装、在假 bridge 上跑，
   * 不碰生产原型，也不污染生产统计（用本地 stats 副本）。
   */
  async function selfTest() {
    const localStats = {
      stamped: 0,
      lastStampAt: null,
      lastStampKind: null,
      lastStampChat: null,
      lastStampTime: null,
      lastStampGap: null,
      lastError: null,
    };
    const localLog = () => undefined;
    const localCfg = { ...cfg, injectTime: true, injectGap: true, logStamps: false };
    const localSeen = new Map();
    const localBase = new Map();
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });

    // ── 纯函数 ───────────────────────────────────────────────────────────────
    check('formatElapsed 47s', formatElapsed(47_000) === '47s');
    check('formatElapsed 3m47s', formatElapsed(227_000) === '3m47s');
    check('formatElapsed 15h35m', formatElapsed(56_100_000) === '15h35m');
    check('formatElapsed 2d4h', formatElapsed(187_200_000) === '2d4h');
    check('formatElapsed 负数→空', formatElapsed(-1) === '');
    check('formatElapsed NaN→空', formatElapsed(NaN) === '');
    check('safeGap 只留 dhms', safeGapValue('15h35m"><x') === '15h35m');
    check(
      'safeTime 只留数字与 T:+-',
      safeTimeValue('2026-10-08T15:15:23+08:00"') === '2026-10-08T15:15:23+08:00',
    );
    check(
      'formatMessageTime 形状',
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(formatMessageTime(new Date())),
    );
    check('sentAtOf 认 unix 秒', Math.abs(sentAtOf({ time: 1_759_000_000 }).getTime() - 1_759_000_000_000) < 1000);
    check('sentAtOf 坏值退回现在', Math.abs(sentAtOf({ time: 5 }).getTime() - Date.now()) < 2000);
    check('chatIdOfEvent 私聊', chatIdOfEvent({ message_type: 'private', user_id: 7 }, fakeBuildChatId) === 'private:7');
    check('chatIdOfEvent 群聊', chatIdOfEvent({ message_type: 'group', group_id: 8 }, fakeBuildChatId) === 'group:8');
    check('chatIdOfEvent 非消息事件→null', chatIdOfEvent({ post_type: 'meta_event' }, fakeBuildChatId) === null);

    // ── 注入 ─────────────────────────────────────────────────────────────────
    const base = '<user_message qq="1" nickname="a">\nhi\n</user_message>';
    const once = injectStamp(base, { time: '2026-10-08T15:15:23+08:00', gap: '3m47s' });
    check('注入两个属性', once.includes(' time="2026-10-08T15:15:23+08:00"') && once.includes(' gap="3m47s"'));
    check('注入不动块内内容', once.includes('\nhi\n') && once.endsWith('</user_message>'));
    check('重复注入不叠加', injectStamp(once, { time: '2026-10-08T15:15:23+08:00', gap: '3m47s' }) === once);
    check('注入保留原属性', injectStamp(base, { gap: '1m' }).includes('qq="1" nickname="a"'));
    check('无标签原样返回', injectStamp('普通文本', { time: '2026-10-08T15:15:23+08:00' }) === '普通文本');
    check('恶意 gap 值被白名单洗掉', !injectStamp(base, { gap: '1h"><x' }).includes('"><x'));
    check('空属性原样返回', injectStamp(base, {}) === base);
    check('只有群前缀时也能命中', injectStamp('[12:00 a(1)] ' + base, { gap: '2s' }).includes(' gap="2s"'));

    // ── 整条链：用生产工厂在假 proto 上装 ─────────────────────────────────────
    const calls = [];
    const fakeProto = {
      handleInbound() {
        return 'inbound-original';
      },
      dispatchFollowup(chatId, text) {
        calls.push(text);
        return 'dispatch-original';
      },
    };
    const previousFor = (receiver, chatId) => localBase.get(chatId);
    const applyLocal = (receiver, chatId, text, atMs) => {
      const previous = previousFor(receiver, chatId);
      const time = formatMessageTime(new Date(atMs));
      const gap =
        typeof previous !== 'number' || !Number.isFinite(previous) || atMs <= previous
          ? ''
          : formatElapsed(atMs - previous);
      const next = injectStamp(text, { time, gap });
      if (next === text) return null;
      localBase.set(chatId, atMs);
      return { text: next, time, gap };
    };
    const fakePatch = (proto, method, moduleId, makeWrapper) => {
      const original = proto[method];
      if (typeof original !== 'function') return false;
      const wrapped = makeWrapper(original);
      wrapped[MODULE_TAG] = moduleId;
      wrapped.__onebotCompanionOriginal = original;
      proto[method] = wrapped;
      return true;
    };
    const stamped1 = fakePatch(fakeProto, 'handleInbound', MODULE_ID, (original) =>
      makeStampHandleInbound({
        original,
        cfg: localCfg,
        seenAt: localSeen,
        buildChatId: fakeBuildChatId,
        stats: localStats,
        log: localLog,
      }),
    );
    const stamped2 = fakePatch(fakeProto, 'dispatchFollowup', MODULE_ID, (original) =>
      makeStampDispatchFollowup({
        original,
        cfg: localCfg,
        seenAt: localSeen,
        apply: applyLocal,
        stats: localStats,
        log: localLog,
      }),
    );
    check('两个闸都挂上', stamped1 === true && stamped2 === true);

    const bridge = Object.create(fakeProto);
    const chatId = 'private:12345';

    bridge.handleInbound({ message_type: 'private', user_id: 12345, time: 1_759_000_000 });
    bridge.dispatchFollowup(chatId, base, 'member', 'a');
    check('首条有 time、无 gap（无基线）', localStats.lastStampTime !== null && localStats.lastStampGap === null);
    const firstTime = localStats.lastStampTime;

    bridge.handleInbound({ message_type: 'private', user_id: 12345, time: 1_759_000_300 });
    calls.length = 0;
    bridge.dispatchFollowup(chatId, base, 'member', 'a');
    check('第二条算出 gap=5m', localStats.lastStampGap === '5m');
    check('第二条 time 前进', localStats.lastStampTime !== firstTime);
    check('原文确实被改写', (calls[0] ?? '').includes(' gap="5m"'));
    check('其它 chat 无基线', previousFor(bridge, 'private:999') === undefined);

    // 无边界投递（命令回执）不推进基线。
    const beforeBaseline = previousFor(bridge, chatId);
    bridge.dispatchFollowup(chatId, '✅ 命令回执', 'member', 'a');
    check('无边界投递不推进基线', previousFor(bridge, chatId) === beforeBaseline);
    check('无边界投递不计数', localStats.stamped === 2);

    // 记账与基线是两张表：入站会更新 seenAt，但不碰 baseline。
    bridge.handleInbound({ message_type: 'private', user_id: 12345, time: 1_759_000_900 });
    check('入站更新 seenAt', localSeen.get(chatId) === 1_759_000_900_000);
    check('入站不动 baseline', previousFor(bridge, chatId) === beforeBaseline);

    // 关掉 time 只留 gap。
    const onlyGap = injectStamp(base, { time: '', gap: '2m' });
    check('可只注入 gap', onlyGap.includes(' gap="2m"') && !onlyGap.includes(' time='));

    return { ok: checks.every((item) => item.ok), checks };
  }

  return {
    MODULE_ID,
    scan,
    selfTest,
    detach,
    METHODS,
    TARGET,
    /** 观测面：内存里记着的入站时刻条数。 */
    seenCount: () => seenAt.size,
    /** 观测面：内存里的 gap 基线条数。 */
    baselineCount: () => baseline.size,
  };
}

/** 自测用的 chatId 拼法副本 —— **仅限自测**，生产路径一律用上游的 buildChatId。 */
function fakeBuildChatId(kind, target) {
  return kind === 'private' ? 'private:' + target : 'group:' + target;
}

/** 本模块的默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /** 注入 `time=`（对方按下发送的时刻）。关掉只留 gap。 */
  injectTime: true,
  /** 注入 `gap=`（距上一条已算好的间隔）。 */
  injectGap: true,
  /** 每次注入都记一条 info（排查用，平时太吵）。 */
  logStamps: false,
};
