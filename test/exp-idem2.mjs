/** 探针：幂等判定为什么没生效（打印实际判定输入）。 */
import { createPatcher, MODULE, originalOf } from '../lib/core/patch.js';

const chain = (fn) => {
  const out = [];
  let cur = fn;
  const seen = new Set();
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    const inner = originalOf(cur);
    out.push({ m: cur[MODULE], hasOrig: typeof inner === 'function' });
    if (typeof inner !== 'function') break;
    cur = inner;
  }
  return out;
};

const proto = { m: () => 'base' };
const ownerA = Symbol('a');
const ownerB = Symbol('b');
const pA = createPatcher({ owner: ownerA, log: () => {}, stats: { patched: [], lost: [] }, label: 'A' });
const pB = createPatcher({ owner: ownerB, log: () => {}, stats: { patched: [], lost: [] }, label: 'B' });

const r1 = pA(proto, 'm', 'guard', (o) => function w1() { return `g(${o.call(this)})`; });
console.log('1) pA 挂 guard      =', r1, '链 =', JSON.stringify(chain(proto.m)), '值 =', proto.m());

const r2 = pA(proto, 'm', 'guard', () => function w() { return 'dup'; });
console.log('2) pA 再挂 guard    =', r2, '（期望 false）链 =', JSON.stringify(chain(proto.m)), '值 =', proto.m());

// 直接检查判定所需的那几项
const head = proto.m;
console.log('   head[MODULE]      =', head[MODULE]);
console.log('   head[ownerA]===A  =', head[ownerA] === ownerA);
console.log('   head[ownerB]===B  =', head[ownerB] === ownerB);

const r3 = pB(proto, 'm', 'guard', (o) => function w2() { return `G(${o.call(this)})`; });
console.log('3) pB 挂 guard      =', r3, '链 =', JSON.stringify(chain(proto.m)), '值 =', proto.m());
