/**
 * audit-sideeffect-cycle.mjs
 *
 * 审计点（对应审计报告里的三个担心）：
 *   A. 担心 1：`makeWrapper` 有副作用时，每次重排都会重造**所有**层 —— 副作用重复？
 *   B. 担心 5：两个不同 moduleId 共用同一个 `makeWrapper` 函数对象会怎样？
 *   C. 担心 8：环状链 / `ORIGINAL` 被外部改坏时，摊平与重建会不会误伤？
 *
 * 结论：
 *   A. 会重复，且**这是设计上无法避免的**：每层都闭包捕获了造它时收到的 `original`，
 *      所以「只改指针」永远改不动它（见 patch.js 顶部与 REGISTRY 的注释）—— 要让它
 *      接到新的下层，只能用它自己的工厂重造。因此 **`makeWrapper` 必须保持纯粹**
 *      （只造函数、不写外部状态）。这条约束已写进 patch.js 的文档注释；本文件把
 *      「重造必然发生」钉成断言，好让将来有人往工厂里塞副作用时立刻被这里打到。
 *   B. 共用同一个函数对象本身没问题 —— 层身份由 `MODULE` 决定，不看工厂对象。
 *   C. 环状链靠 `seen` Set 保证摊平能终止；环上的层因身份不全（`ext-x`/`ext-y`
 *      不在 REGISTRY 里）成为锚点，被原样留用、不会被误伤。
 *
 * 运行：node test/audit-sideeffect-cycle.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
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
  return out.join(' -> ') + (typeof cur === 'function' ? ' -> [环]' : '');
};
const wrapCount = (fn) => chainOf(fn).split(' -> ').filter((n) => n !== '(base)').length;

console.log('=== A. makeWrapper 的副作用会被重排重复触发（所以它必须纯粹）===');
{
  const built = [];
  const protoA = { m: () => 'base' };
  const PA = createPatcher({ owner: Symbol('A'), log: () => {}, stats: { patched: [], lost: [] } });
  const mkTracked = (id) => (original) => {
    built.push(id); // ★ 副作用：真实中 = 写 stats / 注册监听 / 自增计数
    return function layer(...a) {
      return original.apply(this, a);
    };
  };

  PA(protoA, 'm', 'aa', mkTracked('aa'));
  check('首次挂 aa 只调一次自己的工厂', JSON.stringify(built) === '["aa"]', JSON.stringify(built));

  built.length = 0;
  PA(protoA, 'm', 'bb', mkTracked('bb'));
  check(
    '★ bb 进场时 aa 的工厂被**再次**调用（重排必然重造）',
    built.includes('aa') && built.includes('bb'),
    JSON.stringify(built),
  );
  check('链形状正确（同优先级按字典序，aa 在外）', chainOf(protoA.m) === 'aa -> bb -> (base)', chainOf(protoA.m));
}

console.log('\n=== B. 两个 moduleId 共用同一个 makeWrapper 函数对象 ===');
{
  const protoB = { m: () => 'base' };
  const PB = createPatcher({ owner: Symbol('B'), log: () => {}, stats: { patched: [], lost: [] } });
  const shared = (original) =>
    function sharedLayer(...a) {
      return original.apply(this, a);
    };

  check('aa 挂载成功', PB(protoB, 'm', 'aa', shared) === true, chainOf(protoB.m));
  check('bb 用同一个工厂对象挂载成功', PB(protoB, 'm', 'bb', shared) === true, chainOf(protoB.m));
  check(
    '两层并存（身份由 MODULE 决定，与工厂对象无关）',
    chainOf(protoB.m) === 'aa -> bb -> (base)',
    chainOf(protoB.m),
  );
  check('bb 重挂幂等放行', PB(protoB, 'm', 'bb', shared) === false);
  check('层数没有漂移', wrapCount(protoB.m) === 2, String(wrapCount(protoB.m)));
}

console.log('\n=== C. 环状链：摊平能终止，环上层不被误伤 ===');
{
  const protoC = { m: () => 'base' };
  const PC = createPatcher({ owner: Symbol('C'), log: () => {}, stats: { patched: [], lost: [] } });
  PC(protoC, 'm', 'aa', (o) =>
    function aa(...a) {
      return o.apply(this, a);
    },
  );

  const x = function xLayer() {
    return 'x';
  };
  const y = function yLayer() {
    return 'y';
  };
  x[MODULE] = 'ext-x';
  x[ORIGINAL] = y;
  y[MODULE] = 'ext-y';
  y[ORIGINAL] = x; // ★ 成环
  protoC.m = x;

  let threw = null;
  let ret = null;
  try {
    ret = PC(protoC, 'm', 'aa', (o) =>
      function aa(...a) {
        return o.apply(this, a);
      },
    );
  } catch (e) {
    threw = e;
  }
  check('★ 环状链上挂载不抛异常（seen 集合保证摊平终止）', threw === null, threw?.message);
  check(
    '★ 环上的外部层没被摘掉（它们身份不全 → 成为锚点）',
    protoC.m === x || protoC.m[MODULE] === 'aa',
    chainOf(protoC.m),
  );
  check(
    '环的两层仍在链上',
    chainOf(protoC.m).includes('ext-x') && chainOf(protoC.m).includes('ext-y'),
    chainOf(protoC.m),
  );
}

console.log('\n=== C2. 第三方包装（用别的属性名，不认 ORIGINAL）===');
{
  const protoD = { m: () => 'base' };
  const third = function thirdParty() {
    return 'third';
  };
  protoD.m = third; // 第三方包装：不是我们的层，也没有 ORIGINAL
  const PD = createPatcher({ owner: Symbol('D'), log: () => {}, stats: { patched: [], lost: [] } });
  PD(protoD, 'm', 'aa', (o) =>
    function aa(...a) {
      return 'aa>' + o.apply(this, a);
    },
  );
  check('第三方层仍在链底（没被剥掉）', protoD.m[ORIGINAL] === third, chainOf(protoD.m));
  check('调用穿过两层', protoD.m() === 'aa>third', protoD.m());
}

console.log('\n=== C3. unpatch 后 registry 条目与链的一致性 ===');
{
  const protoE = { m: () => 'base' };
  const PE = createPatcher({ owner: Symbol('E'), log: () => {}, stats: { patched: [], lost: [] } });
  PE(protoE, 'm', 'aa', () => () => 'aa');
  PE(protoE, 'm', 'bb', () => () => 'bb');
  const REG = globalThis[Symbol.for('dsh-onebot-companion.registry')];
  const table = REG.get(protoE).get('m');
  check(
    '两侧都登记了',
    JSON.stringify([...table.keys()].sort()) === '["aa","bb"]',
    JSON.stringify([...table.keys()]),
  );

  check('摘 aa 返回 true', PE.unpatch(protoE, 'm', 'aa') === true);
  check(
    '摘后 registry 只剩 bb',
    JSON.stringify([...table.keys()]) === '["bb"]',
    JSON.stringify([...table.keys()]),
  );
  check('摘后链上已无 aa 层', !chainOf(protoE.m).includes('aa'), chainOf(protoE.m));
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
