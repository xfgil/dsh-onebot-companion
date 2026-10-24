/**
 * dsh-onebot-companion / modules/isolation.js
 *
 * 群聊硬隔离：**非管理员在群里说话的那一轮，不许她碰任何工具**。
 *
 * ## 起因（2026-10-17 18:32 实测事故）
 *
 * 群友 `58462qwq(2665507357)` 在群里 @ 她问「工作目录下有什么」，她这一轮：
 *
 * ```
 * tool_use: ops_bash {"command":"ls -a","workdir":"D:\\Documents\\yunyue"}
 * → 「就一个 .dsh-media」「别的啥也没有」
 * ```
 *
 * 她把**宿主的真实文件系统**列出来发进了群。问话的是群友，不是示例用户。
 *
 * ## 为什么提示词不够
 *
 * 上游有 `restrictedMemberPrefix`：非管理员的消息带上 `[受限用户:仅问答]` 前缀，
 * `buildPlatformPrompt` 随之追加一句「仅回答其问题，禁止文件/终端/配置等操作」。
 * 那是**提示词约束**——模型听话时有效，不听话时照样执行。这个事故本身就证明了
 * 它拦不住。
 *
 * ## 硬闸：`ctx.tools.guard()`
 *
 * 宿主文档（app.asar 的稳定性条款）原文：
 *
 * > A denial that must hold regardless of order is a `ctx.tools.guard()`;
 * > a guard is synchronous … The exact effect disposer is returned for ordered
 * > ownership and HMR cleanup.
 *
 * 签名（`ToolRuntime`）：`guard(guard: ToolGuard): () => void`，其中
 * `ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined`——
 * **返回字符串即拒绝**，返回 undefined 放行。guard 走的是
 * `tools/pre-execute` waterfall **之后**的单调判定：任何 guard 都能否掉，
 * 却没有 guard 能强行放行别人否掉的调用。顺序无关，HMR 可回收。
 *
 * ## 判据：按「本轮是谁说的」而不是「哪个会话」
 *
 * 群里示例用户和群友**共用同一个群会话**，所以不能按会话级别封 —— 那会连示例用户
 * 也一起封掉。必须按**这一轮消息的发送者**判。`agent/pre-step` 的 payload
 * 带着本轮 `messages`，从中取最后一条带 `<user_message>` 的用户消息即可。
 *
 * 两条判据取**并集**（任一条成立就算受限）：
 *
 * 1. 消息以 `[受限用户:仅问答]` 开头 —— 上游已经判过它非管理员；
 * 2. `<user_message qq="X">` 里的 X 不在 `adminUsers` 里。
 *
 * 取并集而不是只用第 1 条，是为了让隔离**不依赖 `restrictedMemberPrefix` 这个
 * 配置项**——那个开关被谁改成 false，硬闸都还在（第 2 条独立生效）。
 *
 * ## 白名单：留两个发声工具
 *
 * 用户 2026-10-17 的选择是「群聊禁工具」，但允许「纯聊天（发文字/表情/语音）」。
 * 所以不是全禁：`qq_say`（语音）与 `qq_send_face`（表情）放行，其余一律拒。
 * 其余工具没有一个是「纯发声」——`ops_*` 碰文件与 shell，搜索碰网络，
 * 都会把宿主或外部世界的实情带进群。
 *
 * @module dsh-onebot-companion/modules/isolation
 */

import { describeThrown } from '../core/profile.js';
import { sessionIdOf } from './prompt.js';

/** 模块 id：出现在日志与 `patched` 记录里。 */
export const MODULE_ID = 'isolation';

/** 上游给非管理员群友加的前缀（`dsh-onebot-qq/lib/chat.js:117`）。 */
export const RESTRICTED_PREFIX = '[受限用户:仅问答]';

/**
 * 受限回合里**仍然允许**的工具。
 *
 * `read_image` 是 2026-10-18 加进来的：群友发图时上游已经把本地路径明文写进
 * 文本（`inbound.js:324` 返回 `[图片:D:\...\media_xxx.jpg]`），但硬隔离把这个
 * 工具一起封了，于是她只能说「图我是真看不见的」「图在我这儿就是一片空白」。
 * 那是**诚实的** —— 而且和上游 `prompt.js:18` 的「如需查看图片内容，请使用
 * 当前可用的图像查看/描述工具」直接矛盾。
 *
 * 放开的代价是 `read_image` 能读任意路径的图，所以配了
 * `MEDIA_TOOLS` + `mediaDir` 白名单：**只能读媒体目录里的文件**。
 * 群友没法借它翻 `C:\Users\...` 的截图。
 */
