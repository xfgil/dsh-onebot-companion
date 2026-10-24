/**
 * audit-natural-reach.mjs
 *
 * 审计点：链上出现**冻结层**（有身份、但没有重建工厂）时，重排会怎么处理它。
 *
 * ★ 由**代码升级路径**自然产生，不需要手造异常状态：
 *   2026-10-14 之前那版 patch.js 没有 REGISTRY，也没有稳定的 `OWNER` 键。升级后
 *   REGISTRY 是空的，但链上还留着旧版挂的层 —— 它们带 `MODULE` 标记（`Symbol.for`，
 *   跨实例稳定；热重载也读得到），却**不在 registry 里**。（跨**热重载**的普通挂载
 *   不受影响：REGISTRY 挂在 `globalThis` 上，旧实例登记的条目还在。）
 *
 * 修复前的行为（本文件要守住的反面）：
 *   摊平时对这样的层走兜底 `remembered?.makeWrapper ?? (() => layer)`，
 *   `() => layer` 返回**该层对象本身**；紧接着重建循环把它当新层写入
 *   `layer[ORIGINAL] = head` —— **原地篡改指针**，而它的**闭包**仍指向造它时的
 *   旧下层。指针与闭包就此分叉：链上显示的内层是新建的层，实际执行的却是旧的。
 *   更糟的是幂等判定只比 `MODULE` + `OWNER`、不比闭包，一旦形状稳定，后续每一轮
 *   scan（默认 3 秒）都判定「已就位」直接 return，**损坏永久固化**。
 *
 * 修复后：冻结层成为**锚点**，它和它以下一律原样留用（闭包因此继续有效），
 *   重排只发生在锚点之上。拿不到工厂就不改它的指针。
 *
 * 运行：node test/audit-natural-reach.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

const REGISTRY_KEY = Symbol.for('dsh-onebot-companion.registry');
const REGISTRY = globalThis[REGISTRY_KEY];

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
const proto = { m: base0 };
const P = createPatcher({
  owner: Symbol('onebot.owner'),
  log: () => {},
  stats: { patched: [], lost: [] },
});

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

console.log('\n=== 1. REGISTRY 的存放位置与跨实例共享性 ===');
check(
  'REGISTRY 挂在 globalThis 的 Symbol.for 键上（跨热重载存活）',
  REGISTRY instanceof WeakMap,
  REGISTRY?.constructor?.name,
);

console.log('\n=== 2. 链上放一个「带 MODULE、无 registry 条目」的层（= 升级前留下的层）===');
const legacy = function legacyLayer(...args) {
  calls.push('legacy');
  return base0.apply(this, args);
};
legacy[MODULE] = 'rhythm';
legacy[ORIGINAL] = base0;
// 注意：不设 legacy[OWNER] —— OWNER 是本次重写新加的键，重写前的层没有它
proto.m = legacy;

const table = REGISTRY.get(proto)?.get('m');
check('proto 在 REGISTRY 里还没有表（这就是「必然走兜底」的条件）', !table);
check('registry 里没有 rhythm 条目（所以重建工厂无从取得）', !table?.get('rhythm'));

console.log('\n=== 3. 触发一次重排，观察冻结层是否被原地改写 ===');
const origBefore = legacy[ORIGINAL];
const ret = P(proto, 'm', 'aa', (o) =>
  function aa(...a) {
    calls.push('aa');
    return o.apply(this, a);
  },
);
const origAfter = legacy[ORIGINAL];

check('挂载成功（新层排在冻结层之上）', ret === true);
check('冻结层的 ORIGINAL 指针**未被**改写', origBefore === origAfter);
check('链形状正确', chainOf(proto.m) === 'aa -> rhythm -> (base)', chainOf(proto.m));

console.log('\n=== 4. 指针链与实际执行一致（没有闭包穿透）===');
calls.length = 0;
proto.m();
check(
  '每层恰好执行一次，顺序与指针链一致',
  JSON.stringify(calls) === JSON.stringify(['aa', 'legacy', 'base']),
  JSON.stringify(calls),
);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
