/** 探针：为什么「位置正确时幂等跳过」没跳过。 */
import { createPatcher, MODULE, originalOf } from '../lib/core/patch.js';

const chain = (fn) => {
  const out = [];
  let cur = fn;
  const seen = new Set();
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    const inner = originalOf(cur);
    if (typeof inner !== 'function') break;
    out.push(cur[MODULE]);
    cur = inner;
  }
  return out.join(' -> ') || '(空)';
};

const proto = { m: () => 'base' };
const mk = (tag) => {
  const owner = Symbol(tag);
  const p = createPatcher({ owner, log: () => {}, stats: { patched: [], lost: [] }, label: tag });
  return { tag, owner, patch: (moduleId, wrap) => p(proto, 'm', moduleId, wrap) };
};

const A = mk('A');
const B = mk('B');
const C = mk('C');

console.log('A(rhythm) :', A.patch('rhythm', (o) => function a() { return `r(${o.call(this)})`; }), '=>', chain(proto.m));
console.log('B(stamp)  :', B.patch('stamp', (o) => function b() { return `s(${o.call(this)})`; }), '=>', chain(proto.m));
console.log('C(rhythm) :', C.patch('rhythm', (o) => function c() { return `R(${o.call(this)})`; }), '=>', chain(proto.m), '=>', proto.m());
console.log('B(stamp)  :', B.patch('stamp', (o) => function b3() { return `s3(${o.call(this)})`; }), '=>', chain(proto.m), '=>', proto.m());

// 逐层打印 owner 身份
let cur = proto.m;
while (typeof cur === 'function') {
  console.log('  layer', cur[MODULE], 'owner=', String(cur[MODULE]), cur === A.owner ? '' : '');
  const inner = originalOf(cur);
  if (typeof inner !== 'function') break;
  console.log('    ownerIsA=', cur[A.owner] === A.owner, 'ownerIsB=', cur[B.owner] === B.owner, 'ownerIsC=', cur[C.owner] === C.owner);
  cur = inner;
}