export const ALLOWED_TOOLS = [
  'qq_say',
  'qq_send_face',
  'qq_react',
  'read_image',
];

/**
 * 受限回合里**有条件**允许的工具：`web_fetch` 只许打开本轮聊天里出现过的链接。
 *
 * 为什么要开这个口子（2026-10-19）：`link-card.js` 把 QQ 卡片还原成
 * `[卡片:标题 https://…]`，提示词规则 `link` 又要求「想接话就先 `web_fetch`
 * 打开它」。可群友说话的那一轮是硬隔离的，`web_fetch` 在拒绝之列 —— 规则与闸门
 * 直接打架：她看到链接、被要求去读、然后每次都被拒。
 *
 * 口子开得多窄：**只认本轮入站文本里出现过的那几个 URL**（卡片里的、或对方直接
 * 打出来的），别的一律拒；而且只认公网 http(s)，本机/内网地址一律拒。
 *
 * 后者是必须的：`http://127.0.0.1:6099/webui?token=…` 这种地址一旦被允许，
 * 群友只要贴一行字就能让她把 NapCat 面板内容念进群里。所以闸门里显式挡
 * loopback / 私网 / 链路本地 / `.local`。
 *
 * 2026-10-20 补：加进 `link_parse` / `link_download`。原因和 `web_fetch` 是同一个：
 * 群友丢一条 `b23.tv` 短链过来，`web_fetch` 只能抓到一层跳转 HTML（B 站页面是
 * JS 渲染），等于给了她一个「能看但看不出来」的工具，于是她只能含糊带过。
 * 而 `link_parse` / `link_download` 的参数名也是 `url`，可以原样套 `checkLinkAccess`，
 * 「只许本轮出现过、且是公网」这条边界一点没松。
 */
export const LINK_TOOLS = ['web_fetch', 'link_parse', 'link_download'];

/** 每轮最多认几个链接（防止一条消息塞几百个 URL 把判断拖慢）。 */
const MAX_TURN_LINKS = 8;

/** 从文本里抠出 http(s) 链接。卡片标注与裸链接都认，尾随标点去掉。 */
export function extractLinks(text) {
  const out = new Set();
  if (typeof text !== 'string' || text === '') return out;
  const re = /https?:\/\/[^\s<>"'\[\]（）()]+/gi;
  for (const match of text.matchAll(re)) {
    const url = match[0].replace(/[.,;:!?、。，；：！？]+$/, '');
    out.add(url);
    if (out.size >= MAX_TURN_LINKS * 4) break;
  }
  return out;
}

/** 归一化后比较（去尾部斜杠/大小写差异不算不同链接）。 */
function normalizeUrl(value) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase();
    if (host === '' ) return null;
    return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return null;
  }
}

/** 私网/本机/链路本地地址判定：这些绝不能让群友借她之口读出来。 */
export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (host.startsWith('fd') || host.startsWith('fc') || host.startsWith('fe80')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // tailnet 的 CGNAT 段
  }
  return false;
}

/**
 * 受限回合能不能打开这个 URL。
 *
 * @param {string} raw 工具参数里的 url
 * @param {Iterable<string>} allowed 本轮入站文本里出现过的链接
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkLinkAccess(raw, allowed) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: '缺少 url 参数' };
  }
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: '链接格式不对' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '只开放 http/https 链接' };
  }
  if (isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: '本机与内网地址不开放' };
  }
  const wanted = normalizeUrl(raw);
  const pool = new Set();
  for (const item of allowed ?? []) {
    const norm = normalizeUrl(item);
    if (norm !== null) pool.add(norm);
  }
  if (wanted === null || !pool.has(wanted)) {
    return { ok: false, reason: '只能打开这条聊天里别人发出来的链接' };
  }
  return { ok: true };
}

/** 需要额外做「只能读媒体目录」检查的工具 → 参数里的路径字段名。 */
const MEDIA_TOOLS = { read_image: 'file_path' };

/** `<user_message qq="123" …>` —— 上游 `wrapUserMessage` 产出的边界标签。 */
const USER_MESSAGE_RE = /<user_message[^>]*?\bqq="([^"]*)"/;

/** 规范化路径便于前缀比较（分隔符统一、去尾斜杠、小写）。 */
/**
 * 去掉 `.` 与 `..` 段（`..` 的效果就是抹掉上一段）。
 *
 * 不消掉 `..` 的话 `D:\a\.dsh-media\..\secret.txt` 前缀仍是 `d:\a\.dsh-media`，
 * 白名单形同虚设 —— 2026-10-18 自测里真的 ALLOW 了。
 */
