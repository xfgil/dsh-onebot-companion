/** 探针：多层场景下幂等判定为何失效（打印判定输入）。 */
import { createPatcher, MODULE } from '../lib/core/patch.js';

const proto = { m: () => 'base' };
const ownerA = Symbol('a');
const ownerB = Symbol('b');
const pA = createPatcher({ owner: ownerA, log: () => {}, stats: { patched: [], lost: [] }, label: 'A' });
const pB = createPatcher({ owner: ownerB, log: () => {}, stats: { patched: [], lost: [] }, label: 'B' });

pA(proto, 'm', 'rhythm', (o) => function r() { return `r(${o.call(this)})`; });
console.log('after A: 值 =', proto.m());
pB(proto, 'm', 'stamp', (o) => function s() { return `s(${o.call(this)})`; });
console.log('after B: 值 =', proto.m());

console.log('\n--- pB 视角逐层身份 ---');
let cur = proto.m;
let i = 0;
while (typeof cur === 'function' && i < 5) {
  const ob = cur[ownerB];
  const oa = cur[ownerA];
  console.log(
    `  layer[${i}] MODULE=${cur[MODULE]}  ownerB属性=${ob === undefined ? 'undefined' : ob === ownerB ? '===ownerB' : '其它'}  ownerA属性=${oa === undefined ? 'undefined' : oa === ownerA ? '===ownerA' : '其它'}`,
  );
  const inner = cur.__onebotCompanionOriginal;
  if (typeof inner !== 'function') break;
  cur = inner;
  i += 1;
}

console.log('\n--- pB 再挂 stamp（期望幂等 false） ---');
const again = pB(proto, 'm', 'stamp', (o) => function s2() { return `s2(${o.call(this)})`; });
console.log('返回 =', again, '值 =', proto.m());
