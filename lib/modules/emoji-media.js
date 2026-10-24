/**
 * 表情与表情包的「图片化」。
 *
 * ## 为什么需要这一层
 *
 * QQ 的两种「表情」在上游是两个不同的坑：
 *
 * 1. **原生小黄脸（`face` 段）** —— `dsh-onebot-qq/lib/cq.js:167` 只做一件事：
 *    `textParts.push(faceToEmoji(seg.data.id))`。而那张 `FACE_EMOJI` 表把 id 当
 *    emoji 码位映射，**整体错位**：329 个 id 里 123 个落到兜底的 `😀`，其余语义
 *    全错。实测铁证 —— 示例用户发 `/变形`(id=312)，表里 312 → 🐳，她于是回
 *    「又发个鲸鱼，你今天是走动物表情包路线喵」。
 *
 * 2. **商城表情包（`image` 段且 `sub_type === '1'`）** —— `cq.js:150` 直接
 *    `textParts.push('[表情包]')` 然后 `return`，**图片根本不进 media 数组、
 *    不下载**。模型只看到四个字。
 *
 * ## 做法
 *
 * 在 `InboundPipeline#processInbound` 的入口（`inbound` 已 normalize，`segments`
 * 还留着原始段）把这两类段捞出来：
 *
 * - 表情 → 用本地 `face-names.js`（329 条，源自 NapCat 的 `sysface-full.json`）
 *   给出**中文名**，写成 `[表情:变形]`。**默认不再下载图片** —— QQ 图床
 *   `qzonestyle.gtimg.cn` 的 `e<id>` 与 sysface id 不是同一套编号，实测
 *   `e182` 是比 V 的手（sysface 182 = 笑哭），图和名字会互相矛盾。
 * - 表情包 → 用段里的 `url` / `file` 走上游 `media.resolve`（自带 SSRF 防护与
 *   大小上限），拿到本地路径。
 *
 * 然后把这些注解追加到消息文本末尾。表情只给名字（零成本、可靠）；表情包给
 * `[表情包][图片:路径]`，因为它的 url 是 QQ 自己给的、跟内容一定对得上。
 *
 * ## 三个刻意的取舍
 *
 * - **不认识的表情只留名字，不瞎猜 emoji**。宁可给 `[表情:id=9999]` 也不给一个
 *   错误的 😀 —— 错了她就会顺着错的意思往下聊。
 * - **原生表情不下图，只给名字**。图床 id 与 sysface id 不是一套（见上），下图
 *   只会制造「名字说变形、图是戴帽子的笑脸」这种自相矛盾。表情包的图是 QQ 自己
 *   给的 url，没有这个问题，照旧下载。
 * - **下载失败只丢路径、不丢名字**。名字是零成本的，图下载失败（断网、图床改版）
 *   不该让整条消息变成乱码。
 * - **扩展名按真实字节改**。图床的 `.gif` 有时回 PNG/WebP 字节，`read_image`
 *   会因此报「扩展名与字节不符」而拒读。
 *
 * @module dsh-onebot-companion/emoji-media
 */

import { open, rename, stat } from 'node:fs/promises';
import { auditMethods } from '../core/patch.js';
import { describeThrown, loadTargetClass, moduleUrl } from '../core/profile.js';
import { faceNameOf } from './face-names.js';

export const MODULE_ID = 'emoji';

/** 挂载目标：入站管线的 `processInbound`（`inbound.segments` 在这里还是原始段）。 */
const TARGET = { file: 'inbound.js', exportName: 'InboundPipeline' };

const METHODS = ['processInbound'];

/** 上游 `cq.js` 的 `faceToEmoji`（要它只是为了**删掉**那些错的 emoji）。 */
const CQ_FILE = 'cq.js';
const CQ_EXPORT = 'faceToEmoji';

/** QQ 官方表情图床（公开、无需登录）。`@2x` 是 2 倍图，24→48 左右。 */
const FACE_IMAGE_URL = (id) => `https://qzonestyle.gtimg.cn/qzone/em/e${id}@2x.gif`;

/** 一条消息里最多处理几个表情 —— 防刷屏时把每条消息都拖成几十次下载。 */
const MAX_PER_MESSAGE_DEFAULT = 6;

