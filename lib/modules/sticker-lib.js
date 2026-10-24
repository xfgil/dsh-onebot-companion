/**
 * dsh-onebot-companion / modules/sticker-lib.js
 *
 * 表情包图库：别人发的贴纸自动存下来，以后自己挑着用。
 *
 * ## 为什么需要它
 *
 * 2026-10-21 用户丢来一个社区的 QQ 插件（`zaofan-make/dsh-qqbot`），里面有一
 * 件事我们完全没有：**群里发的图自动入库、去重、分档，她要发图时自己搜库挑**。
 *
 * 现状是另一头：`emoji-media.js` 会把每条消息里的商城表情包**下载到 mediaDir**，
 * 但下完就不管了 —— 那条消息一过，路径还在磁盘上，可她**再也不会想起来**那张图
 * 存在。她手上只有 `faces.js` 里 321 个原生小黄脸的名字，表情包一张也发不出来。
 *
 * 所以这个模块补的是「存下来」之后的那半截：
 *
 *   消息 → emoji-media 下载 → **本模块按内容 hash 入库** → 以后能 list / search
 *        → 拿到本地路径 → 用 `qq_send_image` 发出去
 *
 * ## 三个刻意的取舍
 *
 * - **按内容 hash 去重，不按文件名**。QQ 给的文件名带时间戳与 uuid，同一张图
 *   转发十次就是十个名字；只有 sha256 能认出「这是同一张」。
 * - **入库不删除、不入库不失败**。`emoji-media` 那边已经把图下好了，这里只是
 *   复制一份进图库。复制失败（磁盘满、权限）只记一条统计，**绝不让消息投递挂掉**。
 * - **图库是目录 + 一张表**。文件落在 `mediaDir/stickers/`，元数据在
 *   `stickers-state.json`。删掉 json 不会删图，删掉图不会崩 —— 表里找不到文件
 *   的条目在 list 时自动跳过并标 `missing`。
 *
 * ## 与 `diary` / `echo` 的分工
 *
 * `diary` 记的是**话**（她说给自己听的），`echo` 记的是**语气**，这里是**图**。
 * 三者都是「她自己攒下来的东西」，都不碰入参、不挂 guard。
 *
 * ## 设计约束（与 diary.js 一致）
 *
 *   1. 纯函数部分（`hashOf` / `makeEntry` / `pickStickers` / `pruneStickers`）
 *      零 import，离线单测可裸 node 直接 import；
 *   2. 时间一律走调用方传入的 `now`，模块内部不读 `Date.now()`；
 *   3. 容量上限硬性生效（默认 500 条），淘汰顺序 = 先回收站 → 再最久没用 → 再旧。
 *
 * @module dsh-onebot-companion/modules/sticker-lib
 */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const MODULE_ID = 'sticker';

export const DEFAULTS = {
  /** 总开关。关掉只是不入库，`emoji-media` 的下图行为不受影响。 */
  enabled: true,
  /** 图库子目录（相对 mediaDir）。 */
  dir: 'stickers',
  /** 元数据文件名（落在 mediaDir 下）。 */
  stateFile: 'stickers-state.json',
  /** 表容量上限，超了按「先回收站 → 再最久没用 → 再旧」淘汰。 */
  maxEntries: 500,
  /** 小于这个字节数的不收（多半是破图、占位图）。 */
  minBytes: 1024,
  /** 大于这个字节数的不收（防止一条消息塞进来一个 20M 的 GIF）。 */
  maxBytes: 8 * 1024 * 1024,
  /** `qq_sticker list` 默认返回几条。 */
  listMax: 20,
};

/** 条目状态：正常 / 回收站（用户或她自己划掉的，不再出现在搜索里）。 */
export const STATUSES = ['active', 'recycled'];

/**
 * 内容的 sha256。
 *
 * 用它当身份：同一张图转发十次、改十次文件名，hash 都不变。取前 16 位做 id，
 * 后面留全量 hash 方便将来做「近似重复」（不同编码的同图 hash 不同，那是另一件事）。
 *
 * @param {Buffer|Uint8Array} bytes
 * @returns {string} 64 位小写 hex
 */
export function hashOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 16 位短 id —— 够用，也不至于让模型复述一长串 hex。 */
export function shortId(hash) {
  return String(hash ?? '').slice(0, 16);
}

