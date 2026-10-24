/**
 * dsh-onebot-companion / test/stamp-restart.mjs
 *
 * 回归闸：**重启后第一条消息也要拿到真实 gap**。
 *
 * 这是落盘基线（`stamp-state.json`）存在的**全部理由**。当年 `inbound-state.js`
 * 的头注释写得很清楚：进程内 Map 一重启就空，重启后第一条只能省略 gap，于是
 * 「模型失去唯一可信锚点后转而去读 time-context 旁白的 Elapsed 行，把『两个小时』
 * 说成『过了一整天』」。
 *
 * 2026-10-15 实测抓到的 bug：`storeFor()` 里是 `void store.load()`（异步），而
 * `previousFor()` 在**同一个调用栈**里先写后读 —— 异步 load 永远赶不上，
 * 重启后第一条必定 miss，gap 白丢。文件里明明存着 lastAt，`gap=` 却仍是空。
 *
 * 所以本闸真的造两个 `createStamp` 实例（模拟两次进程），走完整 scan 挂载路径，
 * 中间真的等一次 debounce 落盘。
 *
 * 跑法：node test/stamp-restart.mjs
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStamp } from '../lib/modules/stamp.js';

let pass = 0;
let fail = 0;
const check = (label, condition, detail) => {
  if (condition === true) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : `  → ${detail}`}`);
  }
};

// ── 假 profile：scan 需要 dsh-onebot-qq/lib/{bridge,chat}.js ──────────────────
// 目录必须含 `profiles/<name>` 段，core/profile.js 的 PROFILE_RE 才认。
const base = await mkdtemp(join(tmpdir(), 'stamp-restart-'));
const mediaDir = join(base, 'media');
const profile = join(base, 'profiles', 'fake');
const pkgLib = join(profile, 'node_modules', 'dsh-onebot-qq', 'lib');
await mkdir(pkgLib, { recursive: true });
await mkdir(mediaDir, { recursive: true });

await writeFile(
  join(profile, 'node_modules', 'dsh-onebot-qq', 'package.json'),
  JSON.stringify({ name: 'dsh-onebot-qq', version: '0.0.0-fake', type: 'module', main: 'lib/index.js' }),
  'utf8',
);
await writeFile(
  join(pkgLib, 'chat.js'),
  `export function buildChatId(kind, target) {
  return kind === 'private' ? 'private:' + target : 'group:' + target;
}
export function sessionIdForChat(chatId) {
  return 'onebot-' + chatId.replace(/[^A-Za-z0-9-]/g, '-');
}
`,
  'utf8',
);
await writeFile(
  join(pkgLib, 'bridge.js'),
  `export class ChatBridge {
  constructor() { this.calls = []; }
  handleInbound(event) { return 'inbound-original'; }
  dispatchFollowup(chatId, text) { this.calls.push(text); return 'dispatch-original'; }
}
`,
  'utf8',
);

const bridgeMod = await import(pathToFileURL(join(pkgLib, 'bridge.js')).href);
const ChatBridge = bridgeMod.ChatBridge;

// mediaDir 从 bridge 实例的 `deps.config` 里取 —— 与生产路径一致
// （`stamp.js` 的 `mediaDirOf()` 读的就是 `receiver.deps.config.mediaDir`）。
const makeBridge = () => {
  const b = new ChatBridge();
  b.deps = { config: { mediaDir } };
  return b;
};

const cfgBase = {
  packageName: 'dsh-onebot-qq',
  profileDir: profile,
  enabled: true,
  injectTime: true,
  injectGap: true,
  logStamps: false,
};
const ctx = {};

const mkStats = () => ({
  stamped: 0,
  lastStampAt: null,
  lastStampKind: null,
  lastStampChat: null,
  lastStampTime: null,
  lastStampGap: null,
  stampResolveError: null,
  stampProfileDir: '',
  stampStateFile: '',
  stampEnabled: true,
  scans: 0,
  lastScanAt: null,
  lost: [],
  patched: [],
});

/** 一个「进程」：全新的 createStamp 实例 + 全新的内存 baseline。 */
async function boot() {
  const stats = mkStats();
  const patchMethod = (proto, method, moduleId, makeWrapper) => {
    const original = proto[method];
    const wrapped = makeWrapper(original);
    wrapped.__onebotCompanionOriginal = original;
    proto[method] = wrapped;
    return true;
  };
  patchMethod.unpatch = (proto, method) => {
    const cur = proto[method];
    if (typeof cur?.__onebotCompanionOriginal !== 'function') return false;
    proto[method] = cur.__onebotCompanionOriginal;
    return true;
  };
  const stamp = createStamp({ cfg: { ...cfgBase }, stats, patchMethod, log: () => undefined });
  const result = await stamp.scan(ctx);
  return { stamp, stats, result };
}