/** 按文件头判真实格式（图床扩展名不可信，实测 `.gif` 会回 PNG/WebP）。 */
async function sniffExtension(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const buf = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buf, 0, 12, 0);
    if (bytesRead >= 8 && buf.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return '.png';
    if (bytesRead >= 6) {
      const head = buf.toString('latin1', 0, 6);
      if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
    }
    if (bytesRead >= 12
      && buf.toString('latin1', 0, 4) === 'RIFF'
      && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
    if (bytesRead >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close?.().catch(() => {});
  }
}

/**
 * 确保文件扩展名与真实字节一致；不一致就改名并返回新路径。
 *
 * @param {string} path 下载后的路径
 * @returns {Promise<string>} 可交给 `read_image` 的路径
 */
async function withCorrectExtension(path) {
  const real = await sniffExtension(path);
  if (real === null) return path;
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const current = dot > slash ? path.slice(dot).toLowerCase() : '';
  if (current === real) return path;
  const target = path.slice(0, dot > slash ? dot : path.length) + real;
  try {
    await stat(target);
    // 目标已存在（理论上不会，freshPath 带时间戳+uuid）：不覆盖，就用原名。
    return path;
  } catch {
    /* 不存在才是正常路径 */
  }
  try {
    await rename(path, target);
    return target;
  } catch {
    return path;
  }
}

/**
 * 把一条入站消息里的表情/表情包补成「名字 + 本地图片路径」。
 *
 * **只读 `inbound.segments`，不改上游已解析好的别的字段**，最后只往
 * `inbound.text` 末尾追加几行注解 —— 这是对上游侵入最小的接法。
 *
 * @param {object} inbound `normalizeOneBot11` 的产物（有 segments / text / chatId）
 * @param {object} pipeline `InboundPipeline` 实例（要它的 `ctx.media`）
 * @param {object} cfg 本模块配置
 * @param {object} stats 共享统计
 * @param {(input: {path: string, chatId?: string, userId?: string}) => void} [onSticker]
 *   每成功下载一张**表情包**就回调一次（原生小黄脸不算）。用来喂表情包图库
 *   （`sticker-lib.js`）—— 图已经在这儿落地了，复用它省的是一次重复下载。
 *   回调里抛错不会影响注解，见下方 try/catch。
 * @throws 不会抛 —— 任何失败都只是少一条路径注解
 */
export async function annotateEmoji(inbound, pipeline, cfg, stats, onSticker) {
  const segments = Array.isArray(inbound?.segments) ? inbound.segments : null;
  if (segments === null || segments.length === 0) return undefined;
  const media = pipeline?.ctx?.media;
  if (!media) return undefined;

  const max = Number.isFinite(cfg?.maxPerMessage) ? cfg.maxPerMessage : MAX_PER_MESSAGE_DEFAULT;
  const wanted = [];
  for (const seg of segments) {
    if (wanted.length >= max) break;
    if (seg?.type === 'face') {
      wanted.push({ kind: 'face', id: String(seg?.data?.id ?? '').trim() });
    } else if (seg?.type === 'image') {
      const subType = seg?.data?.sub_type ?? seg?.data?.['sub-type'];
      if (String(subType ?? '') !== '1') continue;
      wanted.push({
        kind: 'sticker',
        url: typeof seg?.data?.url === 'string' ? seg.data.url : '',
        file: typeof seg?.data?.file === 'string' ? seg.data.file : '',
      });
    }
  }
  if (wanted.length === 0) return { unknownFaces: 0 };

  // 表情包：上游给每个 `sub_type=1` 的图都往文本里塞了一个 `[表情包]`，但图片
  // 本身没进 media 数组。我们要在后面补「名字 + 路径」，所以先把那几个空壳
  // 占位删掉 —— 否则会读成 `[表情包] [表情包][图片:...]`。
  const stickerCount = wanted.filter((item) => item.kind === 'sticker').length;
  if (stickerCount > 0 && typeof inbound.text === 'string') {
    let text = inbound.text;
    for (let i = 0; i < stickerCount; i += 1) {
      const at = text.indexOf('[表情包]');
      if (at < 0) break;
      text = text.slice(0, at) + text.slice(at + '[表情包]'.length);
    }
    inbound.text = text;
  }

  const lines = [];
  let unknownFaces = 0;
  for (const item of wanted) {
    let label;
    let ref;
    if (item.kind === 'face') {
      if (item.id === '') continue;
      // 名字表先查出来，**不管 `names` 开关**：认不认识是事实，要不要显示是配置。
      // 混在一起写会让 `names: false` 把所有表情都误判成「认不出」。
      const resolvedName = faceNameOf(item.id);
      const known = cfg?.names !== false ? resolvedName : null;
      label = known === null ? `[表情:id=${item.id}]` : `[表情:${known}]`;
      // 认不出来的表情（不在 329 条 sysface 表里，比如新表情或非标准 id）——
      // 2026-10-18 用户要求「表情认不出别回，装死」，且明确选「那条消息整个
      // 不回」。这里只负责**数出来**，吞不吞由 `makeEmojiProcessInbound` 决定，
      // 因为能不能吞属于流程决策，不该混在文本注解里。
      if (resolvedName === null) unknownFaces += 1;
      // 2026-10-18 实测否决了「下表情图给她看」这条路：`qzonestyle.gtimg.cn` 的
      // `e<id>` **不是** QQ 的 sysface id，是另一套图库编号。像素级证据 ——
      // e182 是一只手比 V（sysface 182 = 笑哭）、e312 是戴金冠的笑脸（sysface
      // 312 = 变形）、e106 是卡通婴儿（sysface 106 = 委屈）、e99 只有 1×1 空白。
      // 同一句文本里「名字」和「图」互相矛盾，比只有名字更糟。所以默认只给名字；
      // `downloadFaces` 打开时才去试（只在确认 id 对齐后才该开）。
      if (cfg?.downloadFaces !== true) {
        lines.push(label);
        continue;
      }
      ref = { kind: 'image', url: FACE_IMAGE_URL(item.id) };
    } else {
      label = '[表情包]';
      ref = { kind: 'image', url: item.url || undefined, file: item.file || undefined };
      if (!ref.url && !ref.file) {
        lines.push(label);
        continue;
      }
    }

    let path = '';
    try {
      const resolved = await media.resolve(ref, async (kind, file) => {
        if (kind !== 'image' || !file) return undefined;
        try {
          const data = await pipeline.ctx.call('get_image', { file });
          return { url: data?.url, file: data?.file };
        } catch {
          return undefined;
        }
      });
      if (resolved?.path) path = await withCorrectExtension(resolved.path);
    } catch (error) {
      stats.emojiLastError = describeThrown(error);
    }

    if (path === '') {
      stats.emojiNoPath = (stats.emojiNoPath ?? 0) + 1;
      lines.push(label);
    } else {
      stats.emojiResolved = (stats.emojiResolved ?? 0) + 1;
      // 名字和路径都给：图小，语义主要靠名字；路径让 read_image 有东西读。
      lines.push(`${label}[图片:${path}]`);
      // 入库只针对**表情包**（商城贴纸）：它是一张真图，入图库以后能再发出去。
      // 原生小黄脸的图不是真图（`downloadFaces` 默认关，且 id 对不齐），不收。
      if (item.kind === 'sticker' && typeof onSticker === 'function') {
        try {
          onSticker({
            path,
            chatId: typeof inbound?.chatId === 'string' ? inbound.chatId : '',
            userId: typeof inbound?.userId === 'string' ? inbound.userId : '',
          });
        } catch (error) {
          // 图库坏了不该让表情注解失败 —— 这条路径的价值本来就只是「顺手收下」。
          stats.stickerLastError = describeThrown(error);
        }
      }
    }
  }
  if (lines.length === 0) return { unknownFaces };
  stats.emojiAnnotated = (stats.emojiAnnotated ?? 0) + lines.length;
  const suffix = lines.join('');
  inbound.text = `${inbound.text ?? ''}${inbound.text ? ' ' : ''}${suffix}`;
  return { unknownFaces };
}

/** 本模块默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  /**
   * 是否把表情转成图片。
   *
   * 关掉也**保留中文名**（`names` 单独控制）—— 名字是纯文本，没有成本，
   * 关它只会让模型重新回到瞎猜 emoji 的状态。
   */
  enabled: true,
  /** 是否附中文名（`face-names.js` 的 329 条表）。 */
  names: true,
  /**
   * 是否还要把原生表情**下载成图片**给她看。
   *
   * 默认关 —— 2026-10-18 实测 `qzonestyle.gtimg.cn` 的 `e<id>` 与 QQ 的 sysface
   * id 不是同一套（e182 是比 V 的手、sysface 182 是笑哭），图和名字会互相矛盾。
   * 名字已经足够，图反而是噪音。只在确认 id 对齐之后才该打开。
   */
  downloadFaces: false,
  /** 一条消息最多处理几个表情/表情包。 */
  maxPerMessage: MAX_PER_MESSAGE_DEFAULT,
  /**
   * 认不出的表情要不要**整条消息吞掉**（不回）。
   *
   * 2026-10-18 用户要求：「表情认不出别回，装死」。他选的正是最保守的那一档 ——
   * 那条消息整个不回，而不是回一句「我看不懂」。理由是：认不出还要接话，只能
   * 瞎猜或者答非所问，两种都比沉默更难看。
   *
   * 判据只看**原生表情（face 段）且 id 不在 329 条表里**。表情包（商城贴纸）
   * 不受影响 —— 那些是图片，能真读。
   */
  muteUnknownFaces: true,
};

