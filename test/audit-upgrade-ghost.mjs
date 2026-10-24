/**
 * audit-upgrade-ghost.mjs
 *
 * 审计点：**代码升级**后链上留下的旧版层（带 `MODULE`、但不在新 REGISTRY 里）
 *   会不会让后继的重排「闭包穿透」。
 *
 * 场景来源（真实且不需要手造异常状态）：
 *   2026-10-14 之前那版 patch.js 没有 REGISTRY，也没有稳定的 `OWNER` 键。升级后
 *   REGISTRY 是空的（新表），而链上还留着旧版挂的层 —— 它们带 `MODULE`（`Symbol.for`，
 *   跨热重载稳定），却不在 registry 里，于是拿不到重建工厂。
 *
 * 修复前的行为：兜底 `() => layer` 把**原层对象**交出去，紧接着重建循环对它
 *   原位写 `ORIGINAL` —— 指针被改到新位置，闭包却留在旧下层，两者分叉。
 *   更糟的是此后每轮 scan 都判定「已就位」（只比 MODULE + OWNER），**永久固化**。
 *
 * 修复后的行为（本文件守住的性质）：
 *   ① 拿不到工厂的层**成为锚点**，它和它以下一律原样留用 —— 指针与闭包不会分叉；
 *   ② 锚点之外的部分照常重排，两个残留旧层能**逐个自愈**（各自所属模块回来重挂一次
 *      就换掉自己那层）；
 *   ③ 若本模块的层被**别人的**冻结层压住而挂不上外层，放弃重排、但留下可见记录
 *      （`lost`），且绝不留下两层同模块的包装（那会让同一条消息被处理两次）。
 *
 * 运行：node test/audit-upgrade-ghost.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const base0 = function base() {
  calls.push('base');
  return 'base';
};

/**
 * 造一个「旧版遗留层」：带 MODULE + ORIGINAL，但**没有 OWNER**（本次新加的键），
 * 也不在任何 registry 条目里。闭包捕获 `inner`，即它被造出来时的下层。
 */
const legacyLayer = (moduleId, inner, tag) => {
  const layer = function legacyWrapper(...args) {
    calls.push(tag);
    return inner.apply(this, args);
  };
  layer[MODULE] = moduleId;
  layer[ORIGINAL] = inner;
  return layer;
};

const chainOf = (fn) => {
  const out = [];
  const seen = new Set();
  let cur = fn;
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur[MODULE] ?? '(base)');
    cur = cur[ORIGINAL];
  }
  return out.join(' -> ');
};

const P = createPatcher({
  owner: Symbol('dsh-onebot-companion.owner'),
  log: () => {},
  stats: { patched: [], lost: [] },
});

const fRhythm = (original) =>
  function newRhythmLayer(...a) {
    calls.push('rhythm@新');
    return original.apply(this, a);
  };
const fStamp = (original) =>
  function newStampLayer(...a) {
    calls.push('stamp@新');
    return original.apply(this, a);
  };

console.log('=== 0. 升级瞬间：链上是旧版留下的层，新 REGISTRY 为空 ===');
{
  const proto = { m: base0 };
  const rhythmOld = legacyLayer('rhythm', base0, 'rhythm@旧');
  const stampOld = legacyLayer('stamp', rhythmOld, 'stamp@旧');
  proto.m = stampOld;
  const origBefore = stampOld[ORIGINAL];

  check('初始链是旧版形态', chainOf(proto.m) === 'stamp -> rhythm -> (base)', chainOf(proto.m));

  console.log('\n=== 1. 第一轮 scan：两个模块各按自己的能力处理 ===');
  // rhythm 在外层是 stamp 的冻结旧层 —— rhythm 无法越过它，只能放弃（这是对的：
  // 改坏锚点的指针远比排序不理想严重）。stamp 的锚点正是它**自己**那层，可以换掉。
  const rRhythm = P(proto, 'm', 'rhythm', fRhythm);
  const rStamp = P(proto, 'm', 'stamp', fStamp);
  check('rhythm 被外层冻结层压住 → 放弃重排（返回 false）', rRhythm === false);
  check('stamp 的锚点是它自己那层 → 成功换掉（返回 true）', rStamp === true);
  check('链形状正确', chainOf(proto.m) === 'stamp -> rhythm -> (base)', chainOf(proto.m));
  check('★ 旧 stamp 层的 ORIGINAL 未被原地改写（指针与闭包不分叉）', stampOld[ORIGINAL] === origBefore);

  console.log('\n=== 2. 后续几轮 scan：形状稳定、每层恰好执行一次 ===');
  let stable = true;
  for (let round = 1; round <= 3; round += 1) {
    P(proto, 'm', 'rhythm', fRhythm);
    P(proto, 'm', 'stamp', fStamp);
    calls.length = 0;
    proto.m();
    const tally = {};
    for (const c of calls) tally[c] = (tally[c] ?? 0) + 1;
    const good =
      tally['stamp@新'] === 1 && tally['rhythm@新'] === 1 && tally.base === 1 && calls.length === 3;
    if (!good) stable = false;
    console.log(`   第 ${round} 轮：${JSON.stringify(calls)}${good ? '' : '  ★ 异常'}`);
  }
  check('每一轮都是 stamp@新 → rhythm@新 → base 各一次（无重复、无跳过）', stable);
}

console.log('\n=== 3. 反面场景：一个模块死活不补挂时，绝不留双份包装 ===');
{
  const proto = { m: base0 };
  const rhythmOld = legacyLayer('rhythm', base0, 'rhythm@旧');
  const stampOld = legacyLayer('stamp', rhythmOld, 'stamp@旧');
  proto.m = stampOld;

  // 只有 rhythm 回来补挂；stamp 一直没补挂（它的 scan 抛异常等）
  P(proto, 'm', 'rhythm', fRhythm);
  calls.length = 0;
  proto.m();

  check(
    'stamp 层仍在链上、只被调用一次（没有被重排掉、更没有被叠成两份）',
    calls.filter((c) => c === 'stamp@旧').length === 1,
    JSON.stringify(calls),
  );
  check(
    '★ rhythm 没能越过冻结层 —— 它放弃了重排（好过把指针改坏）',
    calls.includes('rhythm@旧'),
    JSON.stringify(calls),
  );

  const chainModules = chainOf(proto.m).split(' -> ');
  check(
    '链上没有任何模块出现两次',
    new Set(chainModules).size === chainModules.length,
    chainOf(proto.m),
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
