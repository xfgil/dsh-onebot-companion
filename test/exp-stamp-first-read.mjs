/**
 * 探针：stamp 的落盘基线在「首次读取」时到底能不能拿到？
 *
 * 疑点（2026-10-15）：`lib/modules/stamp.js` 的 `storeFor()` 里是
 *     void store.load();          // fire-and-forget
 *     return store;
 * 而调用方 `previousFor()` 紧接着**同步** `.get(chatId)`。若这是真的，
 * 那么 `previousFor` 上那句注释「重启后第一条也能拿到真实间隔」就是假的。
 *
 * 本探针不碰生产代码，只复刻 `JsonStore` 的时序来回答两件事：
 *   ① 新建 store + void load() + 立刻 get() → 拿到什么？
 *   ② load 完成若晚于 remember()，落盘旧值会不会反过来覆盖内存新值？
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonStore, stateFilePath } from '../lib/core/jsonstore.js';

let pass = 0;
const fails = [];
function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fails.push(label);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const noop = () => {};

// ── 造一份「重启前就存在」的落盘状态 ────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), 'stamp-first-read-'));
const file = stateFilePath(dir, 'stamp-state.json');
const CHAT = 'private:100000001';
const BEFORE = 1_791_993_813_000; // 重启前记下的那次入站时刻
await writeFile(
  file,
  JSON.stringify({ [CHAT]: { lastAt: BEFORE } }),
  'utf8',
);

// ── ① 复刻 storeFor 的时序：new → void load() → 同步 get() ──────────────────
const store = new JsonStore({
  file,
  label: 'probe/stamp',
  log: noop,
  normalize: (value) => {
    const raw = typeof value === 'number' ? value : value?.lastAt;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
    return { lastAt: raw };
  },
});

const loadPromise = store.load(); // 与生产同形：不 await
const immediate = store.get(CHAT);
check(
  '① 立刻读（load 未完成）拿不到落盘基线 —— 这正是 previousFor 的处境',
  immediate === undefined,
  `实际 = ${JSON.stringify(immediate)}（落盘里明明有 lastAt=${BEFORE}）`,
);

await loadPromise; // 等它真的读完
const afterLoad = store.get(CHAT);
check(
  '①b await 之后才拿得到',
  afterLoad?.lastAt === BEFORE,
  `实际 = ${JSON.stringify(afterLoad)}`,
);

// ── ② load 晚于 remember：旧值会不会覆盖新值？ ──────────────────────────────
const store2 = new JsonStore({
  file,
  label: 'probe/stamp2',
  log: noop,
  normalize: (value) => {
    const raw = typeof value === 'number' ? value : value?.lastAt;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
    return { lastAt: raw };
  },
});

const AT_NEW = BEFORE + 60_000; // 本次新消息的时刻
const slow = store2.load(); // 起读（异步，故意不 await —— 复刻生产）
store2.set(CHAT, { lastAt: AT_NEW }); // remember() 先写内存
const memBeforeLoad = store2.get(CHAT)?.lastAt;
check(
  '② remember 后内存是新值',
  memBeforeLoad === AT_NEW,
  `实际 = ${memBeforeLoad}`,
);

await slow; // 读完成
const memAfterLoad = store2.get(CHAT)?.lastAt;
check(
  '②b load 完成后内存**没有被旧值覆盖**',
  memAfterLoad === AT_NEW,
  memAfterLoad === BEFORE
    ? `被落盘旧值覆盖回去了：新值 ${AT_NEW} → 旧值 ${memAfterLoad}（gap 会算成跨了一次重启的时长）`
    : `实际 = ${memAfterLoad}`,
);

await rm(dir, { recursive: true, force: true });

console.log('');
if (fails.length === 0) {
  console.log(`PASS（${pass} 项）`);
} else {
  console.log(`FAIL（${fails.length} 项）`);
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
