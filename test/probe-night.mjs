// 深夜档 + 「搭过没回不追」的独立验证（不碰宿主，纯模块级）。
import { ProactiveScheduler } from '../lib/modules/proactive.js';

const log = (...a) => console.log(...a);
let pass = 0;
let fail = 0;
const ok = (cond, name) => {
  if (cond) { pass += 1; log('  ✔', name); } else { fail += 1; log('  ✘', name); }
};

// 1) 深夜档：23:30 触发时 info.deepNight 应为 true
{
  const infos = [];
  const t = new Date(2026, 9, 20, 23, 30).getTime();
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveQuietStart: 1, proactiveQuietEnd: 8 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:100000001' }],
    eligible: () => true,
    idleMs: () => 3600_000,
    chance: () => 1,
    fire: async (c, i) => infos.push(i),
    random: () => 0.5,
    now: () => t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  ok(infos.length === 1 && infos[0].deepNight === true, '23:30 → deepNight=true');
}

// 2) 追着喊的回归锁：搭完一句他没回，后面两小时不再搭
{
  let fired = 0;
  let t = 0;
  const s = new ProactiveScheduler({
    config: { proactiveEnabled: true, proactiveQuietStart: 0, proactiveQuietEnd: 0 },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:100000001' }],
    eligible: () => true,
    idleMs: () => 5 * 3600_000,
    chance: () => 1,
    fire: async () => { fired += 1; },
    random: () => 0.5,
    now: () => t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  ok(fired === 1, '冷场第一次：搭一句');
  for (let i = 0; i < 4; i += 1) {
    t += 3600_000;
    await s.evaluate(); // 模拟四小时内反复评估
  }
  ok(fired === 1, '四小时反复评估也只搭过那一次（不追）');
  s.noteUserReply('private:100000001');
  await s.evaluate();
  ok(fired === 2, '他回话之后，下一次冷场才会再搭');
}

// 3) 锁有过期：他睡了一整夜没回，第二天还是能再开口一次
{
  let fired = 0;
  let t = 0;
  const s = new ProactiveScheduler({
    config: {
      proactiveEnabled: true,
      proactiveQuietStart: 0,
      proactiveQuietEnd: 0,
      proactiveAwaitReplyHours: 16,
    },
    log: () => {},
    isStopping: () => false,
    listChats: () => [{ chatId: 'private:100000001' }],
    eligible: () => true,
    idleMs: () => 5 * 3600_000,
    chance: () => 1,
    fire: async () => { fired += 1; },
    random: () => 0.5,
    now: () => t,
    setTimer: () => 1,
    clearTimer: () => {},
  });
  await s.evaluate();
  ok(fired === 1 && s.awaitingReply('private:100000001'), '锁生效');
  t += 15 * 3600_000;
  await s.evaluate();
  ok(fired === 1, '15 小时内仍然不追');
  t += 2 * 3600_000; // 累计 17 小时，超过 16 小时上界
  await s.evaluate();
  ok(fired === 2, '超过上界后允许再开口一次（不是永久锁死）');
}

log(`\npass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
