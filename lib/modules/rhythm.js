/**
 * dsh-onebot-companion / modules/rhythm.js
 *
 * 节奏：管「什么时候算说完」和「一条回复分几次发」。
 *
 *   - **入站合并**（coalesce）：对方连打三行，攒成一个回合再回，而不是三行三次回复。
 *   - **出站分段**（burst）：一条长回复切成几条短消息、带打字间隔发出去，
 *     读起来像人在打字，而不是一堵墙。
 *
 * ## 为什么做成插件
 *
 * 这两套代码原本都在 `dsh-onebot-qq` 的 lib 里（`coalesce.js` + `split.js` 的
 * burst 段），2026-10-12 23:43 的 0.9.0 升级把它们一起冲掉了 —— 0.9.0 的
 * `split.js` 里精确搜 `burst` 是 0 命中。手改 node_modules 正是被冲掉的那套
 * 做法，所以这次从外面挂。
 *
 * ## 挂载点（实测确认）
 *
 *   - `ChatBridge.prototype.dispatchFollowup(chatId, text, role, nickname)`
 *     （`lib/bridge.js:375`）—— 入站管线唯一投递口，`lib/inbound.js:208` 与
 *     `lib/commands.js:581` 都汇到这里。合并器在这一层拦截。
 *   - `ChatBridge.prototype.sendToChat(chatId, text, options)`
 *     （`lib/bridge.js:278`）—— 转发给 `this.outbound.sendToChat`。
 *
 * **刻意不用 `OutboundPipeline.prototype.sendToChat`**：guard 模块包的就是那个，
 * 两个模块都带周期扫描，会互相把包装叠到对方外层、无限增长。`ChatBridge` 这个
 * prototype guard 不碰，所以这里挂上去是稳定的 —— 而且 guard 的清洗闸会落在
 * **每一个分条**上（比原来整条清洗更准）。
 *
 * ## 分段判据演进（踩过的坑）
 *
 * 原实现靠 `options.burst === true`（0.8.x 的约定，`interim.js` 会打这个标记）。
 * **0.9.0 把标记跟 burst 代码一起冲掉了**：全库搜 `burst: true` 是 0 命中，
 * `interim.js` 现在只传 `{queuable: true}`。只认旧标记的话分段永远不触发。
 *
 * 现在主判据是 `queuable === true`（模型最终回复路径的特征，`interim.js:124`
 * 与 `:291` 两处 final 投递都带它），再用两条排除法兜住误伤：短文本不切、
 * 状态 emoji 开头的系统提示不切。
 *
 * @module dsh-onebot-companion/modules/rhythm
 */

import { splitBurstChunks } from './burst.js';
import { InboundCoalescer, kindOfChatId } from './coalesce.js';
import { auditMethods, createPatcher } from '../core/patch.js';
import { describeThrown, loadTargetClass } from '../core/profile.js';

export const MODULE_ID = 'rhythm';

/** 挂载点。 */
const TARGET = { file: 'bridge.js', exportName: 'ChatBridge' };
const METHODS = ['dispatchFollowup', 'sendToChat'];

/**
 * 系统消息前缀：状态 emoji 开头的都是提示/回执，不是模型说话，不该分条。
 * （`⏳` 排队提示、`⚠️` 出错、`❌`/`✅` 命令回执、`⏹` 停止、`📦` 诊断包。）
 */
const SYSTEM_PREFIXES = ['⏳', '⚠️', '❌', '✅', '⏹', '📦'];

