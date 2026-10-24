/**
 * 把 QQ 聊天里的「分享卡片」正文捞出来给模型看。
 *
 * ## 为什么需要这一层
 *
 * 用户 2026-10-19 的原话：「现在除了看不懂链接外我还挺满意的」。
 *
 * 上游 `dsh-onebot-qq/lib/cq.js` 的 `parseMessage()` 对卡片段落只有一句：
 *
 * ```js
 * case 'json':
 *     textParts.push('[卡片]');
 *     break;
 * ```
 *
 * 也就是说 —— 卡片里的**标题、正文、跳转链接全部被丢掉**，模型只看到三个字
 * 「[卡片]」。别人在群里甩一个 B 站视频、一篇公众号文章、一条小程序，她完全不
 * 知道那是什么。`xml` 段同类（走 `default` 分支变成 `[xml]`）。
 *
 * ## 做法
 *
 * 与 `emoji-media.js` 完全同构：挂 `InboundPipeline.prototype.processInbound`
 * 的**入口**（`inbound.segments` 还是原始段），只读段、只往 `inbound.text` 末尾
 * 追加注解，不改上游已解析好的 any 别的字段。
 *
 * 注解长这样：
 *
 * ```
 * [卡片:【标题】https://example.com/x]
 * ```
 *
 * 有标题有链接时两个都给；只有链接时只给链接（**链接是最有价值的**，模型可以
 * 用 web_fetch 去读；标题只是给人看的提示）；都没有就退回上游原本的 `[卡片]`。
 *
 * ## 三个刻意的取舍
 *
 * - **只给 URL，不去抓正文**。抓正文是模型该干的事（她有 `web_fetch` /
 *   `research`），插件在入站路径上做网络请求会把「收一条消息」变成「可能挂
 *   十几秒」，而且一旦目标站超时 / 反爬，整条消息都跟着受影响。这里只负责把
 *   上游丢掉的**地址**捡回来。
 * - **解析绝不抛**。卡片 JSON 是腾讯私有格式，字段五花八门（structmsg /
 *   miniapp_01 / music.lua / 小程序 ark），换一版就可能变形。任何一个字段缺
 *   失都只是「少给一段」，绝不能让一条消息因为注解失败而丢掉。
 * - **HTML 实体与 GBK 转义都要解**。实测卡片文本里会出现 `&amp;` `&#44;`
 *   `\u4f60\u597d` 这类编码；不还原，模型看到的就是一坨。
 *
 * @module dsh-onebot-companion/link-card
 */

import { auditMethods } from '../core/patch.js';
import { describeThrown, loadTargetClass } from '../core/profile.js';

export const MODULE_ID = 'linkcard';

/** 挂载目标：与 emoji 模块同一层（`inbound.segments` 还是原始段）。 */
const TARGET = { file: 'inbound.js', exportName: 'InboundPipeline' };

const METHODS = ['processInbound'];

/** 一条消息里最多处理几张卡片（防刷屏时把消息拖成一长串链接）。 */
const MAX_PER_MESSAGE_DEFAULT = 3;

/** 主动去认的卡片段类型。`json` 是主流（腾讯所有卡片都走它），`xml` 是旧格式。 */
const CARD_SEGMENTS = new Set(['json', 'xml']);

/** 认为「这看起来是个链接」的判定。只认 http(s) —— 别的 scheme 不往模型面前送。 */
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;

/** 在 JSON 里找链接时优先看的键名（顺序即优先级）。 */
const URL_KEYS = [
  'jumpUrl',
  'jumpurl',
  'qqdocurl',
  'url',
  'shareUrl',
  'shareurl',
  'href',
  'link',
  'previewUrl',
];

/** 找标题时优先看的键名。 */
const TITLE_KEYS = ['title', 'desc', 'prompt', 'brief', 'summary', 'nickname'];

/**
 * 还原卡片文本里的编码（HTML 实体 + `\uXXXX` 转义）。
 *
 * 为什么两样都要：QQ 卡片 JSON 里的中文有时是 `\u4f60\u597d` 字面量（不是真
 * 的 UTF-8 中文），而 XML 卡片里的 `&amp;` 若不解，拼出来的 URL 就带 `&amp;`
 * 去请求，服务端会把参数名认成 `amp;x`。
 *
 * @param {string} text
 * @returns {string}
 */
export function decodeCardText(text) {
  let out = String(text ?? '');
  if (out === '') return out;
  // \uXXXX（只在确实存在反斜杠时才动手，避免误伤正常文本）
  if (out.includes('\\u')) {
    out = out.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)));
  }
  // HTML 实体：&amp; &lt; &gt; &quot; &#39; &#44; ……
  out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const hit = named[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
  return out;
}

