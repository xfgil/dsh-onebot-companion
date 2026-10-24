/**
 * audit-fallback-replay.mjs
 *
 * 审计点：链上存在「带 MODULE 标记、但 registry 里没有条目」的层（**冻结层**）时，
 *   挂载/重排会不会把它的 `ORIGINAL` 指针**原地改写**，从而让同一层被执行两遍。
 *
 * 场景：先正常挂 `aa`，再在其外层塞一个 `zzz` 冻结层（优先级 0，目标形状里本该在
 *   最内层）。随后 scanAll 每 3 秒会再挂一次 `aa` —— 目标形状与现状不同，必然触发
 *   重排。修复前兜底 `() => layer` 把 `zzz` 原对象交回去，重建循环紧接着写
 *   `zzz[ORIGINAL] = ...`，指针被改到新位置而闭包留在旧下层 → **aa 层被跑两遍**
 *   （实测 `calls = ["aa","ghost","aa","base"]`）。
 *
 * 修复后：冻结层成为**锚点**，`aa` 的层在它下面、拔不出来 → 放弃本次重排（返回
 *   false）并留下可见记录。链保持原样，每层恰好执行一次。
 *
 * 运行：node test/audit-fallback-replay.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const stats = { patched: [], lost: [] };
const proto = {
  m(...a) {
    calls.push('base');
    return 'base';
  },
};

const P = createPatcher({ owner: Symbol('ownerA'), log: () => {}, stats });
const makeAa = (original) =>
  function aaLayer(...args) {
    calls.push('aa');
    return original.apply(this, args);
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

console.log('=== 1. 先正常挂载 aa ===');
check('首次挂载成功', P(proto, 'm', 'aa', makeAa) === true, chainOf(proto.m));

console.log('\n=== 2. 外层塞一个冻结层 zzz（带 MODULE、无 registry 条目）===');
const aaOld = proto.m;
const ghost = function ghostLayer(...args) {
  calls.push('ghost');
  return aaOld.apply(this, args); // 闭包捕获「造它时」的下层 = aaOld
};
ghost[MODULE] = 'zzz'; // 优先级 0 → 目标形状里应排在最内层
ghost[ORIGINAL] = aaOld;
proto.m = ghost;
const ghostOrigBefore = ghost[ORIGINAL];
check('链形状是 ghost 在外层', chainOf(proto.m) === 'zzz -> aa -> (base)', chainOf(proto.m));

console.log('\n=== 3. 再挂一次 aa（scanAll 每 3 秒就会这么做）===');
const r2 = P(proto, 'm', 'aa', makeAa);
check('★ 放弃重排（aa 的层被冻结层压在下面，无法安全摘除）', r2 === false);
check('★ 幽灵层的 ORIGINAL 未被原地改写', ghostOrigBefore === ghost[ORIGINAL]);
check('链形状保持不变', chainOf(proto.m) === 'zzz -> aa -> (base)', chainOf(proto.m));
check(
  'lost 里有可见记录（修复前这里看不出任何异常）',
  stats.lost.some((e) => e.method === 'm' && e.moduleId === 'aa'),
);

console.log('\n=== 4. 调用一遍：每层恰好一次，无重复执行 ===');
calls.length = 0;
proto.m();
const aaCount = calls.filter((c) => c === 'aa').length;
check('★ aa 只被调用一次', aaCount === 1, `实际 ${aaCount} 次：${JSON.stringify(calls)}`);
check(
  '调用顺序与指针链一致',
  JSON.stringify(calls) === JSON.stringify(['ghost', 'aa', 'base']),
  JSON.stringify(calls),
);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
