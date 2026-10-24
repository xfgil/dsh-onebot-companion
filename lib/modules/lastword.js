/**
 * dsh-onebot-companion / modules/lastword.js
 *
 * 记一笔「她最后一次真正开口是什么时候」。
 *
 * ## 为什么单独一个模块只干这个
 *
 * 2026-10-19 用户发来一张别人家的面板截图（卡戎控制台），里头有一行
 * 「她最后说话 19:31:19」。那一行是整张图里最有用的东西：
 *
 *   进程活着 ≠ 她还好着。agent 卡在某个 step 上、上游模型一直超时、
 *   会话被别的东西堵住 —— 这些情况下所有「√ 开着」都照样是绿的，
 *   只有「她已经三小时没说过话」能看出来。
 *
 * 我们这边原本没有任何一个字段回答这个问题：`burst.replies` 只在分条时加，
 * `voice.lastSentAt` 只在发语音时更新，`faces` 只算表情。都不通用。
 *
 * ## 为什么不做成 guard 的一部分
 *
 * guard 是闸门，可以被配置关掉；这一笔记录跟「要不要拦脏话」没有关系。
 * 混进去的话，关掉 guard 就顺带让「最后开口」永远停在旧值 —— 正是这个字段
 * 最不该失真的场景。
 *
 * ## 挂在哪儿
 *
 * `OutboundPipeline.prototype` 的 `sendToChat` / `sendMsg` —— 与 guard 同一个
 * 出口。所有出站（模型回复、分条后的每一条、命令回执、插件内部投递）都从
 * 这两个方法走，所以不管她是怎么说的，这里都能看见。
 *
 * 只记录，不改参数、不改返回值、不抛错。任何异常都吞掉：记不上时间不该
 * 影响发消息。
 *
 * @module dsh-onebot-companion/modules/lastword
 */

import { loadTargetClass, describeThrown } from '../core/profile.js';
import { auditMethods } from '../core/patch.js';

export const MODULE_ID = 'lastword';

/** 挂载点。与 guard 同一个类，但方法各自独立。 */
const TARGET = { file: 'outbound.js', exportName: 'OutboundPipeline' };
const METHODS = ['sendToChat', 'sendMsg'];

/** 最多保留多少条最近发言（面板上扫最近几句就够）。 */
const RECENT_MAX = 20;

/**
 * 从 segments 里拼出文本（只为留个片段，不参与发送）。
 * @param {unknown} segments
 * @returns {string}
 */
export function textOfSegments(segments) {
  if (!Array.isArray(segments)) return '';
  return segments
    .map((s) => (s && typeof s === 'object' && s.type === 'text' ? (s.data?.text ?? '') : ''))
    .join('')
    .trim();
}

/**
 * 把毫秒差写成「3 分钟前」这种人话（面板上直接显示）。
 * @param {number|null} at
 * @param {number} [now]
 * @returns {string}
 */
export function humanAgo(at, now = Date.now()) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '还没说过话';
  const ms = now - at;
  if (ms < 0) return '刚刚';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 创建「最后开口」记录器。
 *
 * @param {object} options
 * @param {object} options.cfg - `{ enabled, packageName, profileDir }`
 * @param {object} options.stats - 共享统计对象
 * @param {Function} options.patchMethod - core/patch 的挂载器
 * @param {(level: string, message: string) => void} options.log
 */