/**
 * 造一条图库记录。纯函数，不做 IO。
 *
 * @param {object} input
 * @param {string} input.hash 内容 sha256
 * @param {string} input.path 图库里的绝对路径
 * @param {number} input.bytes 字节数
 * @param {number} input.at 入库时间
 * @param {string} [input.chatId] 从哪个会话收到的
 * @param {string} [input.userId] 谁发的
 * @param {string} [input.note] 她自己写的一句话描述
 * @returns {object}
 */
export function makeEntry({ hash, path, bytes, at, chatId, userId, note }) {
  return {
    id: shortId(hash),
    hash: String(hash ?? ''),
    path: String(path ?? ''),
    bytes: Number.isFinite(bytes) ? bytes : 0,
    at: Number.isFinite(at) ? at : 0,
    chatId: typeof chatId === 'string' ? chatId : '',
    userId: typeof userId === 'string' ? userId : '',
    note: typeof note === 'string' ? note : '',
    status: 'active',
    useCount: 0,
    lastUsedAt: 0,
  };
}

/** 表里每条记录的形状校验（从 json 读回来的东西不能全信）。 */
export function isEntryOk(value) {
  return (
    value !== null
    && typeof value === 'object'
    && typeof value.id === 'string'
    && value.id !== ''
    && typeof value.path === 'string'
    && value.path !== ''
    && Number.isFinite(value.at)
  );
}

/**
 * 搜索与挑图。纯函数。
 *
 * 匹配顺序：`note`（她自己的描述）优先于 `chatId` / `userId`（谁发的）——
 * 「找个开心的」这种意图只有 note 能满足，而「他发的那张」靠 userId。
 *
 * 排序按「用过几次 + 多久没用」综合，让常用的图更容易被挑中，但不会永远
 * 只出那几张（`lastUsedAt` 越近得分越低）。
 *
 * @param {object[]} entries
 * @param {object} [query]
 * @param {string} [query.text] 关键词（空 = 不过滤）
 * @param {string} [query.chatId] 只从某个会话收到的
 * @param {string} [query.userId] 只从某个人那儿收到的
 * @param {boolean} [query.includeRecycled] 是否包含回收站
 * @param {number} [query.limit]
 * @param {number} [query.now]
 * @returns {object[]}
 */
export function pickStickers(entries, query = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const text = String(query.text ?? '').trim().toLowerCase();
  const chatId = String(query.chatId ?? '');
  const userId = String(query.userId ?? '');
  const includeRecycled = query.includeRecycled === true;
  const now = Number.isFinite(query.now) ? query.now : 0;
  const limit = Number.isFinite(query.limit) && query.limit > 0 ? query.limit : DEFAULTS.listMax;

  const hits = list.filter((entry) => {
    if (!isEntryOk(entry)) return false;
    if (!includeRecycled && entry.status === 'recycled') return false;
    if (chatId !== '' && entry.chatId !== chatId) return false;
    if (userId !== '' && entry.userId !== userId) return false;
    if (text === '') return true;
    return String(entry.note ?? '').toLowerCase().includes(text);
  });

  // 得分：用过的图 +2/次（封顶 6），最近用过的扣分（60 秒内用过 -6，一小时 -3）。
  // 目的是「别每次都发同一张」，而不是做真正的推荐。
  const score = (entry) => {
    const used = Math.min(Number(entry.useCount ?? 0) * 2, 6);
    let recency = 0;
    if (now > 0 && Number(entry.lastUsedAt ?? 0) > 0) {
      const ago = now - entry.lastUsedAt;
      if (ago < 60_000) recency = -6;
      else if (ago < 3_600_000) recency = -3;
    }
    return used + recency;
  };

  return hits
    .slice()
    .sort((a, b) => {
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return Number(b.at ?? 0) - Number(a.at ?? 0);
    })
    .slice(0, limit);
}

/**
 * 容量控制。纯函数。
 *
 * 淘汰顺序：回收站最先（反正已经不要了）→ 再「从没用过且最旧」→ 再「最久没用」。
 * 不设上限的话这个表会无限长大 —— 它跟 `diary` 一样，是只增不减的表。
 *
 * @param {object[]} entries
 * @param {object} cfg
 * @returns {object[]} 留下来的条目（按 at 升序）
 */
