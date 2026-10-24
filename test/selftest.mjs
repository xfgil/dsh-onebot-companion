/**
 * dsh-onebot-companion 自测。
 *
 * 三层：
 *   1. **纯函数**（mood / style / burst / coalesce / aside / rules）—— 无 IO、无宿主。
 *   2. **模块接口**（guard / prompt / rhythm / persona 的 createXxx 返回值与配置语义）。
 *   3. **真实集成**—— 造一个假 profile（含 `dsh-onebot-qq/lib/{bridge,outbound}.js`），
 *      让四个模块的 `scan()` 真的 `import()` 并给原型挂包装，然后**真的调用**被包装的
 *      方法，断言行为。
 *
 * 第 3 层是这个文件存在的理由：前两层全绿也可能「插件说挂好了但功能完全不生效」——
 * 那种 bug 只有真挂真调才抓得到（P3 开发时就踩过：判据写错导致分段永远不触发）。
 *
 * 跑法：`node test/selftest.mjs`
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHandler } from '../lib/core/http.js';
import { JsonStore, stateFilePath } from '../lib/core/jsonstore.js';
import { createPatcher, auditMethods, originalOf, MODULE as MODULE_TAG } from '../lib/core/patch.js';
import { FACE_COUNT, FACES, resolveFaceId, suggestFaces } from '../lib/modules/faces.js';
import {
  createGuard,
  sanitizeText,
  sanitizeSegments,
  isAdminOnlyNotice,
  DEFAULTS as GUARD_DEFAULTS,
} from '../lib/modules/guard.js';
import { createAdopt, DEFAULTS as ADOPT_DEFAULTS, makeAdoptCreateChat } from '../lib/modules/adopt.js';
import { splitBurstChunks, isSoftBreak, isInsideGrouping } from '../lib/modules/burst.js';
import {
  judgeTurn,
  isAllowedInRestricted,
  isUnderDir,
  createIsolation,
  ALLOWED_TOOLS as ISOLATION_ALLOWED_TOOLS,
  LINK_TOOLS,
  RESTRICTED_PREFIX,
  extractLinks,
  checkLinkAccess,
  isPrivateHost,
  parseArgs,
} from '../lib/modules/isolation.js';
import { InboundCoalescer, kindOfChatId } from '../lib/modules/coalesce.js';
import {
  createPersona,
  chatIdOfEvent,
  chatIdOfSession,
  eventTextOf,
  plainOfInbound,
  textOfMessage,
  toolCallCountOf,
} from '../lib/modules/persona.js';
import { createPrompt, renderRules, sessionIdOf } from '../lib/modules/prompt.js';
import { createRhythm, isSystemNotice, shouldBurst } from '../lib/modules/rhythm.js';
import { createStamp, evictOldest, MAX_CHAT_BASELINES } from '../lib/modules/stamp.js';
import { mergeConfig } from '../lib/index.js';
import { DEFAULT_RULES, RULES } from '../lib/modules/rules.js';
import {
  MOOD_IDS,
  WARMTH_BASELINE_DEFAULT,
  createMoodState,
  driftMood,
  lowEnergyLine,
  moodPromptLine,
  moodSnapshot,
  noteAssistantMessage,
  noteProactive,
  noteUserMessage,
  proactiveChance,
  quietMs,
} from '../lib/modules/mood.js';
import { createStyleProfile, mergeStyleSample, stylePromptLine, topParticles } from '../lib/modules/style.js';
import {
  createHands,
  parseApprovalCommand,
  makeCode,
  resolveReactId,
  normalizeGroupRequests,
  normalizeFriendRequests,
  describeRequest,
} from '../lib/modules/hands.js';
import {
  createIntimate,
  resolveIntimateType,
  TYPE_NAMES,
  describeIntimateError,
  normalizeInvites,
  normalizeBonds,
} from '../lib/modules/intimate.js';
import {
  DEFAULT_NAMES,
  DEFAULT_TOPIC_GROUPS,
  DEFAULT_TOPICS,
  findNameMention,
  inQuietHours,
  matchTopic,
  normalizeDiving,
  normalizeTopics,
  rewriteSelfMention,
  topicHint,
} from '../lib/modules/mention.js';
import { ProactiveScheduler } from '../lib/modules/proactive.js';
import { Synthesizer, speakableText, SHIM_SOURCE, VOICES, DEFAULTS as VOICE_DEFAULTS } from '../lib/modules/voice.js';
import {
  annotateEmoji,
  createEmoji,
  DEFAULTS as EMOJI_DEFAULTS,
  makeEmojiProcessInbound,
  stripFaceGlyphs,
} from '../lib/modules/emoji-media.js';
import { FACE_NAMES_IN, FACE_NAMES_IN_COUNT, faceNameOf } from '../lib/modules/face-names.js';
import {
  createSleep,
  createSleepState,
  DEFAULTS as SLEEP_DEFAULTS,
  judgeSleep,
  makeSleepProcessInbound,
  matchSleepWord,
  sleepDuration,
  sleepTrigger,
} from '../lib/modules/sleep.js';
import { createLastWord, humanAgo, textOfSegments, DEFAULTS as LASTWORD_DEFAULTS } from '../lib/modules/lastword.js';
import { buildPhysicalAt, agoText, startOfDay } from '../lib/modules/physical.js';
import { API_VERSION, createApi, SERVICE_NAME } from '../lib/api.js';
import {
  createStickerLib,
  hashOf,
  shortId,
  makeEntry,
  pickStickers,
  pruneStickers,
  isEntryOk,
  describeEntry,
} from '../lib/modules/sticker-lib.js';
import {
  normalizeFocus,
  isFresh as isFocusFresh,
  focusPromptLine,
} from '../lib/modules/focus.js';
import {
  humanSpan as humanSolitudeSpan,
  quietSince,
  isSolitary,
  isLateHour,
  pickThought,
  solitudePromptLine,
  ownerChatOf,
  createSolitude,
} from '../lib/modules/solitude.js';
import {
  dayKeyOf as temperDayKey,
  recordDay as temperRecordDay,
  biasOf as temperBiasOf,
  deviationOf as temperDeviation,
  temperPromptLine,
  createTemper,
} from '../lib/modules/temper.js';
import {
  HOURS as CIRCADIAN_HOURS,
  createBuckets as circadianCreateBuckets,
  advanceBuckets as circadianAdvanceBuckets,
  recordPresence as circadianRecordPresence,
  circadianCurve,
  nightSetOf,
  circadianPromptLine,
  createCircadian,
} from '../lib/modules/circadian.js';
import {
  CADENCE,
  CADENCE_FACTORS,
  createDensity,
  decayDensity,
  bumpDensity,
  densityFactor,
  cadenceOf,
  cadenceFactorOf,
  intensityOf,
  tempoPromptLine,
  createTempo,
} from '../lib/modules/tempo.js';
import {
  noteInterrupted,
  pruneInterrupted,
  interruptedFor,
  interruptPromptLine,
  createInterrupt,
} from '../lib/modules/interrupt.js';
import {
  buildWorkflow,
  normalizeRequest,
  firstImageOf,
  viewPathOf,
  createComfy,
  facePromptOf,
  FACE_PRESETS,
} from '../lib/modules/comfy.js';
import {
  noteIds,
  recentOf,
  dropIds,
  createRecall,
} from '../lib/modules/recall.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}`);
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}\n        got      ${a}\n        expected ${e}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 近似相等断言。
 *
 * 为什么需要它：情绪变量是**按时间积分**出来的（`driftMood` 把「距上次推进的
 * 毫秒数」换算成小时再乘衰减率），所以 `50 + 6` 落盘后是 `55.99999722222222`
 * 而不是 `56` —— 那 2.8e-6 的差就是「两次调用之间真实流逝的几毫秒」被积分进去的
 * 结果。这是设计使然（时间真的在走），不是实现缺陷；拿 `===` 比会得到一个永远
 * 修不好的红灯。容差取 1e-3：比真实噪声大三个数量级，但相对 0–100 的量程仍然
 * 足够严格，算错成 5 或 7 照样抓得到。
 */
function near(actual, expected, tol, label) {
  const diff = Math.abs(actual - expected);
  if (Number.isFinite(actual) && diff <= tol) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}\n        got      ${actual}\n        expected ${expected} ±${tol}`);
  }
}

function section(title) {
  console.log(`\n== ${title} ==`);
}

/** 假 stats（形状与 index.js 里那份一致，但每次新建，测试之间不串味）。 */
function fakeStats() {
  return {
    scans: 0,
    lastScanAt: null,
    enabled: true,
    resolveError: null,
    profileDir: '',
    patched: [],
    lost: [],
    lastError: null,
    blocked: 0,
    stripped: 0,
    lastHitAt: null,
    lastHitKind: null,
    lastHitText: null,
    lastHitChat: null,
    inbound: { held: 0, merged: 0, flushed: 0, dropped: 0, pending: 0 },
    burst: { replies: 0, messages: 0, folded: 0, aborted: 0 },
    proactive: { fired: 0, lastFiredAt: null, lastChatId: null },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
section('aside 旁白判别');

const { looksLikeAside, stripAsideLines } = await import('../lib/modules/aside.js');

// looksLikeAside 收的是**括号内层**（调用方先用 ASIDE_LINE_RE 剥掉括号）。
// 之前这里传了带括号的整串，于是每条都命中「内层还有括号 → 不是旁白」的保守分支，
// 全部返回 false —— 测试红了，但红的不是实现。
ok(looksLikeAside('空') === true, 'aside: 「（空）」判为旁白');
ok(looksLikeAside('不再出声') === true, 'aside: 「（不再出声）」判为旁白');
ok(looksLikeAside('这条不是点我，不接话') === true, 'aside: 「（这条不是点我，不接话）」判为旁白');
ok(looksLikeAside('今天天气不错') === true, 'aside: 括号里是整句话也算旁白（单发时就是病理形态）');
ok(looksLikeAside('1') === false, 'aside: 中文枚举「（1）」不是旁白');
ok(looksLikeAside('2') === false, 'aside: 中文枚举「（2）」不是旁白');
ok(looksLikeAside('a') === false, 'aside: 英文枚举「(a)」不是旁白');
ok(looksLikeAside('笑') === true, 'aside: 「(笑)」是旁白');
ok(looksLikeAside('') === false, 'aside: 空串不是旁白');
ok(looksLikeAside('  ') === false, 'aside: 纯空白不是旁白');
// 「内层还有括号 → 保守不剥」是**整行**层的规则（ASIDE_LINE_RE 的内层字符类
// 排除了括号），不是 looksLikeAside 的规则 —— 后者收到的本来就是内层文本，
// 内层里恰好还有一对括号并不使它变得不像旁白。之前把整句喂给 looksLikeAside，
// 于是断言错了：红的是测试，不是实现。
ok(
  stripAsideLines('他说：今天（很好）') === '他说：今天（很好）',
  'aside: 整行内层还有括号 → 不剥（保守）',
);
ok(
  stripAsideLines('（1）第一点\n（2）第二点') === '（1）第一点\n（2）第二点',
  'aside: 中文枚举整行不剥',
);
ok(looksLikeAside(undefined) === false, 'aside: 非字符串不是旁白');

// stripAsideLines 返回**字符串**（不是行数组）。
eq(stripAsideLines('你好\n（空）\n在吗'), '你好\n在吗', 'aside: 剥掉中间整行旁白');
eq(stripAsideLines('（空）'), '', 'aside: 整条都是旁白 → 空');
eq(stripAsideLines('你好（旁白）'), '你好（旁白）', 'aside: 行内括号不整行剥（交给 guard 的整行判定）');
eq(stripAsideLines('你好\n在吗'), '你好\n在吗', 'aside: 没有旁白时原样返回');

// ─────────────────────────────────────────────────────────────────────────────
section('guard 文本清洗');

ok(sanitizeText('[[silent]]', { stripAside: true }).silent === true, 'guard: [[silent]] 判为沉默');
ok(sanitizeText('[silent]', { stripAside: true }).silent === true, 'guard: [silent] 判为沉默');
ok(sanitizeText('【silent】', { stripAside: true }).silent === true, 'guard: 【silent】判为沉默');
ok(sanitizeText('SILENT', { stripAside: true }).silent === true, 'guard: 大小写不敏感');
ok(sanitizeText('  [[silent]]  ', { stripAside: true }).silent === true, 'guard: 前后空白不影响');
ok(sanitizeText('我说了 silent 这个词', { stripAside: true }).silent === false, 'guard: 句中出现不算沉默');

const withMarker = sanitizeText('你好[[silent]]', { stripAside: true });
ok(withMarker.hit !== null, 'guard: 句中标记算命中（剥离）');
eq(withMarker.text, '你好', 'guard: 剥离句中标记');

const withAside = sanitizeText('先说个事\n（空）\n说完', { stripAside: true });
eq(withAside.text, '先说个事\n说完', 'guard: 剥掉整行旁白');
const noAside = sanitizeText('先说个事\n（空）\n说完', { stripAside: false });
eq(noAside.text, '先说个事\n（空）\n说完', 'guard: stripAside=false 时保留旁白');

eq(sanitizeText('原文', { stripAside: true }).text, '原文', 'guard: 干净文本原样返回');
eq(sanitizeText('', { stripAside: true }).text, '', 'guard: 空串原样');
eq(sanitizeSegments('not-an-array', { stripAside: true }).segments, 'not-an-array', 'guard: 非数组段原样');

// ─────────────────────────────────────────────────────────────────────────────
// 自述/报幕（2026-10-19 用户截图指认「这些文字部分不该露出来吧」）
// 语料来源：onebot-private-100000001 会话 seq 500/541/557/572 + -muwexn8r seq 2511。
// 全量 507 条真实消息回归，只命中这 5 条，其余 502 条全部放行。
section('自述/报幕 拦截');

const { isNarrationOnly } = await import('../lib/modules/aside.js');

for (const s of [
  '等他回话。',
  '问完了，等他说明白这事。',
  '话说完了，就等着他回话。',
  '说完这些，我就安静下来等他反应了。这事怪我，没早点讲清楚。',
  '我已经发了一句过去，就看他那边能不能看见邀请。',
  '那我先不说话了',
  '这事怪我。',
  '这话我记下了。',
  '刚才发了一句',
]) ok(isNarrationOnly(s) === true, `narration: 应拦 ${JSON.stringify(s)}`);

for (const s of [
  '等你回话呢，说啊',
  '我先把饭吃了，等我回来',
  '我这就去。\n\n晚安。',
  '好，那我信你。喵。\n\n那「G了」是什么 G 了？',
  '嗯，去吧。喵。',
  '刚睡醒…一觉睡到一点多，有点罪过\n\n你下午还有课吗',
  '那我先睡啦，修好喊我喵',
  '说完这些我就去吃饭，你要不要一起？',
  '看这个（笑）',
  '（1）第一点\n（2）第二点',
  '在呢。喵。\n\n什么事，说吧。',
  '该不会又是早八上到现在吧。',
  '车被偷了？报警了吗喵',
  '诶，你说完了这个词怎么念',
  '这话我不同意',
]) ok(isNarrationOnly(s) === false, `narration: 别误拦 ${JSON.stringify(s)}`);

ok(isNarrationOnly('等他回话。' + '啊'.repeat(90)) === false, 'narration: 超长不拦');
eq(sanitizeText('等他回话。', { stripNarration: false }).silent, false, 'guard: stripNarration=false 时保留自述');
ok(sanitizeText('等他回话。', { stripNarration: true }).silent === true, 'guard: stripNarration=true 时整条丢弃');
eq(sanitizeText('等他回话。', {}).hit, 'blocked', 'guard: 自述命中记为 blocked');

const segs = sanitizeSegments(
  [
    { type: 'text', data: { text: '你好\n（空）' } },
    { type: 'image', data: { file: 'a.png' } },
  ],
  { stripAside: true },
);
eq(segs.segments[0].data.text, '你好', 'guard: 只清洗 text 段');
eq(segs.segments[1].data.file, 'a.png', 'guard: 非 text 段原样放行');

const segsDrop = sanitizeSegments([{ type: 'text', data: { text: '[[silent]]' } }], { stripAside: true });
ok(segsDrop.drop === true, 'guard: 整段沉默 → drop');

// 2026-10-18 00:32 实测：群友发 `/skin 58462qwq`，上游 commands.js:124 直接回
// 「该命令仅管理员可用。」——模型全程没被调用，群里却出现一条她「念系统提示」。
// 提示词管不到（不是模型输出），只能在出站口吞。
{
  const adminOnly = '该命令仅管理员可用。';
  ok(isAdminOnlyNotice(adminOnly), 'guard: 认出「仅管理员可用」回执');
  ok(isAdminOnlyNotice('  ' + adminOnly + '  '), 'guard: 前后空白不影响判定');
  ok(!isAdminOnlyNotice('该命令可以用'), 'guard: 近似文本不误杀');
  ok(!isAdminOnlyNotice(''), 'guard: 空串不算');
  ok(!isAdminOnlyNotice(undefined), 'guard: undefined 不算');

  const muted = sanitizeText(adminOnly, { stripAside: true, muteAdminOnlyNotice: true });
  ok(muted.silent === true, 'guard: 默认吞掉「仅管理员可用」回执');
  eq(muted.text, '', 'guard: 吞掉后正文为空');
  eq(muted.hit, 'muted', 'guard: 记为 muted 类命中');

  const kept = sanitizeText(adminOnly, { stripAside: true, muteAdminOnlyNotice: false });
  ok(kept.silent === false, 'guard: 关掉开关后照常发出');
  eq(kept.text, adminOnly, 'guard: 关掉开关后原文保留');

  // 默认配置里必须是开的（配置项漏了 = 这个修复静默失效）
  eq(GUARD_DEFAULTS.muteAdminOnlyNotice, true, 'guard: DEFAULTS 里默认吞掉');

  // 整段只有这条回执时也要 drop，不能发出空消息
  const segsMute = sanitizeSegments(
    [{ type: 'text', data: { text: adminOnly } }],
    { stripAside: true, muteAdminOnlyNotice: true },
  );
  ok(segsMute.drop === true, 'guard: 整条只有回执 → drop');
}

// ─────────────────────────────────────────────────────────────────────────────
section('rules 规则表');

eq(RULES.length, 17, 'rules: 共 17 条');
eq(
  RULES.map((r) => r.id),
  [
    'silent',
    'speak',
    'ability',
    'aside',
    'image',
    'link',
    'quarrel',
    'face',
    'tone',
    'voice',
    'time',
    'channel',
    'batch',
    'topic',
    'idle',
    'unsaid',
    'phone',
  ],
  'rules: id 顺序稳定',
);
// 2026-10-17：requireMention:false 之后「每条都进模型」，而提示词原本一边倒
// 全是沉默规则、没有任何「什么时候该开口」的正面判据，实测 19 回合里沉默 4 次。
// 这条规则是那个缺口的补丁，钉住它存在、且顺位紧跟 silent（沉默之后立刻讲开口）。
{
  const speak = RULES.find((r) => r.id === 'speak');
  ok(speak !== undefined, 'rules: 存在 speak（群里什么时候该开口）规则');
  eq(RULES.indexOf(speak), 1, 'rules: speak 紧跟在 silent 之后');
  const body = speak.lines.join('\n');
  ok(body.includes('大多数时候是听着的'), 'speak: 明确保留「大多数时候是听着」');
  ok(body.includes('[[silent]]'), 'speak: 给出沉默的正确出口');
  ok(body.includes('绝不硬接'), 'speak: 防刷屏（绝不硬接）');
  ok(body.includes('[@我]'), 'speak: 列出具象的开口情形（被点名）');
  // ── 2026-10-21 收紧：用户说「群里接话频率太高了」（实测 10 分钟窗口占 50%）。
  // 他明确不要硬限制，所以只改措辞：从「该接的就接」翻成「一段对话只接一次」。
  ok(body.includes('只接'), 'speak: 一段对话只接一次（2026-10-21 收紧）');
  ok(body.includes('在跟彼此说话'), 'speak: 先分清他们在跟谁说话（别人互相聊时别插）');
}
ok(
  RULES.every((r) => Array.isArray(r.lines) && r.lines.length > 0),
  'rules: 每条都有 lines',
);
ok(
  RULES.find((r) => r.id === 'silent').lines.join('').includes('[[silent]]'),
  'rules: 沉默条明写 [[silent]]',
);
ok(
  RULES.find((r) => r.id === 'voice').lines.join('').includes('qq_say'),
  'rules: 语音条点名 qq_say 工具',
);
// 2026-10-16 新增：语音条的「说人话」要求。起因是用户嫌合成音「人机感」，
// 实测（对照实验 _gen_nat.py）发现播报感有很大一部分来自**书面腔文本**，
// 而 edge-tts 免费端点的 SSML 只能调 prosody（<break> 被拒、express-as 要付费），
// 文本层是唯一还能榨自然度的地方。这条断言防止它被后来的人当成啰嗦删掉。
ok(
  RULES.find((r) => r.id === 'voice').lines.join('').includes('说人话'),
  'rules: 语音条要求把话「说人话」（口语化改写）',
);
eq(Object.keys(DEFAULT_RULES).length, 17, 'rules: DEFAULT_RULES 十七项全开');
// 2026-10-19 新增：语音说完别用第三人称复述。起因是用户截图问
// 「怎么还有这种给第三方讲解的」——qq_say 之后正文又写「我催他去睡了」。
// 闸层兜底在 modules/echo.js；提示词这一条是提前拦住，成本更低。
ok(
  RULES.find((r) => r.id === 'voice').lines.join('').includes('第三人称'),
  'rules: 语音条禁止发完再用第三人称复述',
);
// 2026-10-21 新增：默认打字、语音是例外。起因是用户问「怎么全是语音了」——
// 原文「话一长就用语音说」被读成「不止一句就念」，语音成了默认通道。
{
  const voiceBody = RULES.find((r) => r.id === 'voice').lines.join('');
  ok(voiceBody.includes('默认打字'), 'rules: 语音条把默认翻成打字');
  ok(voiceBody.includes('例外'), 'rules: 语音条明确语音是例外不是默认通道');
}
// 2026-10-22 新增：一次只说一句。起因是用户说「上到 QQ 就觉着不对劲」——
// 实测她 QQ 出站平均 30 字、最长 58 字，而提示词说真人是中位 6 字。
// 根子在于她在写的时候就把三四个念头打包成一条 qq_say，出站切分救不回来。
{
  const toneBody = RULES.find((r) => r.id === 'tone').lines.join('');
  ok(toneBody.includes('一次只说一句'), 'rules: 短句条要求一次只说一句');
  ok(toneBody.includes('打包'), 'rules: 短句条教她辨认自己有没有打包');
  const voiceBody = RULES.find((r) => r.id === 'voice').lines.join('');
  ok(voiceBody.includes('一条语音只说一件事'), 'rules: 语音条要求一条只说一件事');
  ok(voiceBody.includes('25 字'), 'rules: 语音条给出字数刻度');
}
ok(
  RULES.find((r) => r.id === 'aside').lines.join('').includes('说给对方'),
  'rules: 旁白条明写「说给对方」判据',
);
// 话题插话条要给出「不想接就 [[silent]]」的退路 —— 否则她进了群就以为非说不可。
ok(
  RULES.find((r) => r.id === 'topic').lines.join('').includes('[[silent]]'),
  'rules: 插话条给出沉默退路',
);
// ── 2026-10-20：用户批准的三件事（想说没说出口的话 / 发呆 / 自己的额度）里，
// 前两件是规则层的，钉住它们存在且措辞不许退化成「任务」或「报幕」。
{
  const idle = RULES.find((r) => r.id === 'idle');
  ok(idle !== undefined, 'rules: 存在 idle（可以什么都不干）规则');
  const idleBody = idle.lines.join('');
  ok(idleBody.includes('什么都不干'), 'rules: idle 条明写「可以什么都不干」');
  ok(idleBody.includes('不欠谁'), 'rules: idle 条明写「不欠谁一句话」');
  // 禁止她宣布自己在发呆 —— 那就是旁白，① 和 ② 都会拦。
  ok(idleBody.includes('不要说出来'), 'rules: idle 条禁止报幕「我在发呆」');

  const unsaid = RULES.find((r) => r.id === 'unsaid');
  ok(unsaid !== undefined, 'rules: 存在 unsaid（咽回去的话可以按住）规则');
  const unsaidBody = unsaid.lines.join('');
  ok(unsaidBody.includes('qq_unsaid'), 'rules: unsaid 条点名 qq_unsaid 工具');
  ok(unsaidBody.includes('原话'), 'rules: unsaid 条要求按住原话');
  // 三条禁忌，逐条钉住：不许当任务、不许当欠账、不许教她报幕式开场。
  ok(unsaidBody.includes('别为了用它而用它'), 'rules: unsaid 条禁止为了用工具而用工具');
  ok(unsaidBody.includes('不等于欠着'), 'rules: unsaid 条明写按住了不等于欠着');
  ok(unsaidBody.includes('我有话一直没说'), 'rules: unsaid 条堵住「我有话一直没说」这种开场');
}

// ── 2026-10-14 补回的第二批：规则里的**具体事实**必须与现役 0.9.0 对得上，
//    否则提示词会让模型去找不存在的东西。这几条是刻意锁住的回归闸。
//
//    ⚠️ 同日晚些时候 `stamp` 模块把 time/gap 属性**补回来了**，下面原本钉
//    「不许引用这两个属性」的两条断言随之反转成「必须正确引用」——
//    当年那两条是对的（属性那时确实没有），现在反过来写才对。
section('rules 第二批（与 0.9.0 实况对齐）');

// 属性既然真的存在了，规则就必须**告诉模型怎么用**，而且必须写明「看 gap、
// 别自己减 time」——那是当年加这两个属性的全部动机（模型做时间减法不可靠）。
{
  const timeRule = RULES.find((r) => r.id === 'time').lines.join('');
  ok(timeRule.includes('gap='), 'rules: time 条引用已补回的 gap 属性');
  ok(
    timeRule.includes('别自己拿 time 相减') || timeRule.includes('别自己减'),
    'rules: time 条明写「看 gap、别自己减 time」',
  );
  ok(
    timeRule.includes('time="') && timeRule.includes('gap="'),
    'rules: time 条给出 time/gap 的实际格式',
  );
  // 缺席时不许猜 —— 这是 gap 为空的真实情形（刚重启、本会话还没收过消息）。
  ok(
    /缺席|留空|为空|没有基线/.test(timeRule),
    'rules: time 条说明属性可能缺席且不许猜',
  );
  ok(
    !timeRule.includes('消息上没有时间戳'),
    'rules: time 条不再说「消息上没有时间戳」（那现在是错的）',
  );
}
ok(
  !RULES.some((r) => r.id !== 'time' && r.lines.some((l) => /\bgap="|time="/.test(l))),
  'rules: 只有 time 条谈 time/gap 格式，其余条不越界',
);
ok(
  // 2026-10-19 晚：`qq_like` / `qq_react` 由本插件的 hands 模块**自己**重新提供了
  // （不再依赖 0.9.0 移除的那批上游动作工具），所以这两名字现在可以出现在规则里。
  // 仍然禁止的是那批真·不存在的上游工具 —— 规则里提到它们等于教她去调空气。
  !RULES.some((r) => r.lines.some((l) => /qq_set_remark|qq_set_avatar|qq_post_qzone|qq_poke_with|qq_set_sign/.test(l))),
  'rules: 不引用 0.9.0 已移除、且本插件也没重开的 qq_ 动作工具',
);
ok(
  !RULES.some((r) => r.id !== 'link' && r.lines.some((l) => l.includes('[卡片'))),
  'rules: 只有 link 条谈 [卡片] 占位（linkcard 模块重开了卡片展开）',
);
ok(
  RULES.find((r) => r.id === 'link').lines.join('').includes('web_fetch'),
  'rules: link 条要求先 web_fetch 打开链接再说话',
);
ok(
  RULES.find((r) => r.id === 'link').lines.join('').includes('编内容'),
  'rules: link 条明写「读不到别编内容」',
);
// 2026-10-19：云玥在私聊里编「我点开了」「我发了个邀请过去」（用户「这不太对啊」）。
// 这条规则专门划能力边界，钉住三个关键否定词，别在后续编辑里被磨掉。
{
  const ability = RULES.find((r) => r.id === 'ability');
  ok(ability !== undefined, 'rules: 存在 ability（能力边界）规则');
  const body = ability.lines.join('\n');
  ok(body.includes('点开了'), 'rules: ability 条点名「我点开了」这类假动作');
  ok(body.includes('看不到对方的屏幕'), 'rules: ability 条写明看不到对方屏幕');
  ok(body.includes('告诉他怎么点'), 'rules: ability 条给出「给步骤」的正确姿势');
  ok(
    body.includes('不知道就别指挥'),
    'rules: ability 条禁止凭空指挥（2026-10-19 她让对方去她的资料卡找入口）',
  );
  ok(
    body.includes('别为这个专门去登我的号'),
    'rules: ability 条明说「别为我折腾」（用户「膈应」那次）',
  );
  ok(
    body.includes('登录'),
    'rules: ability 条说明需要登录的页面打不开',
  );
  // 2026-10-19 晚：hands 模块给了真工具，规则必须跟着改（否则与工具清单打架）。
  ok(
    body.includes('qq_poke'),
    'rules: ability 条列出真能做的社交小事（qq_poke 等）',
  );
  ok(
    body.includes('needsApproval') || body.includes('去问一声'),
    'rules: ability 条说明 qq_approve 只是「去问一声」',
  );
  ok(
    body.includes('已经同意了') && body.includes('绝不能'),
    'rules: ability 条禁止在审批前说「已经同意了」',
  );
  ok(
    !body.includes('你只有一张嘴，没有手'),
    'rules: ability 条已不再写「只有嘴没有手」（hands 落地后那句是事实错误）',
  );
  // 2026-10-19：用户「可以自己改QQ名，改签名，这些不用我审批」。
  ok(
    body.includes('qq_profile'),
    'rules: ability 条列出 qq_profile（改自己的昵称/签名）',
  );
  ok(
    body.includes('改自己的名字和签名不用问谁'),
    'rules: ability 条明说改自己的资料不用审批',
  );
  ok(
    body.includes('别没事就改'),
    'rules: ability 条约束「别动不动就改名」（名字是身份）',
  );
}
ok(
  RULES.find((r) => r.id === 'image').lines.join('').includes('[图片:本地路径]'),
  'rules: image 条写明 [图片:本地路径] 可复用',
);
ok(
  RULES.find((r) => r.id === 'tone').lines.join('').includes('⏳'),
  'rules: tone 条禁状态符号（含 ⏳）',
);
ok(
  RULES.find((r) => r.id === 'channel').lines.join('').includes('[@我]'),
  'rules: channel 条讲清 [@我] 与 @ 别人',
);
ok(
  RULES.find((r) => r.id === 'batch').lines.join('').includes('一起回'),
  'rules: batch 条讲清合并成批',
);
{
  // 2026-10-15：断言原先钉字面词「别依赖」，但那条措辞重写了（现在强调
  // 「兜底，不是许可证」）。断言该保护**语义**：tone 必须明确告诉模型
  // 「自动分段是事后补救、不能拿它当写长的理由」。
  const tone = RULES.find((r) => r.id === 'tone').lines.join('');
  ok(
    /兜底|补救|许可证/.test(tone),
    'rules: tone 条提醒自动分段只是兜底（不是写长的许可证）',
  );
  // 另一条实质语义：必须给出**可对照的尺子**（真实统计），而不只是「要短一点」。
  ok(
    /中位\s*\d|不超过\s*\d+\s*个字|\d+%/.test(tone),
    'rules: tone 条给出真实统计刻度（中位数/百分比），不是空泛的「要短」',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
section('tools 工具 schema');

// 2026-10-14 实测（QQ 会话 HTTP 400，上游 code 11129「工具定义不合规」）：
// `qq_say` / `qq_send_face` 走的是**直接** `tools.register`（因为 profile 侧
// 解析不到 `@deepseek-ai/dsh-tools`，用不了 `defineTool()`），所以 parameters
// 必须**自带完整 JSON Schema 外壳** `type: 'object'`；写成 `defineTool()` 那种
// 扁平参数映射会被原样透传给上游，触发 400。这条断言钉住这个坑。
{
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const toolNames = [...src.matchAll(/name:\s*'(qq_[a-z_]+)'/g)].map((m) => m[1]);
  eq(
    toolNames.sort().join(','),
    'qq_approve,qq_diary,qq_draw,qq_face,qq_intimate,qq_like,qq_phone,qq_poke,qq_profile,qq_promise,qq_react,qq_recall,qq_requests,qq_say,qq_send_face,qq_sticker,qq_unsaid',
    'tools: 注册了 17 个 qq_* 工具',
  );
  for (const toolName of toolNames) {
    const at = src.indexOf(`name: '${toolName}'`);
    const seg = src.slice(at, at + 900);
    const paramAt = seg.indexOf('parameters:');
    ok(paramAt >= 0, `tools: ${toolName} 带 parameters`);
    ok(
      /type:\s*'object'/.test(seg.slice(paramAt, paramAt + 120)),
      `tools: ${toolName} 的 parameters 自带 type:'object'（直接 register 必须完整 JSON Schema）`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section('prompt 模块');

eq(renderRules({ rules: { ...DEFAULT_RULES } }).includes('QQ'), true, 'prompt: 规则文本带 QQ 前缀');
eq(renderRules({ rules: Object.fromEntries(RULES.map((r) => [r.id, false])) }), null, 'prompt: 全关 → null');
ok(renderRules({ rules: { silent: false } }).length < renderRules({ rules: {} }).length, 'prompt: 关一条 → 文本变短');

eq(sessionIdOf({ session: { id: 'onebot-private-1' } }), 'onebot-private-1', 'prompt: sessionIdOf 取 id');
eq(sessionIdOf({ session: { key: 'onebot-x' } }), 'onebot-x', 'prompt: sessionIdOf 回退 key');
eq(sessionIdOf({}), null, 'prompt: sessionIdOf 无会话 → null');

{
  const stats = fakeStats();
  stats.steps = 0;
  stats.injections = 0;
  stats.skippedNotOnebot = 0;
  stats.skippedNotFirstStep = 0;
  const p = createPrompt({ cfg: { ...createPromptDefaults() }, stats, extra: () => '情绪行' });
  ok(p.activeRuleIds().length === RULES.length, `prompt: 默认 ${RULES.length} 条全开`);
  eq(p.setRule('silent', false), { ok: true, id: 'silent', enabled: false }, 'prompt: setRule 关');
  eq(p.setRule('nope', true), { ok: false, reason: 'unknown rule' }, 'prompt: 未知规则被拒');
  eq(p.setRule('silent'), { ok: true, id: 'silent', enabled: true }, 'prompt: setRule 无参=翻转');

  const decision = { messages: [{ role: 'user', content: '原消息' }] };
  const next = async () => decision;
  const out = await p.preStep({ agent: { session: { id: 'onebot-private-1' } }, turn: 1, step: 1 }, next);
  ok(out.messages.length === 2, 'prompt: 首步注入一条消息');

  // ⚠️ 形状断言（2026-10-13 16:16 真实事故的回归锁）：
  // 注入消息的 `content` **必须是数组**。曾经写成裸字符串，宿主对 content 调
  // `.some()` 时整回合崩掉（`message.content.some is not a function`），
  // 用户发的消息云玥完全没能回。自测当时没抓到，是因为下面的断言也在按字符串写
  // （`.includes` 对数组不存在，本该报错却因为实现也是字符串而"通过"）。
  const inj = out.messages[1];
  ok(Array.isArray(inj.content), 'prompt: 注入消息的 content 是数组（不是字符串）');
  eq(inj.content[0].type, 'text', 'prompt: 注入 content 首块是 text');
  const injText = inj.content.map((b) => b.text).join('');
  ok(injText.includes('QQ'), 'prompt: 注入内容含规则');
  ok(injText.includes('情绪行'), 'prompt: 情绪行搭车注入');
  eq(inj.role, 'user', 'prompt: 注入消息 role 是 user');
  eq(inj.source.kind, 'onebot-prompt', 'prompt: 注入消息带 source 标记');
  // ⚠️ id 断言（2026-10-13 20:30 第二条事故的回归锁）：
  // 注入消息缺 id 时，宿主**写入不校验、读取才校验**，于是坏消息顺利落盘，
  // 直到下次加载会话才整条炸掉（`session event at seq N lacks an identified
  // message`），后果是整个会话永久打不开。这条断言必须存在。
  ok(
    typeof inj.id === 'string' && inj.id.length > 0,
    'prompt: 注入消息带 id（缺 id 会让会话永久打不开）',
  );

  const again = await p.preStep({ agent: { session: { id: 'onebot-private-1' } }, turn: 1, step: 1 }, next);
  eq(again.messages.length, 1, 'prompt: 同一轮只注入一次');

  const other = await p.preStep({ agent: { session: { id: 'web-abc' } }, turn: 1, step: 1 }, next);
  eq(other.messages.length, 1, 'prompt: 非 onebot 会话不注入');
  eq(stats.skippedNotOnebot, 1, 'prompt: 统计跳过非 onebot');

  const step2 = await p.preStep({ agent: { session: { id: 'onebot-private-2' } }, turn: 1, step: 2 }, next);
  // ⚠️ 2026-10-15 语义变更：`firstStepOnly` 现在**只管规则文本**，不管 `extra`。
  // 旧断言是「非首步什么都不注入」—— 那正是 bug：人格状态行（情绪/风格画像）
  // 也只在第一步进去过一次，跑了几百轮的会话等于从来没收到过画像。
  eq(step2.messages.length, 2, 'prompt: 非首步仍注入（人格状态行要每步都给）');
  {
    const t2 = step2.messages[1].content.map((b) => b.text).join('');
    ok(!t2.includes('以下是你在 QQ 上说话要遵守的习惯'), 'prompt: 非首步不重复注入规则文本');
    ok(t2.includes('情绪行'), 'prompt: 非首步仍注入情绪行');
  }
}