/** 去掉首尾空白与控制字符，超长截断（标题不是正文，不需要很长）。 */
function tidy(value, limit = 120) {
  const s = decodeCardText(value).replace(/[\r\n\t]+/g, ' ').trim();
  if (s === '') return '';
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

/** 只保留 http(s) 且去掉尾随标点（卡片里常带 `)`、`。`）。 */
function tidyUrl(value) {
  const s = decodeCardText(value).trim().replace(/[)\]},.;，。、]+$/, '');
  return URL_RE.test(s) ? s : '';
}

/**
 * 深度遍历一个已解析的 JSON，找出第一个像链接的字段和第一个像标题的字段。
 *
 * 为什么要遍历而不是按固定路径取：腾讯卡片的 `meta` 里那层键名一直在换
 * （`news` / `detail_1` / `music` / `musicShare` / `wxappinfo`……），写死路径
 * 等于等着下次改版失效。按**键名**找能扛住层级变化。
 *
 * @param {unknown} node
 * @param {{url: string, title: string, depth: number}} acc
 */
function walkCard(node, acc, depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walkCard(item, acc, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (acc.url === '' && URL_KEYS.includes(key)) {
        const url = tidyUrl(value);
        if (url !== '') acc.url = url;
      }
      if (acc.title === '' && TITLE_KEYS.includes(key)) {
        const title = tidy(value);
        // `desc` 常是「[分享]某标题」那种包装，剥掉前缀更像真标题。
        if (title !== '') acc.title = title.replace(/^\[[^\]]*\]\s*/, '');
      }
    } else if (value !== null && typeof value === 'object') {
      walkCard(value, acc, depth + 1);
    }
  }
}

/**
 * 从 XML 卡片里取 url / brief。
 *
 * 只做属性级解析，不引 XML 库：QQ 的 xml 段就是一行 `<msg ...>`，属性全部
 * 平铺，正则足够，且不引入任何依赖。
 *
 * @param {string} xml
 * @returns {{url: string, title: string}}
 */
export function parseXmlCard(xml) {
  const raw = decodeCardText(xml);
  const attr = (name) => {
    const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(raw);
    return m === null ? '' : m[1];
  };
  const url = tidyUrl(attr('url'));
  let title = tidy(attr('brief'));
  if (title === '') title = tidy(attr('summary'));
  if (title === '') title = tidy(attr('title'));
  // `brief` 常写成「[分享]标题」；剥掉这层前缀（但保留别的方括号内容）。
  title = title.replace(/^\[[^\]]*\]\s*/, '');
  return { url, title };
}

/**
 * 从 `json` 段里取 url / title。
 *
 * 段结构是 `{ type: 'json', data: { data: '<JSON 字符串>', ... } }`；但实测也见过
 * `data.data` 直接是对象、或者整段藏在 `data` 字符串里。三种都试一遍。
 *
 * @param {object} seg
 * @returns {{url: string, title: string}}
 */
export function parseJsonCard(seg) {
  const acc = { url: '', title: '' };
  const candidates = [];
  const data = seg?.data;
  if (typeof data === 'string') {
    candidates.push(data);
  } else if (data !== null && typeof data === 'object') {
    for (const key of ['data', 'content', 'json']) {
      const value = data[key];
      if (typeof value === 'string') candidates.push(value);
      else if (value !== null && typeof value === 'object') walkCard(value, acc);
    }
    // `data` 自己的平铺字段（有的实现直接展开在段上）。
    walkCard(data, acc);
  }
  for (const text of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 不是 JSON（小程序 ark 有时是 JS 字面量）：退化成在原文里抠 `"url":"…"`。
      const m = /"?(?:jumpUrl|qqdocurl|url)"?\s*:\s*"([^"]+)"/i.exec(decodeCardText(text));
      if (m !== null) {
        const url = tidyUrl(m[1]);
        if (acc.url === '' && url !== '') acc.url = url;
      }
      if (acc.title === '') {
        const t = /"?(?:title|desc)"?\s*:\s*"([^"]+)"/i.exec(decodeCardText(text));
        if (t !== null) acc.title = tidy(t[1]);
      }
      continue;
    }
    walkCard(parsed, acc);
  }
  return acc;
}

/**
 * 解析单张卡片段 → `{url, title}`。永不抛。
 *
 * @param {object} seg 原始消息段
 * @returns {{url: string, title: string}}
 */
export function parseCardSegment(seg) {
  try {
    if (seg?.type === 'xml') {
      return parseXmlCard(typeof seg?.data === 'string' ? seg.data : String(seg?.data?.data ?? ''));
    }
    return parseJsonCard(seg);
  } catch {
    return { url: '', title: '' };
  }
}

/**
 * 把一条入站消息里的卡片补成可读文本。
 *
 * @param {object} inbound `normalizeOneBot11` 的产物
 * @param {object} cfg 本模块配置
 * @param {object} stats 共享统计
 * @returns {{cards: number, linked: number}} 处理了几张、其中几张拿到了链接
 */