function collapseDots(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function normalizePath(value) {
  return collapseDots(String(value).replace(/\\/g, '/')).toLowerCase();
}

/**
 * 路径是否落在媒体目录内。
 *
 * 用「目录 + /」做前缀，避免 `D:\a\.dsh-media-evil` 被 `D:\a\.dsh-media`
 * 匹配到。`..` 必须**先折叠再比**：折叠前做前缀比较会让
 * `...\.dsh-media\..\secret.txt` 通过（就是同一个漏洞）。
 */
export function isUnderDir(filePath, dir) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return false;
  if (typeof dir !== 'string' || dir.trim() === '') return false;
  return (normalizePath(filePath) + '/').startsWith(normalizePath(dir) + '/');
}

/** 从一条消息的 content 里拼出纯文本（content 必须是数组，见 prompt.js 的教训）。 */
export function textOfMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 从一批 messages 里取出**最后一条**看起来像 QQ 入站用户消息的文本。
 *
 * 为什么要「看起来像」而不是取最后一条 user 消息：`agent/pre-step` 的
 * `messages` 里还会混着本插件自己注入的规则消息（`source.kind` 为
 * `onebot-prompt`）、时间上下文等，它们同样 `role: 'user'`。只认带
 * `<user_message>` 边界的那些 —— 那是上游入站管线盖的章。
 *
 * @param {unknown} messages
 * @returns {string} 没找到返回空串。
 */
export function lastInboundText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = textOfMessage(message);
    if (text.includes('<user_message')) return text;
  }
  return '';
}

/**
 * 判定一批 messages 代表的这一轮是不是「群聊里的非管理员在说话」。
 *
 * @param {unknown} messages - `agent/pre-step` payload 的 messages。
 * @param {string[]} adminUsers - 管理员 QQ 号。
 * @returns {{restricted: boolean, userId: string, reason: string}}
 */
export function judgeTurn(messages, adminUsers) {
  const text = lastInboundText(messages);
  if (text === '') return { restricted: false, userId: '', reason: 'no-inbound' };
  const admins = Array.isArray(adminUsers) ? adminUsers.map((q) => String(q)) : [];
  // 判据②：边界标签里的发送者。
  const userId = (USER_MESSAGE_RE.exec(text)?.[1] ?? '').trim();
  // 判据①：上游盖的受限前缀（可能在群前缀之前，所以要 includes 而不是 startsWith 单判）。
  const hasPrefix = text.includes(RESTRICTED_PREFIX);
  if (hasPrefix) return { restricted: true, userId, reason: 'restricted-prefix' };
  if (userId === '') return { restricted: false, userId, reason: 'unknown-sender' };
  if (!admins.includes(userId)) return { restricted: true, userId, reason: 'not-admin' };
  return { restricted: false, userId, reason: 'admin' };
}

/** 工具名是否属于「纯发声」白名单。 */
export function isAllowedInRestricted(name, allowed) {
  const list = Array.isArray(allowed) ? allowed : ALLOWED_TOOLS;
  return list.includes(String(name ?? ''));
}

/**
 * 工具参数解析：宿主可能给对象，也可能给 JSON 字符串。
 *
 * 解析不了就返回空对象 —— 调用方拿不到字段时按「缺参数」拒绝，不会误放行。
 */
export function parseArgs(args) {
  if (args !== null && typeof args === 'object') return args;
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * 媒体类工具的额外限制：只能碰媒体目录里的文件。
 *
 * 不在 `MEDIA_TOOLS` 里的工具一律放行（这里只管读图的路径边界）。
 * 没配 `mediaDir` 时也放行 —— 上游没给目录就没法判，此时退回纯白名单语义，
 * 与本次改动之前的行为一致。
 *
 * @param {string} name 工具名
 * @param {object|string} args 工具参数（可能是 JSON 字符串）
 * @param {string} mediaDir 允许的目录
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkMediaAccess(name, args, mediaDir) {
  const field = MEDIA_TOOLS[String(name ?? '')];
  if (field === undefined) return { ok: true };
  if (typeof mediaDir !== 'string' || mediaDir.trim() === '') return { ok: true };
  let parsed = args;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, reason: '参数不是合法 JSON' };
    }
  }
  const raw = parsed?.[field];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: `缺少 ${field} 参数` };
  }
  if (!isUnderDir(raw, mediaDir)) {
    return { ok: false, reason: `只能查看聊天里收到的图片（${mediaDir} 之外的文件不开放）` };
  }
  return { ok: true };
}