const CHAT = 'private:100000001';
const um = (body) => `<user_message qq="100000001" nickname="示例用户">\n${body}\n</user_message>`;

// ── 进程 A：收一条，让基线落盘 ───────────────────────────────────────────────
console.log('进程 A（首次运行）');
const a = await boot();
check('A: scan 挂上两个闸', a.result.ok === true && a.result.patched === 2, JSON.stringify(a.result));

const bridgeA = makeBridge();
bridgeA.handleInbound({ message_type: 'private', user_id: 100000001, time: 1_759_000_000 });
bridgeA.dispatchFollowup(CHAT, um('hi'), 'member', '示例用户');
const aText = bridgeA.calls.at(-1) ?? '';
check('A: 第一条注入了 time=', / time="/.test(aText));
check('A: 第一条没有 gap（内存空、盘上也没有）', !/ gap="/.test(aText));
check('A: 第一条后 stampStateFile 已指向 mediaDir 下的文件', a.stats.stampStateFile === join(mediaDir, 'stamp-state.json'), a.stats.stampStateFile);

// 等 debounce（JsonStore 默认 3000ms）落盘
await new Promise((resolve) => setTimeout(resolve, 3600));
const onDisk = JSON.parse(await readFile(join(mediaDir, 'stamp-state.json'), 'utf8'));
check('A: 基线真的落盘了', onDisk[CHAT]?.lastAt === 1_759_000_000_000, JSON.stringify(onDisk));

// ── 进程 B：全新实例（内存 baseline 为空），第一条必须从盘上读回基线 ────────
console.log('进程 B（重启）');
// `detach` 内部已经遍历 METHODS 摘掉本模块的所有层，外部**不要**再循环调 ——
// 重复调会把下一个实例刚挂上的层也当作链头摘掉。
await a.stamp.detach(ctx);
await new Promise((resolve) => setTimeout(resolve, 100));

const b = await boot();
check('B: scan 挂上两个闸', b.result.ok === true && b.result.patched === 2, JSON.stringify(b.result));
check('B: 内存 baseline 是空的（确实是重启）', b.stamp.baselineCount() === 0, String(b.stamp.baselineCount()));

const bridgeB = makeBridge();
// 距 A 那条 300 秒 —— 盘上存着基线，所以 gap 应当是 5m
bridgeB.handleInbound({ message_type: 'private', user_id: 100000001, time: 1_759_000_300 });
bridgeB.dispatchFollowup(CHAT, um('hi again'), 'member', '示例用户');
const bText = bridgeB.calls.at(-1) ?? '';

check('B: 第一条注入了 time=', / time="/.test(bText), bText.slice(0, 120));
check(
  'B: 重启后第一条拿到了盘上基线（gap=5m）',
  / gap="5m"/.test(bText),
  bText.slice(0, 160),
);
check('B: stats.lastStampGap 记成 5m', b.stats.lastStampGap === '5m', JSON.stringify(b.stats.lastStampGap));

// ── 反向：基线为「未来」时 gap 必须留空，不许算出负数或巨大值 ───────────────
console.log('边界：基线在未来');
// 先摘掉 B 的层，**再**挂 C —— 反过来 detach 会把刚挂上的 C 层当成链头摘掉。
await b.stamp.detach(ctx);
await new Promise((resolve) => setTimeout(resolve, 100));
const c = await boot();
const bridgeC = makeBridge();
// 同一 chat，但推送的时刻**早于**盘上基线（时钟回拨 / 上游补发旧消息）
bridgeC.handleInbound({ message_type: 'private', user_id: 100000001, time: 1_759_000_000 });
bridgeC.dispatchFollowup(CHAT, um('old message'), 'member', '示例用户');
const cText = bridgeC.calls.at(-1) ?? '';
check('C: 时刻早于基线时 gap 留空（不算负数）', !/ gap="/.test(cText), cText.slice(0, 160));
check('C: time= 照常注入', / time="/.test(cText));

console.log('');
console.log(`pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('⚠️ 重启后第一条的 gap 又丢了 —— 检查 stamp.js 的 storeFor/previousFor 是不是退回了异步 load。');
  process.exit(1);
}
