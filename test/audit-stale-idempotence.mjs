/**
 * audit-stale-idempotence.mjs
 *
 * 审计点：链的**指针形状完全正确**，但某一层的**闭包已过期** —— 它能被自愈吗？
 *
 * 构造：外层 stamp 层的指针是 `stamp -> aa -> base`（与优先级目标一致、owner 也
 *   对），但它的闭包指向链底 `base0`，于是**跳过**夹在中间的 aa 层。指针链看起来
 *   完全正常，而 aa 一次都不会被调用。
 *
 * 这是「指针被原地篡改过」的所有场景的**共同终态**（见 audit-fallback-replay.mjs
 *   / audit-upgrade-ghost.mjs）：无论损坏是怎么来的，最终都表现为「形状稳定 + 闭包
 *   与指针分叉」。而幂等判定只比 `MODULE` + `OWNER`、**不比闭包**，形状稳定就
 *   `return false` —— 修复前会**永久固化**，每 3 秒扫一轮也没用。
 *
 * 修复后的行为（本文件守住的性质）：
 *   ① 过期的层无法凭自身被识别 —— 那是闭包内部状态，外部看不见。所以修法不是
 *      「识别坏层」，而是**不让坏层产生**（冻结层成为锚点，指针不再被原地改写）；
 *   ② 对已经坏掉的层，**它所属的模块回来重挂一次就恢复**（重造用的是那模块自己的
 *      工厂，闭包随之正确），无需任何人检测；
 *   ③ 若某模块的层被冻结层压住而挂不上外层，`lost` 里必须留下**看得见**的记录，
 *      不能像修复前那样「stats 里看不出任何异常」；该记录在链恢复正常后自动清除。
 *
 * 运行：node test/audit-stale-idempotence.mjs
 */
import { createPatcher, MODULE, OWNER, ORIGINAL } from '../lib/core/patch.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`   ${condition ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`);
  if (!condition) failures += 1;
};

const calls = [];
const stats = { patched: [], lost: [] };
const base0 = function base() {
  calls.push('base');
  return 'base';
};
const proto = { m: base0 };

const owner = Symbol('dsh-onebot-companion.owner');
const P = createPatcher({ owner, log: () => {}, stats });
const makeAa = (original) =>
  function aaLayer(...args) {
    calls.push('aa');
    return original.apply(this, args);
  };
const makeStamp = (original) =>
  function stampLayer(...args) {
    calls.push('stamp@新');
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

console.log('=== 1. 正常挂载 aa ===');
check('首次挂载成功', P(proto, 'm', 'aa', makeAa) === true, chainOf(proto.m));

console.log('\n=== 2. 手工构造「位置正确、闭包过期」的层 ===');
const aaNew = proto.m;
const staleStamp = function staleStampLayer(...args) {
  calls.push('stamp@旧');
  return base0.apply(this, args); // ★ 闭包过期：跳过夹在中间的 aa
};
staleStamp[MODULE] = 'stamp';
staleStamp[OWNER] = Symbol('stampOwner');
staleStamp[ORIGINAL] = aaNew; // 指针正确：stamp -> aa -> base
proto.m = staleStamp;

check('指针链形状正确', chainOf(proto.m) === 'stamp -> aa -> (base)', chainOf(proto.m));
calls.length = 0;
proto.m();
check('（这是损坏态本身）aa 被跳过', !calls.includes('aa'), JSON.stringify(calls));

console.log('\n=== 3. aa 自己重挂修不好它 —— 但会留下可见记录 ===');
const r1 = P(proto, 'm', 'aa', makeAa);
check('aa 重挂返回 false（aa 没被换掉，它确实已在链上）', r1 === false);
check(
  'lost 里留下一条带原因的记录（不再「看不出任何异常」）',
  stats.lost.some((e) => e.method === 'm' && e.moduleId === 'aa' && typeof e.reason === 'string'),
  JSON.stringify(stats.lost.map((e) => e.moduleId)),
);

console.log('\n=== 4. 过期的 stamp 层被它自己的模块重造 —— 当场自愈 ===');
const r2 = P(proto, 'm', 'stamp', makeStamp);
check('stamp 重挂返回 true（锚点就是它的旧层，整层被换掉）', r2 === true);
check('链形状不变', chainOf(proto.m) === 'stamp -> aa -> (base)', chainOf(proto.m));
calls.length = 0;
proto.m();
check(
  '★ aa 现在被调用了 —— 闭包不再穿透',
  JSON.stringify(calls) === JSON.stringify(['stamp@新', 'aa', 'base']),
  JSON.stringify(calls),
);

console.log('\n=== 5. 假警报自动清除（链已正常，lost 里不该还留着）===');
const r3 = P(proto, 'm', 'aa', makeAa);
check('aa 下一轮 scan 幂等放行', r3 === false);
check('lost 已清空', stats.lost.length === 0, JSON.stringify(stats.lost));

console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 条）`}`);
process.exit(failures === 0 ? 0 : 1);
