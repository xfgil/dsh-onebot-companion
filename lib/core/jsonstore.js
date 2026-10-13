/**
 * dsh-onebot-rhythm / jsonstore.js
 *
 * 通用 JSON 状态仓库基类。
 *
 * 为什么要抽它：本地私有分支里攒出了四个结构几乎一样的 store ——
 * `mood-store.js`、`style-store.js`、`inbound-state.js`、`chat-sessions` ——
 * 每个都在重复「Map 索引 + debounce 落盘 + 原子替换 + 坏文件降级」这四件事。
 * 0.9.0 升级把它们一起冲掉之后，重做时只该留一份实现。
 *
 * 设计要点（对齐原来四份实现的共同约定）：
 * - 落盘是 debounce 的：状态每个回合都可能变，逐次写盘太吵；崩溃丢几秒无所谓。
 * - 写盘用「临时文件 + rename」原子替换，避免半截 JSON。
 * - 读盘失败（文件不存在 / JSON 坏 / 形状不对）一律降级为「空表」，绝不让
 *   插件启动失败；坏掉的单个键直接跳过。
 * - 停机时清掉 debounce 并同步写一次。
 *
 * @module dsh-onebot-rhythm/jsonstore
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** 默认 debounce 时长。 */
export const DEFAULT_FLUSH_MS = 3_000;

/** 把抛出的任意值描述成一行文本。 */
function describeThrown(error) {
    if (error !== null && typeof error === 'object' && typeof error.message === 'string')
        return error.message;
    return String(error);
}

/**
 * 拼一个状态文件的绝对路径；目录为空时返回 undefined（表示纯内存）。
 * @param dir - 目录（`mediaDir` 之类）。
 * @param file - 文件名。
 * @returns 绝对路径或 undefined。
 */
export function stateFilePath(dir, file) {
    if (typeof dir !== 'string' || dir === '')
        return undefined;
    const trimmed = dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
    return join(trimmed, file);
}

/**
 * 通用 JSON 状态仓库。
 *
 * @example
 * const store = new JsonStore({
 *   file: stateFilePath(mediaDir, 'mood-state.json'),
 *   log: (level, message) => ctx.logger?.[level]?.(message),
 *   normalize: normalizeMoodState,   // 把磁盘上的对象补全成合法值
 *   isStopping: () => ctx.phase?.abort?.signal?.aborted === true,
 * });
 * await store.load();
 * store.set('private:1', state);
 * store.saveDebounced();
 */
export class JsonStore {
    /**
     * @param options - `{ file?, log?, flushMs?, isStopping?, normalize?, label? }`。
     *   `normalize(value)` 返回补全后的值，返回 `undefined` 表示这一条不合法、跳过。
     */
    constructor(options = {}) {
        this.file = typeof options.file === 'string' && options.file !== '' ? options.file : undefined;
        this.flushMs = Number.isFinite(options.flushMs) ? options.flushMs : DEFAULT_FLUSH_MS;
        this.label = typeof options.label === 'string' && options.label !== '' ? options.label : 'jsonstore';
        this.log = typeof options.log === 'function' ? options.log : () => undefined;
        this.isStopping = typeof options.isStopping === 'function' ? options.isStopping : () => false;
        this.normalize = typeof options.normalize === 'function' ? options.normalize : (value) => value;
        /** @type {Map<string, *>} */
        this.entries = new Map();
        this.saveTimer = undefined;
        this.loaded = false;
    }

    /** 条目数量。 */
    get size() {
        return this.entries.size;
    }

    /** 状态文件绝对路径；未配置时为 undefined。 */
    path() {
        return this.file;
    }

    /**
     * 读盘。可重复调用；成功后 `loaded = true`。
     * 文件缺失是正常情况（首次运行），只记 debug。
     */
    async load() {
        if (this.file === undefined) {
            this.loaded = true;
            return;
        }
        try {
            const raw = await readFile(this.file, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                for (const [key, value] of Object.entries(parsed)) {
                    const normalized = this.normalize(value);
                    if (normalized !== undefined)
                        this.entries.set(key, normalized);
                }
            }
            this.log('debug', this.label + ' 已载入 ' + this.entries.size + ' 条');
        } catch (error) {
            if (error?.code === 'ENOENT') {
                this.log('debug', this.label + ' 尚未生成: ' + this.file);
            } else {
                this.log('warn', this.label + ' 载入失败（已降级为空表）: ' + describeThrown(error));
            }
        }
        this.loaded = true;
    }

    /** 取一条；没有就返回 undefined。 */
    get(key) {
        return this.entries.get(key);
    }

    /** 取一条；没有就用 `fallback` 造一个（**不写 Map**，避免只读路径产生脏数据）。 */
    getOr(key, fallback) {
        const existing = this.entries.get(key);
        if (existing !== undefined)
            return existing;
        return typeof fallback === 'function' ? fallback() : fallback;
    }

    /** 写入一条（引用即可，值视为不可变）。 */
    set(key, value) {
        this.entries.set(key, value);
    }

    /** 删除一条。 */
    forget(key) {
        return this.entries.delete(key);
    }

    /** 所有键。 */
    keys() {
        return [...this.entries.keys()];
    }

    /** 遍历（`for (const [key, value] of store)` 亦可）。 */
    [Symbol.iterator]() {
        return this.entries[Symbol.iterator]();
    }

    /** 排一次延迟写盘。已经排了就不重复排。 */
    saveDebounced() {
        if (this.file === undefined)
            return;
        if (this.saveTimer !== undefined)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.save();
        }, this.flushMs);
        if (typeof this.saveTimer?.unref === 'function')
            this.saveTimer.unref();
    }

    /** 立即写盘；失败只 warn。 */
    async save() {
        if (this.file === undefined)
            return;
        if (this.isStopping() === true)
            return;
        const out = {};
        for (const [key, value] of this.entries)
            out[key] = value;
        const tmp = this.file + '.tmp';
        try {
            await mkdir(dirname(this.file), { recursive: true });
            await writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
            await rename(tmp, this.file);
        } catch (error) {
            this.log('warn', this.label + ' 写盘失败: ' + describeThrown(error));
        }
    }

    /** 停机路径：清掉 debounce 并写一次。 */
    async flush() {
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        await this.save();
    }
}
