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
 * 因为出站有 burst 分段（`rhythm.burst`，默认 20 字/条，2026-10-15 起），
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
 * 「自述/报幕」：她把**自己的动作与状态**当成话讲出来。
 *
 * 与括号旁白的区别：旁白带了括号（形），自述不带括号但语气是自言自语
 * （内容）。两者都该被拦，但判据完全不同，所以分开实现。
 *
 * 实测泄漏样例（脱敏：真实文本已移除，结构保持）：
 *   「……说完这些，我就安静下来等他反应了。」
 *   「……问完了，等他说明白这事。」
 *   「……话说完了，就等着他回话。」
 *   「……我已经发了一句过去，就看他那边能不能看见邀请。」
 *   这三类都只在「把内部状态念出来」时才成立，不是对对方说的话。
 *
 * ## 为什么规则层不够
 *
 * `R_ASIDE` 早就写了「不要用正文报幕你在做什么」，模型照样这么写。
 * 这是**模型层面的失败模式**：它把「turn 结束」这个内部状态误当成
 * 需要汇报的进度。既然劝不住，就在出站闸里兜底 —— 与旁白同一个位置。
 *
 * ## 判据设计（宁漏勿错）
 *
 * 整条消息要**100% 由自述从句构成**才拦，任何一句像是说给对方的话就放行：
 *   - 「等他回话。」              → 拦（全部是自述）
 *   - 「问完了，等他说明白这事。」  → 拦
 *   - 「说完这些，我就安静下来等他反应了。这事怪我。」 → 拦
 *   - 「等你回话呢，说啊」         → 放行（「等你」是说给对方听的）
 *   - 「我先把饭吃了，等我回来」    → 放行（有实质内容）
 *   - 「我这就去。晚安。」         → 放行（有告别）
 *
 * 判据落在**「等 + 第三人称」**上：「等他/等她/等对方/等他说明白」这种
 * 结构，只有在自言自语时才成立 —— 真跟人说话会说「等你」，第二人称。
 * 这是本模块唯一区分「自述」与「对话」的硬支点，改措辞前必须保住它。
 */
const NARRATION_CLAUSE_RES = [
  // 等第三人称的反应/回话（自述的核心特征）
  /^(?:就|还|先)?等(?:他|她|对方)(?:的)?(?:反应|回话|回音|回答|说明白|怎么说|怎么回|开口|点头)/,
  // 句尾的「等着他/她」——覆盖「…，就等着他回话」
  /等着(?:他|她)/,
  // 「说完了 / 问完了 / 讲完了」这类收尾报幕
  /^(?:说完|问完|讲完|聊完|发完|说完这些|说完了|话说完)/,
  // 「这事怪我」「这话我记下了」式的自我总结（收窄到这两句，避免误伤「这话我不同意」）
  /^这事怪我/,
  /^这话我记(?:下|住)/,
  // 「安静下来 / 安静点等」
  /^安静(?:下来|点|着)/,
  // 「先不说话了 / 先不出声」——注意不能碰「先不发火」之类
  /^(?:不|别)(?:再)?(?:说话|出声|接话|发消息|多嘴)/,
  // 「我刚才发了一句 / 我已经说了」
  /^(?:刚才|刚刚|已经|不久前)?(?:发|说|问|讲)(?:了|过)?(?:一句|一条|一段|这些|几句)/,
  // 「就看他那边能不能…」
  /^(?:就)?看(?:他|她|对方)(?:那边|的)?(?:能不能|会|怎么)/,
  // 「没早点讲清楚」式的自我检讨
  /^(?:没|还没|早点|没早点)(?:讲|说|解释|告诉)/,
];

/**
 * 从句开头常带的语气词/连接词，匹配前先剥掉。
 * 只剥这几个，别的不动 —— 剥多了会把正常话误判成自述。
 */
const CLAUSE_LEAD_RE = /^(?:那|嗯|哎|呃|唉|好|行)(?:，|,)?/;


/**
 * 判断**单个从句**是否像自述。
 * 只做结构匹配，不判语义 —— 语义判不准，结构才可靠。
 *
 * 剥「我」开头的虚词是必要的：实测泄漏里既有「等他回话」也有
 * 「我就安静下来等他反应了」「我先不说话了」，「我」是可选的。
 *
 * @param {string} clause
 * @returns {boolean}
 */
function looksLikeNarrationClause(clause) {
  let s = String(clause ?? '').trim();
  if (!s) return false;
  s = s.replace(CLAUSE_LEAD_RE, '').trim();
  // 「我」/「我就」/「那我也」这类主语前缀统一剥掉再判
  s = s.replace(/^(?:我也?|那我也?)(?:就|先|还)?/, '').trim();
  if (!s) return false;
  return NARRATION_CLAUSE_RES.some((re) => re.test(s));
}

/**
 * 整条消息是否**纯自述**（应当整条丢弃）。
 *
 * 先按标点切成从句，要求**每一个非空从句**都像自述；只要有一句不像，
 * 就说明这条里夹了真要对人说的话题，原样放行（宁漏勿错）。
 *
 * 另外要过「长度闸」：超过 `maxLen`（默认 80 字）的多半在讲事情，
 * 前面几个从句恰好撞上判据也不该整条丢掉。
 *
 * @param {string} text
 * @param {{ maxLen?: number }} [options]
 * @returns {boolean}
 */
export function isNarrationOnly(text, options = {}) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  const maxLen = Number.isFinite(options.maxLen) ? options.maxLen : 80;
  if (t.length > maxLen) return false;

  const clauses = t.split(/[，,。！？!?；;、\n]+/).map((s) => s.trim()).filter(Boolean);
  if (clauses.length === 0) return false;
  return clauses.every((c) => looksLikeNarrationClause(c));
}

/**
 * 一步到位：把一条出站正文清成该发的内容。
 *
 * @param {string} text 原始正文
 * @param {{ aside?: boolean, narration?: boolean }} [options]
 *   `aside` 默认 true（剥括号旁白）；`narration` 默认 true（丢纯自述整条）。
 * @returns {{ silent: boolean, text: string, hit: null|'blocked'|'stripped' }}
 *   `silent: true` 表示整条不该发；`hit` 给出命中的类型，便于审计。
 */
export function sanitizeOutbound(text, options = {}) {
  if (typeof text !== 'string') return { silent: false, text, hit: null };

  if (isSilentReply(text)) return { silent: true, text: '', hit: 'blocked' };

  const withoutMarker = stripSilentMarker(text);
  const strippedMarker = withoutMarker !== text;

  // 自述整条丢弃（2026-10-19）——先于旁白，因为自述不带括号、旁的洗不掉。
  if (options.narration !== false && isNarrationOnly(withoutMarker)) {
    return { silent: true, text: '', hit: 'blocked' };
  }

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
