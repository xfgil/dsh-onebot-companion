/**
 * unsaid 模块自测（可执行入口）。
 *
 * 用法：node test/unsaid.test.mjs
 */
import { createUnsaid, DEFAULTS } from '../lib/modules/unsaid.js';

const result = await createUnsaid({
  cfg: { ...DEFAULTS },
  stats: {},
  log: () => undefined,
  resolveMediaDir: () => '',
}).selfTest();

let pass = 0;
let fail = 0;
for (const c of result.checks) {
  if (c.ok) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL  ${c.name}`);
  }
}
console.log(`\nunsaid: ${pass} 通过 / ${fail} 失败（共 ${result.total} 项）`);
process.exit(fail === 0 ? 0 : 1);
