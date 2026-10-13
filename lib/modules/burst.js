/**
 * dsh-onebot-rhythm / burst.js
 *
 * 出站分段：把一条长回复切成几条短消息发出去，让机器人读起来像人在打字
 * （用户原话 m00987：「能不能把发的话分成一句半句分开发啊，像真人一点」）。
 *
 * 这段实现是从 2026-10-06 到 10-12 期间对 dsh-onebot-qq `lib/split.js` 的
 * 15 次改动里**逐字回收**的（素材 `_yy_privfork/split.edits.txt`）——那批改动
 * 在 0.9.0 升级时被上游整个冲掉（0.9.0 的 split.js 里没有任何 burst 代码）。
 * 回收时只做了一件事：把常量导出、把三个函数导出，方便离线单测。
 *
 * 零依赖：不引 node 内建、不引 @deepseek-ai/*，可用裸 node 直接 import 测试。
 *
 * @module dsh-onebot-rhythm/burst
 */

/** 句末终止符（跟着它结束的那句一起走）。 */
export const BURST_TERMINATORS = '。！？!?…';
/** 收尾标点：被吸收进前一个单元。 */
export const BURST_CLOSERS = '"”’\'」』）)】]》';
/** 超长句内部的候选断点。 */
export const BURST_SOFT_BREAKS = '，、；,; ';
/** 软断点前至少要有这么长才算值得切。 */
export const BURST_MIN_PIECE = 8;
/** 当前消息攒到这么长时，单独一个换行就被当作断点。 */
export const BURST_SOFT_BREAK_MIN = 6;
/** 每条消息的默认字数预算。 */
export const BURST_MAX_CHARS_DEFAULT = 36;
/** 一次回复最多发几条（多出来的折叠进最后一条）。 */
export const BURST_MAX_CHUNKS_DEFAULT = 4;

/**
 * 把一个段落切成句子单元，并记住哪些单元是被换行结束的
 * （下一个单元因此可以「倾向」断句）。
 * @param block - 段落文本（不含空行）。
 * @returns 按顺序的单元数组，每项 `{ text, newline }`。
 */
export function splitBurstSentences(block) {
    const out = [];
    let start = 0;
    for (let i = 0; i < block.length; i++) {
        const ch = block[i];
        if (ch === '\n') {
            const slice = block.slice(start, i + 1);
            // 终止符后面的换行本身没有文字 —— 标记它前面那个单元，
            // 而不是吐出一个空单元。
            if (slice.trim() !== '')
                out.push({ text: slice, newline: true });
            else if (out.length > 0)
                out[out.length - 1].newline = true;
            start = i + 1;
            continue;
        }
        let terminated = BURST_TERMINATORS.includes(ch);
        if (!terminated && ch === '.') {
            // 英文句点：只有真的在结束一句话时才算，避免小数、网址、
            // 省略号被切开。
            const next = block[i + 1];
            terminated = next === undefined || /\s/.test(next);
        }
        if (!terminated)
            continue;
        let j = i + 1;
        while (j < block.length && (BURST_TERMINATORS.includes(block[j]) || BURST_CLOSERS.includes(block[j])))
            j++;
        out.push({ text: block.slice(start, j), newline: false });
        start = j;
        i = j - 1;
    }
    if (start < block.length)
        out.push({ text: block.slice(start), newline: false });
    return out.filter(unit => unit.text.trim() !== '');
}

/**
 * 把一个超长句在逗号类断点处切开；短句原样返回。切出来的只是**候选**
 * 片段，由打包器重新合并到每条消息的预算之内。
 * @param piece - 一个句子单元。
 * @param maxChars - 每条消息的预算。
 * @returns 一个或多个片段，按顺序。
 */
export function wrapBurstPiece(piece, maxChars) {
    if (piece.trim().length <= maxChars)
        return [piece];
    const parts = [];
    let start = 0;
    for (let i = 0; i < piece.length; i++) {
        if (!BURST_SOFT_BREAKS.includes(piece[i]))
            continue;
        if (i + 1 - start < BURST_MIN_PIECE)
            continue;
        parts.push(piece.slice(start, i + 1));
        start = i + 1;
    }
    if (start < piece.length)
        parts.push(piece.slice(start));
    return parts.length > 1 ? parts : [piece];
}

/**
 * 把一条回复切成「人话大小」的若干条消息。分段关闭或切了也没赚头时返回
 * `[text]`，所以调用方永远可以把它当成「要发的消息列表」。
 * @param text - 回复正文（已去 Markdown）。
 * @param options - `maxChars` 每条消息预算（默认 36），`maxChunks` 一次回复
 *   最多几条（默认 4，多出来的尾巴折叠进最后一条）。
 * @returns 一个或多个消息正文，按发送顺序。
 */
export function splitBurstChunks(text, options = {}) {
    const maxChars = options.maxChars ?? BURST_MAX_CHARS_DEFAULT;
    const maxChunks = options.maxChunks ?? BURST_MAX_CHUNKS_DEFAULT;
    if (typeof text !== 'string' || text === '')
        return [];
    if (maxChunks <= 1 || maxChars <= 0)
        return [text];
    const units = [];
    /** 下一个单元前强制断句（空行 / 代码围栏）。 */
    let pendingBreak = false;
    /** 上一个单元结束了整行，下一个单元可以「倾向」断句。 */
    let preferBreak = false;
    for (const part of text.split(/(\x60{3}[\s\S]*?\x60{3})/)) {
        if (part === '')
            continue;
        if (part.startsWith('\x60\x60\x60')) {
            units.push({ text: part, len: part.trim().length, breakBefore: pendingBreak, preferBreak: false });
            pendingBreak = true;
            preferBreak = false;
            continue;
        }
        for (const para of part.split(/\n{2,}/)) {
            if (para.trim() === '')
                continue;
            for (const sentence of splitBurstSentences(para)) {
                const pieces = wrapBurstPiece(sentence.text, maxChars);
                for (let i = 0; i < pieces.length; i++) {
                    units.push({
                        text: pieces[i],
                        len: pieces[i].trim().length,
                        breakBefore: i === 0 ? pendingBreak : false,
                        preferBreak: i === 0 ? preferBreak : false,
                    });
                }
                pendingBreak = false;
                preferBreak = sentence.newline;
            }
            // 空行是真正的边界：下一段从头开始攒。
            pendingBreak = true;
        }
    }
    const chunks = [];
    let current = '';
    let currentLen = 0;
    for (const unit of units) {
        const breakNow = unit.breakBefore
            || currentLen + unit.len > maxChars
            || (unit.preferBreak && currentLen >= BURST_SOFT_BREAK_MIN);
        if (current !== '' && breakNow) {
            chunks.push(current.trim());
            current = '';
            currentLen = 0;
        }
        current += unit.text;
        currentLen += unit.len;
    }
    if (current.trim() !== '')
        chunks.push(current.trim());
    if (chunks.length === 0)
        return [];
    if (chunks.length <= maxChunks)
        return chunks;
    // 超出上限：保留前几条，尾巴合并成一条。
    const head = chunks.slice(0, maxChunks - 1);
    head.push(chunks.slice(maxChunks - 1).join('\n'));
    return head;
}