function createPromptDefaults() {
  return { enabled: true, rules: { ...DEFAULT_RULES }, firstStepOnly: true, sourceName: 'onebot-prompt' };
}

// ─────────────────────────────────────────────────────────────────────────────
section('burst 分段');

// 空串 → 空数组（与 P3 原版 `splitBurstChunks('') === []` 一致）。
// 之前写 `['']` 是错的：`[]` 的语义是「没有要发的东西」，而 `['']` 会被调用方
// 当成「有一条空消息要发」。
eq(splitBurstChunks(''), [], 'burst: 空串返回空数组');
eq(splitBurstChunks(null), [], 'burst: null 返回空数组');
eq(splitBurstChunks(undefined), [], 'burst: undefined 返回空数组');
eq(splitBurstChunks('短句'), ['短句'], 'burst: 短句不切');
{
  const chunks = splitBurstChunks('第一句话。第二句话。第三句话。', { maxChars: 8, maxChunks: 4 });
  ok(chunks.length === 3, `burst: 三句切成三条（实际 ${chunks.length}）`);
  eq(chunks[0], '第一句话。', 'burst: 第一条是完整句');
}
// 尾巴折叠：maxChars=2 时六句各成一条，超过 maxChunks=3 才折叠。
// 之前用 maxChars=4，四条字正好两条一句、只切出 3 条，根本没触发折叠。
{
  const chunks = splitBurstChunks('一。二。三。四。五。六。', { maxChars: 2, maxChunks: 3 });
  eq(chunks.length, 3, 'burst: 超 maxChunks 折叠成 3 条');
  ok(chunks[2].includes('三') && chunks[2].includes('六'), 'burst: 尾巴折叠进最后一条');
}
// 空行是**强制断句**（不是「预算内就不切」）—— 空行代表作者真的想分段。
eq(splitBurstChunks('段落一\n\n段落二', { maxChars: 100 }), ['段落一', '段落二'], 'burst: 空行强制断句');
eq(splitBurstChunks('第一段。\n\n第二段。', { maxChars: 100 }), ['第一段。', '第二段。'], 'burst: 空行分段');
ok(
  splitBurstChunks('甲\n\n乙', { maxChars: 2 }).length === 2,
  'burst: 空行在超预算时强制断',
);
eq(splitBurstChunks('3.14 是圆周率', { maxChars: 100 }), ['3.14 是圆周率'], 'burst: 小数点不切');
{
  const code = '看这个：\n```js\nconst a = 1;\nconst b = 2;\n```\n就这样';
  const chunks = splitBurstChunks(code, { maxChars: 10, maxChunks: 8 });
  ok(chunks.some((c) => c.includes('const a = 1;') && c.includes('const b = 2;')), 'burst: 代码围栏原子不切');
}
eq(splitBurstChunks('abc', { maxChunks: 1 }), ['abc'], 'burst: maxChunks<=1 原样');
eq(splitBurstChunks('abc', { maxChars: 0 }), ['abc'], 'burst: maxChars<=0 原样');
ok(
  splitBurstChunks('一二三四五六七八九十一二三四五六七八九十，后半句。', { maxChars: 12 }).length >= 2,
  'burst: 超长句在逗号处切',
);
ok(
  splitBurstChunks('甲。乙。', { maxChars: 8 }).every((c) => c === c.trim()),
  'burst: 结果无首尾空白',
);

// 2026-10-15：用户报「断句断在逗号或句号上啊，别文字里断啊」——真实回复
// 「…攒了 100 多块出来…」被切成「…攒了 100」/「多块出来…」，因为软断点表里
// 的空格把「100 多块」的排版空格当成了词边界。空格只在两侧都不是中日韩文字
// 时才作数。
section('burst 软断点（空格不算词边界）');
{
  const real = '其实你前面做的那几笔挺可以的，7 月到 10 月攒了 100 多块出来，不是全靠运气。';
  const chunks = splitBurstChunks(real, { maxChars: 36, maxChunks: 4 });
  ok(
    chunks.every((c) => !/(^|[^0-9])100$/.test(c)),
    'burst: 数字与量词之间不切（「100 多块」不被劈开）',
  );
  ok(
    chunks.every((c) => !/^多块/.test(c)),
    'burst: 不在词中间起一条消息',
  );
  ok(
    chunks.some((c) => c.includes('100 多块')),
    'burst: 「100 多块」整块留在同一条里',
  );
  ok(isSoftBreak('100 多块', 3) === false, 'burst: 数字与汉字之间的空格不是断点');
  ok(isSoftBreak('hello world', 5) === true, 'burst: 英文句子里的空格仍是断点');
  ok(isSoftBreak('甲，乙', 1) === true, 'burst: 中文逗号是断点');
  ok(isSoftBreak('甲、乙', 1) === true, 'burst: 顿号是断点');
  ok(isSoftBreak('甲；乙', 1) === true, 'burst: 分号是断点');

  // 2026-10-17 实测缺陷：群里让她写 print("hello world")，被切成
  // `print("hello` / `world") 拿去抄喵` —— 引号和圆括号都悬空。
  // 根因是 isSoftBreak 只判「空格两侧是不是中文」，不管是否在包裹内部。
  {
    const code = 'print("hello world") 拿去抄喵';
    const out = splitBurstChunks(code, { maxChars: 20, maxChunks: 6 });
    eq(out.length, 1, 'burst: print("hello world") 不被切开（括号内不断句）');
    eq(out[0], code, 'burst: 代码原样保留，引号成对');
    ok(
      isSoftBreak(code, 12) === false,
      'burst: 双引号内的空格不是断点（截图那个 25 字句子）',
    );
    ok(isInsideGrouping(code, 12) === true, 'burst: hello 后那个空格判在引号内部');
    ok(isInsideGrouping(code, 20) === false, 'burst: 闭合之后的位置不算内部');

    const single = "print('hello world') 拿去抄喵";
    eq(
      splitBurstChunks(single, { maxChars: 20, maxChunks: 6 }).length,
      1,
      'burst: 单引号版本同样不切',
    );
    // 中文全角括号与引号里的逗号也不该从中间劈开。
    const cjk = '（甲，乙，丙，丁，戊，己，庚，辛，壬，癸）';
    eq(
      splitBurstChunks(cjk, { maxChars: 10, maxChunks: 6 }).length,
      1,
      'burst: 全角括号内的逗号不断句',
    );
    const quote = '他说“这个东西真的很好用，你试试看嘛”';
    eq(
      splitBurstChunks(quote, { maxChars: 10, maxChunks: 6 }).length,
      1,
      'burst: 中文引号内的逗号不断句',
    );
    // 括号不配对时整段不切 —— 少切一刀只是长一点，切坏了是内容被破坏。
    ok(
      isInsideGrouping('print("hello world', 12) === true,
      'burst: 引号没闭合时按「内部」处理（宁可不断）',
    );
  }
  const en = splitBurstChunks(
    'This is a fairly long English sentence, and it should still be split on spaces for readability.',
    { maxChars: 36, maxChunks: 4 },
  );
  ok(en.length >= 2 && en.every((c) => c.length <= 40), 'burst: 英文照旧能按空格切成多条');
}

// ─────────────────────────────────────────────────────────────────────────────
section('rhythm 判据');

ok(isSystemNotice('⏳ 当前任务运行中，新消息已排队'), 'rhythm: ⏳ 队列提示判为系统消息');
ok(isSystemNotice('⚠️ 出错了'), 'rhythm: ⚠️ 判为系统消息');
ok(isSystemNotice('❌ 失败'), 'rhythm: ❌ 判为系统消息');
ok(isSystemNotice('你好') === false, 'rhythm: 正常消息不是系统消息');
ok(isSystemNotice('  你好') === false, 'rhythm: 前置空白后仍不是');

const burstCfg = { burst: { maxChars: 10, maxChunks: 4 } };
ok(shouldBurst('这是一句足够长的话了真的', { queuable: true }, burstCfg), 'rhythm: queuable + 超长 → 切');
ok(shouldBurst('这是一句足够长的话了真的', {}, burstCfg) === false, 'rhythm: 不带 queuable 不切');
ok(shouldBurst('这是一句足够长的话了真的', { burst: true }, burstCfg), 'rhythm: burst:true 强制切');
ok(shouldBurst('这是一句足够长的话了真的', { queuable: true, burst: false }, burstCfg) === false, 'rhythm: burst:false 强制不切（防重入）');
ok(shouldBurst('⏳ 当前任务运行中，新消息已排队', { queuable: true }, burstCfg) === false, 'rhythm: 系统消息不切');
// 2026-10-15：判据不再拿字数当门槛 —— 短文本由分段器的输出条数挡，不在这里挡。
ok(shouldBurst('短', { queuable: true }, burstCfg), 'rhythm: 短文本也交给分段器（不按字数预判）');
eq(splitBurstChunks('短', { maxChars: 10, maxChunks: 4 }).length, 1, 'rhythm: 短文本交给分段器后只有 1 条，故不会真的分');
ok(shouldBurst('晚安。早八那会儿我给你发消息，你醒了别当没看见。', { queuable: true }, burstCfg), 'rhythm: 未超 maxChars 的真实回复也要尝试（曾经的漏切场景）');

eq(kindOfChatId('private:123'), 'private', 'coalesce: private 判定');
eq(kindOfChatId('group:456'), 'group', 'coalesce: group 判定');
eq(kindOfChatId('123'), 'private', 'coalesce: 裸号按私聊');

// ─────────────────────────────────────────────────────────────────────────────
section('coalesce 入站合并');

{
  const delivered = [];
  const stats = fakeStats();
  const c = new InboundCoalescer({
    log: () => {},
    isStopping: () => false,
    quietMs: () => 60,
    groupQuietMs: () => 30,
    maxWaitMs: () => 500,
    isBusy: () => false,
    dispatch: (chatId, item) => delivered.push({ chatId, text: item.text }),
    stats: stats.inbound,
  });
  c.hold('private:1', { text: 'a', role: 'member', nickname: 'n' });
  c.hold('private:1', { text: 'b', role: 'member', nickname: 'n' });
  ok(c.pendingCount === 1, 'coalesce: 同一 chat 只攒一批');
  await sleep(160);
  eq(delivered.length, 1, 'coalesce: 安静窗口后合成一次投递');
  eq(delivered[0].text, 'a\nb', 'coalesce: 两条按序 join');
  eq(stats.inbound.merged, 1, 'coalesce: 统计合并次数');

  c.hold('private:2', { text: 'x', role: 'member' });
  c.hold('group:9', { text: 'y', role: 'member' });
  ok(c.pendingCount === 2, 'coalesce: 不同 chat 各自攒批');
  await sleep(160);
  eq(delivered.length, 3, 'coalesce: 两批分别投递');

  c.hold('private:3', { text: 'q', role: 'member' }, { immediate: true });
  eq(delivered.length, 4, 'coalesce: immediate 立刻投递');
  c.stop();
  ok(c.pendingCount === 0, 'coalesce: stop 后清空');
}

{
  const delivered = [];
  const c = new InboundCoalescer({
    log: () => {},
    isStopping: () => false,
    quietMs: () => 40,
    groupQuietMs: () => 40,
    maxWaitMs: () => 100,
    isBusy: () => true, // 一直忙 → 超过 maxWait 也不能投
    dispatch: (chatId, item) => delivered.push(item.text),
    stats: { held: 0, merged: 0, flushed: 0, dropped: 0 },
  });
  c.hold('private:1', { text: 'z', role: 'member' });
  await sleep(200);
  ok(delivered.length === 0, 'coalesce: busy 时不投递（等下一轮）');
  c.stop();
}

{
  const delivered = [];
  const c = new InboundCoalescer({
    log: () => {},
    isStopping: () => true, // 正在停 → 新消息直接丢
    quietMs: () => 30,
    groupQuietMs: () => 30,
    maxWaitMs: () => 200,
    isBusy: () => false,
    dispatch: (chatId, item) => delivered.push(item.text),
    stats: { held: 0, merged: 0, flushed: 0, dropped: 0 },
  });
  c.hold('private:1', { text: 'w', role: 'member' });
  await sleep(120);
  eq(delivered.length, 0, 'coalesce: isStopping 时不接收');
  c.stop();
}

// ─────────────────────────────────────────────────────────────────────────────
section('mood 情绪状态机');

eq(MOOD_IDS.length, 8, 'mood: 8 种心情');
{
  const s = createMoodState(1_000_000);
  eq(s.mood, 'calm', 'mood: 初始心情 calm');
  eq(s.energy, 80, 'mood: 初始精力 80');
  eq(s.affinity, 20, 'mood: 初始亲密度 20');
  eq(s.warmth, 50, 'mood: 初始热情 50');
  ok(s.lastMoodRollAt === 0, 'mood: lastMoodRollAt 初始 0');
}
{
  let t = 1_000_000;
  let s = createMoodState(t);
  s = noteUserMessage(s, t);
  eq(s.energy, 88, 'mood: 用户消息 +8 精力（R2 从 2 提高）');
  eq(s.affinity, 21.5, 'mood: 用户消息 +1.5 亲密度');
  eq(s.warmth, 56, 'mood: 用户消息 +6 热情');
  s = noteAssistantMessage(s, t);
  eq(s.energy, 86.5, 'mood: 她说话 -1.5 精力');
  s = noteProactive(s, t);
  eq(s.energy, 83.5, 'mood: 主动开口 -3 精力');
  // 一来一回的净收支必须为正，否则「聊天」永远顶不动精力（旧 +2 的病症）。
  const oneRound = noteAssistantMessage(noteUserMessage(createMoodState(t), t), t);
  ok(oneRound.energy > 80, 'mood: 一个来回净回血为正');
}
{
  // R2：精力按昼夜**逐段推进并逐段夹紧**，而不是用结算时刻的小时给整段跨度一刀切。
  //
  // 取 10-12 16:00 → 10-16 18:00（跨度 98h），逐段推演：
  //   80 - 8h×7  = 24            （10-12 白天余 8h）
  //   24 + 8h×14 = 100 → 夹紧     （10-13 夜里，溢出浪费）
  //   100 - 16h×7 = 0            （10-13 白天）
  //   ……13/14/15 三个昼夜各自「睡满回 100、白天耗到 0」
  //   0 + 8h×14 = 100            （10-16 夜里）
  //   100 - 10h×7 = 30           （10-16 白天 8:00→18:00）
  const from = new Date('2026-10-12T16:00:00+08:00').getTime();
  const to = new Date('2026-10-16T18:00:00+08:00').getTime();
  const cfg = {
    moodDriftMinutes: 20,
    energyDecayPerHour: 7,
    nightRecoveryPerHour: 14,
    nightStartHour: 0,
    nightEndHour: 8,
  };
  const s = { ...createMoodState(from), energy: 80, lastDriftAt: from };
  const d = driftMood(s, to, () => 0.5, cfg);
  eq(d.energy, 30, 'mood: 逐段夹紧积分——跨天结算给出 30 而非归 0');
  ok(d.energy !== 0, 'mood: 跨天结算不再必然被夹死在 0（这就是修掉的 bug）');
  // 同一段跨度若用「先求总夜间时长、总白天时长再一次性相减」的线性积分，日夜收支
  // 几乎抵消（只差最后不完整的那半段），于是精力基本原地不动。这条锁死「必须逐段
  // 夹紧」这个实现选择，防止有人把它优化回线性。
  const nightHours = 4 * 8;
  const dayHours = 8 + 3 * 16 + 10;
  eq(nightHours * 14 - dayHours * 7, -14, 'mood: 线性积分下日夜收支几乎抵消（净 -14）');
  eq(80 + nightHours * 14 - dayHours * 7, 66, 'mood: 线性积分给出 66 ≠ 逐段夹紧的 30 —— 所以必须逐段夹紧');
}
{
  // 逐段夹紧的验收：从 0 出发睡一夜能回血，不再被「净收支 0」锁死。
  const cfg = {
    moodDriftMinutes: 20,
    energyDecayPerHour: 7,
    nightRecoveryPerHour: 14,
    nightStartHour: 0,
    nightEndHour: 8,
  };
  const d0 = new Date('2026-10-16T00:00:00+08:00').getTime();
  const d1 = new Date('2026-10-17T00:00:00+08:00').getTime();
  const from0 = driftMood({ ...createMoodState(d0), energy: 0, lastDriftAt: d0 }, d1, () => 0.5, cfg);
  eq(from0.energy, 0, 'mood: 从 0 出发跨完整昼夜 → 当天结束时又耗回 0');
  // 但中途（早上 8 点刚睡醒）必须是满的 —— 这才是「精力真的在涨」。
  const wake = new Date('2026-10-16T08:00:00+08:00').getTime();
  const from0Wake = driftMood({ ...createMoodState(d0), energy: 0, lastDriftAt: d0 }, wake, () => 0.5, cfg);
  eq(from0Wake.energy, 100, 'mood: 从 0 出发睡一夜 → 早上满血（旧实现永远是 0）');
}
{
  // 分段积分的两端边界：整段都在夜里 → 纯回血；整段都在白天 → 纯掉电。
  const cfg = {
    moodDriftMinutes: 20,
    energyDecayPerHour: 7,
    nightRecoveryPerHour: 14,
    nightStartHour: 0,
    nightEndHour: 8,
  };
  const n0 = new Date('2026-10-16T01:00:00+08:00').getTime();
  const n1 = new Date('2026-10-16T05:00:00+08:00').getTime();
  const dd0 = new Date('2026-10-16T13:00:00+08:00').getTime();
  const dd1 = new Date('2026-10-16T17:00:00+08:00').getTime();
  const allNight = driftMood({ ...createMoodState(n0), energy: 20, lastDriftAt: n0 }, n1, () => 0.5, cfg);
  eq(allNight.energy, 76, 'mood: 全在夜里 → 4h × 14 纯回血');
  const allDay = driftMood({ ...createMoodState(dd0), energy: 80, lastDriftAt: dd0 }, dd1, () => 0.5, cfg);
  eq(allDay.energy, 52, 'mood: 全在白天 → 4h × 7 纯掉电');
}
{
  // 漂移：热情向基线回归，且回归是**恒定**的（不看随机）。
  let t = 1_000_000;
  let s = createMoodState(t);
  s = { ...s, warmth: 90 };
  const later = t + 3 * 3600_000; // 3 小时
  const d = driftMood(s, later, () => 0.5, { warmthRegressPerHour: 10, warmthBaseline: 30 });
  eq(d.warmth, 60, 'mood: 热情按小时恒定回归（90 - 3×10）');
}
{
  // 心情门控：间隔不够就不重掷，且**一个随机数都不消费**。
  let t = 1_000_000;
  const s = createMoodState(t);
  let rolls = 0;
  const random = () => {
    rolls += 1;
    return 0.5;
  };
  const soon = driftMood(s, t + 60_000, random, { moodDriftMinutes: 20 });
  eq(rolls, 0, 'mood: 间隔不够时零随机消费');
  eq(soon.mood, 'calm', 'mood: 心情不变');

  const later = driftMood(s, t + 25 * 60_000, random, { moodDriftMinutes: 20 });
  eq(rolls, 2, 'mood: 真重掷消费 2 次随机（选心情 + 抖动热情）');
  ok(later.lastMoodRollAt === t + 25 * 60_000, 'mood: lastMoodRollAt 只在重掷时推进');
}
{
  const s = { ...createMoodState(1000), lastUserAt: 5000, lastAssistantAt: 3000 };
  eq(quietMs(s, 5000), 0, 'mood: quietMs 取最近一次互动');
  // 三个时间戳全 0 → 返回 now 本身（文档语义：「视作从纪元起一直安静」），
  // 不是 now - lastDriftAt。之前写 8000 是把 lastDriftAt 当成了参考点，
  // 但 quietMs 只认三个互动时间戳。
  eq(quietMs({ ...createMoodState(1000) }, 9000), 9000, 'mood: 三时间戳全 0 时 quietMs = now');
}
{
  const t = 1_000_000;
  const snap = moodSnapshot(noteUserMessage(createMoodState(t), t), t);
  ok(typeof snap.moodLabel === 'string' && snap.moodLabel !== '', 'mood: 快照带中文标签');
  ok(typeof snap.warmthLabel === 'string', 'mood: 快照带热情标签');
  const line = moodPromptLine(createMoodState(t), t, {});
  ok(line.includes('心情'), 'mood: 提示行含心情');
  ok(line.includes('热情'), 'mood: 提示行含热情');
  ok(!line.includes('{') && !line.includes('}'), 'mood: 提示行不含花括号（宿主插值器会炸）');
}
{
  // 低精力「漏水」：阈值以上一个字都不给（不许常驻占提示），以下必须给出
  // 具体到能执行的毛病，而不是「表现得累一点」这种模型没有刻度的措辞。
  const t = 1_000_000;
  const at = (e) => lowEnergyLine({ ...createMoodState(t), energy: e }, {});
  eq(at(80), '', 'lowEnergy: 精力 80 无提示');
  eq(at(30), '', 'lowEnergy: 精力 30（正好阈值）无提示');
  ok(at(29) !== '', 'lowEnergy: 精力 29 出提示');
  ok(at(29).includes('29/100'), 'lowEnergy: 提示里带出真实精力值');
  ok(!/[{}]/.test(at(0)), 'lowEnergy: 任何精力下都不含花括号（宿主插值器会炸）');
  ok(at(29).includes('别再反复权衡'), 'lowEnergy: 29 时管住「自我辩论」这条必出');
  ok(at(10).includes('不要顺着话头编一个像样的版本'), 'lowEnergy: 见底时叠加「承认记不清」');
  // 确定性：同样的精力与 lastUserAt 必须给出同样的提示（不消费 random，
  // 否则单测里逐条断言的随机数消费次数会错位）。
  eq(at(29), at(29), 'lowEnergy: 同输入同输出（不掷随机数）');
}
{
  const t = 1_000_000;
  const hot = proactiveChance({ ...createMoodState(t), warmth: 100 }, t, {});
  const cold = proactiveChance({ ...createMoodState(t), warmth: 0 }, t, {});
  ok(hot > cold, 'mood: 热情高 → 主动概率高');
  ok(hot <= 0.95 && cold >= 0, 'mood: 概率夹在 [0, 0.95]');
}
ok(WARMTH_BASELINE_DEFAULT === 30, 'mood: 热情基线默认 30');

// ─────────────────────────────────────────────────────────────────────────────
section('style 风格学习');

{
  const p0 = createStyleProfile();
  eq(p0.samples, 0, 'style: 空画像 samples=0');
  eq(stylePromptLine(p0), '', 'style: 样本 <3 时不注入（避免刚认识就说学会了）');

  let p = p0;
  for (let i = 0; i < 3; i++) p = mergeStyleSample(p, `哈哈哈我靠真的${i}`, 1000 + i, {});
  eq(p.samples, 3, 'style: 攒到 3 条');
  ok(p.particles['哈哈'] >= 1 || p.particles['哈哈哈'] >= 1, 'style: 统计到语气词');
  ok(stylePromptLine(p).length > 0, 'style: 样本够后产出提示行');
  ok(!stylePromptLine(p).includes('{'), 'style: 提示行不含花括号');
  ok(p.samples_.length <= 3, 'style: 最多留 3 条原话');
  ok(topParticles(p, 3).length <= 3, 'style: topParticles 限量');

  const noSample = mergeStyleSample(createStyleProfile(), '哈哈', 1, { sample: false });
  eq(noSample.samples_, [], 'style: sample:false 不记原话（群聊陌生人适用）');

  const placeholder = mergeStyleSample(createStyleProfile(), '[图片:C:\\a.png]', 1, {});
  eq(placeholder.samples, 0, 'style: 纯占位符不计样本');
}

// ─────────────────────────────────────────────────────────────────────────────
section('proactive 调度器（无 cron）');

{
  const fired = [];
  const timers = [];
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveMinMinutes: 10, proactiveMaxMinutes: 20 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:1' }],
    eligible: () => true,
    idleMs: () => 60 * 60_000,
    chance: () => 1,
    fire: async (chat, info) => fired.push({ chat: chat.chatId, info }),
    random: () => 0.5,
    now: () => 0,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  s.start();
  ok(timers.length === 1, 'proactive: start 后排一次评估');
  ok(timers[0].ms >= 10 * 60_000 && timers[0].ms <= 20 * 60_000, 'proactive: 间隔落在配置区间（随机）');
  await s.evaluate();
  eq(fired.length, 1, 'proactive: 概率门通过 → 开口一次');
  ok(fired[0].info.delayMs > 0, 'proactive: fire 带上间隔信息');
  s.stop();
}
{
  const fired = [];
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:1' }, { chatId: 'private:2' }],
    eligible: () => true,
    idleMs: () => 3600_000,
    chance: () => 0,
    fire: async () => fired.push(1),
    random: () => 0.99,
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  eq(fired.length, 0, 'proactive: 概率门不过 → 不开口');
}
{
  const s = new ProactiveScheduler({ config: { proactiveEnabled: false }, log: () => {}, setTimer: () => 1 });
  s.start();
  ok(s.running === false, 'proactive: proactiveEnabled=false 不启动');
}
{
  // 「搭过一句他没回 → 不再开口」。旧实现只按静默时长判断，于是搭完一句、
  // 对方没理，下个周期又满足条件再搭一句，变成追着人喊。
  const fired = [];
  let t = 0;
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveIdleMinutes: 20, proactiveQuietStart: 0, proactiveQuietEnd: 0 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:1' }],
    eligible: () => true,
    idleMs: () => 3 * 3600_000,
    chance: () => 1,
    fire: async () => fired.push(t),
    random: () => 0.5,
    now: () => t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  eq(fired.length, 1, 'proactive: 第一次冷场搭一句');
  ok(s.awaitingReply('private:1') === true, 'proactive: 搭完记下「等他回」');
  t += 3600_000;
  await s.evaluate();
  eq(fired.length, 1, 'proactive: 他没回就不追第二句');
  // 她自己说话（noteActivity）不该解锁 —— 否则自己给自己销账
  s.noteActivity('private:1');
  await s.evaluate();
  eq(fired.length, 1, 'proactive: noteActivity（她自己说话）不解锁');
  // 只有对方真回话才解锁
  s.noteUserReply('private:1');
  ok(s.awaitingReply('private:1') === false, 'proactive: 对方回话后解除静默锁');
  await s.evaluate();
  eq(fired.length, 2, 'proactive: 解锁后下一次冷场才能再搭');
}
{
  // fire 失败（真发不出去）不该把她锁到对方下次说话为止
  let fail = true;
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveQuietStart: 0, proactiveQuietEnd: 0 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:1' }],
    eligible: () => true,
    idleMs: () => 3 * 3600_000,
    chance: () => 1,
    fire: async () => { if (fail) throw new Error('boom'); },
    random: () => 0.5,
    now: () => 1000,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  ok(s.awaitingReply('private:1') === false, 'proactive: fire 抛错时撤掉静默锁');
  fail = false;
}
{
  // 深夜档标记：23:00–02:00 的评估要带 deepNight，好让措辞降级成「轻声一句」
  const infos = [];
  let t = new Date(2026, 9, 20, 23, 30, 0).getTime();
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveQuietStart: 2, proactiveQuietEnd: 8 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:1' }],
    eligible: () => true,
    idleMs: () => 3 * 3600_000,
    chance: () => 1,
    fire: async (chat, info) => infos.push(info.deepNight),
    random: () => 0.5,
    now: () => t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  eq(infos[0], true, 'proactive: 23:30 算深夜档');
  t = new Date(2026, 9, 20, 14, 0, 0).getTime();
  s.noteUserReply('private:1');
  await s.evaluate();
  eq(infos[1], false, 'proactive: 14:00 不算深夜档');
  t = new Date(2026, 9, 21, 1, 30, 0).getTime();
  s.noteUserReply('private:1');
  await s.evaluate();
  eq(infos[2], true, 'proactive: 01:30 算深夜档（跨零点）');
}

// ─────────────────────────────────────────────────────────────────────────────
section('voice 语音');

// speakableText：把「写给人看」的文本整理成「念给人听」的。
eq(speakableText('你好呀', 100), '你好呀', 'voice: 普通文本原样');
eq(speakableText('**加粗**', 100), '加粗', 'voice: 去掉 Markdown 强调');
eq(speakableText('第一行\n第二行', 100), '第一行，第二行', 'voice: 换行变停顿（不是念「换行」）');
eq(speakableText('```js\nconst a=1;\n```', 100), '', 'voice: 代码块整体丢掉');
eq(speakableText('[点我](https://x.com)', 100), '点我', 'voice: 链接只留文字');
eq(speakableText('## 标题', 100), '标题', 'voice: 去掉标题标记');
eq(speakableText('啊'.repeat(200), 10).length, 10, 'voice: 超长按 maxChars 截断');
eq(speakableText('   \n\n  ', 100), '', 'voice: 只有空白 → 空串');
eq(speakableText(null, 100), '', 'voice: 非字符串 → 空串');
eq(speakableText('一二三', 0), '一二三', 'voice: maxChars<=0 不截断');

// shim 源码：必须同时改 constants 与 communicate 两处（只改前者无效，实测过）。
ok(SHIM_SOURCE.includes('api.msedgeservices.com'), 'voice: shim 指向新 host');
ok(SHIM_SOURCE.includes('Ocp-Apim-Subscription-Key'), 'voice: shim 用订阅密钥参数（不是 TrustedClientToken）');
ok(SHIM_SOURCE.includes('_CM.WSS_URL'), 'voice: shim 同时改 communicate 的副本');
ok(SHIM_SOURCE.includes('if _LEGACY in _C.WSS_URL'), 'voice: shim 幂等（上游修好后自动跳过）');

// 音色表：默认音色必须在表里，且是成熟取向。
ok(VOICES.length >= 5, 'voice: 音色表非空');
ok(
  VOICES.some((v) => v.id === VOICE_DEFAULTS.voice),
  'voice: 默认音色在表内',
);
eq(VOICE_DEFAULTS.voice, 'zh-CN-XiaoxiaoNeural', 'voice: 默认音色是晓晓（用户要求「成熟点」）');

