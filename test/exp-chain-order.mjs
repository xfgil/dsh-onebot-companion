/** 探针：两个模块共享挂载点时，重挂后的链形状到底是什么。 */
import { createPatcher, MODULE, originalOf } from '../lib/core/patch.js';

const ownerOf = new Map();
const chain = (fn) => {
  const out = [];
  let cur = fn;
  const seen = new Set();
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    const inner = originalOf(cur);
    if (typeof inner !== 'function') break;
    out.push(`${cur[MODULE]}@${ownerOf.get(cur) ?? '?'}`);
    cur = inner;
  }
  return out.join(' -> ') || '(空)';
};

const proto = { m: () => 'base' };
const mk = (tag) => {
  const owner = Symbol(tag);
  const p = createPatcher({ owner, log: () => {}, stats: { patched: [], lost: [] }, label: tag });
  return {
    tag,
    patch: (moduleId, wrap) =>
      p(proto, 'm', moduleId, (orig) => {
        const w = wrap(orig);
        ownerOf.set(w, tag);
        return w;
      }),
  };
};

const A = mk('A');
const B = mk('B');
const C = mk('C');

A.patch('rhythm', (o) => function a() { return `r(${o.call(this)})`; });
B.patch('stamp', (o) => function b() { return `s(${o.call(this)})`; });
console.log('A(rhythm) 先, B(stamp) 后 :', chain(proto.m), '=>', proto.m());

C.patch('rhythm', (o) => function c() { return `R(${o.call(this)})`; });
console.log('C(rhythm) 重挂          :', chain(proto.m), '=>', proto.m());

B.patch('stamp', (o) => function b3() { return `s(${o.call(this)})`; });
console.log('B(stamp) 再挂（scanAll）:', chain(proto.m), '=>', proto.m());

A.patch('rhythm', (o) => function a2() { return `r(${o.call(this)})`; });
console.log('A(rhythm) 再挂          :', chain(proto.m), '=>', proto.m());