export function pruneStickers(entries, cfg = DEFAULTS) {
  const list = (Array.isArray(entries) ? entries : []).filter(isEntryOk).slice();
  const max = Number.isFinite(cfg?.maxEntries) && cfg.maxEntries > 0
    ? cfg.maxEntries
    : DEFAULTS.maxEntries;
  if (list.length <= max) return list.sort((a, b) => Number(a.at) - Number(b.at));

  const weight = (entry) => {
    if (entry.status === 'recycled') return 0;          // 最该扔
    const used = Number(entry.useCount ?? 0);
    if (used <= 0) return 1;                            // 从没用过
    return 2;                                           // 用过，尽量留
  };
  const sorted = list.slice().sort((a, b) => {
    const diff = weight(a) - weight(b);
    if (diff !== 0) return diff;
    const lastA = Number(a.lastUsedAt ?? 0) || Number(a.at ?? 0);
    const lastB = Number(b.lastUsedAt ?? 0) || Number(b.at ?? 0);
    return lastA - lastB;                               // 越久没用越靠前
  });
  return sorted.slice(sorted.length - max).sort((a, b) => Number(a.at) - Number(b.at));
}

/** 条目对模型的可读描述（工具返回值里用）。 */
export function describeEntry(entry) {
  const parts = [`id=${entry.id}`];
  if (entry.note !== '') parts.push(`「${entry.note}」`);
  if (entry.userId !== '') parts.push(`来自 ${entry.userId}`);
  if (Number(entry.useCount ?? 0) > 0) parts.push(`用过 ${entry.useCount} 次`);
  if (entry.status === 'recycled') parts.push('[回收站]');
  parts.push(entry.path);
  return parts.join(' · ');
}

/**
 * 造一个图库实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats 共享统计
 * @param {(level: string, message: string) => void} [options.log]
 * @param {() => string} options.resolveMediaDir 取 mediaDir（惰性，装配时还没有）
 */