// Synthesizer 的构造与串行语义（不真跑 python）。
{
  const s = new Synthesizer({ voice: 'zh-CN-XiaoxiaoNeural', maxChars: 50 });
  eq(s.voiceId, 'zh-CN-XiaoxiaoNeural', 'voice: 音色透传');
  eq(s.charLimit, 50, 'voice: 字数上限透传');
  eq(s.rate, '+0%', 'voice: 非法 rate → 兜底');
  eq(s.pitch, '+0Hz', 'voice: 非法 pitch → 兜底');
  const s2 = new Synthesizer({ rate: '-5%', pitch: '-10Hz' });
  eq(s2.rate, '-5%', 'voice: 合法 rate 采纳');
  eq(s2.pitch, '-10Hz', 'voice: 合法 pitch 采纳');
  const s3 = new Synthesizer({ rate: 'abc', pitch: '12' });
  eq(s3.rate, '+0%', 'voice: 乱写的 rate 被拒');
  eq(s3.pitch, '+0Hz', 'voice: 乱写的 pitch 被拒');
  // 串行：两次 speak 必须按序跑完（用假的 speakNow 替掉真实进程调用）。
  const order = [];
  const s4 = new Synthesizer({ maxChars: 50 });
  s4.speakNow = async (t) => {
    order.push('start:' + t);
    await sleep(20);
    order.push('end:' + t);
    return { path: '/x.mp3', bytes: 1, text: t, voice: 'v' };
  };
  await Promise.all([s4.speak('一'), s4.speak('二')]);
  eq(order, ['start:一', 'end:一', 'start:二', 'end:二'], 'voice: 合成串行，不并发抢语音服务');
  // 空内容在起进程之前就该被拦下。
  let threw = null;
  try {
    await new Synthesizer({ maxChars: 50 }).speakNow('```\nonly code\n```');
  } catch (e) {
    threw = e;
  }
  ok(threw !== null && threw.message.includes('没有可朗读的内容'), 'voice: 无可念内容提前报错（不起进程）');

  // 偶发失败要重试：语音服务实测有瞬时抖动（同机同文本 11 次里失败 2 次，
  // 随后复测 12/12 成功）。这里用假的 attemptOnce 模拟「前两次失败、第三次成功」。
  // 注意 speakNow 会先 mkdir(this.dir)，所以目录必须是真实可建的。
  const retryDir = mkdtempSync(join(tmpdir(), 'companion-voice-'));
  {
    let calls = 0;
    const s5 = new Synthesizer({ maxChars: 50, retries: 3, retryDelayMs: 1 });
    s5.dir = retryDir;
    s5.attemptOnce = async () => {
      calls += 1;
      if (calls < 3) throw new Error('WSServerHandshakeError: 403');
      return { path: '/ok.mp3', bytes: 9, text: 't', voice: 'v' };
    };
    const r = await s5.speakNow('测试重试');
    eq(calls, 3, 'voice: 前两次失败后第三次成功（重试生效）');
    eq(r.bytes, 9, 'voice: 重试成功后返回结果');
  }
  // 全部尝试都失败时，抛的是最后一次的错误（不是静默吞掉）。
  {
    let calls = 0;
    const s6 = new Synthesizer({ maxChars: 50, retries: 3, retryDelayMs: 1 });
    s6.dir = retryDir;
    s6.attemptOnce = async () => {
      calls += 1;
      throw new Error('always fail #' + calls);
    };
    let err = null;
    try {
      await s6.speakNow('测试全失败');
    } catch (e) {
      err = e;
    }
    eq(calls, 3, 'voice: 重试次数用满即停');
    ok(err !== null && err.message.includes('#3'), 'voice: 抛出最后一次错误');
  }
  rmSync(retryDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
section('faces 表情表');

// 2026-10-13 实测暴露：规则④点名 `qq_send_face`，但 qq 桥从没注册过这个工具
// （会话 seq2169/2170：`Error: unknown tool "qq_send_face"`，白烧一个 step）。
// 补工具就必须有「表情名 → OneBot face id」的映射，这一节测的就是那张表。

ok(FACE_COUNT >= 300, `faces: 表里有 ${FACE_COUNT} 个表情（NapCat 全量）`);
eq(Object.keys(FACES).length, FACE_COUNT, 'faces: FACE_COUNT 与表长度一致');
eq(FACES['微笑'], 14, 'faces: 微笑 = 14（QQ 经典 id）');
eq(FACES['呲牙'], 13, 'faces: 呲牙 = 13');
eq(FACES['偷笑'], 20, 'faces: 偷笑 = 20');
eq(FACES['笑哭'], 182, 'faces: 笑哭 = 182');
eq(FACES['委屈'], 106, 'faces: 委屈 = 106');
eq(FACES['害羞'], 6, 'faces: 害羞 = 6');
eq(Object.isFrozen(FACES), true, 'faces: 表被冻结（防止运行时被改坏）');

{
  // 名字 → id
  const r1 = resolveFaceId('笑哭');
  eq(r1.ok, true, 'faces: 查名字命中');
  eq(r1.id, '182', 'faces: 名字解析成字符串 id（OneBot 段要 string）');
  eq(r1.name, '笑哭', 'faces: 回显原名字');
  eq(r1.known, true, 'faces: 表内名字 known=true');

  // 数字字符串也被当 id 认（表里查不到名字，但 id 有效）
  const r2 = resolveFaceId('182');
  eq(r2.ok, true, 'faces: 纯数字字符串当 id');
  eq(r2.id, '182', 'faces: 数字字符串 id 保留');
  eq(r2.name, '笑哭', 'faces: id 反查出名字');

  // 数字类型
  const r3 = resolveFaceId(14);
  eq(r3.ok, true, 'faces: 数字类型也认');
  eq(r3.id, '14', 'faces: 数字类型转成字符串');
  eq(r3.name, '微笑', 'faces: 数字 14 反查微笑');

  // 表外的 id 也放行（模型可能知道表外的 id）
  const r4 = resolveFaceId('99999');
  eq(r4.ok, true, 'faces: 表外 id 不拒绝（模型可能知道更多）');
  eq(r4.known, false, 'faces: 表外 id known=false');

  // 不认识的名字 → 报错 + 候选
  // 注意别拿「狂笑」当反例 —— 它在表里（qsid 283），这个坑实测踩过一次。
  const r5 = resolveFaceId('完全不是表情喵');
  eq(r5.ok, false, 'faces: 不认识的名字 → 失败');
  ok(typeof r5.error === 'string' && r5.error.includes('完全不是表情喵'), 'faces: 错误里带上原输入');

  // 空 / 非法类型
  eq(resolveFaceId('').ok, false, 'faces: 空串 → 失败');
  eq(resolveFaceId('   ').ok, false, 'faces: 纯空白 → 失败');
  eq(resolveFaceId(null).ok, false, 'faces: null → 失败');
  eq(resolveFaceId(undefined).ok, false, 'faces: undefined → 失败');
  eq(resolveFaceId({}).ok, false, 'faces: 对象 → 失败');
  eq(resolveFaceId(-1).ok, false, 'faces: 负数 → 失败');
  eq(resolveFaceId(1.5).ok, false, 'faces: 小数 → 失败');
}

{
  // 候选提示：帮模型下一轮自我纠正
  const hint = suggestFaces('完全不是表情喵');
  ok(hint === '' || hint.includes('想找'), 'faces: 候选提示要么给建议要么留空');
  const hint2 = suggestFaces('哭');
  ok(hint2.includes('哭'), 'faces: 「哭」能给出含「哭」的候选');

  // 空输入不给候选（避免噪声）
  eq(suggestFaces(''), '', 'faces: 空输入 → 无候选');
  eq(suggestFaces(null), '', 'faces: null → 无候选');
  eq(suggestFaces(123), '', 'faces: 非字符串 → 无候选');
}

// ─────────────────────────────────────────────────────────────────────────────
section('mention 自己号改写');

// 2026-10-16 23:10 的现场：用户在群里 @ 了两个人，其中一个就是她自己。
// 上游把 at 段渲染成裸数字，她读成「另一个号，没有 @我」，整场沉默。
eq(
  rewriteSelfMention('@100000002 你看看这个', '100000002'),
  '@你 你看看这个',
  'mention: 指向自己的裸 QQ 号 → @你',
);
// 上游对每个 at 段都渲染成 `@<qq>`（cq.js:191-195），所以真实正文里
// 每个号前面都带 @；她读到的「和 100000002」是她自己转述时去掉的。
eq(
  rewriteSelfMention('@100000003 @100000002 你俩看看这个', '100000002'),
  '@100000003 @你 你俩看看这个',
  'mention: 只改自己那个号，别人的号码保持裸号',
);
eq(
  rewriteSelfMention('@1000000020 这是别人的号', '100000002'),
  '@1000000020 这是别人的号',
  'mention: 以自己号开头的更长号码不被误伤',
);
eq(
  rewriteSelfMention('@100000002 @100000002 连喊两次', '100000002'),
  '@你 @你 连喊两次',
  'mention: 多处出现全部改写',
);
eq(rewriteSelfMention('没 @ 任何人', '100000002'), '没 @ 任何人', 'mention: 没命中时原样');
eq(rewriteSelfMention('@100000002', ''), '@100000002', 'mention: 不知道自己是几号 → 不猜，原样');
eq(rewriteSelfMention('', '100000002'), '', 'mention: 空正文原样');
eq(rewriteSelfMention(undefined, '100000002'), undefined, 'mention: 非字符串原样');

// ─────────────────────────────────────────────────────────────────────────────
// 话题插话（判据三）：群里聊到她感兴趣的方向才可能接话。
// 逻辑的端到端用例在 `createMention().selfTest()` 里（31 例，含冷却、
// 每日上限、安静时段）；这里锁住纯函数层，防止有人改坏关键词或配额语义。
section('mention 话题插话');

// 默认必须是**关**的：开了等于「群里自己开口」，不能悄悄打开。
eq(DEFAULT_TOPICS.enabled, false, 'topics: 默认关闭');

// 默认关键词组：用户要的是「能指认的具体字眼」，不是「娱乐」这类上位词。
ok(Object.keys(DEFAULT_TOPIC_GROUPS).length >= 6, 'topics: 默认至少 6 个方向');
ok(
  Object.values(DEFAULT_TOPIC_GROUPS).every((words) => Array.isArray(words) && words.length >= 5),
  'topics: 每组至少 5 个词',
);
ok(
  // 不设上限就会有人往组里塞「娱乐活动」这种上位词 —— 那样的关键词等于没筛。
  Object.values(DEFAULT_TOPIC_GROUPS).flat().every((w) => typeof w === 'string' && w.length <= 6),
  'topics: 关键词都是能指认的短词（不塞上位词）',
);
ok(DEFAULT_TOPIC_GROUPS['猫'].length > 0, 'topics: 有「猫」这一组（她撸猫）');

eq(matchTopic('今天没加班，回家撸猫了', DEFAULT_TOPIC_GROUPS, 4)?.topic, '猫', 'topics: 命中「猫」');
eq(matchTopic('今晚开黑吗', DEFAULT_TOPIC_GROUPS, 4)?.topic, '游戏', 'topics: 命中「游戏」');
eq(matchTopic('猫', DEFAULT_TOPIC_GROUPS, 4), null, 'topics: 短于 minChars 不判');
eq(matchTopic('今天下午三点开会', DEFAULT_TOPIC_GROUPS, 4), null, 'topics: 无关内容不命中');
eq(matchTopic('', DEFAULT_TOPIC_GROUPS, 4), null, 'topics: 空串不命中');
eq(matchTopic('看 DND 跑团', { 跑团: ['dnd'] }, 4)?.topic, '跑团', 'topics: 英文词按小写比');

// 安静时段：支持跨零点，`start === end` 视为没有安静时段。
eq(inQuietHours(3, 1, 8), true, 'topics: 凌晨 3 点在 1-8 安静时段内');
eq(inQuietHours(12, 1, 8), false, 'topics: 中午不在安静时段');
eq(inQuietHours(23, 22, 6), true, 'topics: 跨零点时段（22-6）含 23 点');
eq(inQuietHours(12, 1, 1), false, 'topics: start===end → 无安静时段');

// 提示词要说明「群里在聊什么」并给出退路 —— 否则 at 段让她以为被点名。
{
  const hint = topicHint({ topic: '猫', word: '橘猫' });
  ok(hint.includes('猫'), 'topics: 提示词带上方向');
  ok(hint.includes('[[silent]]'), 'topics: 提示词给出沉默退路');
}

// 归一化：用户写 `{enabled:true}` 时其余默认值必须还在（浅合并会顶掉整段）。
{
  const t = normalizeTopics({ enabled: true, chance: 0.9 });
  eq(t.enabled, true, 'topics: 归一化保留 enabled');
  eq(t.chance, 0.9, 'topics: 归一化保留显式 chance');
  eq(t.maxPerDay, DEFAULT_TOPICS.maxPerDay, 'topics: 归一化补回默认 maxPerDay');
  eq(t.cooldownMs, DEFAULT_TOPICS.cooldownMs, 'topics: 归一化补回默认 cooldownMs');
  ok(t.groups['猫'].length > 0, 'topics: groups 缺省时用默认组');
  const merged = normalizeTopics({ groups: { 跑团: ['跑团'] } });
  ok(merged.groups['跑团'].length === 1, 'topics: 自定义组生效');
  ok(merged.groups['猫'].length > 0, 'topics: 自定义组不顶掉默认组');
  eq(normalizeTopics({ groups: { 猫: [] } }).groups['猫'].length, 0, 'topics: 组写空数组 = 关掉该组');
  // 非法值回退到默认，不写进运行时。
  const bad = normalizeTopics({ enabled: 'yes', chance: 99, maxPerDay: -3, minChars: 0 });
  eq(bad.enabled, false, 'topics: 非布尔 enabled 回退 false');
  eq(bad.chance, DEFAULT_TOPICS.chance, 'topics: 越界 chance 回退默认');
  eq(bad.maxPerDay, DEFAULT_TOPICS.maxPerDay, 'topics: 负数 maxPerDay 回退默认');
  eq(bad.minChars, DEFAULT_TOPICS.minChars, 'topics: minChars 至少 1');
}

section('persona 辅助函数');

eq(chatIdOfSession('onebot-private-100000001-muwexn8r'), 'private:100000001', 'persona: 反推私聊 chatId');
eq(chatIdOfSession('onebot-group-2000000002-mv40ioj5'), 'group:2000000002', 'persona: 反推群聊 chatId');
eq(chatIdOfSession('onebot-private-100000001'), 'private:100000001', 'persona: 无反推后缀也认');
eq(chatIdOfSession('web-abc'), null, 'persona: 非 onebot 会话 → null');
eq(chatIdOfSession(''), null, 'persona: 空串 → null');

eq(
  textOfMessage({ content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '说' }] }),
  '说',
  'persona: 只取 text block（思维链不算她的话）',
);
eq(textOfMessage({ content: '纯字符串' }), '纯字符串', 'persona: content 是字符串也认');
eq(textOfMessage({}), '', 'persona: 无 content → 空串');

eq(
  plainOfInbound('前缀\n<user_message qq="1" nickname="n">\n正文\n</user_message>'),
  '正文',
  'persona: 抠出 user_message 正文',
);
eq(plainOfInbound('裸文本'), '裸文本', 'persona: 无包装时原样');

// 2026-10-18：入站回血失效的根因是「拿 inbound.chatId」——那一层收到的是**原始
// OneBot 事件**，根本没有 chatId 字段。下面这组钉住「从原始事件现推 chatId」。
{
  const build = (kind, target) => (kind === 'private' ? `private:${target}` : `group:${target}`);
  eq(
    chatIdOfEvent({ message_type: 'group', group_id: 900000002, user_id: 100000001 }, build),
    'group:900000002',
    'persona: 群事件 → group:群号（不是发话人 QQ）',
  );
  eq(
    chatIdOfEvent({ message_type: 'private', user_id: 100000001 }, build),
    'private:100000001',
    'persona: 私聊事件 → private:QQ',
  );
  eq(chatIdOfEvent({ message_type: 'group' }, build), null, 'persona: 群事件缺 group_id → null');
  eq(chatIdOfEvent({ message_type: 'private' }, build), null, 'persona: 私聊缺 user_id → null');
  eq(chatIdOfEvent({ message_type: 'guild', user_id: 1 }, build), null, 'persona: 非群非私聊 → null');
  eq(chatIdOfEvent(undefined, build), null, 'persona: 无事件 → null');
  eq(
    chatIdOfEvent({ message_type: 'group', group_id: 1 }, () => {
      throw new Error('boom');
    }),
    null,
    'persona: buildChatId 抛错 → null 而不是炸掉投递',
  );
}

eq(
  eventTextOf({ message: [{ type: 'text', data: { text: '你' } }, { type: 'text', data: { text: '好' } }] }),
  '你好',
  'persona: 原始事件里多个 text 段拼起来',
);
eq(
  eventTextOf({ message: [{ type: 'face', data: { id: '182' } }] }),
  '',
  'persona: 只有表情段 → 空串（不回落到 CQ 码，否则污染风格样本）',
);
eq(
  eventTextOf({ raw_message: '原始串' }),
  '原始串',
  'persona: 完全没有 message 数组时才回落 raw_message',
);
eq(eventTextOf({}), '', 'persona: 空事件 → 空串');

// ─────────────────────────────────────────────────────────────────────────────
section('JsonStore');

{
  const dir = mkdtempSync(join(tmpdir(), 'companion-store-'));
  const file = stateFilePath(dir, 'x.json');
  ok(file.endsWith('x.json'), 'jsonstore: stateFilePath 拼路径');
  eq(stateFilePath('', 'x.json'), undefined, 'jsonstore: 空目录 → undefined');

  const store = new JsonStore({ file, log: () => {}, flushMs: 10 });
  await store.load();
  eq(store.size, 0, 'jsonstore: 首次 load 空表（文件不存在不是错）');
  store.set('a', { n: 1 });
  store.saveDebounced();
  await sleep(60);
  ok(existsSync(file), 'jsonstore: debounce 后落盘');
  eq(JSON.parse(readFileSync(file, 'utf8')).a.n, 1, 'jsonstore: 内容正确');

  const store2 = new JsonStore({ file, log: () => {} });
  await store2.load();
  eq(store2.get('a').n, 1, 'jsonstore: 重新 load 读回');
  eq(store2.getOr('missing', () => ({ n: 0 })).n, 0, 'jsonstore: getOr 用 fallback');
  eq(store2.get('missing'), undefined, 'jsonstore: getOr 不写 Map');

  store2.set('b', 1);
  await store2.flush();
  eq(JSON.parse(readFileSync(file, 'utf8')).b, 1, 'jsonstore: flush 同步落盘');

  writeFileSync(file, '{坏 JSON', 'utf8');
  const store3 = new JsonStore({ file, log: () => {} });
  await store3.load();
  eq(store3.size, 0, 'jsonstore: 坏文件降级空表（不抛）');

  // ── 同步读 + 内存优先（2026-10-15 修的两个真 bug）────────────────────────
  //
  // ① `load()` 是异步的，而 stamp 的 `previousFor()` 在同一个调用栈里先写后读，
  //    异步 load 永远赶不上 → 重启/热重载后第一条拿不到基线、gap 白丢，
  //    「落盘层的全部理由」当场落空。walk 探针实测 `stamp-state.json` 里
  //    明明白白存着 lastAt，第一条消息的 gap= 却仍然是空。
  // ② `load()` 无条件覆盖内存 → 把 debounce 还没落盘的新值倒回盘上旧值。
  const syncFile = stateFilePath(dir, 'sync.json');
  writeFileSync(syncFile, JSON.stringify({ a: { lastAt: 111 } }), 'utf8');

  const s1 = new JsonStore({ file: syncFile, log: () => {} });
  s1.loadSync();
  eq(s1.get('a')?.lastAt, 111, 'jsonstore: loadSync 之后立刻同步读得到（异步 load 赶不上同步调用栈）');

  const s2 = new JsonStore({ file: syncFile, log: () => {} });
  s2.set('a', { lastAt: 999 });
  s2.loadSync();
  eq(s2.get('a')?.lastAt, 999, 'jsonstore: 内存优先，盘上旧值不覆盖刚写的新值');

  const s3 = new JsonStore({ file: syncFile, log: () => {} });
  s3.set('fromMemory', { lastAt: 7 });
  s3.loadSync();
  eq(s3.get('fromMemory')?.lastAt, 7, 'jsonstore: 内存优先时仍保留内存里的键');
  eq(s3.get('a')?.lastAt, 111, 'jsonstore: 内存优先时盘上的新键照常并进来');

  const s4 = new JsonStore({ file: stateFilePath(dir, 'nope.json'), log: () => {} });
  s4.loadSync();
  eq(s4.size, 0, 'jsonstore: loadSync 缺文件降级空表（不抛）');
  eq(s4.loaded, true, 'jsonstore: loadSync 缺文件也标记 loaded');

  const badSync = stateFilePath(dir, 'bad-sync.json');
  writeFileSync(badSync, '{坏 JSON', 'utf8');
  const s5 = new JsonStore({ file: badSync, log: () => {} });
  s5.loadSync();
  eq(s5.size, 0, 'jsonstore: loadSync 坏文件降级空表（不抛）');

  const s6 = new JsonStore({ file: syncFile, log: () => {} });
  s6.loadSync();
  s6.loadSync();
  eq(s6.get('a')?.lastAt, 111, 'jsonstore: loadSync 可重复调用');

  const s7 = new JsonStore({ file: syncFile, log: () => {} });
  s7.set('a', { lastAt: 999 });
  await s7.load();
  eq(s7.get('a')?.lastAt, 999, 'jsonstore: 异步 load 同样内存优先');

  rmSync(dir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
section('core/patch 脱链语义');

{
  const proto = { m() { return 'base'; } };
  const ownerA = Symbol('a');
  const ownerB = Symbol('b');
  const pA = createPatcher({ owner: ownerA, log: () => {}, stats: fakeStats(), label: 't' });
  const pB = createPatcher({ owner: ownerB, log: () => {}, stats: fakeStats(), label: 't' });

  eq(pA(proto, 'm', 'guard', (orig) => function w1() { return `g(${orig.call(this)})`; }), true, 'patch: 首次挂载成功');
  eq(proto.m(), 'g(base)', 'patch: 包装生效');

  eq(pA(proto, 'm', 'guard', () => function w() { return 'dup'; }), false, 'patch: 同一 owner 幂等跳过');
  eq(proto.m(), 'g(base)', 'patch: 幂等后未被叠层');

  eq(pB(proto, 'm', 'guard', (orig) => function w2() { return `G(${orig.call(this)})`; }), true, 'patch: 新实例重挂（热重载）');
  eq(proto.m(), 'G(base)', 'patch: 重挂剥掉自己的旧包装（不是 G(g(base))）');

  // 别的模块的包装不该被吞掉。
  //
  // 注意别断言**具体顺序**：链形状由 `MODULE_PRIORITY` + moduleId 字典序唯一
  // 决定（见 lib/core/patch.js），那是实现细节。这里要保护的性质是「两层都在」。
  eq(pB(proto, 'm', 'rhythm', (orig) => function w3() { return `r(${orig.call(this)})`; }), true, 'patch: 别的模块挂同一方法');
  ok(
    proto.m().includes('G(') && proto.m().includes('r('),
    'patch: 叠加而非替换（两个模块的包装都在链上）',
  );

  // 同一 owner 再挂同一模块 = 幂等（真实场景：每 3 秒一轮的补挂扫描）。
  // 不幂等的话每轮叠一层，几十秒就把调用链撑爆。
  const afterStack = proto.m();
  eq(pB(proto, 'm', 'rhythm', () => function wDup() { return 'dup'; }), false, 'patch: 同 owner 同模块重挂幂等');
  eq(proto.m(), afterStack, 'patch: 幂等后未叠层');

  // 热重载 = 新 owner 重挂同一模块：只剥自己那层，guard 层必须完好。
  const pC = createPatcher({ owner: Symbol('c'), log: () => {}, stats: fakeStats(), label: 't' });
  eq(pC(proto, 'm', 'rhythm', (orig) => function w4() { return `R(${orig.call(this)})`; }), true, 'patch: 新实例重挂（热重载）');
  ok(
    proto.m().includes('G(') && proto.m().includes('R(') && !proto.m().includes('r('),
    'patch: 只剥自己那层（旧的 r 没了、guard 层完好）',
  );

  eq(auditMethods(proto, ['m'], 'rhythm'), [], 'patch: auditMethods 认领');
  eq(auditMethods(proto, ['m'], 'persona'), ['m'], 'patch: auditMethods 未挂 → lost');
  eq(auditMethods({ n() {} }, ['n'], 'guard'), ['n'], 'patch: 裸方法算 lost');
  ok(originalOf(proto.m) !== undefined, 'patch: originalOf 取到内层');
  // 本模块那层可能不在链头（优先级/字典序决定），所以要扫整条链找它。
  const heldByRhythm = (() => {
    let cur = proto.m;
    const seen = new Set();
    while (typeof cur === 'function' && !seen.has(cur)) {
      seen.add(cur);
      if (cur[MODULE_TAG] === 'rhythm') return true;
      cur = originalOf(cur);
    }
    return false;
  })();
  ok(heldByRhythm, 'patch: MODULE 标记正确（rhythm 那层在链上）');
}

// 两个模块共享同一个挂载点：交替 scan 必须收敛（每模块链上最多一层）。
//
// 这是 2026-10-14 修掉的**真 bug** 的回归钉。原实现的脱链只看链头，于是：
//   A 挂 -> A；B 挂 -> B -> A；A 再挂时链头是 B，幂等落空 -> A -> B -> A；
// 每轮 scanAll（默认 3 秒一次）链长 +2，永不收敛 —— `stats.patched` 每轮白推
// 两条，投递路径上的层数无限增长。stamp 与 rhythm 共享 `dispatchFollowup`、
// 与 persona 共享 `handleInbound` 之后，这个缺陷就会真的发作。
{
  /** 把包装链摊平成 ['module@ownerTag', …]（链头在前）。 */
  const chainOf = (fn, readOwner) => {
    const out = [];
    let cur = fn;
    const seen = new Set();
    while (typeof cur === 'function' && !seen.has(cur)) {
      seen.add(cur);
      const inner = originalOf(cur);
      if (typeof inner !== 'function') break;
      out.push(`${cur[MODULE_TAG]}@${readOwner(cur)}`);
      cur = inner;
    }
    return out;
  };

  const proto = { m() { return 'base'; } };
  const ownerOf = new Map();
  const mk = (tag) => {
    const owner = Symbol(tag);
    const p = createPatcher({ owner, log: () => {}, stats: fakeStats(), label: 't' });
    return {
      tag,
      // 每个包装留个可读的 owner 标签，摊平链时用得上。
      patch: (moduleId, wrap) =>
        p(proto, 'm', moduleId, (orig) => {
          const w = wrap(orig);
          ownerOf.set(w, tag);
          return w;
        }),
    };
  };
  const readOwner = (fn) => ownerOf.get(fn) ?? '?';

  const A = mk('A'); // 模拟先挂的 rhythm
  const B = mk('B'); // 模拟后挂的 stamp

  eq(A.patch('rhythm', (o) => function a() { return `r(${o.call(this)})`; }), true, 'shared: A 首次挂载');
  eq(B.patch('stamp', (o) => function b() { return `s(${o.call(this)})`; }), true, 'shared: B 挂同一方法');
  eq(proto.m(), 's(r(base))', 'shared: 两层叠加，后挂的在外层');
  const stable = 'stamp@B,rhythm@A';
  eq(chainOf(proto.m, readOwner).join(','), stable, 'shared: 链形状');

  // 连扫 5 轮（真实 scanAll 每 3 秒跑一次），每轮两个模块都重新挂。
  let grew = false;
  for (let round = 0; round < 5; round += 1) {
    const before = chainOf(proto.m, readOwner).length;
    A.patch('rhythm', (o) => function a2() { return `r(${o.call(this)})`; });
    B.patch('stamp', (o) => function b2() { return `s(${o.call(this)})`; });
    if (chainOf(proto.m, readOwner).length !== before) grew = true;
  }
  eq(grew, false, 'shared: 交替扫 5 轮链长不增长（原实现每轮 +2）');
  eq(chainOf(proto.m, readOwner).join(','), stable, 'shared: 扫完后链形状不变');
  eq(proto.m(), 's(r(base))', 'shared: 行为不变');

  // 本模块的层被压在外层之下时，auditMethods 也必须认领它（原实现只看链头，
  // 会把 B 的层下方的 A 误报成「丢了」，于是 `lost` 里常驻一条假警报）。
  eq(auditMethods(proto, ['m'], 'stamp'), [], 'shared: auditMethods 认外层');
  eq(auditMethods(proto, ['m'], 'rhythm'), [], 'shared: auditMethods 认得被压在下面的层');
  eq(auditMethods(proto, ['m'], 'persona'), ['m'], 'shared: 真没挂的仍算 lost');

  // 新实例（热重载）重挂同一 moduleId：剥掉该 moduleId 的**所有**旧层（不论哪个
  // 实例挂的），别人的层完好。
  //
  // 关键：stamp 必须**留在外层**。原实现按调用顺序决定外层，实测反例（见
  // lib/core/patch.js 的 MODULE_PRIORITY 注释）：stamp 的层被随后重挂的 rhythm
  // 顶到里层后，下一次 `B.patch('stamp')` 因「链上已有本模块的层」幂等跳过，
  // 于是它**永远回不到外层**，顺序永久停错而 stats 看不出异常。
  // `test/exp-chain-order.mjs` 复刻了那四步。
  const C = mk('C');
  eq(C.patch('rhythm', (o) => function c() { return `R(${o.call(this)})`; }), true, 'shared: 新实例重挂自己的层');
  eq(chainOf(proto.m, readOwner).join(','), 'stamp@B,rhythm@C', 'shared: 重挂后 stamp 仍在外层（优先级决定，不看时序）');
  eq(proto.m(), 's(R(base))', 'shared: 重挂后行为 = stamp(外层) 包住 rhythm(内层)');

  // 已在正确位置 → 幂等跳过（每 3 秒一轮的 scanAll 不该白推 stats）。
  eq(B.patch('stamp', (o) => function b3() { return `s2(${o.call(this)})`; }), false, 'shared: 位置正确时幂等跳过');
  eq(chainOf(proto.m, readOwner).join(','), 'stamp@B,rhythm@C', 'shared: 幂等后链形状不变');
  eq(proto.m(), 's(R(base))', 'shared: 幂等后行为不变（旧实例的包装仍在用）');

  // 热重载 stamp（新 owner）→ 重建，且仍在外层。
  const D = mk('D');
  eq(D.patch('stamp', (o) => function d() { return `S(${o.call(this)})`; }), true, 'shared: stamp 热重载重挂');
  eq(chainOf(proto.m, readOwner).join(','), 'stamp@D,rhythm@C', 'shared: 热重载后 stamp 仍在外层');
  eq(proto.m(), 'S(R(base))', 'shared: 热重载后新包装生效');

  // 任意顺序交替重挂 5 轮：链形状必须恒为 stamp 在外。
  for (let round = 0; round < 5; round += 1) {
    D.patch('stamp', (o) => function d2() { return `S(${o.call(this)})`; });
    C.patch('rhythm', (o) => function c2() { return `R(${o.call(this)})`; });
  }
  eq(chainOf(proto.m, readOwner).join(','), 'stamp@D,rhythm@C', 'shared: 交替重挂 5 轮后链形状恒定');
  eq(proto.m(), 'S(R(base))', 'shared: 交替重挂 5 轮后行为恒定');
}

// `stamp` 的基线表上限（`MAX_CHATS`，逐字沿用当年 inbound-state.js 的 500）。
//
// 这条路径只有超过 500 个 chat 才触发 —— 靠真实聊天永远等不到，所以直接把
// `evictOldest` 当纯函数压。它必须是模块级导出（而不是闭在 createStamp 里），
// 否则这段就没法写。
{
  const mkPair = (count, startAt = 1000) => {
    const memory = new Map();
    const disk = new Map();
    for (let i = 0; i < count; i += 1) {
      memory.set(`c${i}`, startAt + i);
      disk.set(`c${i}`, { lastAt: startAt + i });
    }
    const store = {
      keys: () => [...disk.keys()],
      get: (k) => disk.get(k),
      forget: (k) => disk.delete(k),
    };
    return { memory, disk, store };
  };

  eq(MAX_CHAT_BASELINES, 500, 'evict: 上限沿用 500');

  // ① 没到上限：一条都不动。
  {
    const { memory, disk, store } = mkPair(10);
    eq(evictOldest(memory, store, 'c9'), 0, 'evict: 未到上限不动手');
    eq(memory.size, 10, 'evict: 未到上限内存不变');
    eq(disk.size, 10, 'evict: 未到上限落盘不变');
  }

  // ② 刚好到上限：也不动（「最多 500」）。
  {
    const { memory, disk, store } = mkPair(500);
    eq(evictOldest(memory, store, 'c499'), 0, 'evict: 恰好 500 条不动手');
    eq(memory.size, 500, 'evict: 恰好 500 条保持');
    eq(disk.size, 500, 'evict: 恰好 500 条落盘保持');
  }

  // ③ 超一条：淘汰**最旧**的那条，内存与落盘同步。
  {
    const { memory, disk, store } = mkPair(501);
    eq(evictOldest(memory, store, 'c500'), 1, 'evict: 超一条淘汰一条');
    eq(memory.size, 500, 'evict: 内存回到上限');
    eq(disk.size, 500, 'evict: 落盘回到上限');
    eq(memory.has('c0'), false, 'evict: 淘汰的是最旧的 c0');
    eq(disk.has('c0'), false, 'evict: 落盘也删掉 c0');
    eq(memory.has('c500'), true, 'evict: keep 的 c500 留着');
    eq(memory.has('c1'), true, 'evict: 次旧的 c1 留着（只超一条）');
  }

  // ④ keep 恰好就是最旧那条时，淘汰**第二旧**的，keep 保住。
  {
    const { memory, store } = mkPair(501);
    memory.set('c0', 1); // 把 c0 压成最旧，再当作 keep 传进去
    eq(evictOldest(memory, store, 'c0'), 1, 'evict: keep 是最旧时照样淘汰一条');
    eq(memory.has('c0'), true, 'evict: keep 是最旧也永不淘汰');
    eq(memory.has('c1'), false, 'evict: 改淘汰 c1');
    eq(memory.size, 500, 'evict: 仍然回到上限');
  }

  // ⑤ 一次超很多：按 lastAt 值升序砍，砍够差额就停。
  {
    const { memory, disk, store } = mkPair(505);
    eq(evictOldest(memory, store, 'c504'), 5, 'evict: 超五条淘汰五条');
    eq(memory.size, 500, 'evict: 超五条后回到上限');
    eq(disk.size, 500, 'evict: 超五条后落盘回到上限');
    eq(memory.has('c4'), false, 'evict: c4 在淘汰线上（被砍）');
    eq(memory.has('c5'), true, 'evict: c5 在淘汰线内（留着）');
  }

  // ⑥ 没有 store（mediaDir 没配）：只淘汰内存，不能炸。
  {
    const { memory } = mkPair(502);
    eq(evictOldest(memory, undefined, 'c501'), 2, 'evict: 无 store 时只淘汰内存');
    eq(memory.size, 500, 'evict: 无 store 时内存回到上限');
  }

  // ⑦ 落盘键序与时间新旧无关：**按 lastAt 值挑**，不靠 Map 插入序。
  {
    const memory = new Map();
    const disk = new Map();
    // 先塞一条「最新」的，再塞 500 条旧的 —— 插入序第一条是最新的，
    // 按插入序淘汰会砍掉最该留的那条。
    memory.set('newest', 9_999_999);
    disk.set('newest', { lastAt: 9_999_999 });
    for (let i = 0; i < 500; i += 1) {
      memory.set(`old${i}`, 1000 + i);
      disk.set(`old${i}`, { lastAt: 1000 + i });
    }
    const store = {
      keys: () => [...disk.keys()],
      get: (k) => disk.get(k),
      forget: (k) => disk.delete(k),
    };
    eq(evictOldest(memory, store, 'keep'), 1, 'evict: 超一条淘汰一条（乱序场景）');
    eq(memory.has('newest'), true, 'evict: 按时间挑，不砍插入序第一条');
    eq(memory.has('old0'), false, 'evict: 砍掉的真的是最旧那条');

    // 反向：store 里有一条内存没有的、且它最旧 —— 也要被算进候选。
    const memory2 = new Map();
    const disk2 = new Map();
    disk2.set('ghost', { lastAt: 1 });
    for (let i = 0; i < 500; i += 1) {
      memory2.set(`m${i}`, 5000 + i);
      disk2.set(`m${i}`, { lastAt: 5000 + i });
    }
    const store2 = {
      keys: () => [...disk2.keys()],
      get: (k) => disk2.get(k),
      forget: (k) => disk2.delete(k),
    };
    eq(evictOldest(memory2, store2, 'm499'), 1, 'evict: 只在落盘的幽灵条目也算数');
    eq(disk2.has('ghost'), false, 'evict: 幽灵条目被淘汰');
    eq(disk2.size, 500, 'evict: 含幽灵时落盘回到上限');
  }
}

// 摘闸也要能摘掉**不在链头**的本模块层。
//
// 这是同一个根因（只看链头）的第二处：`handleInbound` 的链是
// `persona -> stamp -> base`，stamp 自己写的 detach 看到链头是 persona 就
// `return false` —— 闸关不掉，而 `POST /module {"module":"stamp","enabled":false}`
// 还报成功。现在摘层统一走 core/patch.js 的 `unpatch`。
{
  const proto = { m() { return 'base'; } };
  const ownerOf = new Map();
  const mk = (tag) => {
    const owner = Symbol(tag);
    const p = createPatcher({ owner, log: () => {}, stats: fakeStats(), label: 't' });
    return {
      tag,
      unpatch: (moduleId) => p.unpatch(proto, 'm', moduleId),
      patch: (moduleId, wrap) =>
        p(proto, 'm', moduleId, (orig) => {
          const w = wrap(orig);
          ownerOf.set(w, tag);
          return w;
        }),
    };
  };
  const chainOf = (fn) => {
    const out = [];
    let cur = fn;
    const seen = new Set();
    while (typeof cur === 'function' && !seen.has(cur)) {
      seen.add(cur);
      const inner = originalOf(cur);
      if (typeof inner !== 'function') break;
      out.push(`${cur[MODULE_TAG]}@${ownerOf.get(cur) ?? '?'}`);
      cur = inner;
    }
    return out.join(',') || '(空)';
  };

  const persona = mk('P');
  const stamp = mk('S');
  const rhythm = mk('R');

  // stamp 与 persona 共享一个方法（真实：handleInbound）。
  persona.patch('persona', (o) => function p1() { return `P(${o.call(this)})`; });
  stamp.patch('stamp', (o) => function s1() { return `S(${o.call(this)})`; });
  eq(proto.m(), 'S(P(base))', 'unpatch: 共享挂载点上两层就位');

  // stamp 摘闸：必须能摘掉**自己那层**，persona 那层完好。
  eq(stamp.unpatch('stamp'), true, 'unpatch: 摘掉不在链头的本模块层');
  eq(proto.m(), 'P(base)', 'unpatch: 剩下 persona 那层且行为正确');
  eq(chainOf(proto.m), 'persona@P', 'unpatch: 链上只剩 persona');
  eq(stamp.unpatch('stamp'), false, 'unpatch: 已摘掉后返回 false');

  // 三方共享同一方法时，摘中间那个不能打断剩下的链。
  rhythm.patch('rhythm', (o) => function r1() { return `R(${o.call(this)})`; });
  stamp.patch('stamp', (o) => function s2() { return `S(${o.call(this)})`; });
  eq(proto.m(), 'S(P(R(base)))', 'unpatch: 三层就位');
  eq(stamp.unpatch('stamp'), true, 'unpatch: 从三方共享里摘中间那个');
  eq(proto.m(), 'P(R(base))', 'unpatch: 摘掉中间层后其余层正确重接');
  eq(chainOf(proto.m), 'persona@P,rhythm@R', 'unpatch: 链形状正确，无断裂');

  // 摘掉链头那个。
  eq(persona.unpatch('persona'), true, 'unpatch: 摘掉链头层');
  eq(proto.m(), 'R(base)', 'unpatch: 摘掉链头后行为正确');
  eq(rhythm.unpatch('rhythm'), true, 'unpatch: 摘掉最后一层（回到上游）');
  eq(proto.m(), 'base', 'unpatch: 全部摘掉后回到上游实现');
  eq(chainOf(proto.m), '(空)', 'unpatch: 链上已无包装');
}

// ─────────────────────────────────────────────────────────────────────────────
section('HTTP handler');

{
  const handler = createHandler({
    prefix: '/dsh-x',
    log: () => {},
    status: () => ({ ok: true, hi: 1 }),
    gets: { '/extra': () => ({ ok: true, e: 2 }) },
    posts: { '/do': (payload) => ({ ok: true, got: payload.v }) },
  });

  const makeRes = () => {
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(s) {
        this.body = s;
      },
    };
    return res;
  };
  const makeReq = (url, method = 'GET', body = '', remote = '127.0.0.1') => {
    const req = {
      url,
      method,
      socket: { remoteAddress: remote },
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(body);
      },
    };
    return req;
  };

  let res = makeRes();
  await handler(makeReq('/dsh-x'), res);
  eq(JSON.parse(res.body).hi, 1, 'http: 前缀剥离后命中 status');

  res = makeRes();
  await handler(makeReq('/dsh-x/extra'), res);
  eq(JSON.parse(res.body).e, 2, 'http: GET 自定义端点');

  res = makeRes();
  await handler(makeReq('/dsh-x/do', 'POST', JSON.stringify({ v: 7 })), res);
  eq(JSON.parse(res.body).got, 7, 'http: POST 解析 body');

  res = makeRes();
  await handler(makeReq('/dsh-x/nope'), res);
  eq(res.statusCode, 404, 'http: 未知路径 404');

  res = makeRes();
  await handler(makeReq('/dsh-x', 'GET', '', '8.8.8.8'), res);
  eq(res.statusCode, 403, 'http: 非 loopback 一律 403');
}

