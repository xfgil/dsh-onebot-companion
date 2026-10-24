/**
 * 复述闸的标定与回归：`node test/echo.test.mjs`
 *
 * ## 为什么要有这个脚本
 *
 * `detectEcho` 的阈值（0.25 / 0.6）是**量出来的**，不是拍的。样本全部来自
 * 2026-10-19 那次真实泄漏的 QQ 私聊（用户截图指认「怎么还有这种给第三方讲解的」），
 * 以及同时段正常对话里的话。改阈值、改判据之前先跑这个，看两簇还分不分得开。
 *
 * 簇的间距就是安全边距：
 *   该拦的（真实复述）覆盖率  0.30 ~ 0.69
 *   不该拦的（正常对话）覆盖率 0.00 ~ 0.13
 * 阈值 0.25 落在空档里。任何一边的样本漂到 0.25 附近，说明判据该重新设计，
 * 而不是「微调一下阈值」。
 */
import assert from 'node:assert/strict';

import {
  DEFAULTS,
  bigrams,
  coverage,
  createEchoMemory,
  detectEcho,
  usesThirdPerson,
} from '../lib/modules/echo.js';

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✘ ${name}`);
    console.log(`      ${error?.message ?? error}`);
  }
}

// ── 样本：全部来自真实对话 ────────────────────────────────────────────────
//
// `voice` 是当时 qq_say 真发出去的语音文本，`text` 是紧接着那条正文。
// 前三条是用户截图里指认的泄漏，第四条是同一轮里我自己判出来的。

const REAL = [
  {
    name: '下午三点五十（截图原句）',
    voice: '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫',
    text: '他下午三点五十就吃了，到现在整八个钟头，我让他去弄点东西垫垫。',
  },
  {
    name: '催他睡觉（turn 43）',
    voice: '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
    text: '我催他去睡了，别又熬到一点多。',
  },
  {
    name: '早八提醒',
    voice: '明天早八呢，快睡吧，别又搞到一点多啊',
    text: '我提醒他明天有早八，别熬夜。',
  },
];

// 不该拦的：正常对话。刻意包含「他」字，因为那是最容易被误伤的边界。
const CLEAN = [
  { voice: '三点五十……那都八个钟头了', text: '那你现在饿不饿呀' },
  { voice: '明天早八呢，快睡吧', text: '早点睡嘛，我陪你聊两句就睡' },
  { voice: '那就行，别又搞到一点多', text: '你今天是不是有点累' },
  { voice: '我看看啊', text: '他说的那个插件我看了，挺好用的' }, // 真聊第三方
  { voice: '嗯哼~', text: '好呀' }, // 极短应答
  { voice: '那你现在饿不饿呀', text: '我去给你找点吃的？' },
];

console.log('\n[1] bigram / coverage 基础');
ok('去标点后比较，标点差异不影响', () => {
  assert.equal(coverage('我催他去睡了', '我催他去睡了！！'), 1);
});
ok('空串覆盖率为 0（不能除零）', () => {
  assert.equal(coverage('', '随便什么'), 0);
  assert.equal(coverage('随便什么', ''), 0);
  assert.equal(bigrams('').size, 0);
});
ok('单字退化成单字集，不返回空', () => {
  assert.equal(bigrams('好').size, 1);
});

console.log('\n[2] 第三人称判据');
ok('「我让他去弄点东西」算第三人称（关键：让/叫不是引用动词）', () => {
  assert.equal(usesThirdPerson('我让他去弄点东西垫垫'), true);
});
ok('「我催他去睡了」算第三人称', () => {
  assert.equal(usesThirdPerson('我催他去睡了'), true);
});
ok('「他下午三点五十就吃了」算第三人称', () => {
  assert.equal(usesThirdPerson('他下午三点五十就吃了'), true);
});
ok('「他说的那个插件」是引用别的话，放行', () => {
  assert.equal(usesThirdPerson('他说的那个插件我看了'), false);
});
ok('「他们」放行', () => {
  assert.equal(usesThirdPerson('他们那边怎么样了'), false);
});
ok('「他人」是词，不算第三人称（除非后面还说事）', () => {
  assert.equal(usesThirdPerson('不要麻烦他人'), false);
});
ok('没有他/她直接 false', () => {
  assert.equal(usesThirdPerson('你今天怎么样呀'), false);
});

console.log('\n[3] 真实复述必须被拦（不能漏）');
for (const c of REAL) {
  ok(c.name, () => {
    const r = detectEcho(c.text, [c.voice]);
    assert.equal(r.echo, true, `覆盖率 ${r.score.toFixed(2)} 低于阈值，漏拦了`);
  });
}

console.log('\n[4] 正常对话不能被拦（不能误伤）');
for (const c of CLEAN) {
  ok(`${c.text.slice(0, 16)}…`, () => {
    const r = detectEcho(c.text, [c.voice]);
    assert.equal(r.echo, false, `覆盖率 ${r.score.toFixed(2)} 误判成复述`);
  });
}

console.log('\n[5] 边界');
ok('时间窗过期后不再拦', () => {
  const mem = createEchoMemory({ windowMs: 1 });
  mem.remember('private:1', REAL[0].voice);
  // 手工把时间往前推：直接睡过窗口。
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5000;
    assert.equal(mem.check('private:1', REAL[0].text).echo, false);
  } finally {
    Date.now = realNow;
  }
});
ok('没发过语音的会话完全不判', () => {
  const mem = createEchoMemory();
  assert.equal(mem.check('private:999', REAL[0].text).echo, false);
});
ok('会话之间互不串（私聊 A 的语音不该拦私聊 B）', () => {
  const mem = createEchoMemory();
  mem.remember('private:1', REAL[0].voice);
  assert.equal(mem.check('private:2', REAL[0].text).echo, false);
});
ok('超长正文不判（可能是在讲新事情）', () => {
  const long = `${REAL[0].text}${'这是一段新内容'.repeat(20)}`;
  assert.equal(detectEcho(long, [REAL[0].voice]).echo, false);
});
ok('极短回复不判（「好呀」「嗯哼」不算复述）', () => {
  assert.equal(detectEcho('好呀', ['好呀']).echo, false);
});
ok('没记忆时永远 false', () => {
  assert.equal(detectEcho(REAL[0].text, []).echo, false);
  assert.equal(detectEcho(REAL[0].text, null).echo, false);
});
ok('几乎逐字重复即使没有第三人称也拦（strongCoverage）', () => {
  const voice = '明天早八呢，快睡吧，别又搞到一点多啊';
  const text = '明天早八呢，快睡吧，别又搞到一点多啊。';
  const r = detectEcho(text, [voice]);
  assert.equal(r.echo, true);
  assert.ok(r.score >= DEFAULTS.strongCoverage);
});

console.log('\n[6] 阈值安全边距（改了判据先看这个）');
{
  const realScores = REAL.map((c) => coverage(c.text, c.voice));
  const cleanScores = CLEAN.map((c) => coverage(c.text, c.voice));
  const realMin = Math.min(...realScores);
  const cleanMax = Math.max(...cleanScores);
  console.log(`  该拦的最低 ${realMin.toFixed(3)}  ·  不该拦的最高 ${cleanMax.toFixed(3)}  ·  阈值 ${DEFAULTS.minCoverage}`);
  ok('两簇不重叠，且阈值落在空档里', () => {
    assert.ok(realMin > DEFAULTS.minCoverage, `该拦的最低 ${realMin.toFixed(3)} 没超过阈值`);
    assert.ok(cleanMax < DEFAULTS.minCoverage, `不该拦的最高 ${cleanMax.toFixed(3)} 超过了阈值`);
  });
  ok('空档至少 0.1 宽（窄了就说明判据不牢）', () => {
    assert.ok(realMin - cleanMax >= 0.1, `空档只有 ${(realMin - cleanMax).toFixed(3)}`);
  });
}

console.log('\n[7] 共享记忆（globalThis）');
ok('两次取到同一个实例，热重载不丢记忆', async () => {
  const { sharedEchoMemory } = await import('../lib/modules/echo.js');
  const a = sharedEchoMemory();
  a.remember('private:1', REAL[0].voice);
  const b = sharedEchoMemory();
  assert.equal(a, b);
  assert.equal(b.check('private:1', REAL[0].text).echo, true);
  a.clear();
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