export function annotateCards(inbound, cfg, stats) {
  const segments = Array.isArray(inbound?.segments) ? inbound.segments : null;
  if (segments === null || segments.length === 0) return { cards: 0, linked: 0 };

  const max = Number.isFinite(cfg?.maxPerMessage) ? cfg.maxPerMessage : MAX_PER_MESSAGE_DEFAULT;
  const labels = [];
  let cards = 0;
  /**
   * 真正替换掉占位的卡片数，**按段类型分开数**：上游给 `json` 段塞的是
   * `[卡片]`、给 `xml` 段塞的是 `[xml]`（走 `default` 分支），要删得对号。
   */
  const replaced = { json: 0, xml: 0 };
  let linked = 0;

  for (const seg of segments) {
    const type = String(seg?.type ?? '');
    if (!CARD_SEGMENTS.has(type)) continue;
    if (cards >= max) break;
    cards += 1;
    const { url, title } = parseCardSegment(seg);
    if (url !== '') {
      linked += 1;
      replaced[type] += 1;
      labels.push(title === '' ? `[卡片:${url}]` : `[卡片:${title} ${url}]`);
    } else if (title !== '') {
      // 没链接但有标题：仍然比裸 `[卡片]` 有用得多（至少知道在聊什么）。
      replaced[type] += 1;
      labels.push(`[卡片:${title}]`);
    }
  }

  if (labels.length === 0) return { cards, linked };

  // 把**被处理过的那几张**卡片对应的裸占位删掉 —— 否则模型会看到
  // `[卡片] [卡片:标题 …]` 两个东西，还以为发了两次。
  //
  // 按类型分开删、且只删实际替换掉的那些：没解析出内容的卡片、以及超过
  // `maxPerMessage` 的那些我们没碰，它们的占位必须留着，否则卡片会
  // **凭空消失**（比看不懂更糟）。
  if (typeof inbound.text === 'string') {
    let text = inbound.text;
    for (const [type, count] of Object.entries(replaced)) {
      if (count === 0) continue;
      const placeholder = type === 'xml' ? '[xml]' : '[卡片]';
      let budget = count;
      let at = text.indexOf(placeholder);
      while (at >= 0 && budget > 0) {
        text = text.slice(0, at) + text.slice(at + placeholder.length);
        budget -= 1;
        at = text.indexOf(placeholder);
      }
    }
    inbound.text = text;
  }

  const suffix = labels.join('');
  stats.linkcardAnnotated = (stats.linkcardAnnotated ?? 0) + labels.length;
  stats.linkcardLinked = (stats.linkcardLinked ?? 0) + linked;
  inbound.text = `${(inbound.text ?? '').trim()}${inbound.text?.trim() ? ' ' : ''}${suffix}`;
  return { cards, linked };
}

/** 本模块默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  /** 总开关。关掉就完全不动文本（上游的 `[卡片]` 原样留着）。 */
  enabled: true,
  /** 一条消息最多展开几张卡片。 */
  maxPerMessage: MAX_PER_MESSAGE_DEFAULT,
};

/**
 * 造 `processInbound` 的包装（纯函数工厂，`core/patch.js` 要求）。
 *
 * @param {object} options
 * @param {Function} options.original 上一层
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level: string, message: string) => void} options.log
 * @returns {Function}
 */
export function makeLinkCardProcessInbound({ original, cfg, stats, log }) {
  return async function companionLinkCardProcessInbound(inbound) {
    if (cfg?.enabled === false) return original.call(this, inbound);
    try {
      annotateCards(inbound, cfg, stats);
    } catch (error) {
      // 注解失败绝不能影响消息投递。
      stats.linkcardLastError = describeThrown(error);
      log?.('warn', `卡片解析失败: ${describeThrown(error)}`);
    }
    return original.call(this, inbound);
  };
}

/**
 * 造一个 linkcard 模块实例（与其余模块同构：`scan` + `detach` + `selfTest`）。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {Function} options.patchMethod
 * @param {(level: string, message: string) => void} options.log
 */
export function createLinkCard({ cfg, stats, patchMethod, log }) {
  async function scan(ctx) {
    stats.linkcardEnabled = cfg?.enabled !== false;
    if (cfg?.enabled === false) {
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.linkcardResolveError = found.error;
      return { ok: false, error: found.error };
    }

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;
    if (patchMethod(proto, 'processInbound', MODULE_ID, (original) =>
      makeLinkCardProcessInbound({ original, cfg, stats, log }), rel)) {
      patched += 1;
    }
    return { ok: true, patched };
  }

  /** 摘闸：`enabled:false` 时必须把上一轮挂的层剥掉。 */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  return { MODULE_ID, scan, detach, METHODS, TARGET, DEFAULTS };
}
