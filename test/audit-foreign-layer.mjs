/**
 * audit-foreign-layer.mjs
 *
 * 审计点：链上「带 ORIGINAL（或 LEGACY 键）但没有 MODULE 标记」的层，在重排时
 *   会不会被**静默丢弃**。它们不属于任何模块，拿不到重建工厂 —— 修复前
 *   `descriptors` 只收 `typeof layer[MODULE] === 'string'` 的层，于是这种层被丢出
 *   目标清单，重建后就不在链上了（第三方补丁、旧插件的闸被无声剥掉）。
 *
 * 两个真实来源：
 *   (a) 第三方补丁：另一个包用同名 `ORIGINAL` 键包了同一个方法（无 MODULE）；
 *   (b) 旧插件 dsh-onebot-guard / dsh-onebot-rhythm：用 LEGACY 键
 *       （`__onebotGuardOriginal` / `__onebotRhythmOriginal`），`originalOf` 认得出
 *       —— 于是进了 `layers`，但没有 MODULE。
 *
 * 修复后：它们成为**锚点**，原样留用、指针一字不改，我们只在其上挂自己的层。
 *
 * 运行：node test/audit-foreign-layer.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const P = createPatcher({
  owner: Symbol('A'),
  log: () => {},
  stats: { patched: [], lost: [] },
});
const makeAa = (tag) => (original) =>
  function aa(...a) {
    calls.push(tag);
    return original.apply(this, a);
  };

const chainOf = (fn) => {
  const out = [];
  const seen = new Set();
  let cur = fn;
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur[MODULE] ?? '(无MODULE层)');
    cur = cur[ORIGINAL] ?? cur.__onebotGuardOriginal ?? cur.__onebotRhythmOriginal;
  }
  return out.join(' -> ');
};

console.log('=== (a) 带 ORIGINAL、无 MODULE 的第三方层 ===');
{
  const proto = {
    m(...a) {
      calls.push('base');
      return 'base';
    },
  };
  const base0 = proto.m;
  const thirdOuter = function thirdPartyOuter(...a) {
    calls.push('third');
    return base0.apply(this, a);
  };
  thirdOuter[ORIGINAL] = base0;
  proto.m = thirdOuter;
  const origBefore = thirdOuter[ORIGINAL];

  check('挂 aa 成功', P(proto, 'm', 'aa', makeAa('aa')) === true, chainOf(proto.m));
  check(
    '★ 第三方层仍在链上（没被静默丢弃）',
    proto.m[MODULE] === 'aa' && proto.m[ORIGINAL] === thirdOuter,
    chainOf(proto.m),
  );
  check('★ 第三方层的 ORIGINAL 未被改写', thirdOuter[ORIGINAL] === origBefore);

  calls.length = 0;
  proto.m();
  check(
    '两层都执行、顺序为 aa → third → base',
    JSON.stringify(calls) === JSON.stringify(['aa', 'third', 'base']),
    JSON.stringify(calls),
  );
}

console.log('\n=== (b) 旧插件 guard 的层（LEGACY 键）===');
{
  const proto2 = {
    m(...a) {
      calls.push('base2');
      return 'base2';
    },
  };
  const base2 = proto2.m;
  const guardLayer = function guardWrapper(...a) {
    calls.push('guard');
    return base2.apply(this, a);
  };
  guardLayer.__onebotGuardOriginal = base2;
  proto2.m = guardLayer;

  check('挂 aa 成功', P(proto2, 'm', 'aa', makeAa('aa')) === true, chainOf(proto2.m));
  calls.length = 0;
  proto2.m();
  check(
    '★ 旧插件的闸没被静默剥掉（guard 仍执行）',
    JSON.stringify(calls) === JSON.stringify(['aa', 'guard', 'base2']),
    JSON.stringify(calls),
  );
}

console.log('\n=== (c) 对照：链底的无包装方法保留 ===');
{
  const proto3 = {
    m(...a) {
      calls.push('base3');
      return 'base3';
    },
  };
  const thirdBare = function bare(...a) {
    calls.push('thirdBare');
    return 'thirdBare';
  };
  proto3.m = thirdBare; // 无 ORIGINAL 键 -> 成为 base
  P(proto3, 'm', 'aa', makeAa('aa'));
  calls.length = 0;
  const value = proto3.m();
  check('返回值来自第三方底层', value === 'thirdBare', value);
  check(
    '第三方底层保留',
    JSON.stringify(calls) === JSON.stringify(['aa', 'thirdBare']),
    JSON.stringify(calls),
  );
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
