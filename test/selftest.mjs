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
import { createGuard, sanitizeText, sanitizeSegments } from '../lib/modules/guard.js';
import { splitBurstChunks } from '../lib/modules/burst.js';
import { InboundCoalescer, kindOfChatId } from '../lib/modules/coalesce.js';
import {
  createPersona,
  chatIdOfSession,
  plainOfInbound,
  textOfMessage,
} from '../lib/modules/persona.js';
import { createPrompt, renderRules, sessionIdOf } from '../lib/modules/prompt.js';
import { createRhythm, isSystemNotice, shouldBurst } from '../lib/modules/rhythm.js';
import { mergeConfig } from '../lib/index.js';
import { DEFAULT_RULES, RULES } from '../lib/modules/rules.js';
import {
  MOOD_IDS,
  WARMTH_BASELINE_DEFAULT,
  createMoodState,
  driftMood,
  moodPromptLine,
  moodSnapshot,
  noteAssistantMessage,
  noteProactive,
  noteUserMessage,
  proactiveChance,
  quietMs,
} from '../lib/modules/mood.js';
import { createStyleProfile, mergeStyleSample, stylePromptLine, topParticles } from '../lib/modules/style.js';
import { ProactiveScheduler } from '../lib/modules/proactive.js';
import { Synthesizer, speakableText, SHIM_SOURCE, VOICES, DEFAULTS as VOICE_DEFAULTS } from '../lib/modules/voice.js';

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

// ─────────────────────────────────────────────────────────────────────────────
section('rules 规则表');

eq(RULES.length, 6, 'rules: 共 6 条');
eq(
  RULES.map((r) => r.id),
  ['silent', 'image', 'quarrel', 'face', 'tone', 'voice'],
  'rules: id 顺序稳定',
);
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
eq(Object.keys(DEFAULT_RULES).length, 6, 'rules: DEFAULT_RULES 六项全开');

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

  const again = await p.preStep({ agent: { session: { id: 'onebot-private-1' } }, turn: 1, step: 1 }, next);
  eq(again.messages.length, 1, 'prompt: 同一轮只注入一次');

  const other = await p.preStep({ agent: { session: { id: 'web-abc' } }, turn: 1, step: 1 }, next);
  eq(other.messages.length, 1, 'prompt: 非 onebot 会话不注入');
  eq(stats.skippedNotOnebot, 1, 'prompt: 统计跳过非 onebot');

  const step2 = await p.preStep({ agent: { session: { id: 'onebot-private-2' } }, turn: 1, step: 2 }, next);
  eq(step2.messages.length, 1, 'prompt: firstStepOnly 挡掉非首步');
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
ok(shouldBurst('短', { queuable: true }, burstCfg) === false, 'rhythm: 短文本不切');
ok(shouldBurst('⏳ 当前任务运行中，新消息已排队', { queuable: true }, burstCfg) === false, 'rhythm: 系统消息不切');

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
  eq(s.energy, 82, 'mood: 用户消息 +2 精力');
  eq(s.affinity, 21.5, 'mood: 用户消息 +1.5 亲密度');
  eq(s.warmth, 56, 'mood: 用户消息 +6 热情');
  s = noteAssistantMessage(s, t);
  eq(s.energy, 80.5, 'mood: 她说话 -1.5 精力');
  s = noteProactive(s, t);
  eq(s.energy, 77.5, 'mood: 主动开口 -3 精力');
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
  eq(pB(proto, 'm', 'rhythm', (orig) => function w3() { return `r(${orig.call(this)})`; }), true, 'patch: 别的模块挂同一方法');
  eq(proto.m(), 'r(G(base))', 'patch: 叠加而非替换');

  // 同一 owner 再挂同一模块 = 幂等（真实场景：每 3 秒一轮的补挂扫描）。
  // 不幂等的话每轮叠一层，几十秒就把调用链撑爆。
  eq(pB(proto, 'm', 'rhythm', () => function wDup() { return 'dup'; }), false, 'patch: 同 owner 同模块重挂幂等');
  eq(proto.m(), 'r(G(base))', 'patch: 幂等后未叠层');

  // 热重载 = 新 owner 重挂同一模块：只剥自己那层，guard 层必须完好。
  const pC = createPatcher({ owner: Symbol('c'), log: () => {}, stats: fakeStats(), label: 't' });
  eq(pC(proto, 'm', 'rhythm', (orig) => function w4() { return `R(${orig.call(this)})`; }), true, 'patch: 新实例重挂（热重载）');
  eq(proto.m(), 'R(G(base))', 'patch: 只剥自己那层，guard 层完好');

  eq(auditMethods(proto, ['m'], 'rhythm'), [], 'patch: auditMethods 认领');
  eq(auditMethods(proto, ['m'], 'persona'), ['m'], 'patch: auditMethods 未挂 → lost');
  eq(auditMethods({ n() {} }, ['n'], 'guard'), ['n'], 'patch: 裸方法算 lost');
  ok(originalOf(proto.m) !== undefined, 'patch: originalOf 取到内层');
  eq(proto.m[MODULE_TAG], 'rhythm', 'patch: MODULE 标记正确');
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
  const rhythm = createRhythm({ cfg: cfg.rhythm, stats, patchMethod, log: () => {} });
  const persona = createPersona({ cfg: cfg.persona, stats, patchMethod, log: () => {}, random: () => 0.5 });
  const prompt = createPrompt({ cfg: cfg.prompt, stats, extra: (sid) => persona.extraFor(sid) });

  const ctx = { loader: { entries: () => [] }, baseUrl: undefined };

  const rGuard = await guard.scan(ctx);
  const rRhythm = await rhythm.scan(ctx);
  const rPersona = await persona.scan(ctx);
  ok(rGuard.ok === true, `集成: guard.scan 成功（${rGuard.error ?? ''}）`);
  ok(rRhythm.ok === true, `集成: rhythm.scan 成功（${rRhythm.error ?? ''}）`);
  ok(rPersona.ok === true, `集成: persona.scan 成功（${rPersona.error ?? ''}）`);
  eq(stats.lost, [], '集成: 挂载后 lost 为空');

  const bridgeMod = await import(
    new URL(`file:///${join(fake.libDir, 'bridge.js').replace(/\\/g, '/')}`).href
  );
  const outboundMod = await import(
    new URL(`file:///${join(fake.libDir, 'outbound.js').replace(/\\/g, '/')}`).href
  );
  const ChatBridge = bridgeMod.ChatBridge;
  const OutboundPipeline = outboundMod.OutboundPipeline;

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
    await bridge.handleInbound({ chatId: 'private:100000001', text: '<user_message qq="1">\n哈哈哈我靠\n</user_message>' });
    eq(bridge.inboundCalls.length, 1, '集成 persona: handleInbound 原样放行');

    const mood = persona.moodOf('private:100000001');
    near(mood.affinity, 21.5, 1e-3, '集成 persona: 入站 +1.5 亲密度');
    near(mood.warmth, 56, 1e-3, '集成 persona: 入站 +6 热情');

    bridge.onSessionEvent(
      { id: 'onebot-private-100000001-abc' },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '哈哈哈好' }] } } },
    );
    near(persona.moodOf('private:100000001').energy, 80.5, 1e-3, '集成 persona: 她说一句 -1.5 精力');

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

  await persona.flush();
  rhythm.stop();
  rmSync(fake.base, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(56)}`);
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
