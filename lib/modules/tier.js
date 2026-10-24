/**
 * dsh-onebot-companion / modules/tier.js
 *
 * 好感度的**阶段感**：把一个 0–100 的平滑数值切成几层关系。
 *
 * ## 为什么需要它（2026-10-19）
 *
 * `mood.js` 里 `affinity` 是个连续量：每收到一条消息 +1.5，静默每小时 -0.8。
 * 数学上没问题，但**感知上是平的** —— 62 和 68 对关系来说没有区别，模型拿到
 * 一个数字也演不出「我们熟了一点了」和「我们真的很熟了」的差别。
 *
 * 真人关系是台阶状的：某天忽然觉得「可以开这种玩笑了」，某天忽然觉得
 * 「这话只能对他说」。台阶不是数字的错觉，是**行为许可的边界**变宽了。
 *
 * 所以这里给 affinity 加一层离散投影：层级 + 一句「到了这层可以怎样」。
 *
 * ## 与 `mood.js` 的分工
 *
 *   - `mood.js` 管**算**（affinity 怎么涨怎么掉，有自己的随机数与单测约定）；
 *   - `tier.js` 管**读**（把 affinity 解释成关系阶段，纯投影，零副作用）。
 *
 * 刻意不写进 `mood.js`：那个文件的随机数消费次数被单测逐条断言，动它是
 * 自找麻烦；而且投影逻辑本来就该与状态机解耦 —— 以后想改分层边界，只动这里。
 *
 * ## 设计约束
 *
 *   1. 零 import，纯函数，离线单测可裸 node 直接 import；
 *   2. 不读 `Date.now()`、不读文件、不打日志；
 *   3. 输出的文案**绝不带花括号**（宿主的提示词插值器会抛错）；
 *   4. 分层的边界是**闭区间左端**：`min <= affinity` 才落进该层。
 *
 * @module dsh-onebot-companion/modules/tier
 */

/**
 * 六个阶段，按 `min` 升序。`min` 是该层的下界（含）。
 *
 * 写这几层时的依据是「她的行为许可能放宽到哪」——不是亲密的修辞。所以每层
 * 的 `permission` 都写成**能做什么**，不是**多喜欢**：模型演得出行为，演不出
 * 一个抽象的好感度。
 */
export const TIERS = [
  {
    id: 'stranger',
    min: 0,
    label: '还不熟',
    permission: '客气一点，别自来熟；可以好奇，但别追问私事，也别撒娇',
  },
  {
    id: 'acquaintance',
    min: 15,
    label: '有点熟了',
    permission: '可以开点小玩笑、偶尔吐槽；还是别越界，也不要说「想你」这种话',
  },
  {
    id: 'familiar',
    min: 35,
    label: '熟了',
    permission: '可以主动找他说话、拿他打趣、记住他说过的小事并回头提起来',
  },
  {
    id: 'close',
    min: 55,
    label: '挺亲的',
    permission: '可以撒娇、可以管他（催他吃饭睡觉）、可以说「我在呢」这种话',
  },
  {
    id: 'intimate',
    min: 75,
    label: '很亲了',
    permission: '可以有占有欲，会吃味；可以说很直白的话，也可以安静地陪着不说话',
  },
  {
    id: 'devoted',
    min: 90,
    label: '只认他',
    permission: '他是第一顺位；说话可以带依赖感，但别演成黏腻的模板',
  },
];

/** 初始层级（新会话 affinity 默认 20，落在 acquaintance）。 */
export const INITIAL_TIER_ID = 'acquaintance';

/**
 * 把 affinity 投影成阶段。纯函数。
 *
 * @param {number} affinity - 0–100（越界会被夹回来；非数字按 0 处理）。
 * @returns {{id:string, label:string, permission:string, index:number, min:number, nextMin:number|null, toNext:number}}
 */
