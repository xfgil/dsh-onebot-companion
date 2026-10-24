/**
 * audit-multimethod.mjs
 *
 * 审计点：REGISTRY 的 per-(proto, method) 隔离性（patch.js `registryFor`）
 *   与「多个方法上各有三个以上模块」时排序/重建是否相互串味。
 *
 * 真实形态：stamp + rhythm + persona 同时挂在 `handleInbound` 与
 *   `dispatchFollowup` 两个共享方法上，两条链独立演化、可能交错重排。
 *
 * 运行：node test/audit-multimethod.mjs
 */
import { createPatcher, MODULE, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const proto = {
  m1(...a) {
    calls.push('base1');
    return 'base1';
  },
  m2(...a) {
    calls.push('base2');
    return 'base2';
  },
};
const P = createPatcher({
  owner: Symbol('onebot.owner'),
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

console.log('=== m1 三模块共享（stamp 优先级 20 → 最外层）===');
P(proto, 'm1', 'rhythm', mk('rhythm'));
P(proto, 'm1', 'persona', mk('persona'));
P(proto, 'm1', 'stamp', mk('stamp'));
check(
  'm1 形状 = stamp -> persona -> rhythm',
  chainOf(proto.m1) === 'stamp -> persona -> rhythm -> (base)',
  chainOf(proto.m1),
);

console.log('\n=== m2 另一组共享（不同方法）===');
P(proto, 'm2', 'guard', mk('guard'));
P(proto, 'm2', 'stamp', mk('stamp'));
check(
  'm2 形状 = stamp -> guard',
  chainOf(proto.m2) === 'stamp -> guard -> (base)',
  chainOf(proto.m2),
);

console.log('\n=== 交错重排 10 轮，观察两条链是否互相污染 ===');
const m1Before = chainOf(proto.m1);
const m2Before = chainOf(proto.m2);
for (let i = 0; i < 10; i += 1) {
  P(proto, 'm1', 'rhythm', mk('rhythm'));
  P(proto, 'm1', 'persona', mk('persona'));
  P(proto, 'm1', 'stamp', mk('stamp'));
}
check('★ m1 十轮后形状不变', chainOf(proto.m1) === m1Before, chainOf(proto.m1));
check('★ m2 完全未受影响', chainOf(proto.m2) === m2Before, chainOf(proto.m2));

console.log('\n=== REGISTRY 分表（per-method 隔离）===');
const REG = globalThis[Symbol.for('dsh-onebot-companion.registry')];
const byMethod = REG.get(proto);
check(
  'proto 下有 m1/m2 两张方法表',
  JSON.stringify([...byMethod.keys()].sort()) === '["m1","m2"]',
  JSON.stringify([...byMethod.keys()]),
);
check(
  'm1 登记 = persona/rhythm/stamp',
  JSON.stringify([...byMethod.get('m1').keys()].sort()) === '["persona","rhythm","stamp"]',
  JSON.stringify([...byMethod.get('m1').keys()]),
);
check(
  'm2 登记 = guard/stamp',
  JSON.stringify([...byMethod.get('m2').keys()].sort()) === '["guard","stamp"]',
  JSON.stringify([...byMethod.get('m2').keys()]),
);
check('两张表是不同 Map 对象（隔离）', byMethod.get('m1') !== byMethod.get('m2'));

console.log('\n=== 摘 m1 的 persona，m2 必须毫发无伤 ===');
check('摘 m1 的 persona 返回 true', P.unpatch(proto, 'm1', 'persona') === true);
check(
  'm1 = stamp -> rhythm',
  chainOf(proto.m1) === 'stamp -> rhythm -> (base)',
  chainOf(proto.m1),
);
check('★ m2 未受牵连', chainOf(proto.m2) === m2Before, chainOf(proto.m2));
check(
  'm1 的 registry 里已无 persona',
  !byMethod.get('m1').has('persona'),
  JSON.stringify([...byMethod.get('m1').keys()]),
);
check(
  'm2 的 registry 依旧是 guard/stamp',
  JSON.stringify([...byMethod.get('m2').keys()].sort()) === '["guard","stamp"]',
  JSON.stringify([...byMethod.get('m2').keys()]),
);

calls.length = 0;
proto.m1();
check(
  'm1 调用 = stamp → rhythm（persona 零次）',
  JSON.stringify(calls) === JSON.stringify(['stamp', 'rhythm', 'base1']),
  JSON.stringify(calls),
);
calls.length = 0;
proto.m2();
check(
  'm2 调用 = stamp → guard',
  JSON.stringify(calls) === JSON.stringify(['stamp', 'guard', 'base2']),
  JSON.stringify(calls),
);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
