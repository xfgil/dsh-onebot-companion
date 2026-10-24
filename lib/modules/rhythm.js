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
 * 与 `:291` 两处 final 投递都带它），再用一条排除法兜住误伤：状态 emoji
 * 开头的系统提示不切。
 *
 * **2026-10-15 撤销长度门槛**。曾有一版写成 `text.length > cfg.burst.maxChars`
 * （36）才尝试分条 —— 用户当天报「文字 1 段全发出来了」，实测那两条真实回复
 * 是 24 / 35 字符，**都差几字没过门槛**，而分段器本身明明能把 35 那条切成
 * 2 条（`test/exp-burst-threshold.mjs` 有离线复现）。拿字数当门槛是错的：
 * 一条回复值不值得切，**是切完才知道的**，判据应当是 `splitBurstChunks`
 * 的输出条数（包装里已有 `chunks.length <= 1` 那道闸），而不是猜一个字数。
 * 当年原实现（`_yy_privfork/outbound.edits.txt:80-88`）正是 `burst === true`
 * 后直接切，**没有任何长度门槛**。
 *
 * @module dsh-onebot-companion/modules/rhythm
 */

import { BURST_MAX_CHARS_DEFAULT, BURST_MAX_CHUNKS_DEFAULT, splitBurstChunks } from './burst.js';
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
 * 该不该尝试分条发。详见文件头「分段判据演进」。
 *
 * 只回答「这条文本值不值得交给分段器」，**不猜字数**：切不切由
 * `splitBurstChunks` 的输出条数说了算（包装里 `chunks.length <= 1` 那道闸）。
 *
 * `burst` 标记仍然尊重：`true` 强制切（上游若恢复该约定即自动生效），
 * `false` 强制不切（分条内部重入就靠它挡，否则会无限递归）。
 *
 * @param {string} text - 待发文本。
 * @param {object} [options] - 出站选项（`queuable` / `burst`）。
 * @param {object} [_cfg] - 保留参数，判据已不再读配置（见文件头）。
 */
export function shouldBurst(text, options, _cfg) {
  if (typeof text !== 'string' || text === '') return false;
  if (options?.burst === false) return false;
  if (options?.burst === true) return true;
  if (options?.queuable !== true) return false;
  if (isSystemNotice(text)) return false;
  return true;
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
 * @param {(chatId: string, rest: string, reason: string) => void} [options.onTruncated]
 *   分条发到一半被他的新消息打断时，把**没发出去的那部分**交出去
 *   （`modules/interrupt.js` 会存成未完成意图）。不传就等于不记录，行为退回旧版。
 */
export function createRhythm({ cfg, stats, patchMethod, log, onTruncated }) {
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
    // 记录开跑的那一刻：用来看「发到一半他是不是又说话了」。
    const startedAt = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        if (cfg.typing) pulseTyping(receiver, chatId, true);
        await sleep(burstPauseMs(chunks[i - 1].length, cfg, random));
        // ── 被打断（2026-10-22）────────────────────────────────────────────
        // 第 1 条已经发出去了，第 2 条还在打字停顿里，他这时候说话 —— 真人
        // 遇到这个会把剩下那半句咽回去，而不是照着原计划继续说。所以我们
        // 也停下，并把没说完的部分交给 `onTruncated`（modules/interrupt.js
        // 会存成「未完成意图」，下一轮她知道自己有半句话没出口）。
        //
        // 只在这个条件下停：**他的新消息确实晚于我们开口的那一刻**。发送
        // 期间没有任何新入站时，一律按原计划发完 —— 这是绝大多数情况。
        try {
          if (cfg.yieldToNewMessage !== false) {
            const chat = receiver?.chats?.get?.(chatId);
            const lastAt = Number(chat?.lastUserAt) || 0;
            if (lastAt > startedAt) {
              const rest = chunks.slice(i).join('');
              stats.burst.yielded = (stats.burst.yielded ?? 0) + 1;
              stats.burst.folded += chunks.length - i;
              if (cfg.typing) pulseTyping(receiver, chatId, false);
              log('info', `说到一半他插话了，剩下的 ${chunks.length - i} 段咽回去 → ${chatId}`);
              try {
                onTruncated?.(chatId, rest, 'new-message');
              } catch {
                /* 记录失败不该影响发送路径 */
              }
              return ids;
            }
          }
        } catch {
          /* 判定失败就按正常流程发完 */
        }
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

  /**
   * 摘闸：把原型上本模块的层剥掉，其余模块的层原样保留并重接。
   *
   * 这是本模块在**共享挂载点**上最要紧的一件事：`dispatchFollowup` 上同时挂着
   * stamp 那层，`sendToChat` 上也可能有别的模块进来。只靠包装内部的
   * `cfg.enabled` 自查是不够的 —— 本模块的 `dispatchFollowup` 包装（入站合并）
   * 里的 `state.coalescer.hold(...)` 一旦拿到旧 cfg 快照就不认关掉，于是
   * `POST /module {"module":"rhythm","enabled":false}` 之后合并行为照旧生效。
   * 关掉就得把层摘掉。
   *
   * 剥层用 `patchMethod.unpatch`（core/patch.js），**不在这里自己写**：自己写的
   * 「只看链头」那版遇到别的模块压在上面就摘不掉（见其 unpatchMethod 注释）。
   *
   * @returns {Promise<boolean>} 是否真的剥掉了一层。
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

  /** 一次补挂扫描：import bridge 模块，给未挂的方法挂上。 */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.enabled = cfg.enabled;
    if (!cfg.enabled) {
      // 关掉时把闸摘掉，而不是留着（见 detach 的注释）。
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

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
    detach,
    METHODS,
    TARGET,
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
    /** 每条消息的字数预算。
     *
     * 引用 `burst.js` 的同一个常量，**不在这里再写一遍字面量** —— 两处各写一份
     * 数字，改一处忘另一处时，DEFAULTS 与 `splitBurstChunks` 的兜底会悄悄分叉
     * （2026-10-15 就抓到这个：burst.js 已调成 20/6，这里还是 36/4）。 */
    maxChars: BURST_MAX_CHARS_DEFAULT,
    /** 一次回复最多几条（多出来的尾巴折叠进最后一条）。 */
    maxChunks: BURST_MAX_CHUNKS_DEFAULT,
    /** 分条之间的基础停顿（毫秒）。 */
    delayMs: 300,
    /** 按「上一条的字数」折算的打字时间（毫秒/字）。 */
    perCharMs: 45,
  },
  /** 分条期间脉冲「正在输入」（仅私聊，NapCat 支持时）。 */
  typing: true,
  /**
   * 分条发到一半、他插话了，就把剩下几段咽回去（2026-10-22）。
   *
   * 真人打下半句时看到新消息弹出来，会先停手 —— 硬把原计划说完，
   * 读起来像根本没在看他。咽回去的那部分会记成「未完成意图」
   * （`modules/interrupt.js`），下一轮她自己知道有半句话没出口。
   * 置 false 退回旧行为（不管有没有新消息都发完）。
   */
  yieldToNewMessage: true,
};