/**
 * 拒绝时回给模型的话。
 *
 * 写清楚「为什么」和「该怎么办」：模型收到一条只有「denied」的错误会重试，
 * 而明确说「你就口答」能让她直接改用文字回答，而不是反复换工具试。
 */
export function denyReason(name) {
  return (
    `群聊里这条消息来自非管理员，不提供工具调用能力（被拒绝的工具：${String(name ?? '?')}）。`
    + '你只能用文字、表情或语音跟对方聊，不要读取本地文件、不要执行命令、不要联网查询。'
    + '对方问到你不知道的事，就照实说不知道，或者用常识口答。'
  );
}

/**
 * 创建隔离模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - isolation 段配置。
 * @param {object} options.stats - 共享统计。
 * @param {(level: string, message: string) => void} options.log
 * @param {() => string[]} [options.adminUsers] - 取当前管理员号（读 bridge 配置，
 *   变化后立刻生效，不用重启）。
 * @param {() => string} [options.mediaDir] - 取当前媒体目录（读图白名单边界）。
 */
export function createIsolation({ cfg, stats, log, adminUsers, mediaDir }) {
  /**
   * sessionId → 本轮是否受限。
   *
   * 为什么是会话级的一次性标记而不是「每轮记录」：`agent/pre-step` 在**每步**
   * 模型调用前都会跑，而工具调用只可能发生在它之后、下一步之前。所以每步都把
   * 本轮的判定**覆盖写**进去即可 —— 不需要区分回合。
   */
  const turnState = new Map();

  /** 取媒体目录：优先注入的回调（读 bridge 实时配置），退回静态配置。 */
  const mediaDirNow = () => {
    try {
      const fromBridge = mediaDir?.();
      if (typeof fromBridge === 'string' && fromBridge !== '') return fromBridge;
    } catch {
      /* 拿不到就退回静态配置；都没有则不做路径限制 */
    }
    return typeof cfg?.mediaDir === 'string' ? cfg.mediaDir : '';
  };

  /** 取管理员号：优先用注入的回调（读 bridge 实时配置），退回静态配置。 */
  const adminsNow = () => {
    try {
      const fromBridge = adminUsers?.();
      if (Array.isArray(fromBridge) && fromBridge.length > 0) return fromBridge.map((q) => String(q));
    } catch {
      /* 拿不到就退回静态配置，不能因为读配置失败把隔离关掉 */
    }
    const fallback = cfg?.adminUsers;
    return Array.isArray(fallback) ? fallback.map((q) => String(q)) : [];
  };

  /**
   * `agent/pre-step` 观察器：把「这一轮是不是受限」记到 sessionId 上。
   *
   * 全程 try/catch：隔离模块自身出错**不能**阻断对话，也不能**误放行**——
   * 出错时按「非 onebot 会话」处理（不标记），而 guard 那边见不到标记时
   * 默认放行，与改动前行为一致。
   */
  function observe(payload) {
    try {
      if (cfg?.enabled === false) return;
      const sid = sessionIdOf(payload?.agent);
      if (sid === null || !sid.startsWith('onebot-')) return;
      // 私聊不隔离：私聊里没有群友，只有对方本人（dmPolicy 已经把关）。
      if (!sid.startsWith('onebot-group-')) {
        turnState.delete(sid);
        return;
      }
      const verdict = judgeTurn(payload?.messages, adminsNow());
      if (verdict.restricted) {
        // 本轮能不能读链接，取决于本轮入站文本里出现过哪几个 URL。先存下来，
        // 等 guard 真被调用时再逐个核（此时还不知道她要读哪个）。
        const links = extractLinks(lastInboundText(payload?.messages));
        turnState.set(sid, { ...verdict, links });
        stats.isolationBlockedTurns = (stats.isolationBlockedTurns ?? 0) + 1;
      } else {
        turnState.delete(sid);
      }
    } catch (error) {
      stats.lastError = describeThrown(error);
    }
  }

  /**
   * 工具守卫。挂在 plugin ctx 上是全局的，但内部只对「标记为受限的 onebot 群会话」
   * 生效 —— 别的会话、私聊、以及示例用户说话的那一轮全都原样放行。
   *
   * @param {any} execution - `ToolExecution`（含 agent / name / arguments）。
   * @returns {string|undefined} 返回字符串 = 拒绝。
   */
  function guard(execution) {
    try {
      if (cfg?.enabled === false) return undefined;
      const sid = sessionIdOf(execution?.agent);
      if (sid === null) return undefined;
      const verdict = turnState.get(sid);
      if (verdict === undefined) return undefined;
      const name = String(execution?.name ?? '');
      if (isAllowedInRestricted(name, cfg?.allowedTools)) {
        // 放行前还要过媒体边界（read_image 只许读聊天目录里的图）。
        const media = checkMediaAccess(name, execution?.arguments, mediaDirNow());
        if (!media.ok) {
          stats.isolationDenied = (stats.isolationDenied ?? 0) + 1;
          stats.lastIsolationDenied = {
            at: Date.now(), tool: name, userId: verdict.userId, reason: media.reason,
          };
          log('info', `群聊隔离：拒绝 ${name} 越界读图（来自 ${verdict.userId || '?'}）：${media.reason}`);
          return `群聊里读图只开放聊天里收到的图片，${media.reason}。不要试图读别的文件。`;
        }
        stats.isolationAllowedCalls = (stats.isolationAllowedCalls ?? 0) + 1;
        return undefined;
      }
      if (LINK_TOOLS.includes(name) && cfg?.allowLinks !== false) {
        // 读链接：只开放本轮聊天里真出现过的那个地址，且不许碰内网。
        const args = parseArgs(execution?.arguments);
        const target = args?.url ?? args?.href ?? '';
        const link = checkLinkAccess(target, verdict.links ?? []);
        if (link.ok) {
          stats.isolationAllowedCalls = (stats.isolationAllowedCalls ?? 0) + 1;
          return undefined;
        }
        stats.isolationDenied = (stats.isolationDenied ?? 0) + 1;
        stats.lastIsolationDenied = {
          at: Date.now(), tool: name, userId: verdict.userId, reason: link.reason,
        };
        log('info', `群聊隔离：拒绝 ${name}（来自 ${verdict.userId || '?'}）：${link.reason}`);
        return `群聊里只能打开别人刚发出来的链接：${link.reason}。`;
      }
      stats.isolationDenied = (stats.isolationDenied ?? 0) + 1;
      stats.lastIsolationDenied = { at: Date.now(), tool: name, userId: verdict.userId, reason: verdict.reason };
      log('info', `群聊隔离：拒绝 ${name}（来自 ${verdict.userId || '?'}，${verdict.reason}）`);
      return denyReason(name);
    } catch (error) {
      // guard 抛错会让宿主怎样？文档说 guard 是同步判定、返回字符串即拒绝。
      // 抛异常没有定义行为，所以自己兜住并按**拒绝**处理（fail-closed）——
      // 这是安全闸，出错时宁可少给她一个工具，也不能漏。
      stats.lastError = describeThrown(error);
      return denyReason(execution?.name);
    }
  }

  /** 当前有哪些会话被标记为受限（诊断用）。 */
  function snapshot() {
    const out = {};
    for (const [sid, verdict] of turnState) {
      // `links` 是 Set，直接 JSON 会变成 `{}`；转成数组才看得见「本轮认了哪几个链接」。
      out[sid] = {
        restricted: verdict.restricted,
        userId: verdict.userId,
        reason: verdict.reason,
        links: [...(verdict.links ?? [])],
        at: new Date().toISOString(),
      };
    }
    return out;
  }

  /**
   * 当前实际生效的读图白名单目录（诊断用）。
   *
   * `cfg.mediaDir` 往往是空串（真值从 bridge 实时取），只报配置会让人误以为
   * 「白名单没开」—— 2026-10-18 排查时 `/status` 里就是空串，多绕了一圈。
   */
  function effectiveMediaDir() {
    return mediaDirNow();
  }

  return { MODULE_ID, observe, guard, snapshot, judgeTurn, effectiveMediaDir, DEFAULTS };
}

/** 本模块默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /**
   * 受限回合里仍然允许的工具。默认只留纯发声的 + 读图。
   * 想更严就把 `qq_say` / `qq_send_face` 也去掉（给 `[]`）。
   */
  allowedTools: [...ALLOWED_TOOLS],
  /**
   * 受限回合里是否允许 `web_fetch` 打开**本轮聊天里出现的**链接。
   * 关掉它就回到「群友说话时完全不能联网」的老行为。
   */
  allowLinks: true,
  /** 读图白名单目录（index.js 用上游 `mediaDir` 填）。 */
  mediaDir: '',
  /** 管理员号兜底（正常情况下由 bridge 配置实时提供）。 */
  adminUsers: ['100000001'],
};
