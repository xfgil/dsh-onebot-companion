/**
 * dsh-onebot-rhythm / coalesce.js
 *
 * 入站合并：把一个 chat 连续发来的几条消息在短暂的安静窗口里攒起来，
 * 合成**一个**回合 —— 群里一阵刷屏也当成一批来读 —— 而不是一条消息一个回合。
 * 被 @ 立刻穿透窗口；正在跑回合的 chat 继续攒，等它回合结束。
 *
 * 为什么要有它：宿主的 `followup()` 只是排一个普通的下一回合提示并唤醒
 * 驱动（`bridge.dispatchFollowup`），入站管线里没有任何地方会等 —— 所以用户
 * 打了三行就得到三个回合、三条回复。
 *
 * 这段实现是从 `_yy_privfork/coalesce.write.js.txt` 移植的（原作者：会话
 * db47932d，2026-10-12 00:47 最后写入）。移植时做了两处改动：
 *   1. 去掉 `trace.js` 依赖 —— 追踪范围改为由 deps 可选注入；
 *   2. 所有外部能力（日志 / 停机 / 三个时长 / busy 判定 / 投递）改为
 *      deps 注入，模块自身零 import，可用裸 node 直接单测。
 *
 * @module dsh-onebot-rhythm/coalesce
 */

/** 私聊默认安静窗口：「对方这句话说完了」。 */
export const DEFAULT_QUIET_MS = 8_000;
/** 群聊默认安静窗口：群里是很多人，不是一个人打字。 */
export const DEFAULT_GROUP_QUIET_MS = 3_000;
/** 攒批的硬上限：一直不停打字的人也该得到一个回合。 */
export const DEFAULT_MAX_WAIT_MS = 30_000;
/** chat 正在跑回合时的复查间隔（这一批继续停着）。 */
export const BUSY_RETRY_MS = 1_000;
/** busy 复查这么多次后放弃（约 5 分钟）：agent 卡死了。 */
export const MAX_BUSY_RETRIES = 300;

/** 一个 chat 的停批记录。 */
/**
 * @typedef {object} Batch
 * @property {Array<{text: string, role: string, nickname: string}>} items
 * @property {*} quietTimer
 * @property {*} maxTimer
 * @property {number} retries
 * @property {*} scope
 */

/**
 * 合并器。每个 chat 一对计时器；所有计时器都 unref，停着的批次绝不会把
 * 宿主进程钉住。
 *
 * 一批里保留的是**已经拼装好的消息文本**（`<user_message>` 边界和群前缀都是
 * 入站管线盖的章），所以合并就是普通 join，每条消息自己的时间 / gap 属性
 * 原样保留 —— 模型看到的是几个真实的发言边界，而不是一坨合成物。
 */
export class InboundCoalescer {
    /** chatId → 停批记录。 */
    batches = new Map();
    /** @type {object} */
    deps;

    /**
     * @param deps - `{ log?, isStopping?, quietMs?, groupQuietMs?, maxWaitMs?,
     *   isBusy?, dispatch?, now? }`。`dispatch(chatId, {text, role, nickname},
     *   scope, meta)` 是真正投递的动作，必填。
     */
    constructor(deps) {
        const source = deps ?? {};
        this.deps = source;
        this.log = typeof source.log === 'function' ? source.log : () => undefined;
        this.isStopping = typeof source.isStopping === 'function' ? source.isStopping : () => false;
        this.dispatch = typeof source.dispatch === 'function' ? source.dispatch : () => undefined;
        this.now = typeof source.now === 'function' ? source.now : Date.now;
        this.stats = source.stats ?? { held: 0, merged: 0, flushed: 0, dropped: 0 };
    }

    /** 这个 chat 现在有没有没冲掉的消息。 */
    hasPending(chatId) {
        return this.batches.has(chatId);
    }

    /** 现在有几个 chat 停着没冲（健康检查 / 诊断用）。 */
    get pendingCount() {
        return this.batches.size;
    }

    /**
     * 收下一条入站消息。重启安静窗口；`options.immediate`（被 @）会立刻
     * 冲掉整批 —— 包括已经停着的那些。
     * @param chatId - 目标会话。
     * @param item - `{ text, role, nickname, kind }`，kind 为 'group' / 'private'。
     * @param options - `{ immediate?: boolean, scope?: * }`。
     */
    hold(chatId, item, options = {}) {
        if (this.isStopping())
            return;
        let batch = this.batches.get(chatId);
        if (batch === undefined) {
            batch = {
                items: [],
                quietTimer: undefined,
                maxTimer: undefined,
                retries: 0,
                scope: options.scope,
                startedAt: this.now(),
            };
            this.batches.set(chatId, batch);
            batch.maxTimer = this.timer(() => this.flush(chatId, 'maxWait'), this.maxWaitMs());
        }
        batch.items.push(item);
        this.stats.held += 1;
        if (options.immediate === true) {
            this.flush(chatId, 'immediate');
            return;
        }
        this.clearQuiet(batch);
        const quiet = item.kind === 'group' ? this.groupQuietMs() : this.quietMs();
        batch.quietTimer = this.timer(() => this.flush(chatId, 'quiet'), quiet);
    }