export function createStickerLib({ cfg, stats, log, resolveMediaDir }) {
  /** @type {object[]} 内存表，按 at 升序。 */
  let entries = [];
  let store = null;
  let loading = null;
  let dirReady = null;
  const say = typeof log === 'function' ? log : () => undefined;

  const enabled = () => cfg?.enabled !== false;

  function mediaDir() {
    try {
      return typeof resolveMediaDir === 'function' ? resolveMediaDir() : '';
    } catch {
      return '';
    }
  }

  /** 图库目录绝对路径；mediaDir 未配置时返回空串（此时整个模块静默失效）。 */
  function libDir() {
    const base = mediaDir();
    if (typeof base !== 'string' || base === '') return '';
    return join(base, cfg?.dir ?? DEFAULTS.dir);
  }

  async function ensureDir() {
    if (dirReady !== null) return dirReady;
    const dir = libDir();
    if (dir === '') return '';
    dirReady = mkdir(dir, { recursive: true })
      .then(() => dir)
      .catch((error) => {
        say('warn', `表情包图库目录建不了: ${error?.message ?? error}`);
        return '';
      });
    return dirReady;
  }

  async function ensureStore() {
    // 已经建过：**必须等加载完成**再返回。
    //
    // 这里有一个很容易踩的坑：`JsonStore.loadFrom` 是**内存优先**的。若在
    // `load()` 还没回来的时候先 `store.set('entries', entries)`（此时 `entries`
    // 只有刚收到的那一张），随后加载回来会发现「这个键内存里已经有了」，于是
    // 磁盘上那份历史被整个跳过 —— 图库每次重启都只剩最后一张。
    // 所以凡是拿到 store 的地方，都要先等 `loading`。
    if (store !== null) {
      if (loading !== null) await loading;
      return store;
    }
    if (loading !== null) {
      await loading;
      return store;
    }
    const base = mediaDir();
    if (typeof base !== 'string' || base === '') return null;
    const { JsonStore, stateFilePath } = await import('../core/jsonstore.js');
    const file = stateFilePath(base, cfg?.stateFile ?? DEFAULTS.stateFile);
    if (file === undefined) return null;
    store = new JsonStore({
      file,
      log: say,
      label: 'stickers',
      normalize: (value) => (Array.isArray(value) ? value.filter(isEntryOk) : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('entries');
        entries = Array.isArray(raw) ? raw.filter(isEntryOk) : [];
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('entries', entries);
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.stickerLastError = String(error?.message ?? error);
    }
  }

  /**
   * 把 `emoji-media` 已经下好的一张表情包收进图库。
   *
   * **任何失败都只是少一张图**：这里抛错会让整条消息投递挂掉，那是不可接受的
   * —— 图库再有用，也不值得让聊天失败。
   *
   * @param {object} input
   * @param {string} input.path 已下载的本地路径
   * @param {string} [input.chatId]
   * @param {string} [input.userId]
   * @param {number} [input.now]
   * @returns {Promise<object|null>} 入库的条目；跳过了返回 null
   */
  async function ingest({ path, chatId, userId, now }) {
    if (!enabled()) return null;
    if (typeof path !== 'string' || path === '') return null;
    try {
      const dir = await ensureDir();
      if (dir === '') return null;

      const info = await stat(path);
      const bytes = Number(info.size);
      const min = Number.isFinite(cfg?.minBytes) ? cfg.minBytes : DEFAULTS.minBytes;
      const max = Number.isFinite(cfg?.maxBytes) ? cfg.maxBytes : DEFAULTS.maxBytes;
      if (!Number.isFinite(bytes) || bytes < min || bytes > max) {
        stats.stickerSkipped = (stats.stickerSkipped ?? 0) + 1;
        return null;
      }

      const { readFile } = await import('node:fs/promises');
      const data = await readFile(path);
      const hash = hashOf(data);

      await ensureStore();

      // 去重：同一个 hash 已经有活的条目就只更新「是谁发的」，不再存第二份。
      const existing = entries.find((e) => e.hash === hash && e.status === 'active');
      if (existing !== undefined) {
        if (typeof userId === 'string' && userId !== '' && existing.userId === '') {
          existing.userId = userId;
        }
        stats.stickerDedup = (stats.stickerDedup ?? 0) + 1;
        persist();
        return existing;
      }

      const ext = (() => {
        const dot = path.lastIndexOf('.');
        const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        const raw = dot > slash ? path.slice(dot).toLowerCase() : '';
        return /^\.[a-z0-9]{2,5}$/.test(raw) ? raw : '.img';
      })();
      const target = join(dir, `${shortId(hash)}${ext}`);
      try {
        await copyFile(path, target);
      } catch (error) {
        // 目标已存在（同名同内容）算成功；其它错误就放弃这张。
        if (error?.code !== 'EEXIST') {
          say('warn', `表情包入库复制失败: ${error?.message ?? error}`);
          stats.stickerSkipped = (stats.stickerSkipped ?? 0) + 1;
          return null;
        }
      }

      const entry = makeEntry({
        hash,
        path: target,
        bytes,
        at: Number.isFinite(now) ? now : 0,
        chatId,
        userId,
      });
      entries.push(entry);
      entries = pruneStickers(entries, cfg);
      persist();
      stats.stickerIngested = (stats.stickerIngested ?? 0) + 1;
      stats.stickerCount = entries.length;
      return entry;
    } catch (error) {
      if (stats) stats.stickerLastError = String(error?.message ?? error);
      return null;
    }
  }

  /** 列 / 搜。返回条目数组（不带 missing 的）。 */
  async function list(query = {}) {
    await ensureStore();
    const hits = pickStickers(entries, { ...query, now: query.now ?? 0 });
    // 顺手核一下文件还在不在：图库是目录，可能被人清过。
    const alive = [];
    for (const entry of hits) {
      let ok = true;
      try {
        await stat(entry.path);
      } catch {
        ok = false;
      }
      if (ok) alive.push(entry);
      else if (stats) stats.stickerMissing = (stats.stickerMissing ?? 0) + 1;
    }
    return alive;
  }

  /** 更新一条：打标签 / 记一次使用 / 回收站 / 捞回来。 */
  async function update(id, patch = {}) {
    await ensureStore();
    const entry = entries.find((e) => e.id === String(id));
    if (entry === undefined) return null;
    if (typeof patch.note === 'string') entry.note = patch.note.slice(0, 120);
    if (patch.markUsed === true) {
      entry.useCount = Number(entry.useCount ?? 0) + 1;
      entry.lastUsedAt = Number.isFinite(patch.now) ? patch.now : 0;
    }
    if (patch.status === 'active' || patch.status === 'recycled') entry.status = patch.status;
    persist();
    return entry;
  }

  /** 统计口（给 `/physical` 之类看）。 */
  function snapshot() {
    const active = entries.filter((e) => e.status === 'active').length;
    return {
      enabled: enabled(),
      count: entries.length,
      active,
      recycled: entries.length - active,
      ingested: stats?.stickerIngested ?? 0,
      dedup: stats?.stickerDedup ?? 0,
      skipped: stats?.stickerSkipped ?? 0,
      lastError: stats?.stickerLastError ?? null,
    };
  }

  return { MODULE_ID, ingest, list, update, snapshot, hashOf, isEntryOk, enabled };
}