/**
 * 把上游为 `face` 段塞进文本的那些 **emoji 占位**删掉。
 *
 * 为什么必须删：上游 `cq.js:167` 对每个 face 段 `textParts.push(faceToEmoji(id))`，
 * 而那张表是错的（`/变形`(312) → 🐳）。如果我们只在后面追加 `[表情:变形]`，模型
 * 会同时看到「🐳」和「变形」两个互相矛盾的信号 —— 而**错误的那个更显眼**（表情
 * 字符在文本里，注解在末尾）。2026-10-18 她回「又发个鲸鱼」的直接原因就是它。
 *
 * 做法：按段顺序一个个找、一个个删。找不到（上游换了实现）就跳过，不报错。
 *
 * @param {string} text 上游解析出的文本
 * @param {object[]} segments 原始段
 * @param {(id: string) => string} faceToEmoji 上游的映射（可能返回兜底 😀）
 * @returns {string}
 */
export function stripFaceGlyphs(text, segments, faceToEmoji) {
  let out = String(text ?? '');
  if (typeof faceToEmoji !== 'function' || !Array.isArray(segments)) return out;
  let cursor = 0;
  for (const seg of segments) {
    if (seg?.type !== 'face') continue;
    let glyph;
    try {
      glyph = faceToEmoji(String(seg?.data?.id ?? ''));
    } catch {
      continue;
    }
    if (typeof glyph !== 'string' || glyph === '') continue;
    let at = out.indexOf(glyph, cursor);
    if (at < 0) at = out.indexOf(glyph);
    if (at < 0) continue;
    out = out.slice(0, at) + out.slice(at + glyph.length);
    cursor = at;
  }
  return out;
}