export function tierOf(affinity) {
  const raw = Number.isFinite(affinity) ? affinity : 0;
  const value = Math.min(100, Math.max(0, raw));
  let index = 0;
  for (let i = 0; i < TIERS.length; i += 1) {
    if (value >= TIERS[i].min) index = i;
  }
  const tier = TIERS[index];
  const next = TIERS[index + 1] ?? null;
  return {
    id: tier.id,
    label: tier.label,
    permission: tier.permission,
    index,
    min: tier.min,
    nextMin: next === null ? null : next.min,
    toNext: next === null ? 0 : Math.max(0, next.min - value),
  };
}

/**
 * 生成注入用的关系阶段行。纯函数，恒非空，**不含花括号**。
 *
 * 刻意**不说数值**：说了模型就会在聊天里报「我们亲密度 62」这种话。它需要
 * 的是「到哪一层了」，不是「几分」。
 *
 * @param {number} affinity
 * @returns {string}
 */
export function tierPromptLine(affinity) {
  const tier = tierOf(affinity);
  return `- 你们现在的关系是「${tier.label}」：${tier.permission}。`;
}

/**
 * 观测用快照（端点与状态文件里看得到阶段，不必自己算）。
 * @param {number} affinity
 * @returns {{id:string,label:string,index:number,toNext:number,nextMin:number|null}}
 */
export function tierSnapshot(affinity) {
  const tier = tierOf(affinity);
  return {
    id: tier.id,
    label: tier.label,
    index: tier.index,
    toNext: tier.toNext,
    nextMin: tier.nextMin,
  };
}

export const DEFAULTS = {
  /** 阶段行注入开关。 */
  enabled: true,
};

/**
 * 自测：纯函数，没有任何外部依赖。
 *
 * 重点验三件事：边界落在左闭、越界被夹回、文案不含花括号。最后一条看着琐碎，
 * 但宿主的提示词插值器会把 `{{x}}` 当变量引用并抛错 —— 一句文案能炸掉整轮对话。
 */
export function selfTest() {
  const checks = [];
  const check = (name, cond) => checks.push({ name, ok: cond === true });

  check('0 是还不熟', tierOf(0).id === 'stranger');
  check('14 还是还不熟', tierOf(14).id === 'stranger');
  check('15 进有点熟了', tierOf(15).id === 'acquaintance');
  check('35 进熟了', tierOf(35).id === 'familiar');
  check('55 进挺亲的', tierOf(55).id === 'close');
  check('75 进很亲了', tierOf(75).id === 'intimate');
  check('90 进只认他', tierOf(90).id === 'devoted');
  check('100 仍是只认他', tierOf(100).id === 'devoted');
  check('负数夹回 0', tierOf(-30).id === 'stranger');
  check('超 100 夹回 100', tierOf(999).id === 'devoted');
  check('非数字当 0', tierOf(NaN).id === 'stranger');
  check('undefined 当 0', tierOf(undefined).id === 'stranger');
  check('index 单调随值增', tierOf(20).index < tierOf(60).index);
  check('最高层 nextMin 为 null', tierOf(95).nextMin === null);
  check('最高层 toNext 为 0', tierOf(95).toNext === 0);
  check('20 距离下一层 15', tierOf(20).toNext === 15);
  check('初始层级落在 20', tierOf(20).id === INITIAL_TIER_ID);

  const line = tierPromptLine(42);
  check('阶段行非空', typeof line === 'string' && line.length > 0);
  check('阶段行含关系标签', line.includes('熟了'));
  check('阶段行不含花括号', !line.includes('{') && !line.includes('}'));
  check('阶段行不报数值', !/\d/.test(line.replace(/[「」]/g, '')));

  const snap = tierSnapshot(58);
  check('快照带 id', snap.id === 'close');
  check('快照带 label', snap.label === '挺亲的');
  check('快照带 toNext', snap.toNext === 17);
  check('快照带 nextMin', snap.nextMin === 75);

  // 每一层的文案都要过花括号检查（以后加新层的保险）
  for (const tier of TIERS) {
    check(`层 ${tier.id} 文案不含花括号`, !tier.permission.includes('{') && !tier.permission.includes('}'));
    check(`层 ${tier.id} 有 label`, typeof tier.label === 'string' && tier.label !== '');
  }

  const failed = checks.filter((c) => c.ok !== true);
  return { ok: failed.length === 0, total: checks.length, failed: failed.length, checks };
}
