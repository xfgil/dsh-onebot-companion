/**
 * audit-unpatch-shared.mjs
 *
 * 审计点：`patchMethod.unpatch`（摘闸）。
 *   · 担心 3：剥掉中间层重接，会不会让别的模块的层丢失或重复？
 *   · 担心 6：三个以上模块共享同一方法时，排序 + 重建 + unpatch 是否成立？
 *
 * 修复前的真 bug（2026-10-14 实测）：`unpatchMethod` 里曾有一条「剩余层顺序已经对
 *   了就跳过」的短路。本模块的层**不在链头**时（真实：`persona -> stamp -> base`
 *   里摘 stamp），剩下的层顺序天然就是对的 → 短路命中 → `return false`，而 stamp
 *   那层还原封不动挂着 —— **闸根本没关掉，接口却报告成功**。
 *
 * 运行：node test/audit-unpatch-shared.mjs
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
const P = createPatcher({
  owner: Symbol('ownerA'),
  log: () => {},
  stats: { patched: [], lost: [] },
});

const mk = (id) => (original) =>
  function layer(...args) {
    calls.push(id);
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
const wrapCount = (fn) => chainOf(fn).split(' -> ').filter((n) => n !== '(base)').length;

console.log('=== 三模块共享同一个方法 ===');
check('挂 aa', P(proto, 'm', 'aa', mk('aa')) === true, chainOf(proto.m));
check('挂 bb', P(proto, 'm', 'bb', mk('bb')) === true, chainOf(proto.m));
check(
  '挂 stamp（优先级 20，应到最外层）',
  P(proto, 'm', 'stamp', mk('stamp')) === true,
  chainOf(proto.m),
);
check(
  '★ 形状由优先级唯一决定：stamp -> aa -> bb',
  chainOf(proto.m) === 'stamp -> aa -> bb -> (base)',
  chainOf(proto.m),
);

console.log('\n=== 收敛性：五轮全量重挂，层数必须稳定 ===');
let stable = true;
for (let round = 1; round <= 5; round += 1) {
  const before = wrapCount(proto.m);
  P(proto, 'm', 'aa', mk('aa'));
  P(proto, 'm', 'bb', mk('bb'));
  P(proto, 'm', 'stamp', mk('stamp'));
  const after = wrapCount(proto.m);
  console.log(`   第 ${round} 轮：包装层数 ${before} -> ${after} | ${chainOf(proto.m)}`);
  if (after !== 3) stable = false;
}
check('★ 五轮后层数不漂移（修复前每轮 +2）', stable);
calls.length = 0;
proto.m();
check(
  '每层恰好执行一次',
  JSON.stringify(calls) === JSON.stringify(['stamp', 'aa', 'bb', 'base']),
  JSON.stringify(calls),
);

console.log('\n=== 摘中间层（这是修复前关不掉闸的那个场景）===');
check('摘 bb 返回 true', P.unpatch(proto, 'm', 'bb') === true);
check('链形状正确', chainOf(proto.m) === 'stamp -> aa -> (base)', chainOf(proto.m));
calls.length = 0;
proto.m();
check(
  '★ bb 已彻底摘掉（一个都没执行），其余层各一次',
  JSON.stringify(calls) === JSON.stringify(['stamp', 'aa', 'base']),
  JSON.stringify(calls),
);

console.log('\n=== 继续从链头、再从最后一层摘 ===');
check('摘 stamp（链头）返回 true', P.unpatch(proto, 'm', 'stamp') === true);
check('链形状正确', chainOf(proto.m) === 'aa -> (base)', chainOf(proto.m));
check('重复摘 stamp 返回 false（链上已无它的层）', P.unpatch(proto, 'm', 'stamp') === false);
check('摘 aa（最后一层）返回 true', P.unpatch(proto, 'm', 'aa') === true);
check('★ 回到上游实现', chainOf(proto.m) === '(base)', chainOf(proto.m));
calls.length = 0;
check(
  '调用直达底层',
  proto.m() === 'base' && JSON.stringify(calls) === '["base"]',
  JSON.stringify(calls),
);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
