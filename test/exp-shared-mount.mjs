/**
 * 实验：两个模块共享同一个挂载点时，反复 scan 会不会互相翻转？
 *
 * 动机：stamp 要挂 ChatBridge.prototype.dispatchFollowup，而 rhythm 已经挂在
 * 那里。patch.js:97 的幂等只看**链头**，patch.js:103-113 的脱链也只剥**链头连续
 * 的本模块层**。若链头是别人，就会把别人整条链当 original 再包一层 —— 那意味着
 * 每轮 scan 翻转一次。本轮实测确认真假。
 */
import { createPatcher, MODULE, PATCHED, originalOf } from '../lib/core/patch.js';

/** 把整条链摊平成 ['owner:module', ...]（链头在前）。 */
function chainOf(fn) {
  const out = [];
  let cur = fn;
  const seen = new Set();
  while (typeof cur === 'function' && !seen.has(cur)) {
    seen.add(cur);
    const tag = cur.__who;
    if (tag === undefined) break;
    out.push(tag);
    cur = originalOf(cur);
  }
  return out;
}

/** 每个模块一个 patcher 实例（各有独立的 owner），与生产一致。 */
function makePatcher(who, stats) {
  const owner = Symbol('owner-' + who);
  const p = createPatcher({ owner, log: () => {}, stats, label: who });
  // 包一层，把 who 记到包装上，方便摊平链时看清是谁。
  return (proto, method, moduleId, makeWrapper) =>
    p(proto, method, moduleId, (original) => {
      const wrapped = makeWrapper(original);
      wrapped.__who = who + ':' + moduleId;
      return wrapped;
    });
}

const stats = { patched: [], lost: [] };

const A = makePatcher('A', stats); // 先挂的（模拟 rhythm）
const B = makePatcher('B', stats); // 后挂的（模拟 stamp）

const proto = {
  dispatchFollowup() {
    return 'upstream';
  },
};

const wrapA = (original) => function A_wrap(...args) {
  return original.apply(this, args);
};
const wrapB = (original) => function B_wrap(...args) {
  return original.apply(this, args);
};

console.log('--- 同一轮：A 先挂，B 后挂 ---');
A(proto, 'dispatchFollowup', 'rhythm', wrapA);
B(proto, 'dispatchFollowup', 'stamp', wrapB);
console.log('chain =', chainOf(proto.dispatchFollowup).join(' -> '));

console.log('\n--- 之后每轮两个模块都 scan（顺序：A 再 B） ---');
for (let round = 1; round <= 4; round += 1) {
  const before = chainOf(proto.dispatchFollowup).join(' -> ');
  const ra = A(proto, 'dispatchFollowup', 'rhythm', wrapA);
  const rb = B(proto, 'dispatchFollowup', 'stamp', wrapB);
  const after = chainOf(proto.dispatchFollowup).join(' -> ');
  console.log(
    `round ${round}: A=${ra} B=${rb}\n   before: ${before}\n   after : ${after}${before === after ? '   (稳定)' : '   ⚠️ 翻转了'}`,
  );
}

console.log('\n--- stats.patched 累积 ---');
console.log('条数 =', stats.patched.length);
console.log(stats.patched.map((p) => p.moduleId + ':' + p.method).join(', '));
