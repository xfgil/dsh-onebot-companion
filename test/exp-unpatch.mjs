/** 探针：unpatch 单独一层时为什么报 false。 */
import { createPatcher, auditMethods } from '../lib/core/patch.js';

const proto = { m() { return 'base'; } };
const p = createPatcher({ owner: Symbol('a'), log: () => {}, stats: { patched: [], lost: [] }, label: 'a' });

console.log('挂载 =', p(proto, 'm', 'adopt', (o) => function w() { return `ad(${o.call(this)})`; }));
console.log('值 =', proto.m());

const r = p.unpatch(proto, 'm', 'adopt');
console.log('unpatch 返回 =', r, '（期望 true）');
console.log('值 =', proto.m(), '（期望 base）');
console.log('audit =', JSON.stringify(auditMethods(proto, ['m'], 'adopt')));

// 第二次 unpatch 应为 false
console.log('再 unpatch =', p.unpatch(proto, 'm', 'adopt'), '（期望 false）');