/**
 * 造 `processInbound` 的包装。
 *
 * 抽成工厂是为了可测。注意**包装函数必须是纯函数**（`core/patch.js` 的
 * 链重排会重造所有层），所以配置、统计、上游函数都通过参数闭包传入。
 *
 * @param {object} options
 * @param {Function} options.original 上一层
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level: string, message: string) => void} options.log
 * @param {{ faceToEmoji: ((id: string) => string)|null }} options.state
 *   上游 `cq.js` 的 `faceToEmoji`（扫不到就为 null，此时不删 emoji）。
 * @param {(input: {path: string, chatId?: string, userId?: string}) => void} [options.onSticker]
 *   表情包落地后的回调（喂图库用，见 `annotateEmoji`）。刻意放在 `state` 外面：
 *   它要读**当下**的图库实例，而 `state` 对象是给「上游函数引用」用的。
 * @returns {Function}
 */
export function makeEmojiProcessInbound({ original, cfg, stats, log, state, onSticker }) {
  return async function companionEmojiProcessInbound(inbound) {
    if (cfg?.enabled === false) return original.call(this, inbound);
    try {
      if (Array.isArray(inbound?.segments)) {
        inbound.text = stripFaceGlyphs(inbound.text, inbound.segments, state?.faceToEmoji);
      }
      const result = await annotateEmoji(inbound, this, cfg, stats, onSticker);
      // 「表情认不出别回，装死」（2026-10-18 用户要求，且明确选「那条消息整个
      // 不回」）：这条消息只要带了**一个**认不出的 QQ 表情，整条不进管线。
      // 直接 `return undefined` 而不是改文本 —— 让模型「看到却别回」既不可靠，
      // 也还是要花一次生成；根本不投递才是真正的静默。
      if ((result?.unknownFaces ?? 0) > 0 && cfg?.muteUnknownFaces !== false) {
        stats.emojiMuted = (stats.emojiMuted ?? 0) + 1;
        stats.lastEmojiMuted = {
          at: Date.now(),
          chatId: typeof inbound?.chatId === 'string' ? inbound.chatId : '',
          ids: Array.isArray(inbound?.segments)
            ? inbound.segments
              .filter((s) => s?.type === 'face')
              .map((s) => String(s?.data?.id ?? ''))
              .filter((id) => id !== '' && faceNameOf(id) === null)
            : [],
          text: typeof inbound?.text === 'string' ? inbound.text.slice(0, 80) : '',
        };
        return undefined;
      }
    } catch (error) {
      // 注解失败绝不能影响消息投递 —— 上游原样走。
      stats.emojiLastError = describeThrown(error);
      log?.('warn', `表情注解失败: ${describeThrown(error)}`);
    }
    return original.call(this, inbound);
  };
}