export function createLastWord({ cfg, stats, patchMethod, log }) {
  /** 最近几条出站发言（新的在后）。 */
  const recent = [];
  /** 自测/静默开关：为真时不写统计。 */
  let suspended = false;

  const ctl = {
    get suspended() {
      return suspended;
    },
    set suspended(value) {
      suspended = value === true;
    },
  };

  function note(chatId, text, via) {
    if (ctl.suspended) return;
    if (typeof text !== 'string' || text.trim() === '') return;
    const at = Date.now();
    const chat = typeof chatId === 'string' ? chatId : null;
    // `sendToChat` 内部最终会调 `sendMsg` 把文字投出去，同一条消息会经过我们两层。
    // 不合并的话「一条消息」在面板上变成两次、via 还会被里层覆盖成 sendMsg。
    // 判据刻意收紧（同会话 + 同正文 + 1 秒内），宁可偶尔把两条一模一样的连发合并，
    // 也不要把真·两条消息算成一条。
    if (
      stats.lastWordAt !== undefined &&
      at - stats.lastWordAt < 1000 &&
      stats.lastWordChat === chat &&
      stats.lastWordText === text.slice(0, 200)
    ) {
      stats.lastWordAt = at;
      return;
    }
    stats.lastWordAt = at;
    stats.lastWordChat = chat;
    stats.lastWordText = text.slice(0, 200);
    stats.lastWordVia = via;
    stats.lastWordCount = (stats.lastWordCount ?? 0) + 1;
    recent.push({ at, chatId: chat, text: text.slice(0, 200), via });
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
  }

  /**
   * 一次补挂扫描。与 guard 的 scan 同构（体检 → 逐方法 patchMethod）。
   * @returns {Promise<{ok: boolean, error?: string, patched?: number}>}
   */
  async function scan(ctx) {
    if (cfg.enabled === false) return { ok: true, patched: 0 };
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (found.ok !== true) {
      stats.lastWordError = found.error ?? 'load target failed';
      return { ok: false, error: stats.lastWordError };
    }

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      if (!Array.isArray(stats.lost)) stats.lost = [];
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;

    if (
      patchMethod(
        proto,
        'sendToChat',
        MODULE_ID,
        (original) =>
          function companionLastWordSendToChat(chatId, text, options = {}) {
            try {
              note(chatId, typeof text === 'string' ? text : '', 'sendToChat');
              // 顺手记下出站管线的 ctx：体检表要问「OneBot 现在连着吗」，
              // 而 `ctx.connected()` 是这个问题的唯一权威回答（outbound.js:59
              // 自己就用它决定发还是排队）。`stats` 跨热重载复用，所以哪怕刚重载、
              // `persona.state.lastReceiver` 还没等到下一条入站消息，这个引用还在。
              stats.lastWordOutboundCtx = this.ctx;
            } catch (error) {
              log('warn', `记录最后开口失败: ${describeThrown(error)}`);
            }
            return original.call(this, chatId, text, options);
          },
        rel,
      )
    ) {
      patched += 1;
    }

    if (
      patchMethod(
        proto,
        'sendMsg',
        MODULE_ID,
        (original) =>
          function companionLastWordSendMsg(chatId, segments, options) {
            try {
              note(chatId, textOfSegments(segments), 'sendMsg');
              stats.lastWordOutboundCtx = this.ctx;
            } catch (error) {
              log('warn', `记录最后开口失败: ${describeThrown(error)}`);
            }
            return original.call(this, chatId, segments, options);
          },
        rel,
      )
    ) {
      patched += 1;
    }

    stats.lastWordError = null;
    return { ok: true, patched };
  }

  /**
   * 只读快照。HTTP `/physical` 用它拼「她最后说话」那一行。
   * @returns {object}
   */
  function snapshot(now = Date.now()) {
    return {
      enabled: cfg.enabled !== false,
      lastAt: stats.lastWordAt ?? null,
      lastChat: stats.lastWordChat ?? null,
      lastText: stats.lastWordText ?? null,
      lastVia: stats.lastWordVia ?? null,
      ago: humanAgo(stats.lastWordAt ?? null, now),
      total: stats.lastWordCount ?? 0,
      recent: recent.slice().reverse(),
      // OneBot 现在连着吗：`true/false`，问不到是 `null`（未知 ≠ 断了）。
      // 走 `ctx.connected()` —— 出站管线自己就用它决定「发还是排队」，
      // 比翻 `connection.connected` getter 更贴近真实判定。
      // 这个引用只在真的发过一次消息之后才有（挂原型那一刻还拿不到实例）。
      connected: (() => {
        try {
          const c = stats.lastWordOutboundCtx?.connected?.();
          return typeof c === 'boolean' ? c : null;
        } catch {
          return null;
        }
      })(),
    };
  }

  /**
   * 端到端自测：造一个真的 `OutboundPipeline` 实例（底层 `ctx.call` 只记录不发网），
   * 喂一条消息进原型链，看「最后开口」有没有真的被记上。
   *
   * 只测 note() 是不够的 —— 那只证明函数本身能跑，不能证明它挂在原型上、
   * 真的会被调。这个测的是后者。
   */
  async function selfTest(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return { ok: false, error: found.error };

    const sent = [];
    const fakeCtx = {
      connected: () => true,
      selfId: () => '0',
      isStopping: () => false,
      log: () => undefined,
      trace: () => undefined,
      getChat: () => undefined,
      config: {
        botQQ: '0',
        sensitivePatterns: [],
        textImageThreshold: 0,
        maxImageBytes: 1 << 20,
        cardFooter: '',
        fontFiles: [],
        fontFamilies: [],
      },
      call: async (action, params, chatId) => {
        sent.push({ action, params, chatId });
        return { message_id: `fake-${sent.length}` };
      },
    };

    const checks = [];
    const check = (name, cond, detail) => checks.push({ name, ok: cond === true, detail });

    // 备份真 stats，测完原样还回去（自测不该让面板上的「最后说话」变成刚刚）
    const backup = {
      at: stats.lastWordAt,
      chat: stats.lastWordChat,
      text: stats.lastWordText,
      via: stats.lastWordVia,
      count: stats.lastWordCount,
    };
    const backupRecent = recent.slice();

    try {
      // 1) 走真原型链：文字消息要被记上，且原文照发（不改参数）
      const fake = new found.klass(fakeCtx);
      await fake.sendToChat('private:1', '自测：这句话应该被记下来', {});
      const gotText = sent
        .flatMap((s) => (Array.isArray(s.params?.message) ? s.params.message : []))
        .filter((s) => s?.type === 'text')
        .map((s) => s.data.text)
        .join('');
      check('文字照发出去（不改参数）', gotText.includes('自测：这句话应该被记下来'), gotText);
      check('真原型链上记到了最后开口', stats.lastWordChat === 'private:1' && typeof stats.lastWordAt === 'number', stats.lastWordChat);
      check('记的是这条正文', stats.lastWordText === '自测：这句话应该被记下来', stats.lastWordText);
      check('via 标成 sendToChat', stats.lastWordVia === 'sendToChat', stats.lastWordVia);
      // 顺手记下的出站 ctx 要能被 snapshot 问出连接状态（体检表靠它判断「断了没」）
      check('记下了出站 ctx 的连接状态', stats.lastWordOutboundCtx?.connected?.() === true, '');
      check('snapshot 里 connected 是 true', snapshot().connected === true, snapshot().connected);

      // 2) 空文本 / 纯空白不该算「开口」
      const at2 = stats.lastWordAt;
      const cnt2 = stats.lastWordCount;
      note('private:1', '', 'sendToChat');
      note('private:1', '   \n ', 'sendToChat');
      check('空消息与纯空白不算开口', stats.lastWordAt === at2 && stats.lastWordCount === cnt2, '');

      // 3) segments 路径：text 段要能拼出来
      check('textOfSegments 拼文本', textOfSegments([{ type: 'text', data: { text: '你好' } }, { type: 'image' }]) === '你好', '');
      check('textOfSegments 空数组', textOfSegments([]) === '', '');
      check('textOfSegments 非数组', textOfSegments(null) === '', '');

      // 4) humanAgo
      check('humanAgo 没说过话', humanAgo(null) === '还没说过话', humanAgo(null));
      check('humanAgo 刚刚', humanAgo(1000, 60_000) === '刚刚', humanAgo(1000, 60_000));
      check('humanAgo 分钟', humanAgo(0, 5 * 60_000) === '5 分钟前', humanAgo(0, 5 * 60_000));
      check('humanAgo 小时', humanAgo(0, 3 * 3600_000) === '3 小时前', humanAgo(0, 3 * 3600_000));
      check('humanAgo 天', humanAgo(0, 2 * 86400_000) === '2 天前', humanAgo(0, 2 * 86400_000));

      // 5) snapshot 形状
      const snap = snapshot();
      check('snapshot 有 ago 字段', typeof snap.ago === 'string', snap.ago);
      check('snapshot 有 recent 数组', Array.isArray(snap.recent), '');

      // 6) restore：从落盘快照灌回来，且连调两次不重复
      //
      // 两次是为了覆盖一个真实发生过的 bug：启动时 `loadSync()` 调一次、
      // 异步 `load()` 再兜一次，`recent` 就出现两遍同样的条目。
      const saved = {
        lastAt: 1_700_000_000_000,
        lastChat: 'private:42',
        lastText: '盘上那句话',
        lastVia: 'sendChat',
        total: 9,
        recent: [{ at: 1_700_000_000_000, chat: 'private:42', text: '盘上那句话' }],
      };
      restore(saved);
      restore(saved);
      check('restore 灌回 lastAt', stats.lastWordAt === saved.lastAt, stats.lastWordAt);
      check('restore 灌回 lastChat', stats.lastWordChat === 'private:42', stats.lastWordChat);
      check('restore 灌回 lastText', stats.lastWordText === '盘上那句话', stats.lastWordText);
      check('restore 灌回 total', stats.lastWordCount === 9, stats.lastWordCount);
      check('restore 连调两次不重复', recent.length === 1, `recent=${recent.length}`);
      check('restore 后 snapshot 的 ago 跟着变', snapshot().ago !== '还没说过话', snapshot().ago);
      // 坏数据不该让恢复炸掉，也不该塞进半条
      restore({ lastAt: 'x', recent: [null, 5, { at: 1 }] });
      check('restore 忽略坏 lastAt', typeof stats.lastWordAt === 'number', stats.lastWordAt);
      check('restore 只留形状对的 recent', recent.length === 1 && recent[0].at === 1, `recent=${recent.length}`);
      // 清空再灌之后，finally 里的快照恢复才不会还错。
      recent.length = 0;

      // 7) 盘上压根没有这一笔 → 必须清空（stats 跨热重载复用，不能留上一代的旧值）
      note('private:99', '这条是自测留下的', 'sendToChat');
      check('前置：确实记上了', stats.lastWordChat === 'private:99', stats.lastWordChat);
      restore(undefined);
      check('无落盘快照时清空 lastAt', stats.lastWordAt === undefined, stats.lastWordAt);
      check('无落盘快照时清空 recent', recent.length === 0, `recent=${recent.length}`);
    } finally {
      // 原样还回真统计
      stats.lastWordAt = backup.at;
      stats.lastWordChat = backup.chat;
      stats.lastWordText = backup.text;
      stats.lastWordVia = backup.via;
      stats.lastWordCount = backup.count;
      // 用快照还回去而不是按长度截断：`restore()` 会**清空**再灌，
      // 按长度截断在那种情况下会还错。
      recent.length = 0;
      for (const item of backupRecent) recent.push(item);
      if (backup.at === undefined) delete stats.lastWordAt;
      if (backup.chat === undefined) delete stats.lastWordChat;
      if (backup.text === undefined) delete stats.lastWordText;
      if (backup.via === undefined) delete stats.lastWordVia;
      if (backup.count === undefined) delete stats.lastWordCount;
    }

    const failed = checks.filter((c) => !c.ok).length;
    return { ok: failed === 0, total: checks.length, failed, checks };
  }

  /**
   * 从落盘的状态里恢复「最后开口」与最近几条。
   *
   * 为什么必须恢复：`lastWordAt` 是整张体检表的主指标，如果它随着进程重启归零，
   * 面板上就永远是「还没说过话」——恰好在她真的卡住、最需要看这一行的时候。
   * 所以这一笔跟着 `state.json` 一起存（它本来就藏在该文件里），重启后再灌回来。
   *
   * @param {{lastAt?: unknown, lastChat?: unknown, lastText?: unknown, lastVia?: unknown,
   *          total?: unknown, recent?: unknown}} saved
   */
  function restore(saved) {
    // 盘上压根没有这一笔（首次安装 / 状态文件被删）= 确实一次都没开过口。
    // 必须按「空」恢复而不是直接 return：`stats` 挂在 globalThis 上跨热重载复用，
    // 直接返回会让上一代的旧值继续装成「刚说过话」。
    // 热重载时不担心误清：`persist()` 每次都会把 `lastwordState` 写进 state.json。
    if (saved === undefined || saved === null) {
      stats.lastWordAt = undefined;
      stats.lastWordChat = undefined;
      stats.lastWordText = undefined;
      stats.lastWordVia = undefined;
      stats.lastWordCount = 0;
      recent.length = 0;
      return;
    }
    if (typeof saved !== 'object') return;
    // 盘上显式写着 null = 「确实一次都没开过口」。必须照着清空 —— 否则热重载
    // 会沿用上一代留在共享 stats 里的旧值（stats 挂 globalThis，跨代复用）。
    if (saved.lastAt === null) {
      stats.lastWordAt = undefined;
      stats.lastWordChat = undefined;
      stats.lastWordText = undefined;
      stats.lastWordVia = undefined;
      stats.lastWordCount = 0;
      recent.length = 0;
      return;
    }
    if (typeof saved.lastAt === 'number' && Number.isFinite(saved.lastAt)) stats.lastWordAt = saved.lastAt;
    if (typeof saved.lastChat === 'string' && saved.lastChat !== '') stats.lastWordChat = saved.lastChat;
    if (typeof saved.lastText === 'string' && saved.lastText !== '') stats.lastWordText = saved.lastText;
    if (typeof saved.lastVia === 'string' && saved.lastVia !== '') stats.lastWordVia = saved.lastVia;
    if (typeof saved.total === 'number' && Number.isFinite(saved.total)) stats.lastWordCount = saved.total;
    if (Array.isArray(saved.recent)) {
      // 先清空再灌：恢复是「把盘上那份搬进来」，不是「追加」。不清就会在
      // 「同步读一次 + 异步再兜一次」的两条路上把同一条记两遍。
      recent.length = 0;
      // 只收形状对的，坏一条就跳过（手改过的状态文件不该让整个恢复失败）
      for (const item of saved.recent) {
        if (item && typeof item === 'object' && typeof item.at === 'number') recent.push(item);
      }
      if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    }
  }

  return {
    MODULE_ID,
    METHODS,
    cfg,
    ctl,
    scan,
    snapshot,
    restore,
    selfTest,
    /** 内部与单测入口（正式流程走 patch）。 */
    note,
  };
}

export const DEFAULTS = { enabled: true };