// ─────────────────────────────────────────────────────────────────────────────
section('真实集成：假 profile 挂载 + 真调用');

/**
 * 造一个假 profile：`<tmp>/profiles/fake/node_modules/dsh-onebot-qq/lib/`。
 *
 * 两个假类刻意长得像真货的关键部分：
 *   - `OutboundPipeline.sendToChat` 走 `this.ctx.call('send_msg', …)`（guard 的
 *     selfTest 就是靠这个收集「真发出去什么」）。
 *   - `ChatBridge.sendToChat` 转发给 `this.outbound`（真 bridge 就是这么做的）。
 */
function makeFakeProfile() {
  const base = mkdtempSync(join(tmpdir(), 'companion-fake-'));
  const profile = join(base, 'profiles', 'fake');
  const libDir = join(profile, 'node_modules', 'dsh-onebot-qq', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(
    join(profile, 'node_modules', 'dsh-onebot-qq', 'package.json'),
    JSON.stringify({ name: 'dsh-onebot-qq', version: '0.0.0-fake', type: 'module', main: 'lib/index.js' }),
    'utf8',
  );
  writeFileSync(
    join(libDir, 'outbound.js'),
    `export class OutboundPipeline {
  constructor(ctx) { this.ctx = ctx; }
  async sendToChat(chatId, text, options = {}) {
    const r = await this.ctx.call('send_msg', { chat_id: chatId, message: [{ type: 'text', data: { text } }] });
    return [r?.message_id ?? 'x'];
  }
  async sendMsg(chatId, segments, options = {}) {
    const r = await this.ctx.call('send_msg', { chat_id: chatId, message: segments });
    return r?.message_id;
  }
}
`,
    'utf8',
  );
  writeFileSync(
    join(libDir, 'bridge.js'),
    `export class ChatBridge {
  constructor() {
    this.chats = new Map();
    this.bySession = new Map();
    this.stopping = false;
    this.inboundCalls = [];
    this.dispatched = [];
    this.sentToChat = [];
    this.events = [];
    this.typing = [];
  }
  async handleInbound(event, opts = {}) { this.inboundCalls.push(event); return 'handled'; }
  onSessionEvent(session, event) { this.events.push({ id: session?.id, type: event?.type }); return 'event'; }
  async dispatchFollowup(chatId, text, role, nickname) {
    this.dispatched.push({ chatId, text, role, nickname });
    return 'dispatched';
  }
  async sendToChat(chatId, text, options = {}) {
    this.sentToChat.push({ chatId, text, options });
    return 'mid-' + this.sentToChat.length;
  }
  startTyping() { this.typing.push('start'); }
  stopTyping() { this.typing.push('stop'); }
}
`,
    'utf8',
  );
  writeFileSync(
    join(libDir, 'chat.js'),
    `export function sessionIdForChat(chatId) {
  return 'onebot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-');
}
export function buildChatId(kind, target) {
  return kind + ':' + String(target);
}
`,
    'utf8',
  );
  // 假 registry 刻意复刻上游 createChat 的**换代路径**：裸 id 有持久化日志就把它
  // 退休、另开带后缀的新会话。adopt 闸要在它之前把这条日志接管掉，所以这个假类
  // 是「闸没上时症状会不会真的出现」的对照物。
  writeFileSync(
    join(libDir, 'registry.js'),
    `import { sessionIdForChat } from './chat.js';
export class ChatRegistry {
  constructor(opts = {}) {
    this.chats = new Map();
    this.evictedChats = new Map();
    this.blocked = new Set(opts.blocked ?? []);
    this.logs = new Set(opts.logs ?? []);
    this.resumed = [];
    this.retired = [];
    this.created = [];
    this.saved = 0;
    this.mappingLoaded = Promise.resolve();
  }
  isSessionIdBlocked(id) { return this.blocked.has(id); }
  async hasPersistedLog(id) { return this.logs.has(id); }
  freshSessionId(chatId) {
    return sessionIdForChat(chatId) + '-' + 'fake' + String(++ChatRegistry.seq);
  }
  async resumeChat(chatId, id) {
    const chat = { chatId, sessionId: id, via: 'resume' };
    this.resumed.push({ chatId, id });
    this.chats.set(chatId, chat);
    return chat;
  }
  retireSession(id) { this.retired.push(id); this.blocked.add(id); }
  async saveMapping() { this.saved += 1; }
  async createChat(chatId, nickname) {
    if (this.chats.has(chatId)) return this.chats.get(chatId);
    if (this.evictedChats.has(chatId)) {
      const ev = this.evictedChats.get(chatId);
      this.evictedChats.delete(chatId);
      return this.resumeChat(chatId, ev.session);
    }
    let id = sessionIdForChat(chatId);
    if (this.isSessionIdBlocked(id)) id = this.freshSessionId(chatId);
    else if (await this.hasPersistedLog(id)) {
      // 上游行为：退休裸 id、另开新会话（这就是「一句话一个会话」的病灶）。
      this.retireSession(id);
      id = this.freshSessionId(chatId);
    }
    const chat = { chatId, sessionId: id, via: 'create' };
    this.created.push({ chatId, id });
    this.chats.set(chatId, chat);
    return chat;
  }
}
ChatRegistry.seq = 0;
`,
    'utf8',
  );
  // 假 inbound.js：`sleep` 与 `emoji` 都挂在 `InboundPipeline#processInbound`，
  // 这里只做「记下收到了什么、然后当作已派发」。
  writeFileSync(
    join(libDir, 'inbound.js'),
    `export class InboundPipeline {
  constructor(ctx = {}) { this.ctx = ctx; this.handled = []; }
  async processInbound(inbound) {
    this.handled.push(inbound);
    return 'processed';
  }
}
`,
    'utf8',
  );
  // 假 cq.js：sleep 用它判「有没有被 @」。
  writeFileSync(
    join(libDir, 'cq.js'),
    `export function detectMention(segments, raw, selfId, botQQ) {
  const bot = selfId !== '' ? selfId : botQQ;
  if (bot === '' || !Array.isArray(segments)) return false;
  return segments.some((s) => s?.type === 'at' && (s.data?.qq === bot || s.data?.qq === 'all'));
}
export function faceToEmoji() { return '😀'; }
`,
    'utf8',
  );
  return { base, profile, libDir };
}

{
  const fake = makeFakeProfile();
  // 走**生产路径上的那份合并**（index.js 的 mergeConfig），不手搓一份近似的。
  // 之前手搓的版本漏了 `packageName`，四个模块的 resolveProfileDirs 全都去
  // 找「含 undefined 的 profile 目录」而挂不上 —— 而插件本身报告一切正常。
  // 这正是这段集成测试存在的意义：它抓的是「看起来挂好了其实没挂」。
  const cfg = mergeConfig({
    packageName: 'dsh-onebot-qq',
    profileDir: fake.profile,
    guard: { enabled: true, stripAside: true, logHits: false },
    rhythm: {
      enabled: true,
      inbound: { enabled: true, quietMs: 150, groupQuietMs: 80, maxWaitMs: 1200, mentionPierces: true },
      burst: { enabled: true, maxChars: 8, maxChunks: 4, delayMs: 0, perCharMs: 0 },
      typing: false,
    },
    persona: {
      enabled: true,
      mediaDir: join(fake.base, 'media'),
      moodEnabled: true,
      styleEnabled: true,
      proactiveEnabled: false, // 自测不启动调度器，避免随机噪声
    },
    prompt: { enabled: true, rules: { ...DEFAULT_RULES }, firstStepOnly: true, sourceName: 'onebot-prompt' },
  });

  const stats = fakeStats();
  const owner = Symbol('test-owner');
  const patchMethod = createPatcher({ owner, log: () => {}, stats, label: 'test' });
  const ctl = { suspended: false };
  const hits = [];
  const guard = createGuard({ cfg: cfg.guard, stats, hits, ctl, patchMethod, log: () => {} });
  const adopt = createAdopt({ cfg: cfg.adopt, stats, patchMethod, log: () => {} });
  const rhythm = createRhythm({ cfg: cfg.rhythm, stats, patchMethod, log: () => {} });
  const persona = createPersona({ cfg: cfg.persona, stats, patchMethod, log: () => {}, random: () => 0.5 });
  const prompt = createPrompt({ cfg: cfg.prompt, stats, extra: (sid) => persona.extraFor(sid) });

  const ctx = { loader: { entries: () => [] }, baseUrl: undefined };

  const rGuard = await guard.scan(ctx);
  const rAdopt = await adopt.scan(ctx);
  const rRhythm = await rhythm.scan(ctx);
  const rPersona = await persona.scan(ctx);
  ok(rGuard.ok === true, `集成: guard.scan 成功（${rGuard.error ?? ''}）`);
  ok(rAdopt.ok === true, `集成: adopt.scan 成功（${rAdopt.error ?? ''}）`);
  ok(rRhythm.ok === true, `集成: rhythm.scan 成功（${rRhythm.error ?? ''}）`);
  ok(rPersona.ok === true, `集成: persona.scan 成功（${rPersona.error ?? ''}）`);
  eq(stats.lost, [], '集成: 挂载后 lost 为空');

  const bridgeMod = await import(
    new URL(`file:///${join(fake.libDir, 'bridge.js').replace(/\\/g, '/')}`).href
  );
  const outboundMod = await import(
    new URL(`file:///${join(fake.libDir, 'outbound.js').replace(/\\/g, '/')}`).href
  );
  const registryMod = await import(
    new URL(`file:///${join(fake.libDir, 'registry.js').replace(/\\/g, '/')}`).href
  );
  const ChatBridge = bridgeMod.ChatBridge;
  const inboundMod = await import(
    new URL(`file:///${join(fake.libDir, 'inbound.js').replace(/\\/g, '/')}`).href
  );
  const InboundPipeline = inboundMod.InboundPipeline;
  const OutboundPipeline = outboundMod.OutboundPipeline;
  const ChatRegistry = registryMod.ChatRegistry;

  // ── adopt：真挂真调，验证「裸 id 有日志 → 采纳」以及对照组 ────────────────
  {
    eq(
      auditMethods(ChatRegistry.prototype, ['createChat'], 'adopt'),
      [],
      '集成 adopt: 闸真的挂在 ChatRegistry.prototype.createChat 上',
    );

    // ① 裸 id 有持久化日志 → 必须采纳（resume），不退休、不开新会话。
    const reg = new ChatRegistry({
      logs: ['onebot-private-100000001'],
    });
    const chat = await reg.createChat('private:100000001', '示例用户');
    eq(reg.resumed.length, 1, '集成 adopt: 走了 resume 路径');
    eq(reg.resumed[0].id, 'onebot-private-100000001', '集成 adopt: 采纳的正是裸 id');
    eq(reg.retired, [], '集成 adopt: 裸 id 没有被退休');
    eq(reg.created.length, 0, '集成 adopt: 没有另开新会话');
    eq(chat.sessionId, 'onebot-private-100000001', '集成 adopt: 返回的会话 id 是裸 id');
    eq(stats.adopted, 1, '集成 adopt: 记一次 adopted');
    ok(reg.saved >= 1, '集成 adopt: 采纳后补写映射');

    // ② 对照：把闸剥到链底（原方法）再调，症状必须出现 —— 证明上面那条不是因为
    //    假 registry 本身不换代。
    const regPlain = new ChatRegistry({ logs: ['onebot-private-100000001'] });
    let base = ChatRegistry.prototype.createChat;
    for (let i = 0; i < 20 && typeof originalOf(base) === 'function'; i += 1) {
      base = originalOf(base);
    }
    const plainChat = await base.call(regPlain, 'private:100000001', '示例用户');
    ok(
      regPlain.retired.includes('onebot-private-100000001'),
      '集成 adopt 对照: 没有闸时裸 id 被退休（症状真实存在）',
    );
    ok(
      plainChat.sessionId !== 'onebot-private-100000001',
      `集成 adopt 对照: 没有闸时换成了带后缀的新会话（${plainChat.sessionId}）`,
    );

    // ③ evicted 快照更权威 → 闸必须放行，让原方法去 resume 快照里的 id。
    const regEv = new ChatRegistry({ logs: ['onebot-private-100000001'] });
    regEv.evictedChats.set('private:100000001', { session: 'onebot-private-100000001-mvold' });
    const chatEv = await regEv.createChat('private:100000001', '');
    eq(chatEv.sessionId, 'onebot-private-100000001-mvold', '集成 adopt: evicted 快照的 id 优先');

    // ④ 裸 id 没有日志 → 该建新的，闸放行。
    const regNew = new ChatRegistry();
    const chatNew = await regNew.createChat('private:999', '');
    eq(regNew.created.length, 1, '集成 adopt: 没有日志时正常新建');
    eq(chatNew.sessionId, 'onebot-private-999', '集成 adopt: 新会话用裸 id');

    // ⑤ 裸 id 已被退休 → 闸不复活它。
    const regBlocked = new ChatRegistry({
      logs: ['onebot-group-1'],
      blocked: ['onebot-group-1'],
    });
    const chatBlocked = await regBlocked.createChat('group:1', '');
    eq(regBlocked.resumed, [], '集成 adopt: 被退休的 id 不会复活');
    ok(chatBlocked.sessionId !== 'onebot-group-1', '集成 adopt: 被退休的 id 走新会话');

    // ⑥ 模块开关关掉 → 闸被摘掉，症状原样出现（证明开关真的有效）。
    const regOff = new ChatRegistry({ logs: ['onebot-private-100000001'] });
    const adoptedBefore = stats.adopted;
    const adoptOff = createAdopt({
      // 走生产那份合并：`packageName` / `profileDir` 必须下发到模块段，否则
      // resolveProfileDirs 会去找「含 undefined 的 profile 目录」。
      cfg: mergeConfig({
        packageName: 'dsh-onebot-qq',
        profileDir: fake.profile,
        adopt: { enabled: false },
      }).adopt,
      stats: fakeStats(),
      patchMethod: createPatcher({
        owner: Symbol('adopt-off'),
        log: () => {},
        stats: fakeStats(),
        label: 'off',
      }),
      log: () => {},
    });
    const rOff = await adoptOff.scan(ctx);
    eq(rOff.detached, true, '集成 adopt: 关掉开关后把闸摘掉了');
    eq(
      auditMethods(ChatRegistry.prototype, ['createChat'], 'adopt'),
      ['createChat'],
      '集成 adopt: 摘掉后 createChat 不再归 adopt 管',
    );
    const chatOff = await regOff.createChat('private:100000001', '');
    ok(regOff.retired.includes('onebot-private-100000001'), '集成 adopt: 关掉开关后不再采纳');
    ok(chatOff.sessionId !== 'onebot-private-100000001', '集成 adopt: 关掉开关后重新换代');
    eq(stats.adopted, adoptedBefore, '集成 adopt: 关掉时不记账');
    // 把闸装回去，免得影响后面的用例。
    await adopt.scan(ctx);
    eq(
      auditMethods(ChatRegistry.prototype, ['createChat'], 'adopt'),
      [],
      '集成 adopt: 开关试验后闸已装回',
    );
  }

  eq(
    auditMethods(ChatBridge.prototype, ['dispatchFollowup', 'sendToChat'], 'rhythm'),
    [],
    '集成: rhythm 的闸在 ChatBridge 上',
  );
  eq(
    auditMethods(ChatBridge.prototype, ['handleInbound', 'onSessionEvent'], 'persona'),
    [],
    '集成: persona 的闸在 ChatBridge 上',
  );
  eq(
    auditMethods(OutboundPipeline.prototype, ['sendToChat', 'sendMsg'], 'guard'),
    [],
    '集成: guard 的闸在 OutboundPipeline 上',
  );
  eq(
    auditMethods(ChatBridge.prototype, ['handleInbound'], 'rhythm'),
    ['handleInbound'],
    '集成: rhythm 不越界占 persona 的方法',
  );

  // ── guard：沉默被拦、旁白被剥 ───────────────────────────────────────────
  {
    const bridge = new ChatBridge();
    bridge.outbound = new OutboundPipeline({
      connected: () => true,
      config: { textImageThreshold: 0 },
      call: async () => ({ message_id: 'm' }),
    });

    const silent = await bridge.outbound.sendToChat('private:1', '[[silent]]', {});
    eq(silent, [], '集成 guard: 沉默输出被拦下（不发送）');
    eq(stats.blocked, 1, '集成 guard: 记一次 blocked');

    const aside = await bridge.outbound.sendToChat('private:1', '你好\n（空）', {});
    eq(aside, ['m'], '集成 guard: 旁白版仍然发出');
    eq(stats.stripped, 1, '集成 guard: 记一次 stripped');
    ok(hits.length >= 2, '集成 guard: 命中环形数组有记录');
  }

  // ── rhythm：出站分段 ────────────────────────────────────────────────────
  {
    const bridge = new ChatBridge();
    const ids = await bridge.sendToChat('private:1', '第一句话。第二句话。第三句话。', { queuable: true });
    eq(bridge.sentToChat.length, 3, `集成 rhythm: 长回复切成 3 条（实际 ${bridge.sentToChat.length}）`);
    ok(ids.length === 3, '集成 rhythm: 返回 3 个消息 id');
    ok(
      bridge.sentToChat.every((s) => s.options.burst === false),
      '集成 rhythm: 每条都带 burst:false（防重入）',
    );
    eq(bridge.sentToChat[1].options.replyTo, undefined, '集成 rhythm: 后续条不带引用');

    bridge.sentToChat.length = 0;
    await bridge.sendToChat('private:1', '短', { queuable: true });
    eq(bridge.sentToChat.length, 1, '集成 rhythm: 短文本整条发');

    // 2026-10-15 真实漏切回归：真实那条回复 35 字符 < maxChars(36)（本集成配置是
    // maxChars=8，故这里用等价的 7 字符样本），曾被字数门槛挡掉，但它内部有换行、
    // 分段器明明能切开。判据撤销字数门槛后就该切。
    bridge.sentToChat.length = 0;
    await bridge.sendToChat('private:1', '晚安。\n\n睡了', { queuable: true });
    eq(
      bridge.sentToChat.length,
      2,
      `集成 rhythm: 未超 maxChars 但含换行的回复也要分条（实际 ${bridge.sentToChat.length}）`,
    );

    bridge.sentToChat.length = 0;
    await bridge.sendToChat('private:1', '第一句话。第二句话。第三句话。', {});
    eq(bridge.sentToChat.length, 1, '集成 rhythm: 不带 queuable 不分段');
  }

  // ── rhythm：入站合并 ────────────────────────────────────────────────────
  {
    const bridge = new ChatBridge();
    const msg = '<user_message qq="1" nickname="n">\n内容\n</user_message>';
    await bridge.dispatchFollowup('private:2', msg, 'member', 'n');
    await bridge.dispatchFollowup('private:2', msg, 'member', 'n');
    eq(bridge.dispatched.length, 0, '集成 rhythm: 入站被攒住（尚未投递）');
    eq(rhythm.pendingCount(), 1, '集成 rhythm: 有一批待投');
    await sleep(320);
    eq(bridge.dispatched.length, 1, '集成 rhythm: 安静窗口后合成一次投递');
    eq(bridge.dispatched[0].text, `${msg}\n${msg}`, '集成 rhythm: 两条原文按序合并');

    // 命令回执（不带 user_message 边界）不该被合并。
    await bridge.dispatchFollowup('private:3', '命令回执', 'admin', 'n');
    eq(bridge.dispatched.length, 2, '集成 rhythm: 非入站文本直投不攒批');
  }

  // ── persona：情绪与风格真的在记 ─────────────────────────────────────────
  {
    const bridge = new ChatBridge();
    bridge.bySession.set('onebot-private-100000001-abc', 'private:100000001');
    // 用**真实 OneBot 事件的形状**（`message_type` + `user_id`）喂：persona 要从
    // 原始事件推 chatId。2026-10-18 前它读的是 `event.chatId`，永远是 undefined，
    // 入站回血一次都没生效 —— 拿 `{chatId}` 测等于把那个 bug 当成契约锁住了。
    await bridge.handleInbound({
      message_type: 'private',
      user_id: 100000001,
      message: [{ type: 'text', data: { text: '哈哈哈我靠' } }],
      raw_message: '哈哈哈我靠',
    });
    eq(bridge.inboundCalls.length, 1, '集成 persona: handleInbound 原样放行');

    const mood = persona.moodOf('private:100000001');
    near(mood.affinity, 21.5, 1e-3, '集成 persona: 入站 +1.5 亲密度');
    near(mood.warmth, 56, 1e-3, '集成 persona: 入站 +6 热情');

    bridge.onSessionEvent(
      { id: 'onebot-private-100000001-abc' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '哈哈哈好' }] } } },
    );
    // R2 起 noteUserMessage 回血 +8（旧 +2），她说一句 -1.5 → 80 + 8 - 1.5 = 86.5。
    near(persona.moodOf('private:100000001').energy, 86.5, 1e-3, '集成 persona: 她说一句 -1.5 精力');

    // 落盘是 **debounce** 的（`persona` 的 flushMs 是 4000ms），所以这里必须
    // 显式 `flush()`，不能靠 sleep(80) —— 那是把「等一小会儿」当成了「等落盘」，
    // 时序一变就会变成偶发红灯。flush() 正是停机路径，语义上就是「现在写下去」。
    await persona.flush();
    const styleDir = cfg.persona.mediaDir;
    ok(existsSync(join(styleDir, 'mood-state.json')), '集成 persona: mood-state.json 落盘');
    const saved = JSON.parse(readFileSync(join(styleDir, 'mood-state.json'), 'utf8'));
    ok(saved['private:100000001'].warmth > 50, '集成 persona: 落盘内容含热情');

    // 情绪行注入：走 prompt 的 pre-step，sessionId 反推 chatId。
    const decision = { messages: [] };
    const out = await prompt.preStep(
      { agent: { session: { id: 'onebot-private-100000001-abc' } }, turn: 1, step: 1 },
      async () => decision,
    );
    ok(out.messages.length === 1, '集成 persona: 情绪行随 pre-step 注入');
    // 同样按数组形状断言（见 prompt 段那条回归锁的说明）。
    ok(Array.isArray(out.messages[0].content), '集成 persona: 注入 content 是数组');
    const personaText = out.messages[0].content.map((b) => b.text).join('');
    ok(personaText.includes('心情'), '集成 persona: 注入内容含情绪');
    ok(personaText.includes('热情'), '集成 persona: 注入内容含热情');

    eq(persona.dir(), styleDir, '集成 persona: mediaDir 解析正确');
    const snap = persona.snapshot();
    ok(snap['private:100000001'] !== undefined, '集成 persona: 快照能读出该 chat');

    // ── 分层：精力全局一份、亲密度按账号（用户 m01086 的需求）──────────────
    //
    // 改造前四个量都挤在「每条 chat 一条记录」里，于是同一个群里说一句、私聊
    // 说一句，各扣一份电量（一天下来精力被扣成三份），亲密度也是每个群各涨各的。
    // 这里把三件事钉住：跨会话精力连续、同一个人跨会话同一份亲密度、
    // 不同人各自一份。
    {
      const now = Date.now();
      // A（100000001）在群里说话：此时私聊那边已经聊到 86.5，群里再 +8 应当接在
      // 那基础上变成 94.5，而不是从默认 80 重新开始。
      persona.noteMood('group:200000002', 'user', now, { userId: 100000001 });
      const inGroup = persona.moodOf('group:200000002', now, { userId: 100000001 });
      near(inGroup.energy, 94.5, 0.5, '集成 persona: 精力全局一份（群里说话接在私聊的电量上）');
      near(inGroup.affinity, 23, 0.01, '集成 persona: 同一个人在群里也涨同一份亲密度（21.5+1.5）');
      near(
        persona.moodOf('private:100000001', now).energy,
        94.5,
        0.5,
        '集成 persona: 私聊那侧也看到群里扣/回的电量',
      );

      // B（300000003）在同一个群里说话：亲密度是他的，不是 A 的。
      persona.noteMood('group:200000002', 'user', now, { userId: 300000003 });
      near(
        persona.moodOf('group:200000002', now, { userId: 300000003 }).affinity,
        21.5,
        0.01,
        '集成 persona: 换个人说话是另一份亲密度（从 20 起 +1.5）',
      );

      await persona.flush();
      ok(existsSync(join(styleDir, 'body-state.json')), '集成 persona: 精力落 body-state.json');
      ok(existsSync(join(styleDir, 'people-state.json')), '集成 persona: 亲密度落 people-state.json');
      const bodySaved = JSON.parse(readFileSync(join(styleDir, 'body-state.json'), 'utf8'));
      ok(typeof bodySaved.body?.energy === 'number', '集成 persona: body-state.json 里只有一条全局精力');
      const peopleSaved = JSON.parse(readFileSync(join(styleDir, 'people-state.json'), 'utf8'));
      ok(peopleSaved['u:100000001'] !== undefined, '集成 persona: people-state.json 按账号存（u:100000001）');
      ok(peopleSaved['u:300000003'] !== undefined, '集成 persona: people-state.json 按账号存（u:300000003）');
    }

    // ── GUI 会话也算进同一个人的账（2026-10-20）────────────────────────────
    //
    // 起因：情绪只在 OneBot 那条线上记账，于是「在网页 GUI 里跟她聊了一整天」
    // 对亲密度毫无影响。判据是消息来源（`source.kind === 'user'` 且带 rpcId），
    // 不是来源 IP —— 用户只能远程，IP 认不了人。
    {
      const now = Date.now();
      cfg.persona.guiChatId = 'private:100000001';
      const before = persona.moodOf('private:100000001', now).affinity;

      // 冒牌货：时间上下文/会话时钟/自动改标题都是 role:user，但来源不是人。
      const fakes = [
        { id: 'g0', role: 'user', content: [{ type: 'text', text: 'Current time…' }], source: { kind: 'time-context' } },
        { id: 'g1', role: 'user', content: [{ type: 'text', text: 'Generate the session title' }], source: { kind: 'dsh-session-title-llm' } },
        { id: 'g2', role: 'user', content: [{ type: 'text', text: 'Session clock' }], source: { kind: 'session-clock' } },
      ];
      const n0 = persona.noteGuiStep('session-fake', fakes, now);
      eq(n0, null, '集成 persona: GUI 自动注入的消息不记账（靠 source.kind 认）');
      near(persona.moodOf('private:100000001', now).affinity, before, 1e-6, '集成 persona: 冒牌消息没涨亲密度');

      // 真人：source.kind === 'user' + rpcId。
      const real = [
        { id: 'r1', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user', rpcId: 'x1' } },
      ];
      const n1 = persona.noteGuiStep('session-fake', real, now);
      eq(n1, 1, '集成 persona: GUI 里真人说的话记一笔');
      near(
        persona.moodOf('private:100000001', now).affinity,
        before + 1.5,
        0.01,
        '集成 persona: GUI 里说话同样涨亲密度',
      );

      // 同一个 id 再来一遍不重复记（pre-step 每一步都会带着整段 messages）。
      const n2 = persona.noteGuiStep('session-fake', real, now);
      eq(n2, null, '集成 persona: 同一条消息不重复记账');

      // OneBot 会话不走这条路（已经由 handleInbound/onSessionEvent 记过）。
      const dup = persona.noteGuiStep(
        'onebot-private-100000001-abc',
        [{ id: 'r9', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user', rpcId: 'x9' } }],
        now,
      );
      eq(dup, null, '集成 persona: OneBot 会话不重复记 GUI 账');

      // 没配 guiChatId 时什么都不做（默认关）。
      const keep = cfg.persona.guiChatId;
      cfg.persona.guiChatId = '';
      eq(persona.noteGuiStep('session-fake2', real, now), null, '集成 persona: 未配置 guiChatId 时不记账');
      eq(persona.extraFor('session-fake2'), null, '集成 persona: 未配置时 GUI 会话不注入状态行');
      cfg.persona.guiChatId = keep;

      // 配了就要能注入情绪行（只 extra、不套 QQ 那套规则）。
      const line = persona.extraFor('session-fake');
      ok(typeof line === 'string' && line.includes('心情'), '集成 persona: 配置后 GUI 会话也注入情绪行');
    }
  }

  // ── sleep：真挂 processInbound，验证「睡着后群里非 @ 不出声」 ──────────────
  //
  // 这组断言存在的理由：2026-10-18 群友说「她每次说睡觉后面还每次都回复」。
  // 单元测试只能证明闸本身算得对，证明不了**它真的挂在了真实链路上**且**排在
  // mention 外层**。这里用假 profile 走一遍生产路径，把这两件事一起钉住。
  {
    const sleepMod = createSleep({
      cfg: cfg.sleep,
      stats,
      patchMethod,
      log: () => {},
      getNames: () => cfg.mention.names,
      getMediaDir: () => cfg.persona.mediaDir,
      moodOf: (chatId) => persona.moodOf(chatId),
      lastReceiver: () => persona.state.lastReceiver,
    });
    const rSleep = await sleepMod.scan(ctx);
    eq(rSleep.ok, true, `集成 sleep: sleep.scan 成功（${rSleep.error ?? ''}）`);
    eq(
      auditMethods(InboundPipeline.prototype, ['processInbound'], 'sleep'),
      [],
      '集成 sleep: 闸真的挂在 InboundPipeline.prototype.processInbound 上',
    );

    const pipe = new InboundPipeline({ config: {}, selfId: () => '100000002' });
    const groupInbound = (text) => ({
      kind: 'group',
      chatId: 'group:900000001',
      userId: '2665507357',
      text,
      raw: text,
      segments: [{ type: 'text', data: { text } }],
    });

    // 没进睡意 → 直通（对照组：证明下面那条不是因为管线本来就不收消息）
    await InboundPipeline.prototype.processInbound.call(pipe, groupInbound('哈哈哈'));
    eq(pipe.handled.length, 1, '集成 sleep: 未睡时消息正常进管线');

    // 让她说「晚安」→ 进入睡意
    eq(
      sleepMod.noteSaid('group:900000001', '那我先睡啦，晚安喵', Date.now()),
      true,
      '集成 sleep: 说晚安后进入睡意',
    );

    // 群里没 @ 她 → 被吞，管线一条都没多收
    await InboundPipeline.prototype.processInbound.call(pipe, groupInbound('还在吗'));
    eq(pipe.handled.length, 1, '集成 sleep: 睡着后群里非 @ 消息**根本没进管线**');
    eq(stats.sleepBlocked, 1, '集成 sleep: 记一次 blocked');

    // 私聊永远放行
    await InboundPipeline.prototype.processInbound.call(pipe, {
      kind: 'private', chatId: 'private:100000001', userId: '100000001',
      text: '在吗', raw: '在吗', segments: [{ type: 'text', data: { text: '在吗' } }],
    });
    eq(pipe.handled.length, 2, '集成 sleep: 私聊照常放行');

    // 群里 @ 她 → 放行并叫醒
    const atInbound = groupInbound('云玥醒醒');
    atInbound.segments = [
      { type: 'at', data: { qq: '100000002' } },
      { type: 'text', data: { text: ' 云玥醒醒' } },
    ];
    await InboundPipeline.prototype.processInbound.call(pipe, atInbound);
    eq(pipe.handled.length, 3, '集成 sleep: 被 @ 时放行');
    eq(stats.sleepWoke, 1, '集成 sleep: 被 @ 后记一次 woke');
    eq(sleepMod.table.get('group:900000001'), undefined, '集成 sleep: 被叫醒后睡意清除');

    // 醒着时再说话不会被吞（证明确实醒了，不是永久静默）
    await InboundPipeline.prototype.processInbound.call(pipe, groupInbound('那我接着说'));
    eq(pipe.handled.length, 4, '集成 sleep: 叫醒后恢复正常回话');
  }

  // ── 热重载：新 owner 重挂不产生双投递 ───────────────────────────────────
  {
    const stats2 = fakeStats();
    const patchMethod2 = createPatcher({ owner: Symbol('reload'), log: () => {}, stats: stats2, label: 'test2' });
    const rhythm2 = createRhythm({ cfg: cfg.rhythm, stats: stats2, patchMethod: patchMethod2, log: () => {} });
    await rhythm2.scan(ctx);

    const bridge = new ChatBridge();
    await bridge.sendToChat('private:1', '第一句话。第二句话。第三句话。', { queuable: true });
    eq(
      bridge.sentToChat.length,
      3,
      `热重载后仍是 3 条（不是 6 条，实际 ${bridge.sentToChat.length}）`,
    );
    rhythm2.stop();
  }

  // ── guard 自测端到端（跑真实 OutboundPipeline，不发网）─────────────────
  {
    const selfTest = await guard.selfTest(ctx);
    ok(selfTest.ok === true, `集成 guard: selfTest 跑通（${selfTest.error ?? ''}）`);
    ok(
      Array.isArray(selfTest.cases) && selfTest.cases.length > 0,
      '集成 guard: selfTest 有用例',
    );
    const blocked = (selfTest.cases ?? []).filter((c) => c.verdict === 'BLOCKED');
    ok(blocked.length > 0, '集成 guard: selfTest 至少拦下一个沉默');
    const errors = (selfTest.cases ?? []).filter((c) => c.verdict === 'ERROR');
    eq(errors.map((c) => c.label ?? c.name), [], '集成 guard: selfTest 无 ERROR 用例');
  }

  // ── 共享挂载点上摘闸：只摘自己的层，别人的层完好 ─────────────────────────
  //
  // `dispatchFollowup` 上同时挂着 rhythm（入站合并）与 stamp（时刻注入），
  // `handleInbound` 上同时挂着 persona 与 stamp。关掉一个模块时若摘闸摘不动
  // （旧实现只看链头，遇到别人压在上面就 `return false`），症状就是「开关点了
  // 没用」；若摘过了头（把共享挂载点整条清掉），症状就是「误伤别的模块」。
  // 这两条都得钉住，而且要拿行为而不只是函数身份当证据。
  {
    const stamp = createStamp({ cfg: cfg.stamp, stats, patchMethod, log: () => {} });
    const rStamp = await stamp.scan(ctx);
    eq(rStamp.ok, true, `集成 detach: stamp.scan 成功（${rStamp.error ?? ''}）`);
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'stamp'),
      [],
      '集成 detach: stamp 的闸与 rhythm 共存于 dispatchFollowup',
    );

    // ① 关掉 rhythm：rhythm 的层要走，stamp / persona 的层必须原地不动。
    cfg.rhythm.enabled = false;
    const rRhythmOff = await rhythm.scan(ctx);
    eq(rRhythmOff.detached, true, '集成 detach: 关掉 rhythm 时摘掉了自己的层');
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'rhythm'),
      ['dispatchFollowup'],
      '集成 detach: rhythm 的层已离开 dispatchFollowup',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'stamp'),
      [],
      '集成 detach: 关掉 rhythm 后 stamp 的层完好',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'persona'),
      [],
      '集成 detach: 关掉 rhythm 后 persona 的层没被牵连',
    );

    // 行为证据：rhythm 真的走了，入站不再攒批，单条立即投递。
    const bridgeOff = new ChatBridge();
    const msgOff = '<user_message qq="1" nickname="n">\n内容\n</user_message>';
    await bridgeOff.dispatchFollowup('private:7', msgOff, 'member', 'n');
    eq(bridgeOff.dispatched.length, 1, '集成 detach: 关掉 rhythm 后入站合并真的停了');
    eq(rhythm.pendingCount(), 0, '集成 detach: 关掉 rhythm 后没有新增待投批次');

    // 装回去，后面的用例还要用。
    cfg.rhythm.enabled = true;
    await rhythm.scan(ctx);
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'rhythm'),
      [],
      '集成 detach: rhythm 的层已装回',
    );

    // ② 关掉 stamp：这次轮到自己走，rhythm 与 persona 都得留着。
    cfg.stamp.enabled = false;
    const rStampOff = await stamp.scan(ctx);
    eq(rStampOff.detached, true, '集成 detach: 关掉 stamp 时摘掉了自己的层');
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'stamp'),
      ['dispatchFollowup'],
      '集成 detach: stamp 的层已离开 dispatchFollowup',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['dispatchFollowup'], 'rhythm'),
      [],
      '集成 detach: 关掉 stamp 后 rhythm 的层完好',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'stamp'),
      ['handleInbound'],
      '集成 detach: stamp 的 handleInbound 层也一并摘掉',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'persona'),
      [],
      '集成 detach: 关掉 stamp 后 persona 的 handleInbound 层完好',
    );

    cfg.stamp.enabled = true;
    await stamp.scan(ctx);
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound', 'dispatchFollowup'], 'stamp'),
      [],
      '集成 detach: stamp 的层已装回',
    );

    // ③ 关掉 persona：同样只能摘掉 `handleInbound` 上自己那层。
    //    persona 的层会被 stamp 压在下面（优先级 10 < 20），正是「不在链头」的
    //    典型场景 —— 旧实现那版只看链头的循环会在这里 `return false`。
    cfg.persona.enabled = false;
    const rPersonaOff = await persona.scan(ctx);
    eq(rPersonaOff.detached, true, '集成 detach: 关掉 persona 时摘掉了自己的层');
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'persona'),
      ['handleInbound'],
      '集成 detach: persona 的层已离开 handleInbound',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'stamp'),
      [],
      '集成 detach: 关掉 persona 后 stamp 的 handleInbound 层完好',
    );
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'rhythm'),
      ['handleInbound'],
      '集成 detach: persona 的层被摘走时没顺手给 rhythm 挂上东西',
    );

    // 行为证据：persona 真的走了，入站不再记情绪。
    // 先量一个真实的 chat（私有 8）在**有闸**时的读数，再关掉后打同一条入站，
    // 看它有没有变 —— 只看「两次读不变」是恒真的，量不出东西。
    const warmBefore = persona.moodOf('private:8').warmth;
    cfg.persona.enabled = true;
    const rPersonaBack = await persona.scan(ctx);
    eq(rPersonaBack.ok, true, '集成 detach: persona 临时装回成功');
    await new ChatBridge().handleInbound({
      message_type: 'private',
      user_id: 8,
      message: [{ type: 'text', data: { text: '哈哈哈' } }],
      raw_message: '哈哈哈',
    });
    const warmAfterOn = persona.moodOf('private:8').warmth;
    ok(warmAfterOn > warmBefore, '集成 detach: 有闸时入站真的走了 persona');

    cfg.persona.enabled = false;
    await persona.scan(ctx);
    // 幂等：关着的时候再扫一遍不该把闸扫回来。
    await persona.scan(ctx);
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound'], 'persona'),
      ['handleInbound'],
      '集成 detach: 关掉期间反复扫描不会把闸扫回来',
    );
    await new ChatBridge().handleInbound({
      message_type: 'private',
      user_id: 8,
      message: [{ type: 'text', data: { text: '哈哈哈' } }],
      raw_message: '哈哈哈',
    });
    // 容差：情绪有按时间衰减的那一项，两次读数之间会掉一点点（实测 56 →
    // 55.999997），所以比的是「没有那次 +6」，而不是位级相等。
    near(
      persona.moodOf('private:8').warmth,
      warmAfterOn,
      1e-3,
      '集成 detach: 关掉后入站不再走 persona（热情没再涨 +6）',
    );

    cfg.persona.enabled = true;
    await persona.scan(ctx);
    eq(
      auditMethods(ChatBridge.prototype, ['handleInbound', 'onSessionEvent'], 'persona'),
      [],
      '集成 detach: persona 的层已装回',
    );

    // ④ guard：挂的是 `OutboundPipeline`（不与本段其余模块共享），但它同样
    //    必须「关掉就摘闸」—— `enabled:false` 只早退的话，闸会留在原型上，
    //    而闸里读的是同一份 cfg，行为看似跟着变，热重载换实例后才是真症状。
    const outboundOf = () =>
      new OutboundPipeline({
        connected: () => true,
        config: { textImageThreshold: 0 },
        call: async () => ({ message_id: 'm' }),
      });

    cfg.guard.enabled = false;
    const rGuardOff = await guard.scan(ctx);
    eq(rGuardOff.detached, true, '集成 detach: 关掉 guard 时摘掉了自己的层');
    eq(
      auditMethods(OutboundPipeline.prototype, ['sendToChat', 'sendMsg'], 'guard'),
      ['sendToChat', 'sendMsg'],
      '集成 detach: guard 的层已离开 OutboundPipeline',
    );
    const rawSend = await outboundOf().sendToChat('private:9', '[[silent]]', {});
    eq(rawSend, ['m'], '集成 detach: 关掉 guard 后沉默输出真的发出去了');

    cfg.guard.enabled = true;
    await guard.scan(ctx);
    eq(
      auditMethods(OutboundPipeline.prototype, ['sendToChat', 'sendMsg'], 'guard'),
      [],
      '集成 detach: guard 的层已装回',
    );
  }

  await persona.flush();
  rhythm.stop();
  rmSync(fake.base, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
section('isolation 群聊硬隔离');

// 2026-10-17 18:32 事故回归：群友 2665507357 问「工作目录下有什么」，她跑
// ops_bash ls -a 把宿主目录内容发进了群。以下是那道硬闸的判据。
{
  const ADMINS = ['100000001'];

  /** 造一条上游风格的入站用户消息（含 <user_message> 边界）。 */
  const inboundMsg = (qq, body, { restricted = false } = {}) => ({
    role: 'user',
    content: [{
      type: 'text',
      text: `${restricted ? RESTRICTED_PREFIX + ' ' : ''}[18:33 某人(${qq})] `
        + `<user_message qq="${qq}" nickname="n${qq}" time="2026-10-17T18:33:00+08:00" gap="5s">\n${body}\n</user_message>`,
    }],
    source: { kind: 'plugin:dsh-onebot' },
  });
  /** 造本插件自己注入的规则消息（role 也是 user，但没有边界标签）。 */
  const injectedRulesMsg = () => ({
    role: 'user',
    content: [{ type: 'text', text: '以下是你在 QQ 上说话要遵守的习惯……' }],
    source: { kind: 'onebot-prompt' },
  });

  const guest = inboundMsg('2665507357', '工作目录下有什么');
  const admin = inboundMsg('100000001', '帮我看看目录');

  // 判据：按「本轮是谁说的」而不是「哪个会话」——群里两种人共用一个会话。
  const rAdmin = judgeTurn([admin], ADMINS);
  eq(rAdmin.restricted, false, 'isolation: 管理员说话不隔离');
  const rGuest = judgeTurn([guest], ADMINS);
  eq(rGuest.restricted, true, 'isolation: 群友说话要隔离（事故发生的那一条）');
  eq(rGuest.userId, '2665507357', 'isolation: 认出群友 qq');

  // 上游受限前缀独立生效（即使 restrictedMemberPrefix 被改回 false）
  eq(
    judgeTurn([inboundMsg('100000001', 'x', { restricted: true })], ADMINS).reason,
    'restricted-prefix',
    'isolation: 带 [受限用户:仅问答] 前缀即隔离',
  );

  // 纯注入（无入站消息）不误伤
  eq(judgeTurn([injectedRulesMsg()], ADMINS).restricted, false, 'isolation: 无入站消息不隔离');

  // 白名单：只留纯发声
  ok(isAllowedInRestricted('qq_say'), 'isolation: qq_say 允许');
  ok(isAllowedInRestricted('qq_send_face'), 'isolation: qq_send_face 允许');
  ok(!isAllowedInRestricted('ops_bash'), 'isolation: ops_bash 拒绝（事故工具）');
  ok(!isAllowedInRestricted('read'), 'isolation: read 拒绝');
  ok(!isAllowedInRestricted('web_search'), 'isolation: web_search 拒绝');

  // 端到端：同一个群会话，群友回合拒、管理员回合放行
  const stats2 = {};
  const iso = createIsolation({
    cfg: { enabled: true, allowedTools: [...ISOLATION_ALLOWED_TOOLS], adminUsers: ADMINS },
    stats: stats2,
    log: () => {},
    adminUsers: () => ADMINS,
    mediaDir: () => 'D:\\Documents\\yunyue\\.dsh-media',
  });
  const agentOf = (sid) => ({ session: { id: sid } });
  const G = 'onebot-group-900000002-mvc62ikt';

  iso.observe({ agent: agentOf(G), messages: [guest] });
  ok(
    typeof iso.guard({ agent: agentOf(G), name: 'ops_bash' }) === 'string',
    'isolation: 群友回合 ops_bash 被硬拒',
  );
  eq(iso.guard({ agent: agentOf(G), name: 'qq_send_face' }), undefined, 'isolation: 群友回合表情仍可发');

  iso.observe({ agent: agentOf(G), messages: [admin] });
  eq(
    iso.guard({ agent: agentOf(G), name: 'ops_bash' }),
    undefined,
    'isolation: 紧接的管理员回合放行（同会话切换）',
  );

  // 私聊与非 onebot 会话完全不受影响
  eq(iso.guard({ agent: agentOf('session-abc'), name: 'ops_bash' }), undefined, 'isolation: 非 onebot 会话不受影响');
  iso.observe({ agent: agentOf('onebot-private-100000001'), messages: [guest] });
  eq(
    iso.guard({ agent: agentOf('onebot-private-100000001'), name: 'ops_bash' }),
    undefined,
    'isolation: 私聊不隔离',
  );

  // ── 读图白名单：群友回合能读图，但只能读聊天媒体目录 ────────────────────
  //
  // 2026-10-18 实测：群友发图后她说「图我是真看不见的」—— 那不是模型摆烂，
  // 是 `ALLOWED_TOOLS` 里没有 `read_image`，guard 把读图拒了。放开之后必须
  // 同时收窄路径，否则这条就成了「群友诱导她读任意文件」的新口子。
  ok(isAllowedInRestricted('read_image'), 'isolation: read_image 在白名单里');
  // 上一步的管理员回合把 turnState 清了，这里重新标记成群友回合。
  iso.observe({ agent: agentOf(G), messages: [guest] });
  eq(
    iso.guard({
      agent: agentOf(G),
      name: 'read_image',
      arguments: JSON.stringify({ file_path: 'D:\\Documents\\yunyue\\.dsh-media\\media_1.jpg' }),
    }),
    undefined,
    'isolation: 群友回合可读聊天媒体目录里的图',
  );

  const outside = iso.guard({
    agent: agentOf(G),
    name: 'read_image',
    arguments: JSON.stringify({ file_path: 'D:\\Documents\\yunyue\\secret.txt' }),
  });
  ok(typeof outside === 'string', 'isolation: 群友回合读媒体目录以外的文件被拒');
  ok(outside.includes('.dsh-media'), `isolation: 拒绝理由指向媒体目录（实际 ${outside}）`);

  const sibling = iso.guard({
    agent: agentOf(G),
    name: 'read_image',
    arguments: JSON.stringify({ file_path: 'D:\\Documents\\yunyue\\.dsh-media-evil\\x.jpg' }),
  });
  ok(typeof sibling === 'string', 'isolation: 前缀相似的兄弟目录不被当成媒体目录');

  // ── 链接工具：群友回合能拆链接，但只能拆本轮那个 ──────────────────────
  //
  // 2026-10-20：群里别人丢 `b23.tv` 短链过来，`web_fetch` 抓到的只是跳转壳
  // （B 站页面 JS 渲染），她于是只能说「看了个大概」。真正能读出标题/作者的是
  // `link_parse`。放开它的前提是它跟 web_fetch 共用同一条 `checkLinkAccess` 边界。
  const guestLink = inboundMsg('2665507357', '这个视频你看看 https://b23.tv/IxOYYrG');
  iso.observe({ agent: agentOf(G), messages: [guestLink] });
  eq(
    iso.guard({
      agent: agentOf(G),
      name: 'link_parse',
      arguments: JSON.stringify({ url: 'https://b23.tv/IxOYYrG' }),
    }),
    undefined,
    'isolation: 群友回合 link_parse 能拆本轮那条短链',
  );
  eq(
    iso.guard({
      agent: agentOf(G),
      name: 'link_download',
      arguments: JSON.stringify({ url: 'https://b23.tv/IxOYYrG' }),
    }),
    undefined,
    'isolation: link_download 同样放行本轮链接',
  );
  const strayLink = iso.guard({
    agent: agentOf(G),
    name: 'link_parse',
    arguments: JSON.stringify({ url: 'https://www.bilibili.com/video/BV1Gx411c7ZZ' }),
  });
  ok(typeof strayLink === 'string', 'isolation: 本轮没出现过的地址 link_parse 也拒');
  const localLink = iso.guard({
    agent: agentOf(G),
    name: 'link_parse',
    arguments: JSON.stringify({ url: 'http://127.0.0.1:6099/webui?token=abc' }),
  });
  ok(typeof localLink === 'string', 'isolation: link_parse 不许碰 NapCat 面板');
}

// 2026-10-18 自测里抓到：`..\..\` 逃逸曾被 ALLOW —— 折叠前做前缀比较是漏的。
{
  const DIR = 'D:\\Documents\\yunyue\\.dsh-media';
  ok(isUnderDir('D:\\Documents\\yunyue\\.dsh-media\\a.jpg', DIR), 'isolation: 目录内文件放行');
  ok(isUnderDir('D:/Documents/yunyue/.dsh-media/a.jpg', DIR), 'isolation: 正斜杠也认');
  ok(!isUnderDir('C:\\Users\\x\\.ssh\\id_rsa', DIR), 'isolation: 目录外拒绝');
  ok(!isUnderDir('D:\\Documents\\yunyue\\.dsh-media-evil\\a.jpg', DIR), 'isolation: 兄弟目录拒绝');
  ok(
    !isUnderDir('D:\\Documents\\yunyue\\.dsh-media\\..\\secret.txt', DIR),
    'isolation: `..` 跳出目录必须拒绝（曾经的漏）',
  );
  ok(
    !isUnderDir('D:\\Documents\\yunyue\\.dsh-media\\..\\..\\Windows\\win.ini', DIR),
    'isolation: 多级 `..` 跳出目录也拒绝',
  );
  ok(
    isUnderDir('D:\\Documents\\yunyue\\.dsh-media\\.\\sub\\a.jpg', DIR),
    'isolation: 折叠 `.` 后仍在目录内 → 放行',
  );
  ok(!isUnderDir('', DIR), 'isolation: 空路径拒绝');
  ok(!isUnderDir('D:\\a\\b.jpg', ''), 'isolation: 目录为空 → 拒绝（不因配置缺失而全放行）');
}

// 2026-10-19：`link-card.js` 会给出 `[卡片:标题 https://…]`，提示词规则 `link`
// 又要求她「想接话就先 web_fetch」。可群友说话的那一轮是硬隔离的 —— 收窄到
// 「只许打开本轮聊天里真出现过的公网链接」，否则规则和闸门互相打架。
{
  const text = '看看 [卡片:大肥鱼 https://b23.tv/IxOYYrG] 还有 https://example.com/a?b=1。';
  const links = [...extractLinks(text)];
  eq(links.length, 2, 'isolation-link: 卡片标注与裸链接都抠得出来');
  ok(links.includes('https://b23.tv/IxOYYrG'), 'isolation-link: 卡片里的地址');

  ok(checkLinkAccess('https://b23.tv/IxOYYrG', links).ok, 'isolation-link: 本轮出现过的链接 → 放行');
  ok(
    /只能打开/.test(checkLinkAccess('https://evil.example/x', links).reason),
    'isolation-link: 本轮没出现过的链接 → 拒绝',
  );
  ok(!checkLinkAccess('file:///C:/Windows/win.ini', links).ok, 'isolation-link: file:// 拒绝');

  // 内网/本机地址**即便**在本轮文本里出现过也必须拒：否则群友贴一行
  // `http://127.0.0.1:6099/webui?token=…` 就能让她把 NapCat 面板念进群。
  const local = [...extractLinks(
    'http://127.0.0.1:6099/webui?token=abc http://192.168.1.5/x http://100.83.121.115:443/',
  )];
  eq(local.length, 3, 'isolation-link: 三条内网地址都抠出来了');
  for (const url of local) {
    const verdict = checkLinkAccess(url, local);
    ok(!verdict.ok, `isolation-link: 本机/内网地址拒绝 ${url}`);
    ok(/内网|本机/.test(verdict.reason), 'isolation-link: 拒绝理由说明是内网');
  }

  eq([...extractLinks('见 https://a.com/x. 和 https://b.com/y,')],
    ['https://a.com/x', 'https://b.com/y'], 'isolation-link: 去掉尾随标点');

  for (const host of ['localhost', 'foo.local', '10.1.2.3', '172.20.1.1', '192.168.0.1',
    '100.83.121.115', '169.254.1.1', '::1']) {
    ok(isPrivateHost(host), `isolation-link: ${host} 判为内网`);
  }
  for (const host of ['b23.tv', '1.1.1.1', '172.32.0.1', 'example.com']) {
    ok(!isPrivateHost(host), `isolation-link: ${host} 属公网`);
  }

  eq(Object.keys(parseArgs('{"url":"https://a.com"}')).length, 1, 'isolation-link: JSON 字符串参数可解析');
  eq(Object.keys(parseArgs('not json')).length, 0, 'isolation-link: 坏参数解析成空对象（按缺参数拒绝）');

  // 2026-10-20：群里别人丢 B 站短链过来，web_fetch 只能抓到一层跳转壳，
  // 真正能读出内容的是 link_parse。它和 link_download 的参数名同样是 `url`，
  // 所以能原样套 checkLinkAccess —— 边界（只限本轮出现、只限公网）一点没松。
  ok(LINK_TOOLS.includes('link_parse'), 'isolation-link: link_parse 在受限回合的链接白名单里');
  ok(LINK_TOOLS.includes('link_download'), 'isolation-link: link_download 也放行');
  ok(checkLinkAccess('https://b23.tv/IxOYYrG', links).ok, 'isolation-link: 本轮出现过的 B 站短链 link_parse 能拆');
  ok(
    !checkLinkAccess('https://www.bilibili.com/video/BV1xx', links).ok,
    'isolation-link: 群友没发过的 B 站地址，link_parse 也拒',
  );
  ok(
    !checkLinkAccess('http://127.0.0.1:6099/webui?token=abc', links).ok,
    'isolation-link: link_parse 同样不许碰内网',
  );
}

section('emoji 表情/表情包图片化');

// 2026-10-18 15:12 实测：示例用户发 `/变形`(id=312)，上游 `FACE_EMOJI['312']` 是 🐳，
// 她于是回「又发个鲸鱼，你今天是走动物表情包路线喵」。这张表整体错位（329 个 id
// 里 123 个落兜底 😀），所以这里锁两件事：① emoji 必须被删掉；② 名字必须来自
// `sysface-full.json` 导出的那张表，而不是猜。
{
  eq(FACE_NAMES_IN_COUNT, 329, 'emoji: 名字表 329 条');
  eq(Object.keys(FACE_NAMES_IN).length, FACE_NAMES_IN_COUNT, 'emoji: 声明条数与实际一致');
  eq(faceNameOf(312), '变形', 'emoji: 312 → 变形（她曾读成鲸鱼的那一个）');
  eq(faceNameOf(182), '笑哭', 'emoji: 182 → 笑哭');
  eq(faceNameOf(14), '微笑', 'emoji: 14 → 微笑');
  eq(faceNameOf(9999), null, 'emoji: 不认识的 id 返回 null（不回落 emoji）');
  eq(faceNameOf(''), null, 'emoji: 空 id 返回 null');

  // ── stripFaceGlyphs：删掉上游塞进来的错误 emoji ──────────────────────────
  const fakeFaceToEmoji = (id) => ({ 312: '🐳', 182: '🧕' }[String(id)] ?? '😀');
  const segs = [
    { type: 'text', data: { text: '你这 ' } },
    { type: 'face', data: { id: 312 } },
    { type: 'text', data: { text: ' 好怪' } },
  ];
  eq(
    stripFaceGlyphs('你这 🐳 好怪', segs, fakeFaceToEmoji),
    '你这  好怪',
    'emoji: 错误的 emoji 从文本里删掉',
  );
  eq(
    stripFaceGlyphs('没有表情的句子', segs, fakeFaceToEmoji),
    '没有表情的句子',
    'emoji: 文本里找不到就原样返回（上游换实现也不炸）',
  );
  eq(
    stripFaceGlyphs('🐳', segs, null),
    '🐳',
    'emoji: 拿不到 faceToEmoji 时不删（宁可留着错 emoji 也不猜）',
  );
  // 两个相同 emoji 要删两次 —— 用 indexOf 从 cursor 往后找，不能只删第一个。
  eq(
    stripFaceGlyphs('😂和😂',
      [{ type: 'face', data: { id: 1 } }, { type: 'face', data: { id: 1 } }],
      () => '😂'),
    '和',
    'emoji: 连续相同的 emoji 逐个删净',
  );

  // ── annotateEmoji：表情只给名字，表情包给名字+路径 ────────────────────────
  // 原生表情默认**不**下图：QQ 图床 `e<id>` 与 sysface id 不是一套编号（e182 是
  // 比 V 的手，sysface 182 是笑哭），图和名字会互相矛盾。
  const fakeResolve = async (ref) => ({
    path: `D:\\media\\${ref.url ? 'face.png' : 'sticker.png'}`,
  });
  const piped = { ctx: { media: { resolve: fakeResolve } } };
  const statsE = {};
  const inbound = {
    text: '你发的 好怪',
    segments: [
      { type: 'text', data: { text: '你发的 ' } },
      { type: 'face', data: { id: 312 } },
      { type: 'text', data: { text: ' 好怪' } },
    ],
  };
  await annotateEmoji(inbound, piped, { ...EMOJI_DEFAULTS }, statsE);
  eq(inbound.text, '你发的 好怪 [表情:变形]', 'emoji: 表情只补中文名，不下图');
  eq(statsE.emojiResolved ?? 0, 0, 'emoji: 表情没下载就没有 resolved');
  eq(statsE.emojiAnnotated, 1, 'emoji: 记一次 annotated');

  // 显式打开 downloadFaces 时才走图床（留给「确认 id 对齐之后」用）
  const withImg = { text: 'z', segments: [{ type: 'face', data: { id: 312 } }] };
  await annotateEmoji(withImg, piped, { ...EMOJI_DEFAULTS, downloadFaces: true }, {});
  ok(withImg.text.includes('[表情:变形][图片:D:\\media\\face.png]'),
    'emoji: downloadFaces=true 时才附加图片路径');

  // 不认识 id：只留 `[表情:id=N]`，仍然尝试下载图（图床按 id 拼，多半 404）
  const unknown = {
    text: 'x',
    segments: [{ type: 'face', data: { id: 9999 } }],
  };
  const unknownResult = await annotateEmoji(unknown, { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\u.gif' }) } } },
    { ...EMOJI_DEFAULTS }, {});
  ok(unknown.text.includes('[表情:id=9999]'), 'emoji: 不认识的 id 写成 [表情:id=9999]');
  ok(!unknown.text.includes('😀'), 'emoji: 不认识也不塞兜底 😀');
  eq(unknownResult.unknownFaces, 1, 'emoji: 认不出的表情会计数（供上层决定吞不吞）');

  // 认识的表情不计数 —— 否则「装死」会把整片群聊吞光
  const knownOne = { text: 'k', segments: [{ type: 'face', data: { id: 312 } }] };
  const knownResult = await annotateEmoji(knownOne, { ctx: { media: { resolve: async () => undefined } } },
    { ...EMOJI_DEFAULTS }, {});
  eq(knownResult.unknownFaces, 0, 'emoji: 认识的表情不计数');

  // names:false 只是不显示名字，**不该**把认识的表情算成认不出
  const noNames = { text: 'n', segments: [{ type: 'face', data: { id: 312 } }] };
  const noNamesResult = await annotateEmoji(noNames, { ctx: { media: { resolve: async () => undefined } } },
    { ...EMOJI_DEFAULTS, names: false }, {});
  eq(noNamesResult.unknownFaces, 0, 'emoji: names=false 不把认识的表情误判成认不出');

  // 表情包（贴纸）不算「认不出的表情」—— 那是图片，能真读
  const stickerOnly = {
    text: 's [表情包]',
    segments: [{ type: 'image', data: { sub_type: 1, url: 'https://e/x.gif', file: 'f.image' } }],
  };
  const stickerResult = await annotateEmoji(stickerOnly,
    { ctx: { media: { resolve: async () => undefined } } }, { ...EMOJI_DEFAULTS }, {});
  eq(stickerResult.unknownFaces, 0, 'emoji: 表情包不计入认不出的表情');

  // 下载失败：名字要保住，只丢路径
  const noPath = { text: 'y', segments: [{ type: 'face', data: { id: 182 } }] };
  await annotateEmoji(noPath, { ctx: { media: { resolve: async () => undefined } } }, { ...EMOJI_DEFAULTS }, {});
  eq(noPath.text, 'y [表情:笑哭]', 'emoji: 图下载失败仍保留名字');
  ok(!noPath.text.includes('[图片:'), 'emoji: 下载失败时不写空路径');

  // 表情包（sub_type=1）：先删掉上游那几个 `[表情包]` 空壳，再补名字+路径
  const sticker = {
    text: '这个 好看 [表情包]',
    segments: [
      { type: 'text', data: { text: '这个 好看 ' } },
      { type: 'image', data: { sub_type: 1, url: 'https://example.com/s.gif', file: 'abc.image' } },
    ],
  };
  await annotateEmoji(sticker, { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\s.gif' }) } } },
    { ...EMOJI_DEFAULTS }, {});
  // 上游那个空壳占位要被删掉，只留我们自己补的这一处（带路径的那个）。
  eq(
    (sticker.text.match(/\[表情包\]/g) ?? []).length,
    1,
    'emoji: 表情包空壳占位被删掉（只剩补回的那一个）',
  );
  ok(sticker.text.includes('[表情包][图片:D:\\m\\s.gif]'), 'emoji: 表情包补回名字+路径');

  // onSticker 回调（2026-10-21）：每落地一张**表情包**就喂一次图库。
  // 关键在于只喂表情包，不喂原生小黄脸 —— 后者不是真图（`downloadFaces` 默认关，
  // 且图床 id 与 sysface id 对不齐），收进图库只会是一堆配错名字的图。
  {
    const collected = [];
    const withCallback = {
      text: '',
      chatId: 'group:123',
      userId: 'u456',
      segments: [
        { type: 'image', data: { sub_type: 1, url: 'https://example.com/s.gif', file: 'a.image' } },
        { type: 'image', data: { sub_type: 1, url: 'https://example.com/t.gif', file: 'b.image' } },
      ],
    };
    await annotateEmoji(
      withCallback,
      { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\z.gif' }) } } },
      { ...EMOJI_DEFAULTS },
      {},
      (input) => collected.push(input),
    );
    eq(collected.length, 2, 'emoji: 两张表情包各回调一次 onSticker');
    eq(collected[0].path, 'D:\\m\\z.gif', 'emoji: 回调里带落地路径');
    eq(collected[0].chatId, 'group:123', 'emoji: 回调里带会话 id');
    eq(collected[0].userId, 'u456', 'emoji: 回调里带发送者 id');

    // 原生表情（face 段）不该触发回调
    const faceOnly = {
      text: '',
      segments: [{ type: 'face', data: { id: 14 } }],
    };
    const faceCollected = [];
    await annotateEmoji(
      faceOnly,
      { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\e.gif' }) } } },
      { ...EMOJI_DEFAULTS, downloadFaces: true },
      {},
      (input) => faceCollected.push(input),
    );
    eq(faceCollected.length, 0, 'emoji: 原生小黄脸不喂图库（不是真图）');

    // 回调抛错不能影响注解本身
    const boomBack = { text: '', segments: [{ type: 'image', data: { sub_type: 1, url: 'https://example.com/s.gif' } }] };
    await annotateEmoji(
      boomBack,
      { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\q.gif' }) } } },
      { ...EMOJI_DEFAULTS },
      {},
      () => { throw new Error('图库炸了'); },
    );
    ok(boomBack.text.includes('[表情包][图片:D:\\m\\q.gif]'), 'emoji: onSticker 抛错不影响注解');
  }

  // 普通图（sub_type 不是 1）不归本模块管 —— 上游已经给了路径
  const normal = { text: '图 [图片]', segments: [{ type: 'image', data: { file: 'x.image' } }] };
  const before = normal.text;
  await annotateEmoji(normal, { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\n.jpg' }) } } },
    { ...EMOJI_DEFAULTS }, {});
  eq(normal.text, before, 'emoji: 普通图片不重复注解（上游已给路径）');

  // maxPerMessage：按配置截断（用表情包测，表情默认不下载就体现不出截断）
  const many = {
    text: '',
    segments: Array.from({ length: 10 }, () => ({
      type: 'image', data: { sub_type: 1, url: 'https://example.com/s.gif' },
    })),
  };
  const statsMany = {};
  await annotateEmoji(many, { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\f.gif' }) } } },
    { ...EMOJI_DEFAULTS, maxPerMessage: 3 }, statsMany);
  eq(statsMany.emojiResolved, 3, 'emoji: maxPerMessage 截断生效');

  // ── makeEmojiProcessInbound：纯函数包装 ─────────────────────────────────
  const called = [];
  const wrap = makeEmojiProcessInbound({
    original: async function original(inb) { called.push(inb.text); return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS },
    stats: {},
    log: () => {},
    state: { faceToEmoji: fakeFaceToEmoji },
  });
  const pipedSelf = { ctx: { media: { resolve: async () => ({ path: 'D:\\m\\f.png' }) } } };
  const msg = {
    text: '看 🐳',
    segments: [{ type: 'text', data: { text: '看 ' } }, { type: 'face', data: { id: 312 } }],
  };
  const r = await wrap.call(pipedSelf, msg);
  eq(r, 'ok', 'emoji: 包装放行上游返回值');
  ok(!called[0].includes('🐳'), 'emoji: 包装先删错 emoji 再交给上游');
  ok(called[0].includes('[表情:变形]'), 'emoji: 包装把中文名交给上游');

  // 上游抛错不影响投递：注解失败只记 lastError
  const statsErr = {};
  const wrapBad = makeEmojiProcessInbound({
    original: async function original() { return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS },
    stats: statsErr,
    log: () => {},
    state: { faceToEmoji: null },
  });
  const bad = {
    text: 'x',
    segments: [{ type: 'image', data: { sub_type: 1, url: 'https://example.com/s.gif' } }],
  };
  const badSelf = { ctx: { media: { resolve: async () => { throw new Error('boom'); } } } };
  eq(await wrapBad.call(badSelf, bad), 'ok', 'emoji: 注解抛错也照常投递');
  ok(typeof statsErr.emojiLastError === 'string', 'emoji: 注解抛错记到 stats');

  // enabled:false：完全不动消息
  const wrapOff = makeEmojiProcessInbound({
    original: async function original(inb) { called.push(inb.text); return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS, enabled: false },
    stats: {},
    log: () => {},
    state: { faceToEmoji: fakeFaceToEmoji },
  });
  called.length = 0;
  await wrapOff.call(pipedSelf, { text: '看 🐳', segments: [{ type: 'face', data: { id: 312 } }] });
  eq(called[0], '看 🐳', 'emoji: 关掉后原样放行（连错 emoji 都不删）');

  // ── 认不出的表情：整条不回（2026-10-18 用户要求「装死」）──────────────
  // 关键在**上游根本没被调用** —— 只要改了文本再放行，模型还是会花一次生成，
  // 只是被提示词劝住，那不算「装死」。
  const muteCalled = [];
  const wrapMute = makeEmojiProcessInbound({
    original: async function original(inb) { muteCalled.push(inb.text); return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS },
    stats: {},
    log: () => {},
    state: { faceToEmoji: fakeFaceToEmoji },
  });
  const muteSelf = { ctx: { media: { resolve: async () => undefined } } };
  const mystery = {
    text: '嗯 😀',
    segments: [{ type: 'text', data: { text: '嗯 ' } }, { type: 'face', data: { id: 9999 } }],
  };
  eq(await wrapMute.call(muteSelf, mystery), undefined, 'emoji: 认不出的表情 → 包装返回 undefined（吞掉）');
  eq(muteCalled.length, 0, 'emoji: 吞掉时上游一次都没被调（不是改文本放行）');

  // 认识的表情照常放行 —— 不能把整片群聊吞了
  const knownMsg = {
    text: '哈 😀',
    segments: [{ type: 'text', data: { text: '哈 ' } }, { type: 'face', data: { id: 182 } }],
  };
  eq(await wrapMute.call(muteSelf, knownMsg), 'ok', 'emoji: 认识的表情照常放行');

  // 关掉开关就照常放行（万一哪天想让她硬接）
  const wrapNoMute = makeEmojiProcessInbound({
    original: async function original() { return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS, muteUnknownFaces: false },
    stats: {},
    log: () => {},
    state: { faceToEmoji: fakeFaceToEmoji },
  });
  eq(await wrapNoMute.call(muteSelf, {
    text: 'x', segments: [{ type: 'face', data: { id: 9999 } }],
  }), 'ok', 'emoji: muteUnknownFaces=false 时照常放行');

  // 统计要能看出来她被静默了多少次（否则「她今天怎么这么安静」无从排查）
  const statsMute = {};
  const wrapMuteStat = makeEmojiProcessInbound({
    original: async function original() { return 'ok'; },
    cfg: { ...EMOJI_DEFAULTS },
    stats: statsMute,
    log: () => {},
    state: { faceToEmoji: fakeFaceToEmoji },
  });
  await wrapMuteStat.call(muteSelf, {
    chatId: 'group:1',
    text: 'x',
    segments: [{ type: 'face', data: { id: 9998 } }, { type: 'face', data: { id: 312 } }],
  });
  eq(statsMute.emojiMuted, 1, 'emoji: 记一次 emojiMuted');
  eq(statsMute.lastEmojiMuted.ids, ['9998'], 'emoji: lastEmojiMuted 只列认不出的那些');

  // 实例结构：与其余模块同构
  const emojiMod = createEmoji({
    cfg: { ...EMOJI_DEFAULTS },
    stats: {},
    patchMethod: () => false,
    log: () => {},
  });
  eq(emojiMod.MODULE_ID, 'emoji', 'emoji: MODULE_ID');
  eq(emojiMod.METHODS, ['processInbound'], 'emoji: 只挂 processInbound');
  ok(typeof emojiMod.scan === 'function' && typeof emojiMod.detach === 'function', 'emoji: 有 scan/detach');
}

section('sleep 睡意闸');

// 2026-10-18 群友反馈：「她每次说睡觉后面还每次都回复」。实录里 15:11:33 说
// 「我撑不住了……先去睡一会儿喵」，之后 15:12:14 / 15:12:22 / 15:12:48 又接了
// 三条。这些断言锁的是：说了要睡之后，**群里的非 @ 消息必须被吞**，而 @ / 喊
// 名字必须能把她叫醒（否则半夜 @ 她装死是另一种毛病）。
{
  // ── 措辞识别 ──────────────────────────────────────────────────────────
  eq(matchSleepWord('那我先睡啦，晚安喵'), '晚安', 'sleep: 「晚安」命中');
  eq(matchSleepWord('我撑不住了……先去睡一会儿喵'), '去睡', 'sleep: 「去睡」命中（措辞表按顺序取第一个）');
  eq(matchSleepWord('我真的撑不住了'), '撑不住', 'sleep: 只说「撑不住」也命中');
  eq(matchSleepWord('今天天气不错'), null, 'sleep: 普通句子不命中');
  eq(matchSleepWord(''), null, 'sleep: 空串不命中');
  eq(matchSleepWord(undefined), null, 'sleep: 非字符串不命中');

  // ── 进入睡意的判据 ────────────────────────────────────────────────────
  eq(
    sleepTrigger({ text: '晚安喵', energy: 90, mood: 'happy' }, SLEEP_DEFAULTS),
    'word:晚安',
    'sleep: 明确说晚安 → 不看精力直接进',
  );
  eq(
    sleepTrigger({ text: '今天好热', energy: 10, mood: 'tired', hour: 2 }, SLEEP_DEFAULTS),
    'state:tired/10',
    'sleep: 深夜 + 精力 10 + tired → 按状态进',
  );
  eq(
    sleepTrigger({ text: '今天好热', energy: 10, mood: 'tired', hour: 15 }, SLEEP_DEFAULTS),
    null,
    'sleep: 下午精力低也不算困（时间窗保护）',
  );
  eq(
    sleepTrigger({ text: '今天好热', energy: 10, mood: 'tired' }, SLEEP_DEFAULTS),
    null,
    'sleep: 不知道几点 → 不按状态进（宁可不睡）',
  );
  // 精力低但心情不 tired → **不进**。2026-10-18 实测：group:900000002 的
  // energy 长期是 0，按「只低精力也算」会让她随便说句话就整晚静默。
  eq(
    sleepTrigger({ text: '今天好热', energy: 10, mood: 'happy', hour: 2 }, SLEEP_DEFAULTS),
    null,
    'sleep: 精力低但心情不 tired → 不进（精力会长期为 0，太危险）',
  );
  eq(
    sleepTrigger({ text: '今天好热', energy: 80, mood: 'happy', hour: 2 }, SLEEP_DEFAULTS),
    null,
    'sleep: 精神饱满又不提睡觉 → 不进',
  );
  eq(
    sleepTrigger({ text: '今天好热', energy: 10, mood: 'tired', hour: 2 }, { ...SLEEP_DEFAULTS, autoByMood: false }),
    null,
    'sleep: autoByMood=false 时只看措辞',
  );

  // ── 睡多久：白天打盹 1 小时，夜里 7 小时（2026-10-18 用户要求）──────────
  // 时间戳按本地时区造，`sleepDuration` 内部用 `new Date(at).getHours()`。
  const atHour = (h) => new Date(2026, 9, 18, h, 30, 0).getTime();
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(15)), 3600000, 'sleep: 下午 3 点说困 → 只睡 1 小时');
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(7)), 3600000, 'sleep: 7:00 整是白天窗口起点 → 1 小时');
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(22)), 3600000, 'sleep: 22:59 还是白天 → 1 小时');
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(23)), 25200000, 'sleep: 23:00 起算夜里 → 7 小时');
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(3)), 25200000, 'sleep: 凌晨 3 点 → 7 小时');
  eq(sleepDuration(SLEEP_DEFAULTS, atHour(6)), 25200000, 'sleep: 6:59 仍是夜里 → 7 小时');
  eq(
    sleepDuration({ ...SLEEP_DEFAULTS, daytimeDurationMs: 900000 }, atHour(12)),
    900000,
    'sleep: daytimeDurationMs 可配',
  );
  eq(
    sleepDuration({ ...SLEEP_DEFAULTS, dayStartHour: 23, dayEndHour: 7 }, atHour(2)),
    SLEEP_DEFAULTS.daytimeDurationMs,
    'sleep: 白天窗口写反（跨零点）也能算',
  );

  // ── 状态表与落盘 ──────────────────────────────────────────────────────
  const table = createSleepState();
  table.set('group:1', { until: 5000, reason: 'word:晚安', at: 1000 });
  eq(table.size(), 1, 'sleep: 状态表能存');
  const roundTrip = createSleepState();
  roundTrip.fromObject(table.toObject());
  eq(roundTrip.get('group:1').reason, 'word:晚安', 'sleep: 落盘再读回内容一致');
  roundTrip.fromObject({ 'group:2': { until: 'bad' }, 'group:1': { until: 5000, reason: 'ok', at: 1 } });
  eq(roundTrip.size(), 1, 'sleep: 坏数据跳过（until 非数字），好数据保留');
  roundTrip.fromObject({ 'group:3': { until: 0 } });
  eq(roundTrip.size(), 0, 'sleep: until<=0 跳过');
  roundTrip.fromObject(null);
  eq(roundTrip.size(), 0, 'sleep: null 清空');

  // ── 放行判据 ──────────────────────────────────────────────────────────
  const entry = { until: 9000, reason: 'word:晚安', at: 1000 };
  const noMention = () => false;
  const yesMention = () => true;
  const names = ['云玥', '玥玥'];

  eq(
    judgeSleep({ kind: 'group', segments: [], text: '哈哈哈哈' }, entry, 5000, noMention, names, {}).reason,
    'sleeping',
    'sleep: 群里没被叫 → 吞掉',
  );
  eq(
    judgeSleep({ kind: 'group', segments: [], text: '哈哈哈' }, entry, 5000, yesMention, names, {}).reason,
    'mentioned',
    'sleep: 被 @ → 放行（会被叫醒）',
  );
  eq(
    judgeSleep({ kind: 'group', segments: [], text: '云玥你睡了吗' }, entry, 5000, noMention, names, {}).reason,
    'name:云玥',
    'sleep: 喊名字 → 放行',
  );
  eq(
    judgeSleep({ kind: 'private', segments: [], text: '在吗' }, entry, 5000, noMention, names, {}).reason,
    'private',
    'sleep: 私聊永远放行（只跟她一个人说，不存在刷屏问题）',
  );
  eq(
    judgeSleep({ kind: 'group', segments: [], text: '哈哈哈' }, entry, 9999, noMention, names, {}).reason,
    'expired',
    'sleep: 睡意过期 → 放行',
  );
  eq(
    judgeSleep({ kind: 'group', segments: [], text: '哈哈哈' }, undefined, 5000, noMention, names, {}).reason,
    'no-entry',
    'sleep: 没有睡意记录 → 放行',
  );
  eq(
    judgeSleep(
      { kind: 'group', segments: [], text: '哈哈哈' }, entry, 5000,
      () => { throw new Error('boom'); }, names, {},
    ).reason,
    'sleeping',
    'sleep: 判定器炸了按「没被叫」处理（宁可多沉默）',
  );

  // ── 包装层行为 ────────────────────────────────────────────────────────
  {
    const stats = {};
    const table2 = createSleepState();
    const calls = [];
    const original = function (inbound) { calls.push(inbound.text); return 'dispatched'; };
    const wrapper = makeSleepProcessInbound({
      original,
      cfg: { ...SLEEP_DEFAULTS },
      state: { detectMention: null, names: ['云玥'], ids: {} },
      table: table2,
      stats,
      log: () => {},
      now: () => 5000,
    });

    // 没进睡意 → 直通
    eq(wrapper.call({}, { chatId: 'group:1', kind: 'group', text: '在吗' }), 'dispatched', 'sleep: 未睡时直通');
    eq(calls.length, 1, 'sleep: 未睡时原方法被调用');

    table2.set('group:1', { until: 9000, reason: 'word:晚安', at: 1000 });
    eq(wrapper.call({}, { chatId: 'group:1', kind: 'group', text: '哈哈哈' }), undefined, 'sleep: 睡着时吞掉（不返回原方法结果）');
    eq(calls.length, 1, 'sleep: 睡着时原方法**没被调用**（消息根本没进模型）');
    eq(stats.sleepBlocked, 1, 'sleep: 记 blocked 计数');
    eq(stats.lastSleepBlocked.chatId, 'group:1', 'sleep: 记最后一条被吞的 chat');
    eq(table2.get('group:1') !== undefined, true, 'sleep: 被吞不会清掉睡意');

    // 喊名字 → 叫醒
    eq(
      wrapper.call({}, { chatId: 'group:1', kind: 'group', text: '云玥醒了没' }),
      'dispatched',
      'sleep: 喊名字放行',
    );
    eq(calls.length, 2, 'sleep: 叫醒后原方法被调用');
    eq(table2.get('group:1'), undefined, 'sleep: 被叫醒后睡意清除');
    eq(stats.sleepWoke, 1, 'sleep: 记 woke 计数');

    // 过期自动清
    table2.set('group:2', { until: 4000, reason: 'word:晚安', at: 1000 });
    eq(wrapper.call({}, { chatId: 'group:2', kind: 'group', text: '哈哈哈' }), 'dispatched', 'sleep: 过期直通');
    eq(table2.get('group:2'), undefined, 'sleep: 过期顺手清掉');

    // 闸自己炸了 → 必须放行
    const broken = makeSleepProcessInbound({
      original,
      cfg: { ...SLEEP_DEFAULTS },
      state: { detectMention: null, names: null, ids: {} },
      table: { get: () => { throw new Error('boom'); } },
      stats,
      log: () => {},
      now: () => 5000,
    });
    eq(broken.call({}, { chatId: 'group:9', kind: 'group', text: '在吗' }), 'dispatched', 'sleep: 闸异常时放行（不能卡死消息）');
    ok(typeof stats.lastError === 'string', 'sleep: 闸异常记进 lastError');

    // enabled=false → 完全不拦
    const off = makeSleepProcessInbound({
      original,
      cfg: { ...SLEEP_DEFAULTS, enabled: false },
      state: { detectMention: null, names: [], ids: {} },
      table: table2,
      stats: {},
      log: () => {},
      now: () => 5000,
    });
    table2.set('group:3', { until: 9000, reason: 'word:晚安', at: 1000 });
    eq(off.call({}, { chatId: 'group:3', kind: 'group', text: '哈哈哈' }), 'dispatched', 'sleep: enabled=false 时不拦');
  }

  // ── 模块形状 ──────────────────────────────────────────────────────────
  {
    const mod = createSleep({
      cfg: { ...SLEEP_DEFAULTS },
      stats: {},
      patchMethod: () => false,
      log: () => {},
    });
    eq(mod.MODULE_ID, 'sleep', 'sleep: MODULE_ID');
    eq(mod.METHODS, ['processInbound'], 'sleep: 只挂 processInbound');
    ok(typeof mod.scan === 'function' && typeof mod.detach === 'function', 'sleep: 有 scan/detach');
    eq(mod.noteSaid('group:5', '那我先睡啦，晚安喵', 1000), true, 'sleep: noteSaid 识别晚安');
    // `at=1000` 是 1970-01-01 **本地 08:00**，落在白天窗口里 → 打盹 1 小时。
    // 之前这里断言的是 7 小时，那等于把「白天也睡一整晚」当契约锁住了。
    eq(mod.table.get('group:5').until, 1000 + SLEEP_DEFAULTS.daytimeDurationMs,
      'sleep: 白天说晚安 → 只睡 daytimeDurationMs');
    // 夜里说晚安 → 睡满 durationMs
    const nightAt = new Date(2026, 9, 18, 23, 40, 0).getTime();
    eq(mod.noteSaid('group:7', '晚安喵', nightAt), true, 'sleep: noteSaid 夜里说晚安');
    eq(mod.table.get('group:7').until, nightAt + SLEEP_DEFAULTS.durationMs,
      'sleep: 夜里说晚安 → 睡满 durationMs');
    eq(mod.noteSaid('group:6', '今天天气不错', 1000), false, 'sleep: 普通句子不进睡意');
    eq(mod.snapshot(2000)['group:5'] !== undefined, true, 'sleep: snapshot 报当前在睡');
    eq(mod.snapshot(1000 + SLEEP_DEFAULTS.durationMs + 1)['group:5'], undefined, 'sleep: snapshot 过滤过期');
    eq(mod.wake('group:5'), true, 'sleep: wake 手动叫醒');
    eq(mod.table.get('group:5'), undefined, 'sleep: wake 后记录消失');
  }
}


