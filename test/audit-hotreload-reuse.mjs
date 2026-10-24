/**
 * audit-hotreload-reuse.mjs
 *
 * 审计点：重建别人的层时用 `registrySnapshot.get(layerModule).makeWrapper` —— 而
 *   REGISTRY 挂在 `globalThis` 上**跨热重载存活**，里存的可能是**旧模块实例**的工厂。
 *
 * 问题：热重载后新实例还没挂上之前，若有别的模块先触发一次重排，被重建的那层会拿到
 *   **旧实例闭包**（旧 cfg / 旧 stats）。
 *
 * 结论（本文件断言的性质）：
 *   ① 旧闭包确实会被沿用 —— 这是**刻意**的，不是漏。REGISTRY 里只有旧实例登记过
 *      那个 moduleId；拿不到「新实例的工厂」时，沿用旧的是唯一能保持链完整的选择
 *      （丢掉它就等于把那一层从链上抹掉）。
 *   ② 但它**只在同一个 moduleId 的新实例还没调用 patchMethod 之前**存在。新实例一旦
 *      扫描到自己那一层（owner 不同 → 不幂等），当场整层重造、闭包换成新的。
 *   ③ 因此**每个模块的 scan 都不能因为「auditMethods 说层还在」就跳过 patchMethod**。
 *      那是这个自愈机制的充要条件 —— auditMethods 按 MODULE 判定「在不在」，看不到
 *      owner/闭包已经过期。
 *
 * 运行：node test/audit-hotreload-reuse.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const proto = {
  m(...a) {
    calls.push('base');
    return 'base';
  },
};

const statsOld = { patched: [], lost: [] };
const statsNew = { patched: [], lost: [] };

// P1 = 热重载「之前」的模块实例；P2 = 热重载「之后」的新实例。
// 同一个 moduleId 'aa'，但 owner 与 cfg/stats 都是新的。
const P1 = createPatcher({ owner: Symbol('instance-OLD'), log: () => {}, stats: statsOld });
const P2 = createPatcher({ owner: Symbol('instance-NEW'), log: () => {}, stats: statsNew });

const makeAaOld = (original) =>
  function aaLayer_OLD(...args) {
    calls.push('aa@旧实例');
    return original.apply(this, args);
  };
const makeAaNew = (original) =>
  function aaLayer_NEW(...args) {
    calls.push('aa@新实例');
    return original.apply(this, args);
  };
const makeBb = (original) =>
  function bbLayer(...args) {
    calls.push('bb');
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

console.log('=== 1. 旧实例挂载 aa ===');
check('旧实例挂载成功', P1(proto, 'm', 'aa', makeAaOld) === true, chainOf(proto.m));
check('旧实例记了一笔', statsOld.patched.length === 1);

console.log('\n=== 2. 热重载：新实例的同一轮扫描里，另一个模块 bb 先触发重排 ===');
check('bb 挂载成功', P2(proto, 'm', 'bb', makeBb) === true, chainOf(proto.m));
calls.length = 0;
proto.m();
check(
  '① 此刻 aa 层仍是旧实例闭包（刻意的：新实例还没有工厂可用）',
  calls.includes('aa@旧实例'),
  JSON.stringify(calls),
);
check('链形状正确', chainOf(proto.m) === 'aa -> bb -> (base)', chainOf(proto.m));

console.log('\n=== 3. 新实例随后扫到自己那一层（owner 不同 → 不幂等 → 整层重造）===');
check('新实例重挂 aa 返回 true（确实重建了）', P2(proto, 'm', 'aa', makeAaNew) === true);
calls.length = 0;
proto.m();
check(
  '② 闭包已换成新实例的',
  calls.includes('aa@新实例') && !calls.includes('aa@旧实例'),
  JSON.stringify(calls),
);
check('链形状不变', chainOf(proto.m) === 'aa -> bb -> (base)', chainOf(proto.m));

console.log('\n=== 4. 自愈后再扫一轮：幂等放行，形状稳定 ===');
check('本轮幂等放行', P2(proto, 'm', 'aa', makeAaNew) === false);
calls.length = 0;
proto.m();
check(
  '每层恰好一次',
  JSON.stringify(calls) === JSON.stringify(['aa@新实例', 'bb', 'base']),
  JSON.stringify(calls),
);

console.log(
  '\n③ 结论：每个模块的 scan 都不能因为「auditMethods 说层还在」就跳过 patchMethod ——\n' +
    '   那是旧闭包能被换掉的充要条件（auditMethods 只看 MODULE，看不到 owner 已过期）。',
);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