/** 这条文本看起来是不是系统提示/命令回执。 */
export function isSystemNotice(text) {
  const head = String(text).trimStart();
  return SYSTEM_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * 该不该分条发。详见文件头「分段判据演进」。
 *
 * `burst` 标记仍然尊重：`true` 强制切（上游若恢复该约定即自动生效），
 * `false` 强制不切（分条内部重入就靠它挡，否则会无限递归）。
 */
export function shouldBurst(text, options, cfg) {
  if (typeof text !== 'string' || text === '') return false;
  if (options?.burst === false) return false;
  if (options?.burst === true) return true;
  if (options?.queuable !== true) return false;
  if (isSystemNotice(text)) return false;
  return text.length > cfg.burst.maxChars;
}

/** 打字停顿：基础拍 + 上一条字数折算的打字时间，±25% 抖动。 */
export function burstPauseMs(prevLength, cfg, random) {
  const raw = cfg.burst.delayMs + prevLength * cfg.burst.perCharMs;
  const jitter = 0.75 + random() * 0.5;
  return Math.min(6000, Math.max(120, Math.round(raw * jitter)));
}

/** 睡一会儿（不 unref：这是发送路径，必须真的等）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 私聊时脉冲「正在输入」；失败静默（NapCat 不支持就退化成没有）。 */
function pulseTyping(receiver, chatId, on) {
  try {
    if (!String(chatId).startsWith('private:')) return;
    const target = Number(String(chatId).slice('private:'.length));
    if (!Number.isFinite(target)) return;
    void receiver?.outbound?.ctx?.call?.('set_input_status', {
      user_id: target,
      event_type: on ? 1 : 0,
    }, chatId).catch(() => undefined);
  } catch {
    /* 指示器是装饰，不影响发送 */
  }
}

/**
 * 创建 rhythm 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - rhythm 段配置。
 * @param {object} options.stats - 共享统计（含 `inbound` / `burst` 子对象）。
 * @param {Function} options.patchMethod - core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 */
export function createRhythm({ cfg, stats, patchMethod, log }) {
  /** 最近一次入站投递的 ChatBridge 实例（busy 判定与投递都要用）。 */
  const state = { lastReceiver: undefined, coalescer: undefined };

  const isStopping = () => state.lastReceiver?.stopping === true;

  /**
   * 分条发送：一条一条发，中间停顿。第一条带引用目标，后续不带。
   * 中途失败就把剩下的合并成一条补发，一个字都不丢。
   */
  async function sendBurst(receiver, chatId, chunks, options) {
    const random = receiver?.outbound?.random ?? Math.random;
    const ids = [];
    stats.burst.replies += 1;
    stats.burst.messages += chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        if (cfg.typing) pulseTyping(receiver, chatId, true);
        await sleep(burstPauseMs(chunks[i - 1].length, cfg, random));
      }
      // 只有第一条气泡引用被回复的那条消息；全部带 burst:false 防止重入。
      const sendOptions =
        i === 0 ? { ...options, burst: false } : { ...options, burst: false, replyTo: undefined };
      try {
        const id = await receiver.sendToChat(chatId, chunks[i], sendOptions);
        if (id !== undefined) ids.push(id);
      } catch (error) {
        if (cfg.typing) pulseTyping(receiver, chatId, false);
        stats.burst.aborted += 1;
        stats.burst.folded += chunks.length - i;
        log('warn', `第 ${i} 条分段发送失败，剩余内容合并补发: ${describeThrown(error)}`);
        const tailId = await receiver.sendToChat(chatId, chunks.slice(i).join('\n'), sendOptions);
        if (tailId !== undefined) ids.push(tailId);
        return ids;
      }
    }
    if (cfg.typing) pulseTyping(receiver, chatId, false);
    return ids;
  }

  state.coalescer = new InboundCoalescer({
    log,
    isStopping,
    quietMs: () => cfg.inbound.quietMs,
    groupQuietMs: () => cfg.inbound.groupQuietMs,
    maxWaitMs: () => cfg.inbound.maxWaitMs,
    isBusy: (chatId) => state.lastReceiver?.chats?.get?.(chatId)?.agent?.status === 'running',
    dispatch: (chatId, item, scope) => {
      const receiver = scope?.receiver ?? state.lastReceiver;
      // 投递走 scope 上带的「链底原方法」—— 绝不能再走本包装，否则同一条消息
      // 会被重新入队、永远发不出去。
      const deliver = scope?.deliver;
      stats.inbound.flushed += 1;
      if (typeof deliver !== 'function') {
        log('warn', `合并投递缺少原方法，已丢弃 ${chatId} 的一批`);
        stats.inbound.dropped += 1;
        return;
      }
      try {
        Promise.resolve(deliver.call(receiver, chatId, item.text, item.role, item.nickname)).catch(
          (error) => {
            stats.lastError = describeThrown(error);
            log('warn', `合并投递失败: ${describeThrown(error)}`);
          },
        );
      } catch (error) {
        stats.lastError = describeThrown(error);
        log('warn', `合并投递失败: ${describeThrown(error)}`);
      }
    },
    stats: stats.inbound,
  });

  /** 一次补挂扫描：import bridge 模块，给未挂的方法挂上。 */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.enabled = cfg.enabled;
    if (!cfg.enabled) return { ok: true, patched: 0 };

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.resolveError = found.error;
      return { ok: false, error: found.error };
    }
    stats.profileDir = found.profileDir;
    stats.resolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;

    if (patchMethod(proto, 'dispatchFollowup', MODULE_ID, (original) =>
      function companionRhythmDispatchFollowup(chatId, text, role, nickname) {
        try {
          if (!cfg.enabled || !cfg.inbound.enabled)
            return original.call(this, chatId, text, role, nickname);
          // 只合并入站管线投递的消息（带注入边界）；命令回执与插件内部投递不碰。
          if (typeof text !== 'string' || !text.includes('<user_message'))
            return original.call(this, chatId, text, role, nickname);
          const kind = kindOfChatId(chatId);
          const immediate =
            cfg.inbound.mentionPierces === true && kind === 'group' && text.includes('[@我]');
          state.lastReceiver = this;
          state.coalescer.hold(chatId, { text, role, nickname, kind }, {
            immediate,
            scope: { receiver: this, deliver: original },
          });
          return Promise.resolve(undefined);
        } catch (error) {
          stats.lastError = describeThrown(error);
          log('warn', `入站合并异常，按原文直投: ${describeThrown(error)}`);
          return original.call(this, chatId, text, role, nickname);
        }
      }, rel)) patched += 1;

    if (patchMethod(proto, 'sendToChat', MODULE_ID, (original) =>
      function companionRhythmSendToChat(chatId, text, options = {}) {
        try {
          if (!cfg.enabled || !cfg.burst.enabled) return original.call(this, chatId, text, options);
          if (!shouldBurst(text, options, cfg)) return original.call(this, chatId, text, options);
          // 会走文字图卡片的超长回复不分条：卡片本来就是一条。
          const threshold = Number(this?.outbound?.ctx?.config?.textImageThreshold) || 0;
          if (threshold > 0 && text.length > threshold)
            return original.call(this, chatId, text, options);
          const chunks = splitBurstChunks(text, {
            maxChars: cfg.burst.maxChars,
            maxChunks: cfg.burst.maxChunks,
          });
          if (chunks.length <= 1) return original.call(this, chatId, text, options);
          log('info', `分条发送 ${chunks.length} 条 → ${chatId}`);
          return sendBurst(this, chatId, chunks, options);
        } catch (error) {
          stats.lastError = describeThrown(error);
          log('warn', `出站分段异常，按原文整条发: ${describeThrown(error)}`);
          return original.call(this, chatId, text, options);
        }
      }, rel)) patched += 1;

    return { ok: true, patched };
  }

  return {
    MODULE_ID,
    scan,
    state,
    stop: () => state.coalescer?.stop(),
    pendingCount: () => state.coalescer?.pendingCount ?? 0,
    splitBurstChunks,
  };
}

/** 本模块的默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /** 入站合并。 */
  inbound: {
    enabled: true,
    /** 私聊安静窗口：对方这句话说完了。 */
    quietMs: 8000,
    /** 群聊安静窗口：群里是很多人，不是一个人打字。 */
    groupQuietMs: 3000,
    /** 攒批硬上限：一直不停打字的人也该得到一个回合。 */
    maxWaitMs: 30000,
    /** 被 @ 时立刻穿透窗口。 */
    mentionPierces: true,
  },
  /** 出站分段。 */
  burst: {
    enabled: true,
    /** 每条消息的字数预算。 */
    maxChars: 36,
    /** 一次回复最多几条（多出来的尾巴折叠进最后一条）。 */
    maxChunks: 4,
    /** 分条之间的基础停顿（毫秒）。 */
    delayMs: 300,
    /** 按「上一条的字数」折算的打字时间（毫秒/字）。 */
    perCharMs: 45,
  },
  /** 分条期间脉冲「正在输入」（仅私聊，NapCat 支持时）。 */
  typing: true,
};
