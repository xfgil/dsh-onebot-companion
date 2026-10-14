// 顶层总开关 / 模块级开关的语义测试。
//
// 为什么单列一个文件：`selftest.mjs` 只走「挂载 + 真调用」，从没碰过
// `POST /toggle` / `POST /module` 这两条改配置的路径 —— 于是 2026-10-14 之前
// 「总开关点了等于没点」这种 bug 能一路活到线上还报 299 项全过。
//
// 这里测的是 `mergeConfig()` 返回的各段 `enabled`：
//   · 默认全开
//   · 顶层 `enabled:false` 一票否决全部模块，且**运行时**改也能立刻反映
//     （`/toggle` 只改顶层，模块早拿着自己的子对象了）
//   · 模块级 `enabled:false` 只关自己
//   · 顶层开关来回切**不吞掉**模块级意图（回到原值后模块该关还是关）
//   · `JSON.stringify` 能读出该值（`persist()` 落盘依赖它）
import { mergeConfig } from '../lib/index.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${msg}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${msg}`);
  }
};

console.log('== 顶层总开关 ==');
const cfg = mergeConfig({});
ok(cfg.guard.enabled === true, '默认 guard.enabled = true');
ok(cfg.voice.enabled === true, '默认 voice.enabled = true');

cfg.enabled = false; // 模拟 POST /toggle {"enabled":false}
ok(cfg.guard.enabled === false, '总开关关后 guard.enabled 变 false（运行时可反映）');
ok(cfg.prompt.enabled === false, '总开关关后 prompt.enabled 变 false');
ok(cfg.rhythm.enabled === false, '总开关关后 rhythm.enabled 变 false');
ok(cfg.persona.enabled === false, '总开关关后 persona.enabled 变 false');
ok(cfg.voice.enabled === false, '总开关关后 voice.enabled 变 false');

cfg.enabled = true; // 模拟 /toggle {"enabled":true}
ok(cfg.guard.enabled === true, '总开关开回来 guard.enabled 恢复 true');

console.log('== 模块级开关 ==');
const c2 = mergeConfig({});
c2.guard.enabled = false; // 模拟 POST /module
ok(c2.guard.enabled === false, '单关 guard 生效');
ok(c2.rhythm.enabled === true, '单关 guard 不影响 rhythm');
c2.enabled = false;
c2.enabled = true;
ok(c2.guard.enabled === false, '总开关来回切换不吞掉模块级意图（仍为 false）');
ok(c2.rhythm.enabled === true, '总开关来回切换不影响未关的模块');

console.log('== 配置里直接写 enabled:false ==');
const c3 = mergeConfig({ guard: { enabled: false } });
ok(c3.guard.enabled === false, 'YAML 里 guard.enabled:false 生效');
ok(c3.voice.enabled === true, '不影响 voice');

console.log('== JSON 序列化（状态落盘）==');
const c4 = mergeConfig({});
const j = JSON.parse(JSON.stringify(c4.guard));
ok(j.enabled === true, 'JSON.stringify 能读出 enabled（persist 依赖）');

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
