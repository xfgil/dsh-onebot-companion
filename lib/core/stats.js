/**
 * dsh-onebot-companion / core/stats.js
 *
 * 运行统计与 guard 命中记录。
 *
 * ## 为什么从 `index.js` 搬出来（2026-10-21）
 *
 * 当时的判断（大意）：功能要留，但结构必须拆——之前把几个插件合并成一个是不对的。
 * 拆之前 `lib/index.js` 2431 行，同时干四件事：装配模块、注册 14 个工具、
 * 提供 HTTP 观测面、管状态落盘。统计形状这一块是最没争议的 —— 它不依赖任何
 * 模块、不碰宿主、纯数据，却因为「`index.js` 里的东西只能从 `index.js` 里读」
 * 而被锁在那一个文件里。
 *
 * 搬出来之后 `index.js` 只做一件事：`import { stats } from './core/stats.js'`。
 *
 * ## 为什么挂在 `globalThis` 上
 *
 * 热重载换了模块实例，数字不该清零 —— 否则「插件到底跑了几轮」这个问题，
 * 每次改代码都会归零一次，而后台补挂也是靠这些数字自愈的。
 *
 * `Symbol.for()` 而不是 `Symbol()`：只有前者能跨模块实例拿到**同一个** symbol
 * （`Symbol()` 每次调用都是新的，热重载之后会造出第二份 stats）。
 *
 * @module dsh-onebot-companion/core/stats
 */

const STATS_KEY = Symbol.for('dsh-onebot-companion.stats');

/**
 * 共享统计对象。
 *
 * 一个对象服务所有模块：字段名互不冲突（guard 用顶层 `blocked`/`stripped`，
 * rhythm 用 `inbound`/`burst`，persona 用 `proactive`，prompt 用 `steps`/
 * `injections`），共享的 `scans`/`patched`/`lost`/`profileDir` 本来就是全局的。
 *
 * 新增字段**必须同时写进 `ensureStatsShape` 的模板**，否则热重载之后拿到的是
 * 旧对象，新字段是 `undefined`，`stats.xxx.yyy += 1` 会直接抛 `TypeError`。
 * 这个坑实测踩过（`voice` 段落盘是空的 `{}`）。
 */
export const stats = (globalThis[STATS_KEY] ??= {
  version: 1,
  startedAt: null,
  generations: 0,
  scans: 0,
  lastScanAt: null,
  enabled: true,
  resolveError: null,
  profileDir: '',
  patched: [],
  lost: [],
  lastError: null,
  // guard
  blocked: 0,
  stripped: 0,
  muted: 0,
  lastHitAt: null,
  lastHitKind: null,
  lastHitText: null,
  lastHitChat: null,
  // adopt：把「会话换代」补丁从 node_modules 搬出来（modules/adopt.js）
  adopted: 0,
  lastAdoptAt: null,
  lastAdoptChat: null,
  lastAdoptSession: null,
  adoptResolveError: null,
  adoptProfileDir: '',
  // stamp：给 <user_message> 边界补 time= / gap=（modules/stamp.js）
  stamped: 0,
  lastStampAt: null,
  lastStampKind: null,
  lastStampChat: null,
  lastStampTime: null,
  lastStampGap: null,
  stampResolveError: null,
  stampProfileDir: '',
  stampStateFile: '',
  stampEnabled: true,
  // prompt
  steps: 0,
  injections: 0,
  skippedNotOnebot: 0,
  skippedNotFirstStep: 0,
  skippedDuplicate: 0,
  lastInjectionAt: null,
  lastSessionId: null,
  activeRules: [],
  // rhythm
  inbound: { held: 0, merged: 0, flushed: 0, dropped: 0, pending: 0 },
  burst: { replies: 0, messages: 0, folded: 0, aborted: 0 },
  // persona
  proactive: { fired: 0, lastFiredAt: null, lastChatId: null },
  // voice
  voice: { sent: 0, lastSentAt: null, lastChatId: null, lastBytes: 0, lastText: null },
  // face（qq_send_face 工具）
  faces: { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null },
  // 已注册的工具名
  tools: [],
});

/** guard 的命中环形数组（跨热重载保留最近 200 条）。 */
const HITS_KEY = Symbol.for('dsh-onebot-companion.hits');
export const hits = (globalThis[HITS_KEY] ??= []);

