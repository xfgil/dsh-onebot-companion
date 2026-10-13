/**
 * dsh-onebot-guard / aside.js
 *
 * 出站文本清洗：**沉默标记** + **括号旁白**。
 *
 * 这是 index.js 里 `sanitizeText` 的可选增强模块。默认不依赖它——
 * 但如果只拦 `[[silent]]`，会漏掉另一半同样会被原样发出去的东西：
 *
 *   1. **括号旁白**（整行/整条被括号包住的"内心独白"）
 *      实测泄漏原文（2026-10-12 18:17–18:20，QQ 群 2000000002）：
 *        （这条不是点我，是别人之间的邀约，不接话）
 *        （空）
 *        （这条是问对方的，跟我无关，不接）
 *        （他们俩在聊配置的事，我刚说过一句了，这会儿插进去反而多余。安静看着就好）
 *        （不再出声）
 *      只拦 `[[silent]]` 完全拦不住它们。
 *
 *   2. **`[[silent]]` 的字面变体**
 *      `[silent]` / `［silent］` / `【silent】` / 大小写 / 空格。
 *
 * 关键设计：**括号旁白要做「整块判定」，不能只逐行判定。**
 * 因为出站有 burst 分段（`burstMessages: true` + `burstMaxChars: 36`），
 * 一条跨行旁白会被切成两条独立消息发出去：
 *     （他们俩在聊配置的事，我刚说过一句了，这会儿插进去反而多余。
 *      安静看着就好）
 *   → 「…这会儿插进去反而多余。」和「安静看着就好）」两条都发。
 * 所以先对 `text.trim()` 整块试匹配，命中就整条丢掉，再退化到逐行清洗。
 * （这是 2026-10-12 端到端测试暴露出来的真实缺陷，逐行版漏掉它。）
 *
 * 已在 35 项单元测试 + 18 项端到端测试下验证（见 test/aside.test.mjs）。
 */

/** 规范写法。提示词层让模型输出的就是这一个。 */
export const SILENT_MARKER = '[[silent]]';

/**
 * 「整条只由沉默标记构成」的判据。
 *
 * 允许 `[]`/`［］`/`【】` 三种括号、单层或双层、可有空格、大小写不敏感。
 * 注意：`[[silent]] and more` 这种**不匹配**——那是有正文的，只该剥标记，
 * 不该整条丢弃。
 */
const SILENT_BARE_RE = /^(?:\[{1,2}|［{1,2}|【)?\s*silent\s*(?:\]{1,2}|］{1,2}|】)?$/i;

/** 剥离包裹时匹配的标记本体（带 g，逐处替换）。 */
const SILENT_INLINE_RE = /\[{1,2}\s*silent\s*\]{1,2}|［{1,2}\s*silent\s*］{1,2}|【\s*silent\s*】/gi;

/**
 * 「一整行就是一对括号」。
 * 内层**不允许再出现任何括号**，所以
 *     （1）第一点
 *     （2）第二点
 * 这种枚举不会被整体误判成旁白。
 */
const ASIDE_LINE_RE = /^[（(]([^（()）]{0,1000})[)）]$/;

/** 纯数字/标点/序号（`（1）`、`（。`、`（  ）`）不是旁白，是正常排版。 */
const ASIDE_TRIVIAL_RE = /^[\d\s.、,，:：\-—_]+$/;

/** 单个 ASCII 字母（`(a)`、`（B）`）可能是选择题答案，不能当旁白丢掉。 */
const ASIDE_SINGLE_LETTER_RE = /^[A-Za-z]$/;

/**
 * 判断括号里的内容是否"像旁白"。
 *
 * ⚠️ **单字也要算旁白**：实测泄漏里就有整条消息是 `（空）` 的
 * （2026-10-12 18:18:55，群 1129820238）。只有两种情况放行：
 *   1. 空 / 纯数字标点（`（1）`、`（  ）`）——那是排版；
 *   2. 单个 ASCII 字母（`(a)`）——可能是选择题答案。
 * 情绪词如 `（笑）` 单发时也算旁白（那同样是"用括号表示沉默"的病理形态）；
 * 但 `（笑）你好呀` 这种**带正文**的不会被丢，因为整块判定要求全文只有括号。
 *
 * @param {string} inner 括号内的原文
 * @returns {boolean}
 */
export function looksLikeAside(inner) {
  if (typeof inner !== 'string') return false;
  const s = inner.trim();
  if (s === '') return false;
  if (ASIDE_TRIVIAL_RE.test(s)) return false;
  if (ASIDE_SINGLE_LETTER_RE.test(s)) return false;
  return true;
}

/**
 * 整条回复是否等于「沉默」。
 *
 * 先去掉空白与 Markdown 强调符号（模型偶尔会把标记写成 `**[[silent]]**`），
 * 再要求剩下的部分整体就是标记本身。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isSilentReply(text) {
  if (typeof text !== 'string') return false;
  const compact = text.replace(/[\s`*_~]+/g, '');
  if (compact === '') return false;
  if (SILENT_BARE_RE.test(compact)) return true;
  return /^silent$/i.test(compact);
}

/**
 * 从正文里剥掉沉默标记，保留其余内容。
 * 没有 `silent` 字样时走快速路径原样返回（绝大多数消息都走这条）。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSilentMarker(text) {
  if (typeof text !== 'string' || text === '') return text;
  if (!/silent/i.test(text)) return text;
  return text.replace(SILENT_INLINE_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 剥掉「整行就是一对括号」的旁白行。
 *
 * 先做**整块判定**（这是与"逐行清洗"唯一的重要区别，见文件头注释）：
 * 若 `text.trim()` 整体就是一对括号且内容像旁白 → 直接返回 `''`。
 * 否则逐行丢弃这类行，最后收拢多余空行。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripAsideLines(text) {
  if (typeof text !== 'string' || text === '') return text;

  const trimmed = text.trim();
  const block = ASIDE_LINE_RE.exec(trimmed);
  if (block !== null && looksLikeAside(block[1])) return '';

  const kept = [];
  let dropped = false;
  for (const line of text.split('\n')) {
    const m = ASIDE_LINE_RE.exec(line.trim());
    if (m !== null && looksLikeAside(m[1])) {
      dropped = true;
      continue;
    }
    kept.push(line);
  }
  if (!dropped) return text;
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 一步到位：把一条出站正文清成该发的内容。
 *
 * @param {string} text 原始正文
 * @param {{ aside?: boolean }} [options] `aside` 默认 true；关掉就只处理沉默标记。
 * @returns {{ silent: boolean, text: string, hit: null|'blocked'|'stripped' }}
 *   `silent: true` 表示整条不该发；`hit` 给出命中的类型，便于审计。
 */
export function sanitizeOutbound(text, options = {}) {
  if (typeof text !== 'string') return { silent: false, text, hit: null };

  if (isSilentReply(text)) return { silent: true, text: '', hit: 'blocked' };

  const withoutMarker = stripSilentMarker(text);
  const strippedMarker = withoutMarker !== text;

  const useAside = options.aside !== false;
  const cleaned = useAside ? stripAsideLines(withoutMarker) : withoutMarker;

  if (cleaned.trim() === '') {
    // 剥完什么都不剩：原本有内容的话，说明全文都是旁白/标记 → 不发
    if (text.trim() !== '') return { silent: true, text: '', hit: 'blocked' };
    return { silent: false, text, hit: null };
  }
  if (cleaned !== text) return { silent: false, text: cleaned, hit: 'stripped' };
  return { silent: false, text, hit: null };
}
