/**
 * dsh-onebot-rhythm / burst.js
 *
 * 出站分段：把一条长回复切成几条短消息发出去，让机器人读起来像人在打字
 * （起因：当时希望能把回复拆成一句半句分开发，更像真人）。
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
/**
 * 断句时要从**行尾**剥掉的标点：逗号、顿号、分号、冒号。它们被切在句尾时
 * 看着像没写完，真人不会在一条消息末尾留个逗号。句末终止符（`。！？`）和
 * 收尾引号、括号不在其列 —— 那是自然的收尾。
 *
 * 只在**被切成中间条**时剥，整段回复的最后一条不动。
 */
export const BURST_TRIM_TAIL = '，、；：,;:';
/**
 * 中日韩文字与全角标点。用来判断一个空格到底是不是词边界 —— 见
 * `isSoftBreak`。
 */
const CJK_RE = /[\u2e80-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

/**
 * 成对包裹符号：开 → 闭。用来判断某个位置是否落在**未闭合**的括号/引号内部。
 *
 * 为什么需要它（2026-10-17 实测缺陷）：群里让她写 `print("hello world")`，
 * 出站分条按 20 字预算切，`hello` 后面那个空格命中软断点，于是发成了
 *     `print("hello`
 *     `world") 拿去抄喵`
 * 引号和圆括号都悬空，代码被劈成两半 —— 这比一条消息长一点难看得多。
 *
 * **不含单引号 `'`**：英文里它更常是撇号（`don't` / `it's`），当成引号开合会
 * 把后半句全判成「引号内」、从此切不开。Python 那种 `print('hello world')`
 * 已经被外面的圆括号护住了，不缺这一个。
 */
const BURST_PAIR_OPENERS = {
  '(': ')',
  '（': '）',
  '[': ']',
  '【': '】',
  '{': '}',
  '《': '》',
  '「': '」',
  '『': '』',
  '“': '”',
  '‘': '’',
};

/**
 * 下标 `i` 是否落在**未闭合**的括号或引号内部。
 *
 * 从开头扫到 `i` 维护一个期望闭合符栈：开符号入栈，栈顶匹配的闭符号出栈。
 * 英文双引号 `"` 既开也闭，按「栈顶是它就弹出、否则压入」处理。
 *
 * 括号**不配对**时（模型写漏了闭符号）会一路判成「内部」，于是整段不切 ——
 * 这是有意的取舍：少切一刀只是消息长一点，切坏了是内容被破坏。
 *
 * @param piece - 句子单元。
 * @param i - 待判定的下标。
 * @returns 在未闭合的包裹内部则为 true。
 */
export function isInsideGrouping(piece, i) {
  const stack = [];
  for (let k = 0; k < i; k++) {
    const ch = piece[k];
    if (ch === '"') {
      if (stack.length > 0 && stack[stack.length - 1] === '"') stack.pop();
      else stack.push('"');
      continue;
    }
    const close = BURST_PAIR_OPENERS[ch];
    if (close !== undefined) {
      stack.push(close);
      continue;
    }
    if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
  }
  return stack.length > 0;
}

/**
 * 位置 `i` 上是不是一个可用的软断点。
 *
 * 标点（逗号、顿号、分号）永远算；**空格要另说**：中文正文里「100 多块」
 * 「7 月到 10 月」这类空格夹在数字与汉字之间，是排版习惯而不是词边界，
 * 在那儿切会把词劈成两半。所以空格只在两侧都不是中日韩文字时才作数 ——
 * 英文句子照旧能在空格处断。
 *
 * **括号/引号内部一律不算**（`isInsideGrouping`）：那里切开会让 `(` 或 `"`
 * 悬空，`print("hello world")` 就是这么被劈成两半的。
 *
 * @param piece - 句子单元。
 * @param i - 待判定的下标。
 * @returns 是断点则为 true。
 */
export function isSoftBreak(piece, i) {
    const ch = piece[i];
    if (!BURST_SOFT_BREAKS.includes(ch))
        return false;
    // 包裹内部不做断点 —— 放在最前，逗号类标点同样受这条保护
    // （`（甲，乙）` 也不该从中间劈开）。
    if (isInsideGrouping(piece, i))
        return false;
    if (ch !== ' ')
        return true;
    const before = piece[i - 1];
    const after = piece[i + 1];
    if (before === undefined || after === undefined)
        return false;
    return !CJK_RE.test(before) && !CJK_RE.test(after);
}
/** 当前消息攒到这么长时，单独一个换行就被当作断点。 */
export const BURST_SOFT_BREAK_MIN = 6;
/** 每条消息的默认字数预算。
 *
 * 2026-10-15 从 36 调到 20：36 字是真人语料的 **P99 之外**，切完每条仍像一段话。
 * 数据来自本人与沈芯妍的真实微信记录 23605 条（`_wxread/learn_voice.py` 统计，
 * 落到 `_wxread/style_seed.json`）：中位 6 字、P90 17 字、≤20 字占 97%。
 * 20 字 ≈ P90，一条气泡约等于真人说的两句话。
 *
 * 这只是**兜底默认**；实际生效值由 profile 的 `rhythm.burst` 覆盖
 * （本机 `cordis.patch.yml` 写的就是 20/6）。两者保持一致，免得换 profile 时
 * 悄悄退回「一大段」。 */
export const BURST_MAX_CHARS_DEFAULT = 20;
/** 一次回复最多发几条（多出来的折叠进最后一条）。
 *
 * 2026-10-15 从 4 调到 6：真人连发统计是平均 4.4 条一串、中位 2 条、32% 单挑
 * 一句就走（同上语料）。4 条的上限把长回复硬折成一大块，正好抵消掉前面的细分。 */
export const BURST_MAX_CHUNKS_DEFAULT = 6;

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
 * 剥掉一条**中间消息**末尾的逗号类标点。
 *
 * 只在被切成中间条时调用；整段回复的最后一条保留原文收尾。剥完若变空
 * （理论上不会 —— 一条至少有一个非标点字符），退回原文免得发出空消息。
 *
 * @param text - 已 trim 过的一条消息正文。
 * @returns 去掉行尾逗号类标点后的正文。
 */
export function trimBurstTail(text) {
    let end = text.length;
    while (end > 0 && BURST_TRIM_TAIL.includes(text[end - 1]))
        end--;
    if (end === 0)
        return text;
    return text.slice(0, end);
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
        if (!isSoftBreak(piece, i))
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
 * @param options - `maxChars` 每条消息预算（默认见 `BURST_MAX_CHARS_DEFAULT`），
 *   `maxChunks` 一次回复最多几条（默认见 `BURST_MAX_CHUNKS_DEFAULT`，
 *   多出来的尾巴折叠进最后一条）。
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
    let out = chunks;
    if (chunks.length > maxChunks) {
        // 超出上限：保留前几条，尾巴合并成一条。
        //
        // ⚠️ 已知副作用（2026-10-15 记录，未改）：合并出来的尾巴可能很长 ——
        // 实测 154 字回复折成 74 字、189 字折成 111 字。这与「别倒一大段」的目标
        // 相抵触。之所以先留着：`maxChunks` 是**防刷屏保险**（一条回复别在几秒内
        // 变成几十条轰炸对方，真人那 94 条是跨 20 分钟的对话、不是一次回复），
        // 而删掉它就没有兜底了。真正的解法是**让模型一开始就别写那么长**
        // （见 rules 的 `tone`），这个折叠只该在模型不听话时兜底。
        const head = chunks.slice(0, maxChunks - 1);
        head.push(chunks.slice(maxChunks - 1).join('\n'));
        out = head;
    }
    // 2026-10-15：**只剥非末条**的行尾标点 —— 真人不会在一条消息末尾留个
    // 逗号或句号（切分点取在标点上，标点本身要去掉）。
    // 整段回复的最后一条保留原文收尾，那是真正的句末。
    // 必须放在折叠之后：被折进尾巴的那些条前面还有内容，标点该留着。
    return out.map((text, i) => (i === out.length - 1 ? text : trimBurstTail(text)));
}