section('hands 社交的手 + 审批闸');
{
  // ── 纯函数部分 ────────────────────────────────────────────────────────────
  eq(parseApprovalCommand('/同意 a3f9'), { approve: true, code: 'a3f9' }, 'hands: /同意 解析');
  eq(parseApprovalCommand('／通过 AB12'), { approve: true, code: 'ab12' }, 'hands: 全角斜杠 + 大写编号');
  eq(parseApprovalCommand('/拒绝 zz99'), { approve: false, code: 'zz99' }, 'hands: /拒绝 解析');
  eq(parseApprovalCommand('/驳回 k2m8'), { approve: false, code: 'k2m8' }, 'hands: /驳回 也是拒绝');
  eq(parseApprovalCommand('同意 a3f9'), null, 'hands: 没有斜杠不认（防止误吞普通聊天）');
  eq(parseApprovalCommand('/同意'), null, 'hands: 缺编号不认');
  eq(parseApprovalCommand('/同意 a3f9 好的'), null, 'hands: 编号后面还有字不认');
  eq(parseApprovalCommand(''), null, 'hands: 空串');
  eq(parseApprovalCommand(undefined), null, 'hands: 非字符串');

  // 编号字母表去掉了易混字符：不能出现 0 / O / 1 / I / l
  const codes = [];
  for (let i = 0; i < 200; i += 1) codes.push(makeCode());
  ok(codes.every((c) => c.length === 4), 'hands: makeCode 长度恒为 4');
  ok(codes.every((c) => /^[abcdefghjkmnpqrstuvwxyz23456789]+$/.test(c)),
    'hands: 编号只用不易看错的字符');
  ok(new Set(codes).size > 150, 'hands: 编号有足够的随机性');

  // 表情名 → id
  eq(resolveReactId('赞'), '76', 'hands: 「赞」→ 76');
  eq(resolveReactId('笑哭'), '178', 'hands: 「笑哭」→ 178');
  eq(resolveReactId('128077'), '128077', 'hands: 纯数字原样透传');
  eq(resolveReactId(undefined), '76', 'hands: 省略时默认赞');
  eq(resolveReactId('不存在的表情'), null, 'hands: 认不出的名字返回 null');

  // 申请清单归一化
  const groups = normalizeGroupRequests({
    invited_requests: [
      { flag: 'f1', group_id: 900000001, group_name: '批发部', invitor_uin: 100000001, invitor_nick: '示例用户' },
    ],
    join_requests: [
      { flag: 'f2', group_id: 900000002, group_name: '我的世界', requester_uin: 10001, requester_nick: '芙', message: '让我进' },
    ],
  });
  eq(groups.length, 2, 'hands: 群邀请 + 入群申请都能认出来');
  eq(groups[0].subType, 'invite', 'hands: invited_requests 是 invite');
  eq(groups[1].subType, 'add', 'hands: join_requests 是 add');
  eq(groups[1].userId, '10001', 'hands: 申请人 QQ 号归一化');
  eq(normalizeGroupRequests({}), [], 'hands: 空响应不炸');
  eq(normalizeGroupRequests(null), [], 'hands: null 不炸');
  eq(normalizeGroupRequests({ invited_requests: [{ group_id: 1 }] }), [],
    'hands: 没有 flag 的条目直接跳过（拿不到 flag 就批不了）');

  const friends = normalizeFriendRequests([
    { flag: 'f3', uin: 10002, nick: '测试', msg: '你好' },
  ]);
  eq(friends.length, 1, 'hands: 好友申请能认出来');
  eq(friends[0].kind, 'friend', 'hands: kind=friend');
  eq(friends[0].message, '你好', 'hands: 留言带出来');
  eq(normalizeFriendRequests([]), [], 'hands: 空数组');
  eq(normalizeFriendRequests({ list: [{ flag: 'x', uin: 1 }] }).length, 1, 'hands: 兼容 {list:[]} 壳');

  // 一句话描述（审批消息里用的就是它）
  ok(describeRequest(groups[0]).includes('示例用户'), 'hands: 描述里有邀请人昵称');
  ok(describeRequest(groups[0]).includes('批发部'), 'hands: 描述里有群名');
  ok(describeRequest(friends[0]).includes('你好'), 'hands: 好友描述里带留言');

  // ── 行为部分：真造一个实例，用假 bridge / 假 patchMethod ─────────────────
  const calls = [];
  const said = [];
  const fakeBridge = {
    deps: {
      policy: { adminUsers: ['100000001'] },
      connection: {
        call: async (action, params) => {
          calls.push([action, params]);
          if (action === 'set_group_add_request' && params.flag === 'boom') {
            throw new Error('模拟 NapCat 报错');
          }
          return { status: 'ok', retcode: 0, data: {} };
        },
      },
    },
    sendToChat: async (chatId, text) => {
      said.push([chatId, text]);
      return { messageId: 1 };
    },
  };
  const stats = {};
  const hstats = {};
  const hands = createHands({
    cfg: { enabled: true, approveTtlMs: 1_800_000, autoApproveAdminInvites: true, adminUsers: ['100000001'] },
    stats: hstats,
    log: () => {},
    getReceiver: () => fakeBridge,
    adminUsers: () => ['100000001'],
    patchMethod: null,
  });
  ok(typeof hands.poke === 'function', 'hands: 实例有 poke');

  // 戳一戳：私聊 / 群聊参数要对
  await hands.poke({ user_id: '100000001' });
  eq(calls.at(-1)[0], 'send_poke', 'hands: poke 走 send_poke');
  eq(calls.at(-1)[1].user_id, '100000001', 'hands: poke 带 user_id');
  eq(calls.at(-1)[1].group_id, undefined, 'hands: 私聊 poke 不带 group_id');
  await hands.poke({ user_id: '1', group_id: '900000002' });
  eq(calls.at(-1)[1].group_id, '900000002', 'hands: 群里 poke 带 group_id');
  let threw = false;
  try {
    await hands.poke({});
  } catch {
    threw = true;
  }
  ok(threw, 'hands: poke 没给对象要报错（不能默默成功）');

  // 贴表情：给了 message_id 就用它
  await hands.react({ message_id: '992400273', emoji_id: '赞' });
  eq(calls.at(-1)[0], 'set_msg_emoji_like', 'hands: react 走 set_msg_emoji_like');
  eq(calls.at(-1)[1].emoji_id, '76', 'hands: react 把「赞」翻成 76');
  eq(calls.at(-1)[1].set, true, 'hands: react 带 set:true');
  threw = false;
  try {
    await hands.react({});
  } catch {
    threw = true;
  }
  ok(threw, 'hands: react 没上下文又没 message_id 要报错');

  // 名片赞
  await hands.like({ user_id: '100000001', times: 99 });
  eq(calls.at(-1)[1].times, 10, 'hands: like 的 times 上限夹到 10');

  // ── 自己的资料：用户 2026-10-19「改QQ名、改签名这些不用我审批」 ──────────
  await hands.setNickname({ nickname: '云玥' });
  eq(calls.at(-1)[0], 'set_qq_profile', 'profile: 改名走 set_qq_profile');
  eq(calls.at(-1)[1].nickname, '云玥', 'profile: 改名带 nickname');
  eq(calls.at(-1)[1].personal_note, undefined,
    'profile: 只改名时不能带 personal_note（否则会把签名冲成空）');

  await hands.setSignature({ text: '今天也在装死' });
  eq(calls.at(-1)[0], 'set_self_longnick', 'profile: 改签名走 set_self_longnick');
  eq(calls.at(-1)[1].longNick, '今天也在装死', 'profile: 签名走 longNick 字段');

  threw = false;
  try {
    await hands.setNickname({ nickname: '  ' });
  } catch {
    threw = true;
  }
  ok(threw, 'profile: 空名字要报错');
  threw = false;
  try {
    await hands.setNickname({ nickname: 'x'.repeat(25) });
  } catch {
    threw = true;
  }
  ok(threw, 'profile: 名字超 24 字要报错');
  threw = false;
  try {
    await hands.setSignature({ text: 'x'.repeat(81) });
  } catch {
    threw = true;
  }
  ok(threw, 'profile: 签名超 80 字要报错');

  // 改资料**不该**产生审批单（用户的明确要求）
  const beforeProfile = said.length;
  const beforePending = hands.snapshot().pending.length;
  await hands.setNickname({ nickname: '云玥玥' });
  eq(said.length, beforeProfile, 'profile: 改名字不发审批通知');
  eq(hands.snapshot().pending.length, beforePending, 'profile: 改名字不生成审批单');
  ok(calls.at(-1)[0] === 'set_qq_profile', 'profile: 改名字直接就执行了');

  // allowSelfProfile 关掉就拦住
  {
    const blocked = createHands({
      cfg: { enabled: true, allowSelfProfile: false, adminUsers: ['100000001'] },
      stats: {},
      log: () => {},
      getReceiver: () => fakeBridge,
      adminUsers: () => ['100000001'],
      patchMethod: null,
    });
    threw = false;
    try {
      await blocked.setNickname({ nickname: '随便' });
    } catch {
      threw = true;
    }
    ok(threw, 'profile: allowSelfProfile=false 时改名字被拒');
  }

  // 审批闸 —— 核心：**不会直接执行**，而是生成审批单发私聊
  const beforeCalls = calls.length;
  const req = await hands.approve({
    kind: 'friend', flag: 'REQ-1', nickname: '小明', user_id: '10003',
  });
  eq(req.needsApproval, true, 'hands: 首次调用不执行，只要审批');
  eq(req.executed, undefined, 'hands: 首次调用不能带 executed');
  eq(calls.length, beforeCalls, 'hands: 审批前一个 OneBot 调用都不该发出');
  ok(typeof req.code === 'string' && req.code.length === 4, 'hands: 给了审批编号');
  eq(said.length, 1, 'hands: 给管理员发了一条审批通知');
  eq(said[0][0], 'private:100000001', 'hands: 审批通知发到管理员私聊');
  ok(said[0][1].includes('小明'), 'hands: 通知里说清是谁');
  ok(said[0][1].includes(req.code), 'hands: 通知里带编号');
  ok(said[0][1].includes('/同意'), 'hands: 通知里教他怎么回');

  // 管理员回 /同意 → 真正执行
  const decided = await hands.decide(req.code, true);
  eq(decided.ok, true, 'hands: /同意 执行成功');
  eq(decided.executed, true, 'hands: /同意 标 executed');
  eq(calls.at(-1)[0], 'set_doubt_friends_add_request', 'hands: 好友申请走 set_doubt_friends_add_request');
  ok(calls.at(-1)[1].approve === true, 'hands: 带 approve:true');
  eq(await hands.decide(req.code, true), {
    ok: false, code: req.code, error: '没有这个编号（可能已过期或已处理）',
  }, 'hands: 同一个编号不能批两次');

  // 「我拉的除外」：管理员邀请进群 → 直接放行，不走审批
  const beforeSaid = said.length;
  const invite = await hands.approve({
    kind: 'group', flag: 'G-1', sub_type: 'invite', group_id: '900000003', group_name: 'brothers', user_id: '100000001',
  });
  eq(invite.executed, true, 'hands: 管理员邀请 → 直接执行');
  eq(invite.auto, 'admin-invite', 'hands: 标出来是自动放行的');
  eq(said.length, beforeSaid, 'hands: 自动放行不打扰管理员');
  eq(calls.at(-1)[0], 'set_group_add_request', 'hands: 群邀请走 set_group_add_request');
  eq(calls.at(-1)[1].sub_type, 'invite', 'hands: sub_type 传 invite');

  // 非管理员邀请 → 照样要审批（这条是安全边界，必须钉死）
  const other = await hands.approve({
    kind: 'group', flag: 'G-2', sub_type: 'invite', group_id: '900000003', group_name: 'brothers', user_id: '10004', nickname: '路人',
  });
  eq(other.needsApproval, true, 'hands: 别人邀请我进群也要审批');
  eq(other.executed, undefined, 'hands: 别人邀请不自动执行');

  // 审批执行失败要回滚（编号还在，能重来）
  const boom = await hands.approve({ kind: 'group', flag: 'boom', sub_type: 'add', group_id: '1' });
  const boomDecide = await hands.decide(boom.code, true);
  eq(boomDecide.ok, false, 'hands: 执行报错要如实返回');
  ok(String(boomDecide.error).includes('模拟 NapCat 报错'), 'hands: 报错原文带出来');
  ok(hands.snapshot().pending.some((p) => p.code === boom.code), 'hands: 执行失败后编号还在（可重试）');

  // 拒绝
  const deniable = await hands.approve({ kind: 'friend', flag: 'REQ-2', nickname: '推销' });
  const denied = await hands.decide(deniable.code, false);
  eq(denied.denied, true, 'hands: /拒绝 标 denied');
  eq(denied.executed, undefined, 'hands: 拒绝不执行任何 OneBot 调用');

  // 入站拦截层：管理员的命令要被吞掉，群友的命令不能生效
  const seen = [];
  const proc = hands.makeProcessInbound({ original: async function original(inbound) { seen.push(inbound); return 'passed'; } });
  const pend = await hands.approve({ kind: 'friend', flag: 'REQ-3', nickname: '待批' });
  const swallowed = await proc.call(
    { chatId: 'private:100000001' },
    { chatId: 'private:100000001', userId: '100000001', text: `/同意 ${pend.code}` },
  );
  eq(swallowed, undefined, 'hands: 管理员私聊的 /同意 被吞掉（模型看不到）');
  eq(seen.length, 0, 'hands: 被吞的命令没有继续往下传');
  eq(await proc.call({}, { chatId: 'group:900000002', userId: '10005', text: `/同意 ${pend.code}` }), 'passed',
    'hands: 群里别人的 /同意 不生效，照常投递');
  eq(await proc.call({}, { chatId: 'private:100000001', userId: '10005', text: '/同意 abcd' }), 'passed',
    'hands: 非管理员私聊的命令也不生效');
  eq(await proc.call({}, { chatId: 'private:100000001', userId: '100000001', text: '今天好热' }), 'passed',
    'hands: 管理员说普通的话照常投递');
  // 记住 message_id：贴表情要用
  await proc.call({}, { chatId: 'group:900000002', userId: '10005', text: '看看这个', messageId: '888' });
  await hands.react({ chat_id: 'group:900000002', emoji_id: '笑' });
  eq(calls.at(-1)[1].message_id, '888', 'hands: 省略 message_id 时用当前会话最近一条');

  // 拦截层出错不能挡消息（这里只验证「不抛出去」）
  const fragile = createHands({
    cfg: { enabled: true, adminUsers: ['100000001'] },
    stats: {},
    log: () => {},
    getReceiver: () => ({}),
    adminUsers: () => { throw new Error('读配置炸了'); },
    patchMethod: null,
  });
  // 这里只验证「不抛出去」，用脆弱实例自己的拦截层
  ok(typeof fragile.snapshot().admins !== 'undefined', 'hands: adminUsers 抛错时 snapshot 不炸');

  // 总开关
  const closed = createHands({
    cfg: { enabled: false }, stats: {}, log: () => {}, getReceiver: () => fakeBridge,
    adminUsers: () => ['100000001'], patchMethod: null,
  });
  threw = false;
  try {
    await closed.poke({ user_id: '1' });
  } catch {
    threw = true;
  }
  ok(threw, 'hands: enabled:false 时 poke 被拒');
}

// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
section('intimate 亲密关系（oidb 私有协议）');
{
  eq(resolveIntimateType('lover'), 1, 'intimate: lover → 1');
  eq(resolveIntimateType('闺蜜'), 2, 'intimate: 中文别名「闺蜜」→ 2');
  eq(resolveIntimateType('BESTFRIEND'), 26, 'intimate: 大小写不敏感');
  eq(resolveIntimateType(3), 3, 'intimate: 数字直接过');
  eq(resolveIntimateType(undefined), 1, 'intimate: 不传默认情侣');
  eq(resolveIntimateType('乱写'), null, 'intimate: 认不出返回 null');

  eq(TYPE_NAMES[26], '死党', 'intimate: 26 是死党不是情侣');
  ok(describeIntimateError(10007).includes('还不是好友'), 'intimate: 10007 说清要先加好友');
  ok(describeIntimateError(10006).includes('已经绑定'), 'intimate: 10006 说清已绑定');
  eq(describeIntimateError(0), '', 'intimate: 0 不是错误');

  // 邀请解析：真实返回形状是 lst_invite
  const inv = normalizeInvites({ lst_invite: [{ frd_uin: 100000001, intimate_type: 1, time: 1792400000000 }] });
  eq(inv.length, 1, 'intimate: 从 lst_invite 解出一条邀请');
  eq(inv[0].userId, '100000001', 'intimate: 邀请带对方号');
  eq(inv[0].typeName, '情侣', 'intimate: 邀请带类型名');
  eq(normalizeInvites({}), [], 'intimate: 没字段就是空数组（不抛）');
  eq(normalizeInvites(null), [], 'intimate: null 也不抛');

  // 已绑定解析：intimate_list 里是 lover/ladybro/buddy/bestfriend 布尔标记
  const bonds = normalizeBonds({ intimate_list: [{ frd_uin: 111, lover: true }, { frd_uin: 222, bestfriend: true }, { frd_uin: '' }] });
  eq(bonds.length, 2, 'intimate: 空 uin 的条目丢掉');
  eq(bonds[0].typeName, '情侣', 'intimate: lover 标记 → 情侣');
  eq(bonds[1].typeName, '死党', 'intimate: bestfriend 标记 → 死党');

  // ── 真的打一遍：把 fetch 与 get_cookies 都换成假的 ──────────────────────
  const seen = [];
  const calls = [];
  const fakeCallAction = async (action, params) => {
    calls.push([action, params]);
    if (action === 'get_cookies') return { cookies: 'uin=o100000002; skey=@FAKE', bkn: '123456' };
    if (action === 'get_login_info') return { user_id: 100000002, nickname: '云玥' };
    throw new Error(`意外的 action: ${action}`);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    if (url.includes('getPairState')) {
      return new Response(JSON.stringify({ data: { lst_invite: [{ frd_uin: 100000001, intimate_type: 1, time: 1 }], is_qqfriend: true } }), { status: 200 });
    }
    if (url.includes('oidb_0xd00_1')) {
      return new Response(JSON.stringify({ ErrorCode: 0, intimate_list: [{ frd_uin: 100000001, lover: true }] }), { status: 200 });
    }
    if (url.includes('oidb_0xcf3_1')) {
      return new Response(JSON.stringify({ ErrorCode: 0 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  try {
    const it = createIntimate({ callAction: fakeCallAction, cfg: {}, stats: {} });
    const listed = await it.list();
    eq(listed.invites.length, 1, 'intimate: list 通过 getPairState 拿到邀请');
    eq(listed.bonds.length, 1, 'intimate: list 通过 oidb_0xd00_1 拿到已绑定');
    eq(listed.errors.length, 0, 'intimate: 一次成功不该有 errors');
    ok(calls.some(([a]) => a === 'get_cookies'), 'intimate: 登录态走 get_cookies');
    ok(seen[0].url.includes('bkn=123456'), 'intimate: bkn 挂在 query 上');
    ok(String(seen[0].init.headers.Cookie).includes('skey=@FAKE'), 'intimate: cookie 头带上了她自己的登录态');
    eq(seen[0].init.method, 'POST', 'intimate: 用 POST');

    // 接受：sub_cmd=1，target_uin 是数字
    const acc = await it.respond('100000001', 1, 'accept');
    eq(acc.ok, true, 'intimate: accept 返回 ok');
    eq(acc.typeName, '情侣', 'intimate: accept 回报类型名');
    const cf3 = seen.filter((s) => s.url.includes('oidb_0xcf3_1')).at(-1);
    eq(JSON.parse(cf3.init.body).sub_cmd, 1, 'intimate: accept 用 sub_cmd=1');
    eq(JSON.parse(cf3.init.body).target_uin, 100000001, 'intimate: target_uin 是数字');
    eq(JSON.parse(cf3.init.body).intimate_type, 1, 'intimate: intimate_type 透传');

    // 发起用 sub_cmd=0，解绑用 sub_cmd=2
    await it.respond('100000001', 1, 'launch');
    eq(JSON.parse(seen.filter((s) => s.url.includes('oidb_0xcf3_1')).at(-1).init.body).sub_cmd, 0, 'intimate: launch 用 sub_cmd=0');
    await it.respond('100000001', 1, 'release');
    eq(JSON.parse(seen.filter((s) => s.url.includes('oidb_0xcf3_1')).at(-1).init.body).sub_cmd, 2, 'intimate: release 用 sub_cmd=2');

    // 10006 = 已经绑上了，对接受来说算成功
    globalThis.fetch = async (url) => {
      if (url.includes('oidb_0xcf3_1')) return new Response(JSON.stringify({ ErrorCode: 10006 }), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    const again = await it.respond('100000001', 1, 'accept');
    eq(again.ok, true, 'intimate: 10006 当成成功（已经绑上了）');
    eq(again.already, true, 'intimate: 10006 标记 already');

    // 真错误要抛，且是人话
    globalThis.fetch = async (url) => {
      if (url.includes('oidb_0xcf3_1')) return new Response(JSON.stringify({ ErrorCode: 10007 }), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    let threw = false;
    try {
      await it.respond('100000001', 1, 'accept');
    } catch (error) {
      threw = String(error.message).includes('还不是好友');
    }
    ok(threw, 'intimate: 10007 抛人话错误');

    // 号不对要早退，不发请求
    threw = false;
    try {
      await it.respond('abc', 1);
    } catch {
      threw = true;
    }
    ok(threw, 'intimate: 对方号不是数字要报错');

    // 关掉子能力就彻底不联网
    const off = createIntimate({ callAction: fakeCallAction, cfg: { enabled: false }, stats: {} });
    threw = false;
    try {
      await off.list();
    } catch (error) {
      threw = String(error.message).includes('已关闭');
    }
    ok(threw, 'intimate: enabled=false 时 list 直接拒绝');
  } finally {
    globalThis.fetch = realFetch;
  }
}

section('lastword 最后开口');

{
  // 纯函数：segments → 文本
  eq(textOfSegments([{ type: 'text', data: { text: '你好' } }, { type: 'image', data: {} }]), '你好', 'lastword: 只取 text 段');
  eq(textOfSegments([{ type: 'text', data: { text: 'a' } }, { type: 'text', data: { text: 'b' } }]), 'ab', 'lastword: 多段拼接');
  eq(textOfSegments([]), '', 'lastword: 空数组给空串');
  eq(textOfSegments(null), '', 'lastword: 非数组给空串');
  eq(textOfSegments([{ type: 'image' }]), '', 'lastword: 没有 text 段给空串');

  // 纯函数：人话时间
  eq(humanAgo(null), '还没说过话', 'lastword: 没说过话');
  eq(humanAgo(0, 30_000), '刚刚', 'lastword: 半分钟内算刚刚');
  eq(humanAgo(0, 5 * 60_000), '5 分钟前', 'lastword: 分钟');
  eq(humanAgo(0, 3 * 3600_000), '3 小时前', 'lastword: 小时');
  eq(humanAgo(0, 2 * 86400_000), '2 天前', 'lastword: 天');
  eq(humanAgo(5000, 1000), '刚刚', 'lastword: 未来时间也不崩');

  // note()：空消息不记
  {
    const stats = {};
    const counter = createLastWord({ cfg: { enabled: true }, stats, patchMethod: () => true, log: () => undefined });
    counter.note('private:1', '', 'sendToChat');
    counter.note('private:1', '   \n ', 'sendToChat');
    eq(stats.lastWordAt, undefined, 'lastword: 空消息不记时间');
    eq(stats.lastWordCount, undefined, 'lastword: 空消息不计数');

    counter.note('private:1', '第一句', 'sendToChat');
    eq(stats.lastWordCount, 1, 'lastword: 正常消息计数 +1');
    eq(stats.lastWordText, '第一句', 'lastword: 记下正文');

    // 同一条消息经 sendToChat → sendMsg 两层：不该算两条
    counter.note('private:1', '第一句', 'sendMsg');
    eq(stats.lastWordCount, 1, 'lastword: 同一句在两层里经过只算一次');
    eq(stats.lastWordVia, 'sendToChat', 'lastword: 里层不覆盖 via');

    counter.note('private:1', '第二句', 'sendToChat');
    eq(stats.lastWordCount, 2, 'lastword: 换了正文就照常计数');

    // 换会话即换了人说话，不该合并
    counter.note('group:9', '第二句', 'sendToChat');
    eq(stats.lastWordCount, 3, 'lastword: 不同会话不合并');

    // recent 只留最近的，且新的在前
    for (let i = 0; i < 30; i += 1) counter.note('private:1', `第 ${i} 句`, 'sendToChat');
    const snap = counter.snapshot();
    ok(snap.recent.length <= 20, 'lastword: recent 有上限');
    eq(snap.recent[0].text, '第 29 句', 'lastword: recent 新的在前');
    eq(snap.ago, '刚刚', 'lastword: 刚说过话的 ago');

    // suspended 期间不写
    const before = stats.lastWordCount;
    counter.ctl.suspended = true;
    counter.note('private:1', '不该被记的一句', 'sendToChat');
    eq(stats.lastWordCount, before, 'lastword: suspended 期间不写统计');
    counter.ctl.suspended = false;

    // —— 重启恢复：存量从盘上灌回来（体检表主指标不该跟着进程归零）——
    const revived = createLastWord({ cfg: { enabled: true }, stats: {}, patchMethod: () => true, log: () => undefined });
    revived.restore({
      lastAt: 1_700_000_000_000,
      lastChat: 'private:100000001',
      lastText: '我去睡了',
      lastVia: 'sendToChat',
      total: 42,
      recent: [{ at: 1_700_000_000_000, chat: 'private:100000001', text: '我去睡了' }],
    });
    const back = revived.snapshot();
    eq(back.lastAt, 1_700_000_000_000, 'lastword: restore 灌回时间');
    eq(back.lastChat, 'private:100000001', 'lastword: restore 灌回会话');
    eq(back.lastText, '我去睡了', 'lastword: restore 灌回正文');
    eq(back.total, 42, 'lastword: restore 灌回累计条数');
    eq(back.recent.length, 1, 'lastword: restore 灌回 recent');

    // 坏数据不该让恢复整体失败（手改过的 state.json 很常见）
    const dirty = createLastWord({ cfg: { enabled: true }, stats: {}, patchMethod: () => true, log: () => undefined });
    dirty.restore({ lastAt: 'yesterday', total: 'lots', recent: [null, 1, { at: 5 }] });
    const dsnap = dirty.snapshot();
    eq(dsnap.lastAt, null, 'lastword: restore 忽略非数字时间');
    eq(dsnap.total, 0, 'lastword: restore 忽略非数字条数');
    eq(dsnap.recent.length, 1, 'lastword: restore 只留形状对的 recent');

    // 完全没存过 / 传 null：什么都不做，也不抛
    const nobody = createLastWord({ cfg: { enabled: true }, stats: {}, patchMethod: () => true, log: () => undefined });
    nobody.restore(null);
    nobody.restore(undefined);
    eq(nobody.snapshot().lastAt, null, 'lastword: restore 传空时保持原样');
  }

  // enabled=false 时不挂
  {
    const stats = {};
    const off = createLastWord({
      cfg: { enabled: false, packageName: 'x' },
      stats,
      patchMethod: () => {
        throw new Error('不该被调用');
      },
      log: () => undefined,
    });
    const r = await off.scan({});
    eq(r.ok, true, 'lastword: enabled=false 时 scan 直接成功');
    eq(r.patched, 0, 'lastword: enabled=false 时一个方法都不挂');
  }
}

section('physical 体检表数据面');

{
  eq(agoText(null, 1000), '—', 'physical: 没有时间给破折号');
  eq(agoText(0, 30_000), '刚刚', 'physical: 半分钟内');
  eq(agoText(0, 5 * 60_000), '5 分钟前', 'physical: 分钟');
  eq(agoText(0, 3 * 3600_000), '3 小时前', 'physical: 小时');
  eq(agoText(0, 2 * 86400_000), '2 天前', 'physical: 天');
  eq(agoText(9_000, 1000), '刚刚', 'physical: 未来时间不崩');
  ok(startOfDay(1_700_000_000_000) <= 1_700_000_000_000, 'physical: startOfDay 不晚于当前');
  eq(new Date(startOfDay(1_700_000_000_000)).getHours(), 0, 'physical: startOfDay 落在 0 点');

  // 空输入也得能出形状（面板不能因为一个模块没数据就白屏）
  const empty = buildPhysicalAt({}, 1_700_000_000_000);
  eq(empty.ok, undefined, 'physical: 不自己造 ok 字段（由端点包）');
  eq(empty.alive.lastWordAgo, '—', 'physical: 没 lastword 时给破折号');
  eq(empty.chats.length, 0, 'physical: 没会话时是空数组');
  eq(empty.diary.total, 0, 'physical: 日记缺省 0');
  eq(empty.promise.open, 0, 'physical: 约定缺省 0');
  eq(empty.errors.lost, 0, 'physical: 掉链缺省 0');

  // 有数据时逐项对得上
  const full = buildPhysicalAt(
    {
      stats: { lastError: 'boom', lost: [{}, {}], lastHitKind: 'stripped' },
      cfg: { enabled: true },
      moods: {
        'private:1': { moodLabel: '开心', energy: 80, affinity: 60, warmth: 70, quietMs: 5 * 60_000 },
        'group:2': { moodLabel: '累了', energy: 20, affinity: 8, warmth: 30, quietMs: 3 * 3600_000 },
      },
      diary: { enabled: true, total: 4, byLevel: { normal: 2, important: 1, critical: 1 } },
      promise: { enabled: true, open: 2, due: 1, done: 3 },
      lastword: { lastAt: 1_699_999_000_000, ago: '2 小时前', lastText: '我在呢', lastChat: 'private:1', total: 42 },
      diaryRecent: [{ level: 'normal', text: '他今天很累' }],
      promiseOpen: [{ text: '帮他查那个番' }],
      tierOf: (a) => ({ id: a > 50 ? 'close' : 'acquaintance', label: a > 50 ? '挺亲的' : '有点熟了', toNext: 5 }),
      patches: [{ moduleId: 'guard', method: 'sendToChat', patched: true }],
      connected: true,
    },
    1_700_000_000_000,
  );
  eq(full.alive.lastWordText, '我在呢', 'physical: 带出最后一句正文');
  eq(full.alive.saidTotal, 42, 'physical: 带出累计发言数');
  eq(full.link.connected, true, 'physical: 连接状态照传');
  eq(full.chats.length, 2, 'physical: 两个会话都投影出来');
  eq(full.chats[0].tier, '挺亲的', 'physical: 亲密度 60 映射到「挺亲的」');
  eq(full.chats[0].quiet, '5 分钟前', 'physical: quietMs 转成人话');
  eq(full.chats[1].tierId, 'acquaintance', 'physical: 亲密度 8 是「有点熟了」');
  eq(full.errors.last, 'boom', 'physical: 带出最后一条错');
  eq(full.errors.lost, 2, 'physical: 掉链计数');
  eq(full.diary.recent.length, 1, 'physical: 带出最近日记');
  eq(full.promise.items.length, 1, 'physical: 带出未兑现约定');
  eq(full.patches.length, 1, 'physical: 带出挂载记录');

  // connected 缺省是 null（不知道 ≠ 断了）
  const unk = buildPhysicalAt({}, 1);
  eq(unk.link.connected, null, 'physical: 连接状态未知时是 null 不是 false');

  // tierOf 抛错也不能让整张表挂掉
  const boom = buildPhysicalAt(
    { moods: { 'private:1': { affinity: 10 } }, tierOf: () => { throw new Error('x'); } },
    1,
  );
  eq(boom.chats[0].tier, null, 'physical: tierOf 抛错时该项为 null，其余照出');

  // ── 分层之后（2026-10-20）：精力全局一份、亲密度按账号 ──────────────────
  // 用户点出来的坑：三个会话并排显示三个一样的精力值 73，看着像各有一份电量。
  const layered = buildPhysicalAt(
    {
      moods: {
        'private:1': { moodLabel: '开心', energy: 73, affinity: 53, warmth: 30, quietMs: 0 },
        'group:2': { moodLabel: '安静', energy: 73, affinity: 4, warmth: 35, quietMs: 0 },
      },
      body: { energy: 73.4, lastDriftAt: 1_699_999_400_000 },
      people: [
        { key: 'u:1', label: '1', affinity: 53.4, lastContactAt: 1_699_999_000_000, chatIds: ['private:1'] },
        { key: 'u:9', label: '9', affinity: 4, lastContactAt: 0, chatIds: [] },
      ],
      tierOf: (a) => ({ id: a > 50 ? 'close' : 'new', label: a > 50 ? '挺亲的' : '还不熟', toNext: 5 }),
    },
    1_700_000_000_000,
  );
  eq(layered.body.energy, 73.4, 'physical: 全局精力取 body 记录，不是某个会话的');
  eq(layered.body.driftAgo, '10 分钟前', 'physical: body 的结算时间转成人话');
  eq(layered.people.length, 2, 'physical: 认识的人按账号列出来');
  eq(layered.people[0].key, 'u:1', 'physical: people 按亲密度降序，第一个是最亲的');
  eq(layered.people[0].tier, '挺亲的', 'physical: people 也映射关系阶段');
  eq(layered.people[0].lastSeenAgo, '16 分钟前', 'physical: people 带上次说话');
  eq(layered.people[1].lastSeenAgo, '—', 'physical: 从没说过话的人给破折号');
  eq(layered.people[0].chatIds.join(','), 'private:1', 'physical: people 带出在哪见过');
  // 两个会话的 energy 还是同一个数（合成值，与提示词看到的一致），
  // 但表上不再重复显示 —— 这是「数据保留、展示分层」的约定。
  eq(layered.chats[0].energy, layered.chats[1].energy, 'physical: chats 里的 energy 仍是合成值');

  // 没有 body 记录时（分层改造前的老数据）退回第一个会话的合成值，不能白屏
  const noBody = buildPhysicalAt(
    { moods: { 'private:1': { energy: 61, affinity: 10 } } },
    1,
  );
  eq(noBody.body.energy, 61, 'physical: 缺 body 记录时退回会话合成值');
  eq(noBody.body.driftAgo, null, 'physical: 没有结算时间就给 null，不编');
  eq(noBody.people.length, 0, 'physical: 没有 people 时是空数组');

  // people 里坏一条不能带塌整块
  const badPeople = buildPhysicalAt(
    { people: [{ key: 'u:1', affinity: 30 }], tierOf: () => { throw new Error('x'); } },
    1,
  );
  eq(badPeople.people[0].tier, null, 'physical: people 的 tierOf 抛错时该项 null');

  // `g:` 键是「群里沟通过但没认出是谁」的兜底，不是人，不能混进 people 表
  const mixed = buildPhysicalAt(
    {
      people: [
        { key: 'g:900000002', label: '群 900000002', affinity: 100 },
        { key: 'u:100000001', label: '100000001', affinity: 53.39 },
      ],
      tierOf: () => ({ id: 'familiar', label: '熟了', toNext: 1.6105757777777825 }),
    },
    1,
  );
  eq(mixed.people.length, 1, 'physical: g: 键不进 people');
  eq(mixed.people[0].key, 'u:100000001', 'physical: people 里只留真实账号');
  eq(mixed.unnamed.length, 1, 'physical: g: 键单独归到 unnamed，不丢数据');
  eq(mixed.unnamed[0].affinity, 100, 'physical: unnamed 仍保留亲密度');
  eq(mixed.people[0].toNext, 1.6, 'physical: toNext 取一位小数');
}

section('stickers 表情包图库');

{
  // ── 纯函数 ────────────────────────────────────────────────────────────────
  const h1 = hashOf(Buffer.from('same bytes'));
  const h2 = hashOf(Buffer.from('same bytes'));
  const h3 = hashOf(Buffer.from('other bytes'));
  eq(h1, h2, 'stickers: 同一份内容 hash 相同（按内容去重的前提）');
  ok(h1 !== h3, 'stickers: 不同内容 hash 不同');
  eq(h1.length, 64, 'stickers: sha256 是 64 位 hex');
  eq(shortId(h1).length, 16, 'stickers: 短 id 取前 16 位');
  eq(shortId(undefined), '', 'stickers: 没有 hash 时短 id 是空串而不是崩');

  const e1 = makeEntry({ hash: h1, path: '/x/a.png', bytes: 100, at: 1000, chatId: 'group:1', userId: 'u1' });
  eq(e1.id, shortId(h1), 'stickers: makeEntry 的 id 来自 hash');
  eq(e1.status, 'active', 'stickers: 新条目默认 active');
  eq(e1.useCount, 0, 'stickers: 新条目没用过');
  ok(isEntryOk(e1), 'stickers: 新条目通过形状校验');
  ok(!isEntryOk({ id: '' }), 'stickers: 缺 id 的条目被拒');
  ok(!isEntryOk(null), 'stickers: null 被拒');
  ok(!isEntryOk({ id: 'a', path: '', at: 1 }), 'stickers: 缺 path 被拒');

  // note 写清楚之后，describeEntry 得能给她看
  const described = describeEntry({ ...e1, note: '得意的猫', useCount: 3 });
  ok(described.includes('得意的猫'), 'stickers: describeEntry 带上备注');
  ok(described.includes('用过 3 次'), 'stickers: describeEntry 带上使用次数');
  ok(described.includes('/x/a.png'), 'stickers: describeEntry 末尾是路径');

  // ── pickStickers：过滤 + 排序 ─────────────────────────────────────────────
  const now = 10_000_000;
  const pool = [
    makeEntry({ hash: 'a'.repeat(64), path: '/x/1.png', bytes: 1, at: 100, chatId: 'group:1', userId: 'u1' }),
    makeEntry({ hash: 'b'.repeat(64), path: '/x/2.png', bytes: 1, at: 200, chatId: 'group:1', userId: 'u2' }),
    makeEntry({ hash: 'c'.repeat(64), path: '/x/3.png', bytes: 1, at: 300, chatId: 'private:9', userId: 'u1' }),
  ];
  pool[0].note = '开心的猫';
  pool[2].status = 'recycled';
  eq(pickStickers(pool).length, 2, 'stickers: 默认不返回回收站条目');
  eq(pickStickers(pool, { includeRecycled: true }).length, 3, 'stickers: includeRecycled 能翻到回收站');
  eq(pickStickers(pool, { text: '开心' }).length, 1, 'stickers: 按备注搜得到');
  eq(pickStickers(pool, { text: '开心' })[0].path, '/x/1.png', 'stickers: 搜到的正是那张');
  eq(pickStickers(pool, { text: '不存在的词' }).length, 0, 'stickers: 搜不到就是空');
  eq(pickStickers(pool, { userId: 'u1' }).length, 1, 'stickers: 按发送者过滤（回收站那条不算）');
  eq(pickStickers(pool, { chatId: 'group:1' }).length, 2, 'stickers: 按会话过滤');
  eq(pickStickers(pool, { limit: 1 }).length, 1, 'stickers: limit 生效');

  // 排序：刚发过的往后排，免得每次都推同一张
  const frequent = makeEntry({ hash: 'd'.repeat(64), path: '/x/f.png', bytes: 1, at: 500 });
  frequent.useCount = 5;
  frequent.lastUsedAt = 0;
  const justUsed = makeEntry({ hash: 'e'.repeat(64), path: '/x/j.png', bytes: 1, at: 600 });
  justUsed.useCount = 5;
  justUsed.lastUsedAt = now - 1000; // 一秒前刚用过
  const ranked = pickStickers([frequent, justUsed], { now });
  eq(ranked[0].path, '/x/f.png', 'stickers: 同样常用的两张，刚发过的排后面');

  // ── pruneStickers：淘汰顺序 ───────────────────────────────────────────────
  const many = [];
  for (let i = 0; i < 6; i += 1) {
    many.push(makeEntry({ hash: String(i).repeat(64), path: `/x/${i}.png`, bytes: 1, at: i }));
  }
  many[0].status = 'recycled';   // 最该扔
  many[1].useCount = 3;          // 用过，尽量留
  many[1].lastUsedAt = 900;
  const kept = pruneStickers(many, { maxEntries: 3 });
  eq(kept.length, 3, 'stickers: 超容量时砍到上限');
  ok(!kept.some((e) => e.id === many[0].id), 'stickers: 回收站最先被淘汰');
  ok(kept.some((e) => e.id === many[1].id), 'stickers: 用过的条目优先保留');
  ok(pruneStickers(many, { maxEntries: 100 }).length === 6, 'stickers: 没超容量就原样留下');
  ok(pruneStickers(null, { maxEntries: 3 }).length === 0, 'stickers: 坏输入不崩');

  // ── 实例：真落盘、真去重 ──────────────────────────────────────────────────
  const mediaDir = mkdtempSync(join(tmpdir(), 'companion-sticker-'));
  const stats = {};
  const cfg = {
    enabled: true,
    dir: 'stickers',
    stateFile: 'stickers-state.json',
    maxEntries: 4,
    minBytes: 4,
    maxBytes: 1_000_000,
  };
  const lib = createStickerLib({ cfg, stats, log: () => {}, resolveMediaDir: () => mediaDir });

  const srcA = join(mediaDir, 'in-a.png');
  const srcB = join(mediaDir, 'in-b.png');
  const tiny = join(mediaDir, 'tiny.png');
  writeFileSync(srcA, Buffer.from('AAAA-sticker-bytes'));
  writeFileSync(srcB, Buffer.from('BBBB-sticker-bytes'));
  writeFileSync(tiny, Buffer.from('x')); // 小于 minBytes

  const gotA = await lib.ingest({ path: srcA, chatId: 'group:1', userId: 'u1', now: 1000 });
  ok(gotA !== null, 'stickers: 第一张能入库');
  ok(gotA.path.startsWith(join(mediaDir, 'stickers')), 'stickers: 图落在 mediaDir/stickers 下');
  ok(existsSync(gotA.path), 'stickers: 图库里的文件真的存在');

  const again = await lib.ingest({ path: srcA, chatId: 'group:1', userId: 'u1', now: 2000 });
  eq(again.id, gotA.id, 'stickers: 同一张图再收一次还是同一条（按 hash 去重）');
  eq(lib.snapshot().count, 1, 'stickers: 去重后表里只有一条');

  const skipped = await lib.ingest({ path: tiny, now: 3000 });
  eq(skipped, null, 'stickers: 太小的图直接跳过');
  eq(await lib.ingest({ path: join(mediaDir, '不存在.png'), now: 3000 }), null, 'stickers: 文件不存在不崩，返回 null');

  const gotB = await lib.ingest({ path: srcB, chatId: 'private:9', userId: 'u9', now: 4000 });
  ok(gotB !== null, 'stickers: 第二张也能入库');
  eq(lib.snapshot().count, 2, 'stickers: 两张不同的图就是两条');

  // 打标签 → 搜索 → 记使用
  const tagged = await lib.update(gotA.id, { note: '得意的猫' });
  eq(tagged.note, '得意的猫', 'stickers: note 写得进去');
  const found = await lib.list({ text: '得意', now: 5000 });
  eq(found.length, 1, 'stickers: 打完标签就能搜到');
  eq(found[0].id, gotA.id, 'stickers: 搜到的就是那张');
  await lib.update(gotA.id, { markUsed: true, now: 6000 });
  eq((await lib.list({ text: '得意', now: 7000 }))[0].useCount, 1, 'stickers: use 记一次使用');
  await lib.update(gotA.id, { status: 'recycled' });
  eq((await lib.list({ text: '得意', now: 8000 })).length, 0, 'stickers: recycle 之后搜索不到');
  eq(lib.snapshot().recycled, 1, 'stickers: snapshot 数得出回收站条数');
  eq(await lib.update('不存在的id', { note: 'x' }), null, 'stickers: 改不存在的 id 返回 null');

  // 图被外部删掉：list 要跳过，而不是给一个假路径
  rmSync(gotA.path, { force: true });
  const afterDelete = await lib.list({ now: 9000 });
  ok(!afterDelete.some((e) => e.id === gotA.id), 'stickers: 文件没了就不列出来');

  // 关掉开关：不入库，也不炸
  const off = createStickerLib({ cfg: { ...cfg, enabled: false }, stats: {}, log: () => {}, resolveMediaDir: () => mediaDir });
  eq(await off.ingest({ path: srcB, now: 10_000 }), null, 'stickers: 关掉之后 ingest 直接返回 null');

  // mediaDir 为空：整个模块静默失效，不抛
  const noDir = createStickerLib({ cfg, stats: {}, log: () => {}, resolveMediaDir: () => '' });
  eq(await noDir.ingest({ path: srcB, now: 11_000 }), null, 'stickers: 没配 mediaDir 时静默不干活');

  rmSync(mediaDir, { recursive: true, force: true });
}


// ── api 对外接口 ────────────────────────────────────────────────────────────
{
  section('api 对外接口');

  eq(SERVICE_NAME, 'onebotCompanion', 'api: 服务名固定');
  ok(Number.isInteger(API_VERSION) && API_VERSION >= 1, 'api: 版本号是正整数');

  // 通道没就绪时：say / sendSegments 抛明确错误，而不是 undefined 挂掉
  const bare = createApi({
    name: 'dsh-onebot-companion',
    cfg: { persona: { enabled: true } },
    stats: { startedAt: 1, generations: 2, tools: ['qq_say'] },
    log: () => {},
    mediaDir: () => 'D:/tmp/media',
    receiver: () => undefined,
    chatIdOfSession: () => null,
    patchMethod: null,
    onPreStep: null,
  });

  eq(bare.plugin, 'dsh-onebot-companion', 'api: 报自己的名字');
  eq(bare.version, API_VERSION, 'api: 版本与常量一致');
  eq(Object.isFrozen(bare), true, 'api: 整个对象冻结（外部改不动契约）');

  let sayErr = null;
  try {
    await bare.say('private:1', 'hi');
  } catch (error) {
    sayErr = String(error?.message ?? error);
  }
  ok(sayErr !== null && sayErr.includes('尚未就绪'), 'api: 通道没就绪时 say 抛出人话错误');

  let segErr = null;
  try {
    await bare.sendSegments('private:1', []);
  } catch (error) {
    segErr = String(error?.message ?? error);
  }
  ok(segErr !== null && segErr.includes('尚未就绪'), 'api: 通道没就绪时 sendSegments 同样抛');

  eq(bare.moodOf('private:1'), null, 'api: 没有 persona 时 moodOf 给 null 而不是抛');
  eq(bare.lastInbound('private:1'), null, 'api: 没有 hands 时 lastInbound 给 null');
  eq(bare.lastSpoke(), null, 'api: 没有 lastword 时 lastSpoke 给 null');
  eq(bare.chatIdOfSession('session-abc'), null, 'api: 认不出的会话 id 给 null');

  const h = bare.health();
  eq(h.ok, false, 'api: 没通道时 health.ok 是 false');
  eq(h.channel, 'not-ready', 'api: health 报 not-ready');
  eq(h.mediaDir, 'D:/tmp/media', 'api: health 带上媒体目录');
  eq(h.toolCount, 1, 'api: health 带上工具数量');

  eq(bare.config().persona.enabled, true, 'api: 不传参数拿整份配置');
  eq(bare.config('persona').enabled, true, 'api: 传段落名拿那一段');
  eq(bare.config('nope'), null, 'api: 不存在的段落给 null');

  eq(Array.isArray(bare.phoneSources()), true, 'api: 没给来源表时 phoneSources 是空数组');

  // 通道装好之后：say 真的走 bridge.sendToChat
  const sent = [];
  const live = createApi({
    name: 'dsh-onebot-companion',
    cfg: {},
    stats: {},
    log: () => {},
    mediaDir: () => '',
    receiver: () => ({
      sendToChat: async (chatId, text) => {
        sent.push([chatId, text]);
        return { message_id: 42 };
      },
      sendSegments: async (chatId, segs) => {
        sent.push([chatId, segs.length]);
        return { message_id: 43 };
      },
    }),
    chatIdOfSession: (sid) => (String(sid).startsWith('onebot-private-') ? 'private:100000001' : null),
    patchMethod: null,
    onPreStep: null,
  });

  const r1 = await live.say('private:100000001', '在呢');
  eq(r1.message_id, 42, 'api: say 把返回值原样交回去');
  eq(sent[0][1], '在呢', 'api: say 真的发到了 bridge');
  await live.sendSegments('group:1', [{}, {}]);
  eq(sent[1][1], 2, 'api: sendSegments 把段数组原样交出去');
  eq(live.chatIdOfSession('onebot-private-100000001-x'), 'private:100000001', 'api: 会话 id 反推出 chatId');
  eq(live.health().ok, true, 'api: 通道在时 health.ok 是 true');

  // onPreStep：订阅、广播、取消订阅
  const heard = [];
  const listeners = new Set();
  const withHooks = createApi({
    name: 'x',
    cfg: {},
    stats: {},
    log: () => {},
    mediaDir: () => '',
    receiver: () => undefined,
    chatIdOfSession: () => null,
    patchMethod: null,
    onPreStep: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
  const off = withHooks.onPreStep((p) => heard.push(p?.step));
  eq(listeners.size, 1, 'api: onPreStep 把监听器交给本插件');
  for (const fn of listeners) fn({ step: 1 });
  eq(heard.length, 1, 'api: 广播能到订阅者手上');
  off();
  eq(listeners.size, 0, 'api: 返回的函数能取消订阅');
  eq(typeof withHooks.onPreStep(null), 'function', 'api: 传非函数给一个空取消函数而不是抛');
}

section('focus 注意力');

{
  const T = 1_700_000_000_000;

  // ── normalizeFocus ────────────────────────────────────────────────────────
  eq(normalizeFocus({ what: 'browse', detail: 'B 站热门' }, T)?.what, 'browse', 'focus: 认得 browse');
  eq(normalizeFocus({ what: 'browse', detail: '  B 站热门  ' }, T)?.detail, 'B 站热门', 'focus: detail 去空白');
  eq(normalizeFocus({ what: 'nope' }, T), null, 'focus: 不认识的活动返回 null');
  eq(normalizeFocus(null, T), null, 'focus: null 输入返回 null');
  eq(normalizeFocus({ what: 'game', at: 123 }, T)?.at, 123, 'focus: 给了 at 就用给的');
  eq(normalizeFocus({ what: 'game' }, T)?.at, T, 'focus: 没给 at 用现在');
  eq(normalizeFocus({ what: 'watch', detail: 'x'.repeat(80) }, T)?.detail.length, 40, 'focus: detail 截到 40 字');
  eq(normalizeFocus({ what: 'music' }, T)?.detail, '', 'focus: 没 detail 时是空串而不是 undefined');

  // ── isFresh ───────────────────────────────────────────────────────────────
  const f = { what: 'game', detail: '', at: T };
  ok(isFocusFresh(f, T + 1000), 'focus: 刚记的算新鲜');
  ok(isFocusFresh(f, T + 19 * 60 * 1000), 'focus: 19 分钟还算新鲜');
  ok(!isFocusFresh(f, T + 21 * 60 * 1000), 'focus: 21 分钟就过期');
  ok(!isFocusFresh(null, T), 'focus: null 不算新鲜');
  ok(!isFocusFresh({ what: 'game', at: 'x' }, T), 'focus: at 不是数字不算新鲜');
  ok(!isFocusFresh({ what: 'game', at: T }, T + 5000, { ttlMs: 1000 }), 'focus: ttl 可调');

  // ── focusPromptLine ──────────────────────────────────────────────────────
  const line = focusPromptLine({ what: 'browse', detail: 'B 站热门', at: T }, T + 5 * 60 * 1000);
  ok(typeof line === 'string' && line.includes('在刷'), 'focus: 注入行带上活动');
  ok(line.includes('B 站热门'), 'focus: 注入行带上具体内容');
  ok(line.includes('5 分钟'), 'focus: 注入行带上分钟数');
  ok(!line.includes('{') && !line.includes('}'), 'focus: 注入行不含花括号');
  eq(focusPromptLine({ what: 'game', at: T }, T + 21 * 60 * 1000), null, 'focus: 过期了不注入');
  eq(focusPromptLine(null, T), null, 'focus: 没在忙时是 null');
  eq(focusPromptLine({ what: 'browse', at: T }, T, { enabled: false }), null, 'focus: 关掉就不注入');
  ok(focusPromptLine({ what: 'browse', at: T }, T + 60000, { maxChars: 20 }).length <= 20, 'focus: 超长会截断');
  ok(focusPromptLine({ what: 'idle', at: T }, T + 60000).includes('在发呆'), 'focus: 没有 detail 也出句子');
}

// ── 独处 solitude ────────────────────────────────────────────────────────────
// 与 focus 是同一天（2026-10-21）加的两块，但方向相反：focus 说「我刚才在看别的」，
// 独处说「你不在这段时间我过了什么」。两者都只在真的成立时才注入，平时是 null。
section('solitude 独处');
{
  const T = 1_700_000_000_000;
  const MIN = 60_000;

  eq(humanSolitudeSpan(5 * MIN), '5 分钟', 'solitude: 分钟档');
  eq(humanSolitudeSpan(3 * 60 * MIN), '3 小时', 'solitude: 小时档');
  eq(humanSolitudeSpan(3 * 60 * MIN + 20 * MIN), '3 个多小时', 'solitude: 多小时档');
  eq(humanSolitudeSpan(30 * 60 * MIN), '一天', 'solitude: 一天档');
  eq(humanSolitudeSpan(-1), '', 'solitude: 负数给空串');

  eq(quietSince(T, T + 1000), 1000, 'solitude: 安静时长按毫秒算');
  eq(quietSince(0, T), null, 'solitude: 没有时间戳返回 null');
  eq(quietSince(T, T - 1000), 0, 'solitude: 时间倒流夹到 0');

  ok(!isSolitary(T, T + MIN), 'solitude: 刚说完话不算独处');
  ok(isSolitary(T, T + 26 * MIN), 'solitude: 26 分钟算独处');
  ok(!isSolitary(0, T), 'solitude: 没时间戳不算');
  ok(!isSolitary(T, T + 60 * MIN, { enabled: false }), 'solitude: 关掉不算');

  eq(pickThought({ gapMs: 30 * MIN, unsaidText: '算了' }).kind, 'unsaid', 'solitude: 有话说优先过一遍');
  eq(pickThought({ gapMs: 30 * MIN, unsaidText: '   ' }).kind, 'idle', 'solitude: 空白串不算有话说');
  eq(pickThought({ gapMs: 30 * MIN, mood: { energy: 10 } }).kind, 'doze', 'solitude: 没力气就打盹');
  eq(
    pickThought({ gapMs: 30 * MIN, entries: [{ text: '他说会回来', level: 'important', at: T }] }).kind,
    'diary',
    'solitude: 有本子就翻本子',
  );
  eq(pickThought({ gapMs: 20 * 3600 * 1000 }).kind, 'idle', 'solitude: 很久没见仍是发呆档');

  // 说法按小时轮换（2026-10-22）：一小时之内稳定，跨小时才允许换 ——
  // 真随机会让同一段独处在两轮注入里自相矛盾，那是在编。
  const sameHourA = pickThought({ gapMs: 30 * MIN, now: T });
  const sameHourB = pickThought({ gapMs: 30 * MIN, now: T + 20 * MIN });
  eq(sameHourA.text, sameHourB.text, 'solitude: 同一小时说法稳定');

  const variants = new Set();
  for (let h = 0; h < 24; h += 1) {
    variants.add(pickThought({ gapMs: 30 * MIN, now: T + h * 3600 * 1000 }).text);
  }
  ok(variants.size >= 3, 'solitude: 一天之内会换几种说法');

  // 深夜档（23 点到 6 点）措辞不同，但档位（kind）不变。
  const lateNight = pickThought({ gapMs: 30 * MIN, now: T + 10 * 3600 * 1000 });
  eq(lateNight.kind, 'idle', 'solitude: 深夜仍是发呆档');
  ok(typeof lateNight.text === 'string' && lateNight.text !== '', 'solitude: 深夜有说法');
  ok(!isLateHour(T + 10 * 3600 * 1000) || !isLateHour(T), 'solitude: 深夜判定不是恒真');

  // 有话说时，低落和开心该说得不一样 —— 同一句心声不该永远同一个措辞。
  const unsaidDown = pickThought({ gapMs: 30 * MIN, unsaidText: '算了', mood: { mood: 'down' }, now: T }).text;
  const unsaidCalm = pickThought({ gapMs: 30 * MIN, unsaidText: '算了', mood: { mood: 'calm' }, now: T }).text;
  ok(unsaidDown !== unsaidCalm, 'solitude: 心情不同说法不同');

  const line = solitudePromptLine({ lastAt: T, now: T + 40 * MIN });
  ok(typeof line === 'string' && line.includes('40 分钟'), 'solitude: 注入行带时长');
  ok(typeof line === 'string' && line.length > 20, 'solitude: 注入行带她在干什么');
  ok(!line.includes('{') && !line.includes('}'), 'solitude: 注入行不含花括号');
  ok(line.includes('是你自己的'), 'solitude: 收尾点明这段时间属于她');
  eq(solitudePromptLine({ lastAt: T, now: T + MIN }), null, 'solitude: 刚说完话不注入');
  eq(solitudePromptLine({ lastAt: T, now: T + 40 * MIN }, { enabled: false }), null, 'solitude: 关掉不注入');
  ok(
    solitudePromptLine({ lastAt: T, now: T + 40 * MIN }, { maxChars: 20 }).length <= 20,
    'solitude: 超长会截断',
  );
  ok(
    solitudePromptLine({ lastAt: T, now: T + 10 * 3600 * 1000 }).includes('之前了'),
    'solitude: 大半天用「之前了」',
  );

  // 群聊那种「不是跟他说话」的线，措辞要换掉（2026-10-22）。
  const groupLine = solitudePromptLine({ lastAt: T, now: T + 40 * MIN, samePerson: false });
  ok(groupLine.includes('在这条线上开口'), 'solitude: 群聊改说「在这条线上开口」');
  ok(!groupLine.includes('跟他说话'), 'solitude: 群聊不说「跟他说话」');
  ok(!groupLine.includes('没有他'), 'solitude: 群聊不说「没有他」');
  ok(
    solitudePromptLine({ lastAt: T, now: T + 40 * MIN, samePerson: true }).includes('跟他说话'),
    'solitude: 私聊仍说「跟他说话」',
  );

  // ownerChatOf：从「只对他主动」的名单反推他的私聊 id。
  eq(ownerChatOf(['100000001']), 'private:100000001', 'solitude: 纯号反推出私聊 id');
  eq(ownerChatOf(['private:100000001']), 'private:100000001', 'solitude: 带前缀也认');
  eq(ownerChatOf([]), '', 'solitude: 空名单推不出');
  eq(ownerChatOf(undefined), '', 'solitude: 非数组推不出');

  // 实例层：回调抛错不能连累注入链
  const broken = createSolitude({
    cfg: {},
    lastContactAt: () => {
      throw new Error('boom');
    },
  });
  eq(broken.promptLine(), null, 'solitude: 回调抛错返回 null 而不是崩');

  const okInst = createSolitude({ cfg: {}, lastContactAt: () => T - 40 * MIN });
  ok(typeof okInst.promptLine() === 'string', 'solitude: 实例能出注入行');
  ok(okInst.snapshot().gapMinutes >= 39, 'solitude: snapshot 有 gapMinutes');

  // chatId 要能传下去 —— 心情和「上次说话」都是按人记的
  let seenChat = null;
  const chatInst = createSolitude({
    cfg: {},
    lastContactAt: (chatId) => {
      seenChat = chatId;
      return T - 40 * MIN;
    },
  });
  chatInst.promptLine('private:100000001');
  eq(seenChat, 'private:100000001', 'solitude: chatId 会传到 lastContactAt');
}

section('temper 长期底色');
{
  const T = new Date(2026, 9, 21, 12, 0, 0).getTime();
  const D = 24 * 3600 * 1000;
  const mk = (i, over) => ({
    at: T - i * D,
    dayKey: temperDayKey(T - i * D),
    quietHours: 3,
    energy: 80,
    affinity: 50,
    rounds: 10,
    ...over,
  });

  eq(temperDayKey(T), '2026-10-21', 'temper: dayKey 是本地日期');
  eq(temperDayKey(Number.NaN), '', 'temper: 非法时间给空串');

  const one = temperRecordDay([], { quietHours: 3, rounds: 4 }, T);
  eq(one.length, 1, 'temper: 记下一天');
  eq(one[0].rounds, 4, 'temper: rounds 保留');
  const two = temperRecordDay(one, { quietHours: 9, rounds: 2 }, T + 3600_000);
  eq(two.length, 1, 'temper: 同一天不新增');
  eq(two[0].quietHours, 9, 'temper: 同一天取最大静默');
  eq(two[0].rounds, 6, 'temper: 同一天累加 rounds');
  eq(
    temperRecordDay(two, { quietHours: 1 }, T + 7200_000)[0].quietHours,
    9,
    'temper: 短静默不覆盖长静默',
  );
  eq(temperRecordDay(two, {}, T + D).length, 2, 'temper: 跨天新增');
  const many = [];
  for (let i = 0; i < 20; i += 1) many.push(mk(i));
  eq(temperRecordDay(many, {}, T, { windowDays: 14 }).length, 14, 'temper: 裁到窗口长度');
  eq(temperRecordDay(null, {}, T).length, 1, 'temper: 输入不是数组也不崩');

  eq(temperDeviation(temperBiasOf([])), 0, 'temper: 没数据不偏');
  eq(temperDeviation(temperBiasOf(null)), 0, 'temper: null 也不偏');

  const sunnyDays = [];
  for (let i = 0; i < 10; i += 1) sunnyDays.push(mk(i, { quietHours: 2, rounds: 20 }));
  const sunny = temperBiasOf(sunnyDays);
  ok(sunny.happy > 1, 'temper: 好好聊过 happy 上偏');
  ok(sunny.down < 1, 'temper: 好好聊过 down 下偏');

  const lonely = [];
  for (let i = 0; i < 10; i += 1) lonely.push(mk(i, { quietHours: 12, affinity: 70, rounds: 0 }));
  const sensitive = temperBiasOf(lonely);
  ok(sensitive.down > 1, 'temper: 被晾着 down 上偏');
  ok(sensitive.clingy > 1, 'temper: 被晾着 clingy 上偏');
  ok(sensitive.excited < 1, 'temper: 被晾着 excited 下偏');

  const shallow = [];
  for (let i = 0; i < 10; i += 1) shallow.push(mk(i, { quietHours: 12, affinity: 20, rounds: 0 }));
  const shy = temperBiasOf(shallow);
  ok(shy.down <= 1, 'temper: 关系浅被晾着不会敏感');
  ok(shy.clingy < 1, 'temper: 关系浅被晾着不敢黏');

  const drained = [];
  for (let i = 0; i < 10; i += 1) drained.push(mk(i, { energy: 12 }));
  ok(temperBiasOf(drained).tired > 1, 'temper: 长期没电 tired 上偏');

  const capped = temperBiasOf(lonely, { maxBias: 1.05, minBias: 0.95 });
  ok(
    Object.values(capped).every((v) => v <= 1.05 + 1e-9 && v >= 0.95 - 1e-9),
    'temper: 上下限夹住',
  );

  eq(temperPromptLine(temperBiasOf([])), null, 'temper: 平静不注入');
  const tline = temperPromptLine(sensitive);
  ok(typeof tline === 'string' && tline.includes('攒出来'), 'temper: 偏了才注入');
  ok(!tline.includes('{') && !tline.includes('}'), 'temper: 注入行无花括号');
  eq(temperPromptLine(sensitive, { enabled: false }), null, 'temper: 关掉不注入');
  ok(temperPromptLine(sensitive, { maxChars: 10 }).length <= 10, 'temper: 超长会截断');

  const inst = createTemper({ cfg: {} });
  eq(temperDeviation(inst.current()), 0, 'temper: 实例空表不偏');
  eq(typeof inst.observe({ rounds: 1 }), 'object', 'temper: observe 返回偏向');
  ok(inst.snapshot().windowDays > 0, 'temper: snapshot 有窗口信息');
  const offInst = createTemper({ cfg: { enabled: false } });
  eq(temperDeviation(offInst.observe({ rounds: 99 })), 0, 'temper: 关掉后不记');
  const biasedInst = createTemper({ cfg: { talkRounds: 1 } });
  biasedInst.observe({ rounds: 5, quietHours: 1, energy: 90, affinity: 60 });
  ok(typeof biasedInst.current().happy === 'number', 'temper: 观测后 current 有值');
}

section('circadian 学出来的生物钟');
{
  const D = 24 * 3600 * 1000;
  // 一律用本地时间构造：桶按 `new Date(ms).getHours()` 落位，用 UTC 时间戳写死
  // 会让测试在不同时区跑出不同结果。
  const T = new Date(2026, 9, 21, 2, 0, 0).getTime(); // 凌晨两点

  const empty = circadianCreateBuckets();
  eq(empty.buckets.length, CIRCADIAN_HOURS, 'circadian: 空桶 24 个');
  ok(empty.buckets.every((v) => v === 0), 'circadian: 空桶全 0');
  eq(empty.lastAt, 0, 'circadian: 空前参考点 0');

  // 记账
  const p1 = circadianRecordPresence(empty, T);
  eq(p1.buckets[2], 1, 'circadian: 一笔落在凌晨两点');
  ok(p1.buckets.filter((v, i) => i !== 2).every((v) => v === 0), 'circadian: 其余小时仍为 0');
  eq(circadianRecordPresence(p1, T + 60_000).buckets[2], 2, 'circadian: 同小时累加');
  // 在场窗口内连发不衰减（浮点数必须严格等于 3，否则「同一小时累加」站不住）
  const burst = circadianRecordPresence(circadianRecordPresence(p1, T + 1000), T + 2000);
  eq(burst.buckets[2], 3, 'circadian: 在场窗口内连发不衰减');

  // 衰减
  const later = T + 10 * D;
  const p3 = circadianRecordPresence(p1, later);
  const days = (later - p1.lastAt) / D;
  ok(
    Math.abs(p3.buckets[2] - (1 * Math.pow(0.94, days) + 1)) < 1e-9,
    'circadian: 十天后先衰减再 +1',
  );
  ok(circadianRecordPresence(p1, T + 3600_000).buckets[2] < 1, 'circadian: 窗口外重开会衰减');
  const noDecay = circadianAdvanceBuckets(empty, T);
  ok(noDecay.buckets.every((v) => v === 0), 'circadian: 从未记过不衰减');
  eq(noDecay.lastAt, T, 'circadian: 从未记过把参考点挪到 now');

  // 样本不足一律 null（宁可先按钟表过几天）
  eq(circadianCurve(p3.buckets), null, 'circadian: 样本不足返回 null');
  eq(circadianCurve(new Array(CIRCADIAN_HOURS).fill(0)), null, 'circadian: 全 0 返回 null');
  eq(circadianCurve(null), null, 'circadian: 非数组返回 null');

  // 「只在凌晨两点出现」的作息
  const night = new Array(CIRCADIAN_HOURS).fill(0);
  for (let i = 0; i < 50; i += 1) night[2] += 1;
  const curve = circadianCurve(night, { smooth: false });
  ok(Array.isArray(curve) && curve.length === CIRCADIAN_HOURS, 'circadian: 样本够了给曲线');
  eq(curve[2], 1, 'circadian: 峰值归一成 1');
  ok(curve.filter((v, i) => i !== 2).every((v) => v === 0), 'circadian: 其余小时为 0');

  const smooth = circadianCurve(night, { smooth: true });
  ok(smooth[1] > 0 && smooth[3] > 0, 'circadian: 平滑抬起了邻居');
  ok(Math.abs(smooth[2] - 1) < 0.26, 'circadian: 平滑后仍按峰值归一');

  // 夜间掩码的三种语义
  const onlyTwo = nightSetOf(curve);
  eq(onlyTwo.filter(Boolean).length, 23, 'circadian: 只活两点 → 23 个夜');
  eq(onlyTwo[2], false, 'circadian: 活着的那个小时不是夜');
  const alwaysCurve = circadianCurve(new Array(CIRCADIAN_HOURS).fill(20), { smooth: false });
  const alwaysSet = nightSetOf(alwaysCurve);
  ok(alwaysSet.every((v) => v === false), 'circadian: 全天在线 → 全 false（从不困倦）');
  eq(nightSetOf(null), null, 'circadian: 没曲线 → null（退回固定区间）');
  eq(nightSetOf([1, 2, 3]), null, 'circadian: 长度不对 → null');
  eq(nightSetOf(curve, { nightThreshold: 0.5 }).filter(Boolean).length, 23, 'circadian: 阈值可调');

  // 注入行
  eq(circadianPromptLine(null), null, 'circadian: 无曲线不注入');
  eq(circadianPromptLine(curve, { enabled: false }), null, 'circadian: 关掉不注入');
  const line = circadianPromptLine(curve);
  ok(typeof line === 'string' && line.length > 0, 'circadian: 有曲线时给一行');
  ok(line.includes('两点'), 'circadian: 注入行提到两点');
  ok(!line.includes('{') && !line.includes('}'), 'circadian: 注入行没有花括号');
  ok(circadianPromptLine(curve, { maxChars: 8 }).length <= 8, 'circadian: 超长会截断');

  // 实例层
  const inst = createCircadian({ cfg: {} });
  eq(inst.curve(), null, 'circadian: 实例空时曲线为 null');
  eq(inst.observe(T), true, 'circadian: 实例 observe 记账');
  eq(createCircadian({ cfg: { enabled: false } }).observe(T), false, 'circadian: 关掉后不记');
  eq(inst.nightSet(), null, 'circadian: 样本不够时掩码为 null');
  ok(inst.snapshot().samples > 0, 'circadian: snapshot 报样本数');
  eq(inst.snapshot().enough, false, 'circadian: 样本不够时 enough=false');
}

section('tempo 生活节奏与对话密度');
{
  const T = new Date(2026, 9, 22, 14, 0, 0).getTime(); // 下午两点，白天
  const NIGHT = new Date(2026, 9, 22, 1, 0, 0).getTime(); // 凌晨一点
  const MIN = 60 * 1000;

  // 五档倍率：数值本身是设计决定（照着 HDS-Interlude 的默认值），钉住防止被乱改。
  eq(CADENCE_FACTORS[CADENCE.PHONE], 1.4, 'tempo: 正拿着手机 ×1.4');
  eq(CADENCE_FACTORS[CADENCE.AVAILABLE], 1.0, 'tempo: 闲着 ×1.0');
  eq(CADENCE_FACTORS[CADENCE.OCCUPIED], 0.7, 'tempo: 忙 ×0.7');
  eq(CADENCE_FACTORS[CADENCE.RESTING], 0.5, 'tempo: 躺着 ×0.5');
  eq(CADENCE_FACTORS[CADENCE.ASLEEP], 0.15, 'tempo: 睡着 ×0.15');
  eq(cadenceFactorOf('nonsense'), 1, 'tempo: 未知档位按 1');

  // 基础判定：睡 > 累 > 忙 > 闲
  eq(cadenceOf({ now: T, hour: 14, isNight: false, energy: 80 }), CADENCE.AVAILABLE, 'tempo: 白天精力足 = 闲着');
  eq(cadenceOf({ now: T, hour: 14, isNight: false, energy: 20 }), CADENCE.RESTING, 'tempo: 精力 20 = 躺着');
  eq(
    cadenceOf({ now: NIGHT, hour: 1, isNight: true, energy: 10 }),
    CADENCE.ASLEEP,
    'tempo: 夜里精力 10 = 睡着',
  );
  eq(
    cadenceOf({ now: T, hour: 14, isNight: false, energy: 10 }),
    CADENCE.RESTING,
    'tempo: 白天精力 10 只是躺着，不算睡着',
  );
  const busy = { text: '上课', expiresAt: T + 30 * MIN };
  eq(cadenceOf({ now: T, hour: 14, isNight: false, energy: 80, focus: busy }), CADENCE.OCCUPIED, 'tempo: 手上有事 = 忙');
  eq(
    cadenceOf({ now: T, hour: 14, isNight: false, energy: 80, focus: { text: '上课', expiresAt: T - MIN } }),
    CADENCE.AVAILABLE,
    'tempo: 过期的焦点不再压着她',
  );

  // 他刚说话 → 睡/累/闲都提到「正拿着手机」；**忙不提升**。
  const hot = T - 60 * 1000;
  eq(cadenceOf({ now: T, hour: 14, isNight: false, energy: 20, lastUserAt: hot }), CADENCE.PHONE, 'tempo: 他刚说话，躺着也拿手机');
  eq(cadenceOf({ now: NIGHT, hour: 1, isNight: true, energy: 10, lastUserAt: NIGHT - 60 * 1000 }), CADENCE.PHONE, 'tempo: 他刚说话，睡着也醒一下');
  eq(cadenceOf({ now: T, hour: 14, isNight: false, energy: 80, lastUserAt: hot }), CADENCE.PHONE, 'tempo: 闲着且他刚说话');
  eq(
    cadenceOf({ now: T, hour: 14, isNight: false, energy: 80, focus: busy, lastUserAt: hot }),
    CADENCE.OCCUPIED,
    'tempo: 忙的时候收到消息，还是忙',
  );
  eq(
    cadenceOf({ now: T, hour: 14, isNight: false, energy: 20, lastUserAt: T - 10 * MIN }),
    CADENCE.RESTING,
    'tempo: 十小时…十分钟前说的就不算刚说话',
  );

  // 密度：加、衰、夹紧。
  const d0 = createDensity();
  eq(decayDensity(d0, T).value, 0, 'tempo: 空密度衰减还是 0');
  const d1 = bumpDensity(d0, T, { densityBump: 0.18 });
  ok(Math.abs(d1.value - 0.18) < 1e-9, 'tempo: 记一条加 0.18');
  const d2 = bumpDensity(d1, T, { densityBump: 0.9 });
  eq(d2.value, 1, 'tempo: 密度封顶 1');
  const half = decayDensity(bumpDensity(createDensity(), T, { densityBump: 1 }), T + 90 * MIN, {
    densityHalfLifeMs: 90 * MIN,
  });
  ok(Math.abs(half.value - 0.5) < 1e-6, 'tempo: 一个半衰期后正好一半');
  eq(decayDensity(createDensity(), T).at, T, 'tempo: 首次衰减把参考点挪到 now');

  eq(densityFactor(createDensity(), T), 1, 'tempo: 冷透了的密度因子是 1（不罚沉默）');
  ok(
    Math.abs(densityFactor(bumpDensity(createDensity(), T, { densityBump: 1 }), T) - 1.4) < 1e-9,
    'tempo: 满密度因子是 activeMultiplier',
  );

  // 综合倍率是乘法。
  const it = intensityOf({ now: T, hour: 14, isNight: true, energy: 10, densityFactor: 1.4 }, {});
  eq(it.cadence, CADENCE.ASLEEP, 'tempo: intensity 取到睡着档');
  ok(Math.abs(it.factor - 0.15 * 1.4) < 1e-9, 'tempo: 综合倍率 = 节奏 × 密度');

  // 注入行：常态与睡着都不出。
  eq(tempoPromptLine({ cadence: CADENCE.AVAILABLE }), '', 'tempo: 闲着不注入');
  eq(tempoPromptLine({ cadence: CADENCE.ASLEEP }), '', 'tempo: 睡着不注入');
  eq(tempoPromptLine({ cadence: CADENCE.AVAILABLE }, { enabled: false }), '', 'tempo: 关掉不注入');
  const busyLine = tempoPromptLine({ cadence: CADENCE.OCCUPIED });
  ok(busyLine.includes('慢一点'), 'tempo: 忙的时候说会慢一点');
  ok(!busyLine.includes('{') && !busyLine.includes('}'), 'tempo: 注入行不含花括号');
  ok(tempoPromptLine({ cadence: CADENCE.RESTING }).includes('不想说话'), 'tempo: 躺着可以说不出话');
  ok(tempoPromptLine({ cadence: CADENCE.OCCUPIED }, { maxChars: 10 }).length <= 10, 'tempo: 超长会截断');

  // 实例层：不接 moodOf 时退化成 available × 1。
  const inst = createTempo({ cfg: {} });
  const r = inst.intensity('private:1', T);
  eq(r.cadence, CADENCE.AVAILABLE, 'tempo: 实例没有来源时是闲着');
  eq(r.factor, 1, 'tempo: 实例没有来源时倍率 1');
  eq(inst.promptLine('private:1', T), '', 'tempo: 闲着时实例注入行是空串');
  ok(inst.snapshot().enabled === true, 'tempo: snapshot 报 enabled');
}

section('interrupt 未完成意图');
{
  const T = new Date(2026, 9, 22, 14, 0, 0).getTime();
  const MIN = 60 * 1000;
  let list = [];
  list = noteInterrupted(list, { chatId: 'private:1', text: '我刚想说，那个事儿…', at: T });
  eq(list.length, 1, 'interrupt: 记下一条');
  eq(list[0].text, '我刚想说，那个事儿…', 'interrupt: 原文保住（含省略号，清理只在取用时做）');
  // 同一条不重复记
  eq(noteInterrupted(list, { chatId: 'private:1', text: '我刚想说，那个事儿…', at: T }).length, 1, 'interrupt: 同一条不重复');
  // 空 chatId / 空文本都不记
  eq(noteInterrupted([], { chatId: '', text: 'x', at: T }).length, 0, 'interrupt: 空 chatId 不记');
  eq(noteInterrupted([], { chatId: 'private:1', text: '  ', at: T }).length, 0, 'interrupt: 空文本不记');
  eq(noteInterrupted([], { chatId: 'private:1', text: 'x', at: T }, { enabled: false }).length, 0, 'interrupt: 关掉不记');

  // 每个 chat 只留 N 条
  let many = [];
  for (let i = 0; i < 4; i += 1) many = noteInterrupted(many, { chatId: 'private:1', text: `第${i}句`, at: T + i }, { maxPerChat: 2 });
  eq(many.length, 2, 'interrupt: 每个 chat 只留 2 条');
  eq(many[many.length - 1].text, '第3句', 'interrupt: 留下的是最新的');

  // 过期
  eq(pruneInterrupted(list, T + 11 * MIN).length, 0, 'interrupt: 11 分钟就过期');
  eq(pruneInterrupted(list, T + 5 * MIN).length, 1, 'interrupt: 5 分钟还在');

  // 三个判据：他在这之后说过话才算被打断
  eq(interruptedFor(list, 'private:1', { now: T + MIN, lastUserAt: T - MIN }), null, 'interrupt: 他没再说话就不算被打断');
  const hitCond = interruptedFor(list, 'private:1', { now: T + MIN, lastUserAt: T + 30 * 1000 });
  ok(hitCond !== null && hitCond.text.startsWith('我刚想说'), 'interrupt: 他之后说话了才算');
  ok(!hitCond.text.endsWith('…'), 'interrupt: 取用时剪掉结尾省略号');
  eq(interruptedFor(list, 'private:2', { now: T + MIN, lastUserAt: T + MIN }), null, 'interrupt: 别的 chat 取不到');
  eq(interruptedFor(list, 'private:1', { now: T + 20 * MIN, lastUserAt: T + MIN }), null, 'interrupt: 过期后取不到');

  // 注入行
  const line = interruptPromptLine(hitCond);
  ok(line.includes('我刚想说'), 'interrupt: 注入行引用原话');
  ok(line.includes('没发出去'), 'interrupt: 注入行说清是没发出去');
  ok(line.includes('别假装'), 'interrupt: 注入行不许她装没想过');
  ok(!line.includes('{') && !line.includes('}'), 'interrupt: 注入行不含花括号');
  eq(interruptPromptLine(null), '', 'interrupt: 没有就不注入');
  eq(interruptPromptLine(hitCond, { enabled: false }), '', 'interrupt: 关掉不注入');
  ok(
    interruptPromptLine({ text: 'x'.repeat(100), at: T }, { maxQuoteChars: 10 }).includes('…'),
    'interrupt: 长原话被截断加省略号',
  );

  const inst = createInterrupt({ cfg: {} });
  eq(inst.promptLine('private:1', T + MIN, T + MIN), '', 'interrupt: 实例空时注入空串');
  ok(inst.snapshot().enabled === true, 'interrupt: snapshot 报 enabled');
}

section('comfy 自己画图');
{
  // 工作流：节点数与关键连线钉死，防止以后手滑改错 ID。
  const wf = buildWorkflow({
    prompt: 'a cat',
    negative: 'blurry',
    ckptName: 'v1-5-pruned-emaonly.safetensors',
    width: 512,
    height: 768,
    steps: 20,
    cfg: 7,
    samplerName: 'euler',
    scheduler: 'normal',
    seed: 42,
    filenamePrefix: 'yara-test',
  });
  eq(Object.keys(wf).length, 7, 'comfy: 七个节点');
  eq(wf[1].class_type, 'CheckpointLoaderSimple', 'comfy: 1 是加载底模');
  eq(wf[1].inputs.ckpt_name, 'v1-5-pruned-emaonly.safetensors', 'comfy: 底模文件名透传');
  eq(wf[2].class_type, 'CLIPTextEncode', 'comfy: 2 是正面编码');
  eq(wf[3].inputs.text, 'blurry', 'comfy: 3 是负面编码');
  eq(wf[4].inputs.width, 512, 'comfy: 4 是空 latent');
  eq(wf[4].inputs.height, 768, 'comfy: 高度透传');
  eq(wf[4].inputs.batch_size, 1, 'comfy: 一次一张');
  eq(wf[5].class_type, 'KSampler', 'comfy: 5 是采样');
  eq(wf[5].inputs.seed, 42, 'comfy: seed 透传');
  eq(wf[5].inputs.denoise, 1, 'comfy: denoise 固定 1');
  ok(JSON.stringify(wf[5].inputs.model) === JSON.stringify(['1', 0]), 'comfy: 采样器接 model');
  ok(JSON.stringify(wf[5].inputs.positive) === JSON.stringify(['2', 0]), 'comfy: 采样器接正面');
  ok(JSON.stringify(wf[5].inputs.negative) === JSON.stringify(['3', 0]), 'comfy: 采样器接负面');
  ok(JSON.stringify(wf[5].inputs.latent_image) === JSON.stringify(['4', 0]), 'comfy: 采样器接 latent');
  eq(wf[6].class_type, 'VAEDecode', 'comfy: 6 是解码');
  ok(JSON.stringify(wf[6].inputs.vae) === JSON.stringify(['1', 2]), 'comfy: VAE 从底模节点取');
  eq(wf[7].class_type, 'SaveImage', 'comfy: 7 是存图');
  ok(JSON.stringify(wf[7].inputs.images) === JSON.stringify(['6', 0]), 'comfy: 存图接解码');

  // 参数规整：空提示词要拒，尺寸对齐 8，越界夹紧，seed 兜底。
  eq(normalizeRequest({ prompt: '  ' }).ok, false, 'comfy: 空提示词被拒');
  ok(String(normalizeRequest({ prompt: '  ' }).reason).includes('不能为空'), 'comfy: 空提示词说清原因');
  eq(normalizeRequest({ prompt: 'x'.repeat(2001) }).ok, false, 'comfy: 超长提示词被拒');
  const r1 = normalizeRequest({
    prompt: 'a cat',
    width: 513,
    height: 100,
    steps: 999,
    cfg: 99,
  });
  eq(r1.width, 512, 'comfy: 宽度对齐到 8 的倍数');
  eq(r1.height, 256, 'comfy: 高度越界被抬到下限');
  eq(r1.steps, 60, 'comfy: 步数封顶 60');
  eq(r1.cfg, 20, 'comfy: cfg 封顶 20');
  ok(r1.seed >= 0 && r1.seed < 2147483647, 'comfy: 不给 seed 就随机在范围内');
  const r2 = normalizeRequest({ prompt: 'a cat', seed: 7, negative: '' });
  eq(r2.seed, 7, 'comfy: 给了 seed 就用它');
  ok(r2.negative.includes('watermark'), 'comfy: 负面留空用默认那组');
  ok(r2.negative.length > 0 && !r2.negative.includes('{'), 'comfy: 默认负面提示词没有花括号');
  eq(normalizeRequest({ prompt: 'a cat', negative: 'ugly' }).negative, 'ugly', 'comfy: 自定义负面透传');

  // history 解析：认第一张图，跳过没有图/坏结构。
  const hist = {
    abc: {
      outputs: {
        7: { images: [{ filename: 'yara-1.png', subfolder: '', type: 'output' }] },
      },
    },
  };
  eq(firstImageOf(hist, 'abc')?.filename, 'yara-1.png', 'comfy: 从 history 取到文件名');
  eq(firstImageOf(hist, 'abc')?.type, 'output', 'comfy: 取到 type');
  eq(firstImageOf({ abc: { outputs: {} } }, 'abc'), null, 'comfy: 没图返回 null');
  eq(firstImageOf({ abc: { outputs: { 7: { images: [] } } } }, 'abc'), null, 'comfy: 空图列表返回 null');
  eq(firstImageOf(null, 'abc'), null, 'comfy: history 为 null 返回 null');
  eq(firstImageOf({ abc: { outputs: { 7: { images: [{ filename: '' }] } } } }, 'abc'), null, 'comfy: 空文件名返回 null');

  // /view 路径：文件名要编码，空的 subfolder 不写。
  const vp = viewPathOf({ filename: 'yara 1.png', subfolder: '', type: 'output' });
  ok(vp.startsWith('/view?'), 'comfy: view 路径以 /view 开头');
  ok(vp.includes('filename=yara+1.png') || vp.includes('filename=yara%201.png'), 'comfy: 文件名被编码');
  ok(!vp.includes('subfolder='), 'comfy: 空 subfolder 不写进查询串');
  ok(viewPathOf({ filename: 'a.png', subfolder: 'sub', type: 'output' }).includes('subfolder=sub'), 'comfy: 有 subfolder 时写进去');

  // 实例：没开就没开，说清楚。
  const off = createComfy({ cfg: { enabled: false } });
  const offRes = await off.generate({ prompt: 'a cat' });
  eq(offRes.ok, false, 'comfy: 关掉时不出图');
  ok(String(offRes.reason).includes('没开'), 'comfy: 关掉时说清是没开');
  const noDir = createComfy({ cfg: {} , resolveMediaDir: () => '' });
  const noDirRes = await noDir.generate({ prompt: 'a cat' });
  eq(noDirRes.ok, false, 'comfy: 没配媒体目录时不出图');
  ok(String(noDirRes.reason).includes('mediaDir'), 'comfy: 没配目录时说清是 mediaDir');
  const snap = off.snapshot();
  eq(snap.enabled, false, 'comfy: snapshot 报 enabled=false');
  eq(snap.draws, 0, 'comfy: 初始画过 0 张');
}

section('recall 撤回');
{
  const T = 1_700_000_000_000;
  const MIN = 60 * 1000;

  // 记账：一串 id 只记一次，环形裁剪。
  let t = noteIds({}, 'private:1', [101, 102], T);
  eq(t['private:1'].length, 2, 'recall: 记下两条 id');
  t = noteIds(t, 'private:1', [101], T + MIN);
  eq(t['private:1'].length, 2, 'recall: 同一个 id 不重复记');
  eq(noteIds({}, '', [1], T)['private:1'], undefined, 'recall: 空 chatId 不记');
  eq(Object.keys(noteIds({}, 'private:1', [], T)).length, 0, 'recall: 空列表不记');

  let many = {};
  for (let i = 0; i < 20; i += 1) many = noteIds(many, 'private:1', [1000 + i], T + i);
  eq(many['private:1'].length, 12, 'recall: 每个 chat 只留 12 条');
  eq(many['private:1'][11].id, '1019', 'recall: 留下的是最新的');

  // 取：从新到旧，且只在窗口内。
  const g = recentOf(t, 'private:1', 1, T + MIN);
  eq(g.length, 1, 'recall: 取一条');
  eq(g[0].id, '102', 'recall: 取到的是最新那条');
  eq(recentOf(t, 'private:1', 1, T + 10 * MIN).length, 0, 'recall: 超过窗口取不到');
  eq(recentOf(t, 'private:1', 99, T + MIN).length, 2, 'recall: count 超过存量就给全部');
  eq(recentOf(t, 'private:2', 1, T + MIN).length, 0, 'recall: 别的 chat 取不到');
  eq(recentOf({}, 'private:1', 1, T).length, 0, 'recall: 空表取不到');

  // 划掉。
  const gone = dropIds(t, 'private:1', ['102']);
  eq(gone['private:1'].length, 1, 'recall: 划掉一条');
  eq(gone['private:1'][0].id, '101', 'recall: 剩下的是没撤的');
  eq(dropIds(t, 'private:1', []), t, 'recall: 空 id 列表不改表');

  // 实例：没开、没 id、拿不到通道时都要老实说原因。
  const off = createRecall({ cfg: { enabled: false } });
  const offRes = await off.recallLast('private:1', 1);
  eq(offRes.ok, false, 'recall: 关掉时撤不了');
  ok(String(offRes.reason).includes('没开'), 'recall: 关掉时说清是没开');

  const inst = createRecall({ cfg: {} });
  const emptyRes = await inst.recallLast('private:1', 1);
  eq(emptyRes.ok, false, 'recall: 没记过 id 时撤不了');
  ok(String(emptyRes.reason).includes('分钟'), 'recall: 说清是窗口里没有');
  const noChatRes = await inst.recallLast('', 1);
  eq(noChatRes.ok, false, 'recall: 空 chatId 撤不了');

  inst.note('private:1', [555]);
  const noBridge = await inst.recallLast('private:1', 1);
  eq(noBridge.ok, false, 'recall: 没通道时撤不了');
  ok(String(noBridge.reason).includes('通道'), 'recall: 说清是通道没就绪');

  // 有通道时真的会调 delete_msg。
  const calls = [];
  const fake = createRecall({
    cfg: {},
    getReceiver: () => ({
      outbound: { ctx: { call: async (action, params) => { calls.push({ action, params }); } } },
    }),
  });
  fake.note('private:1', [777, 778]);
  const okRes = await fake.recallLast('private:1', 2);
  eq(okRes.ok, true, 'recall: 有通道时撤回成功');
  eq(okRes.recalled.length, 2, 'recall: 撤了两条');
  eq(calls.length, 2, 'recall: 调了两次 delete_msg');
  eq(calls[0].action, 'delete_msg', 'recall: action 是 delete_msg');
  eq(calls[0].params.message_id, 778, 'recall: 从新到旧撤（先撤 778）');
  // 撤完就划掉了，第二次撤不到。
  const again = await fake.recallLast('private:1', 1);
  eq(again.ok, false, 'recall: 撤过的不会再撤一次');

  const snap = fake.snapshot();
  ok(snap.enabled === true, 'recall: snapshot 报 enabled');
  eq(snap.recalled, 2, 'recall: snapshot 报撤回次数');
  eq(snap.windowMinutes, 5, 'recall: snapshot 报窗口分钟数');
}

section('comfy 表情预设');
{
  ok(Object.keys(FACE_PRESETS).length >= 6, 'face: 至少六个预设');
  for (const name of ['happy', 'smug', 'cry', 'angry', 'shock', 'sleepy']) {
    ok(typeof FACE_PRESETS[name] === 'string' && FACE_PRESETS[name] !== '', `face: 有 ${name}`);
  }
  const made = facePromptOf('happy');
  eq(made.ok, true, 'face: happy 能组出提示词');
  ok(made.prompt.includes('cat ears'), 'face: 预设里写死了猫耳');
  ok(made.prompt.includes('heterochromia'), 'face: 预设里写死了异色瞳');
  ok(made.prompt.includes('white hair'), 'face: 预设里写死了白毛');
  ok(made.prompt.includes('head focus'), 'face: 压成头肩景');
  ok(made.prompt.includes('white background'), 'face: 白底');
  ok(made.negative.includes('full body'), 'face: 负面掉全身');
  ok(!made.prompt.includes('{') && !made.prompt.includes('}'), 'face: 提示词不含花括号');
  eq(facePromptOf('nope').ok, false, 'face: 未知预设被拒');
  ok(facePromptOf('happy', '拿着咖啡杯').prompt.includes('拿着咖啡杯'), 'face: extra 追加到末尾');
}

section('energy 工具加扣');
{
  const T = 1_700_000_000_000;
  const base = { ...createMoodState(T), energy: 80 };

  // 纯说话：与加这条之前**逐位一致**（1.5）。
  eq(noteAssistantMessage(base, T, {}).energy, 78.5, 'energy: 纯说话扣 1.5');
  eq(noteAssistantMessage(base, T, {}, 0).energy, 78.5, 'energy: toolCalls=0 与省略等价');

  // 按工具数加扣，每个 0.4。
  ok(Math.abs(noteAssistantMessage(base, T, {}, 1).energy - (80 - 1.5 - 0.4)) < 1e-9, 'energy: 一个工具加扣 0.4');
  ok(Math.abs(noteAssistantMessage(base, T, {}, 3).energy - (80 - 1.5 - 1.2)) < 1e-9, 'energy: 三个工具加扣 1.2');

  // 封顶 4：二十个工具也只加扣 4。
  ok(Math.abs(noteAssistantMessage(base, T, {}, 20).energy - (80 - 1.5 - 4)) < 1e-9, 'energy: 工具加扣封顶 4');
  ok(
    Math.abs(noteAssistantMessage(base, T, {}, 100).energy - noteAssistantMessage(base, T, {}, 20).energy) < 1e-9,
    'energy: 超过封顶后不再多扣',
  );

  // 可配：换步长与封顶。
  ok(
    Math.abs(noteAssistantMessage(base, T, { energyPerToolCall: 1, toolCallEnergyCap: 2 }, 5).energy - (80 - 1.5 - 2)) < 1e-9,
    'energy: 步长与封顶都能配',
  );
  // 负数/非有限数不该把精力加回去。
  eq(noteAssistantMessage(base, T, { energyPerToolCall: -9 }, 5).energy, 78.5, 'energy: 负步长被当成 0');
  eq(noteAssistantMessage(base, T, {}, Number.NaN).energy, 78.5, 'energy: NaN 工具数按 0');

  // 连脏数据也不会把精力扣成负数。
  const low = { ...base, energy: 1 };
  eq(noteAssistantMessage(low, T, {}, 20).energy, 0, 'energy: 精力不会扣成负数');

  // toolCallCountOf：数 tool-call / tool_use，忽略 text 与 reasoning。
  eq(toolCallCountOf({ content: [{ type: 'text', text: '嗯' }] }), 0, 'energy: 纯文本没有工具');
  eq(toolCallCountOf({ content: [{ type: 'tool-call' }, { type: 'tool-call' }] }), 2, 'energy: 数两个 tool-call');
  eq(toolCallCountOf({ content: [{ type: 'tool_use' }] }), 1, 'energy: 认 tool_use 这个名字');
  eq(
    toolCallCountOf({ content: [{ type: 'reasoning' }, { type: 'text' }, { type: 'tool-call' }] }),
    1,
    'energy: 混着也只数工具',
  );
  eq(toolCallCountOf({}), 0, 'energy: 空消息没有工具');
  eq(toolCallCountOf(null), 0, 'energy: null 没有工具');
}

console.log(`\n${'='.repeat(56)}`);
console.log(`pass=${pass} fail=${fail}`);


if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