    /** 这个 chat 的回合结束了：把期间攒下的都投出去。 */
    onTurnEnd(chatId) {
        if (this.batches.has(chatId))
            this.flush(chatId, 'turnEnd');
    }

    /** 把一个 chat 停着的批当成单个 agent 回合投递。 */
    flush(chatId, cause) {
        const batch = this.batches.get(chatId);
        if (batch === undefined)
            return;
        if (batch.items.length === 0) {
            this.drop(chatId, batch);
            return;
        }
        if (this.isBusy(chatId)) {
            // 她还在回上一个回合：继续停着复查。turn/end 也会调 onTurnEnd()，
            // 所以这个计时器只是安全网。
            if (batch.retries >= MAX_BUSY_RETRIES) {
                this.log('warn', 'coalesce: ' + chatId + ' 连续 ' + MAX_BUSY_RETRIES
                    + ' 次复查仍然忙，丢弃 ' + batch.items.length + ' 条停批消息');
                this.stats.dropped += batch.items.length;
                this.drop(chatId, batch);
                return;
            }
            batch.retries += 1;
            this.clearQuiet(batch);
            batch.quietTimer = this.timer(() => this.flush(chatId, 'busyRetry'), BUSY_RETRY_MS);
            return;
        }
        this.batches.delete(chatId);
        this.clearTimers(batch);
        const items = batch.items;
        const last = items[items.length - 1];
        this.log('info', 'coalesce: ' + items.length + ' 条消息 → 一个回合（' + chatId
            + '，' + cause + '）');
        this.stats.flushed += 1;
        if (items.length > 1)
            this.stats.merged += 1;
        this.dispatch(chatId, {
            text: items.map(entry => entry.text).join('\n'),
            role: last.role,
            nickname: last.nickname,
        }, batch.scope, { count: items.length, cause, waitedMs: Math.max(0, this.now() - batch.startedAt) });
    }

    /** 丢掉所有停着的批（插件拆卸）。 */
    stop() {
        for (const [chatId, batch] of this.batches) {
            this.clearTimers(batch);
            this.log('debug', 'coalesce: 停机丢弃 ' + batch.items.length + ' 条停批消息（' + chatId + '）');
        }
        this.batches.clear();
    }

    /** 安静窗口时长（毫秒）。 */
    quietMs() {
        const value = Number(this.deps.quietMs?.());
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUIET_MS;
    }

    /** 群聊安静窗口时长（毫秒）。 */
    groupQuietMs() {
        const value = Number(this.deps.groupQuietMs?.());
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GROUP_QUIET_MS;
    }

    /** 停批硬上限（毫秒）。 */
    maxWaitMs() {
        const value = Number(this.deps.maxWaitMs?.());
        return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_WAIT_MS;
    }

    /** 这个 chat 是否正在跑回合。 */
    isBusy(chatId) {
        try {
            return this.deps.isBusy?.(chatId) === true;
        } catch {
            return false;
        }
    }

    drop(chatId, batch) {
        this.clearTimers(batch);
        this.batches.delete(chatId);
    }

    clearQuiet(batch) {
        if (batch.quietTimer !== undefined) {
            clearTimeout(batch.quietTimer);
            batch.quietTimer = undefined;
        }
    }

    clearTimers(batch) {
        this.clearQuiet(batch);
        if (batch.maxTimer !== undefined) {
            clearTimeout(batch.maxTimer);
            batch.maxTimer = undefined;
        }
    }

    /** setTimeout + unref（停着的批绝不能把进程撑着）。 */
    timer(fn, ms) {
        const handle = setTimeout(fn, ms);
        if (typeof handle.unref === 'function')
            handle.unref();
        return handle;
    }
}

/**
 * 从 chatId 判断会话类型。`dsh-onebot-qq` 的 chatId 形如
 * `private:100000001` / `group:2000000002`（见其 `lib/chat.js`）。
 * @param chatId - 会话 id。
 * @returns 'group' 或 'private'。
 */
export function kindOfChatId(chatId) {
    return typeof chatId === 'string' && chatId.startsWith('group') ? 'group' : 'private';
}