/** 取上游 `cq.js#faceToEmoji`；拿不到就返回 null（此时不删 emoji，注解照做）。 */
async function loadUpstreamFaceToEmoji(ctx, cfg) {
  const url = moduleUrl(ctx, cfg, CQ_FILE);
  if (url === null) return null;
  try {
    const mod = await import(url);
    const fn = mod?.[CQ_EXPORT];
    return typeof fn === 'function' ? fn : null;
  } catch {
    return null;
  }
}

/**
 * 造一个 emoji 模块实例（与其余模块同构：`scan` + `detach` + `selfTest`）。
 *
 * 挂载点选 `InboundPipeline.prototype.processInbound` 而不是
 * `ChatBridge.prototype.processInbound`：前者是 `inbound.segments` 还在原始形态、
 * `inbound.text` 还没被 `buildBody` 处理完的那一层，改了之后同一条消息后续所有环节
 * （转发、引用、wrap）都自然带着注解。
 *
 * @param {object} options
 * @param {object} options.stats 共享统计
 * @param {Function} options.patchMethod `core/patch.js` 的挂载器
 * @param {(level: string, message: string) => void} options.log
 * @param {(input: {path: string, chatId?: string, userId?: string}) => void} [options.onSticker]
 *   每收到一张表情包就回调一次（喂 `sticker-lib.js` 的图库）。可选：没接就是
 *   老行为，只注解不进库。
 */
export function createEmoji({ cfg, stats, patchMethod, log, onSticker }) {
  /**
   * 上游 `faceToEmoji` 的**可变引用**。
   *
   * 为什么放在对象里而不是闭包里：`core/patch.js` 要求 `makeWrapper` 是纯函数
   * （链重排会重造所有层），包装函数只能通过参数闭包拿到值。若把函数直接闭包
   * 进去，第一轮扫描拿到 null 之后就永远是 null 了 —— 上游晚一点才挂上时，
   * 错误的 emoji 就删不掉。放进 state 对象，每次调用读的是**当下**的值。
   */
  const state = { faceToEmoji: null };

  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.emojiEnabled = cfg?.enabled !== false;

    if (cfg?.enabled === false) {
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.emojiResolveError = found.error;
      return { ok: false, error: found.error };
    }

    // 拿不到 faceToEmoji 也**照常挂**：那只影响「删不删错的 emoji」，
    // 而真正的价值（中文名 + 图片路径）不依赖它。
    const upstream = await loadUpstreamFaceToEmoji(ctx, cfg);
    state.faceToEmoji = upstream;
    stats.emojiResolveError = upstream === null ? `无法加载上游 ${CQ_FILE}#${CQ_EXPORT}` : null;
    stats.emojiProfileDir = found.profileDir;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;
    if (patchMethod(proto, 'processInbound', MODULE_ID, (original) =>
      makeEmojiProcessInbound({ original, cfg, stats, log, state, onSticker }), rel)) {
      patched += 1;
    }

    return { ok: true, patched };
  }

  /** 摘闸：`enabled:false` 时必须把上一轮挂的层剥掉，否则旧闸还在。 */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  return { MODULE_ID, scan, detach, state, METHODS, TARGET };
}