/**
 * 把新增的统计字段补进**已经存在**的 stats 对象。
 *
 * 为什么需要：`stats` 挂在 `globalThis` 上跨热重载复用，`??=` 只在首次创建时
 * 填入完整形状。之后再往模板里加字段（比如 `voice`），热重载拿到的是
 * **旧对象** —— 新字段是 `undefined`，于是 `stats.voice.sent += 1` 直接抛
 * `TypeError`。实测就是这么暴露的：`voice` 段落盘是空的 `{}`。
 *
 * 补法是「只在缺失时填」：已有值（累计的计数）绝不覆盖。
 */
export function ensureStatsShape(target = stats) {
  const template = {
    version: 1,
    startedAt: null,
    generations: 0,
    scans: 0,
    lastScanAt: null,
    enabled: true,
    resolveError: null,
    profileDir: '',
    patched: [],
    lost: [],
    lastError: null,
    blocked: 0,
    stripped: 0,
    muted: 0,
    lastHitAt: null,
    lastHitKind: null,
    lastHitText: null,
    lastHitChat: null,
    adopted: 0,
    lastAdoptAt: null,
    lastAdoptChat: null,
    lastAdoptSession: null,
    adoptResolveError: null,
    adoptProfileDir: '',
    mentionNamed: 0,
    mentionDived: 0,
    mentionUpstream: 0,
    mentionAwake: 0,
    mentionSelfId: 0,
    mentionTopic: 0,
    mentionTopicAlive: 0,
    mentionTopicAwake: 0,
    lastMentionAt: null,
    lastMentionName: null,
    mentionResolveError: null,
    mentionProfileDir: '',
    stamped: 0,
    lastStampAt: null,
    lastStampKind: null,
    lastStampChat: null,
    lastStampTime: null,
    lastStampGap: null,
    stampResolveError: null,
    stampProfileDir: '',
    stampStateFile: '',
    isolationGuardInstalled: false,
    isolationBlockedTurns: 0,
    isolationDenied: 0,
    isolationAllowedCalls: 0,
    lastIsolationDenied: null,
    stampEnabled: true,
    steps: 0,
    injections: 0,
    skippedNotOnebot: 0,
    skippedNotFirstStep: 0,
    skippedDuplicate: 0,
    lastInjectionAt: null,
    lastSessionId: null,
    activeRules: [],
    inbound: { held: 0, merged: 0, flushed: 0, dropped: 0, pending: 0 },
    burst: { replies: 0, messages: 0, folded: 0, aborted: 0 },
    proactive: { fired: 0, lastFiredAt: null, lastChatId: null },
    voice: { sent: 0, lastSentAt: null, lastChatId: null, lastBytes: 0, lastText: null },
    faces: { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null },
    /** 已注册的工具名（`ctx.inject(['tools'])` 的回调真的跑过才会出现）。 */
    tools: [],
  };
  for (const [key, value] of Object.entries(template)) {
    if (target[key] === undefined) {
      target[key] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
      continue;
    }
    // 嵌套段（inbound / burst / proactive / voice）同样补齐缺失的键。
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (target[key][k] === undefined) target[key][k] = v;
      }
    }
  }
  return target;
}

ensureStatsShape(stats);

/**
 * 记一笔「工具真的注册上了」。
 *
 * 为什么要有这个：`ctx.inject(['tools'], cb)` 的回调**可能永远不被调用**（宿主
 * 没提供 `tools` 服务时静默跳过），而插件报告一切正常 —— 2026-10-13 补
 * `qq_send_face` 时正需要区分「注册失败」与「注册成功但模型没调用」。
 * 只记名字，不记 disposer。
 */
export function noteToolRegistered(toolName) {
  if (!Array.isArray(stats.tools)) stats.tools = [];
  if (!stats.tools.includes(toolName)) stats.tools.push(toolName);
  // 注册成功即清掉「服务不可用」这类陈旧告警 —— 否则它会在 state.json 里
  // 一直躺着，下次排查时把人引向已经不存在的问题（2026-10-16 修工具注册时
  // 就遇到过：工具明明回来了，toolErrors 里还留着旧代码写的条目）。
  if (Array.isArray(stats.toolErrors) && stats.toolErrors.length > 0) {
    stats.toolErrors = stats.toolErrors.filter((m) => !/tools 服务不可用|未注册/.test(String(m)));
  }
}
