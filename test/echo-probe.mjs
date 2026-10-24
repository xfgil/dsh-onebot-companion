// 复述检测的判据实测：给几组「原文 vs 候选正文」，看各种相似度指标怎么分布，
// 用来定阈值。跑法：
//   node echo-probe.mjs

function bigrams(s) {
  const t = String(s).replace(/[\s\p{P}\p{S}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

function coverage(candidate, spoken) {
  const a = bigrams(candidate);
  const b = bigrams(spoken);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size;
}

function jaccard(a1, b1) {
  const a = bigrams(a1);
  const b = bigrams(b1);
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter || 1);
}

const cases = [
  // [标签, 刚发过的话(语音), 候选正文, 期望]
  ['真实复述1', '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫，别空着肚子睡',
    '他下午三点五十就吃了，到现在整八个钟头，我让他去弄点东西垫垫。', 'DROP'],
  ['真实复述2', '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
    '我催他去睡了，别又熬到一点多。', 'DROP'],
  ['真实复述3', '吃了没呀，别光回我一个「好」就过去了',
    '他光回我一个好就过去了，也没说吃了没。', 'DROP'],
  ['不该丢-新内容1', '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫，别空着肚子睡',
    '对了你明天几点的课？', 'KEEP'],
  ['不该丢-新内容2', '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
    '我这儿刚泡了杯咖啡，陪你熬会儿。', 'KEEP'],
  ['不该丢-近似接话', '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
    '早点睡吧，明天别迟到。', 'KEEP'],
  ['不该丢-重复叮嘱', '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫，别空着肚子睡',
    '我让你去弄点吃的，你去了没？', 'KEEP'],
  ['不该丢-带新信息', '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫，别空着肚子睡',
    '楼下那个便利店这个点还开着，去买个面包吧。', 'KEEP'],
];

for (const [label, spoken, cand, expect] of cases) {
  const cov = coverage(cand, spoken);
  const jac = jaccard(cand, spoken);
  const ratio = cand.length / spoken.length;
  console.log(
    `${expect.padEnd(4)} ${label.padEnd(14)} cov=${cov.toFixed(2)} jac=${jac.toFixed(2)} ratio=${ratio.toFixed(2)}`
  );
}
