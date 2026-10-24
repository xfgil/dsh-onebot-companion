/**
 * dsh-onebot-companion / modules/echo.js
 *
 * 拦住「把刚说出口的话再转述一遍」——**复述闸**。
 *
 * ## 到底出了什么事（2026-10-19 23:13，QQ 私聊 100000001）
 *
 * 用户在截图里看到我在同一个对话框里，对同一件事说了两遍，第二遍还是
 * **第三人称**的：
 *
 *   用户：「下午三点五十就吃了」
 *   → `qq_say`：「三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫」
 *   → 下一步正文：「他下午三点五十就吃了，到现在整八个钟头，我让他去弄点东西垫垫。」
 *
 * turn 43 一模一样：
 *   → `qq_say`：「那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多」
 *   → 正文：「我催他去睡了，别又熬到一点多。」
 *
 * 用户的原话是「什么个情况？怎么还有这种给第三方讲解的」。
 *
 * ## 为什么会出现
 *
 * `qq_say` 发完语音，那一步就结束了；宿主让模型继续往下说。模型**不知道
 * 语音已经发出去了**（工具结果只说「已发语音（45072 bytes…）」），于是把
 * 刚才干的事当成「还没汇报的进度」再讲一遍。讲的时候又切回了「描述一个
 * 不在场的人」的口吻，于是「你」变成了「他」。
 *
 * ## 为什么放到出站闸
 *
 * 提示词早就写了「话发完就发完了，别补一句『我在等他回话』」，而
 * `aside.js` 的 `isNarrationOnly` 拦的也是「等第三人称的反应」这种**纯自述**。
 * 但这一条是正常句子 + 括号都没有，规则层和自述判据都抓不到 ——
 * 它长得完全像一句要对人说的话，只是**内容跟刚发过的重合**。
 *
 * ## 判据（宁漏勿错，实测标定）
 *
 * 两件事同时成立才丢：
 *
 *   1. **跟同一会话里刚发出去的话（默认 120 秒内）字面重合度高**。
 *      用 bigram 覆盖率（候选的字符二元组有多大比例在原文里出现过）。
 *      `test/echo.test.mjs` 的实测分布（样本取自真实对话）：
 *        真实复述   cov = 0.18 / 0.30 / 0.33 / 0.69
 *        不该丢的话 cov = 0.00 ~ 0.08
 *      取 **0.16** 作门槛，落在两簇之间 0.10 宽的空档里。
 *
 *      注意 0.18 那条（`我提醒他明天有早八，别熬夜。` ↔ `明天早八呢，快睡吧，
 *      别又搞到一点多啊`）是分布下沿：复述做了较多改写时覆盖率会掉到这一步。
 *      再往下调就进入正常对话的区间了，所以别为了多拦一两条而压到 0.1。
 *
 *   2. **候选正文用第三人称指代对方**（「他」「她」）。
 *      这是真正的硬支点：**跟正在说话的人讲话，不会用「他」指人家**。
 *      真人转述别人时才用「他」，所以这一条把「聊第三方」的情况挡在外面 ——
 *      例外是 `他说的 / 他们说 / 他的意思` 这类**引用别人话**的场合，
 *      那些下面单独放行。
 *
 * 或者候选几乎就是原文（cov ≥ 0.6）—— 这种情况连代词都不用看，重得离谱。
 *
 * ## 边界
 *
 * - 只对**短消息**（默认 ≤ 100 字）生效。长的多半在讲新事情。
 * - 时间窗过期就忘，不会隔天还在拦同一句。
 * - 只记 `qq_say` 真发出去的语音文本；没发过语音的会话完全不启用这条闸，
 *   日常聊天零影响。
 *
 * @module dsh-onebot-companion/modules/echo
 */

/** 默认参数。改这些前先跑 `test/echo-probe.mjs` 看分布有没有变。 */
export const DEFAULTS = {
  /** 开关。 */
  enabled: true,
  /** 记忆窗口：多少毫秒内发过的话算「刚说过」。 */
  windowMs: 120000,
  /** bigram 覆盖率门槛。实测：真实复述 ≥0.18，误伤区 ≤0.08。取得离误伤区更远一点。 */
  minCoverage: 0.16,
  /** 覆盖率到这个数就不管代词了（几乎逐字重复）。 */
  strongCoverage: 0.6,
  /** 只看这么短的消息（字）。 */
  maxLen: 100,
  /**
   * 比这更短的一律不判（字）。
   *
   * 必须要有这个下限：`好呀` 这种两个字的回复，两个 bigram 自然全覆盖，
   * 覆盖率 1.0 直接判成复述 —— 但它就是正常应答。真正要拦的复述
   * （`我催他去睡了，别又熬到一点多。`）都在 14 字以上。
   */
  minLen: 8,
  /** 每个会话最多记几条。 */
  perChatMax: 12,
};

/** 去掉空白与标点，只留实字。标点差异不该影响「是不是同一句话」。 */
function compact(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符二元组集合。单字时退化成单字集合，避免空集。 */
export function bigrams(text) {
  const t = compact(text);
  const out = new Set();
  if (t.length === 0) return out;
  if (t.length === 1) {
    out.add(t);
    return out;
  }
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 候选里有多大比例的内容在参照文本里出现过。
 *
 * 用「候选覆盖率」而不是 Jaccard：复述往往是**缩写**（语音说三句，正文
 * 压成一句），Jaccard 会被长度差拉低到 0.13 那种程度、分不开，而覆盖率
 * 只看「候选说的东西原文有没有」，缩写了照样高。
 *
 * @param {string} candidate 候选正文
 * @param {string} reference 刚发过的话
 * @returns {number} 0~1
 */
export function coverage(candidate, reference) {
  const a = bigrams(candidate);
  const b = bigrams(reference);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return hit / a.size;
}

/**
 * 这句话是不是在用第三人称指代对方。
 *
 * 排除两类：`他人`（泛指别人）、`他说的 / 他们说 / 他的意思`（引用别人的话，
 * 那是真的在聊第三方，不该拦）。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function usesThirdPerson(text) {
  // 「他人」是个词（泛指别人），不是「他」+「人」，先摘掉再判。
  const t = String(text ?? '').replace(/他人/g, '');
  if (!/[他她]/.test(t)) return false;
  // 引用别人的话 / 转述别人的看法 —— 那是真的在聊第三方，放行。
  //
  // ⚠️ 只列「说/讲/问/…」这类**引用动词**，绝不能把「让/叫」加进来：
  // 实测复述原文就是「我**让他**去弄点东西垫垫」「我催**他**去睡了」，
  // 「让他去做某事」是祈使、不是引用，加进来会让真实复述整条漏网。
  if (/[他她](?:们|说|讲|问|告诉|觉得|认为|提到|回复|意思|的话)/.test(t)) return false;
  return true;
}

/**
 * 核心判定：候选正文是不是「刚发过的那句话」的转述。
 *
 * @param {string} candidate 要发出去的正文
 * @param {string[]} recent 同一会话里最近发过的话（新的在后面）
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {{ echo: boolean, score: number, hit: string }}
 *   `hit` 是命中的参照原文（截断到 120 字），便于审计与日志。
 */
export function detectEcho(candidate, recent, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const text = String(candidate ?? '').trim();
  if (text === '') return { echo: false, score: 0, hit: '' };
  if (text.length > cfg.maxLen) return { echo: false, score: 0, hit: '' };
  if (text.length < cfg.minLen) return { echo: false, score: 0, hit: '' };
  if (!Array.isArray(recent) || recent.length === 0) return { echo: false, score: 0, hit: '' };

  let best = { echo: false, score: 0, hit: '' };
  for (const ref of recent) {
    const s = coverage(text, ref);
    const strong = s >= cfg.strongCoverage;
    const lookalike = s >= cfg.minCoverage && usesThirdPerson(text);
    if (strong || lookalike) {
      // 命中：留覆盖率最高的那条作为证据。
      if (best.echo === false || s > best.score) {
        best = { echo: true, score: s, hit: String(ref).slice(0, 120) };
      }
      continue;
    }
    // 没命中时只记最高分（供观测阈值是否偏低），绝不能被它覆盖掉已命中的结论。
    if (best.echo === false && s > best.score) best = { echo: false, score: s, hit: '' };
  }
  return best;
}

/**
 * 各会话「最近发过的话」的记忆。
 *
 * 刻意做成**内存态、不落盘**：它服务的是「同一个回合内别复述」，跨重启
 * 没有任何意义，落盘反而会让隔天的旧话在重启后被当成参照。
 */
export function createEchoMemory(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  /** @type {Map<string, Array<{ text: string, at: number }>>} */
  const byChat = new Map();

  /** 记一条刚发出去的话（语音、或已经通过闸的正文）。 */
  function remember(chatId, text) {
    const id = String(chatId ?? '');
    const body = String(text ?? '').trim();
    if (id === '' || body === '') return;
    const now = Date.now();
    const list = byChat.get(id) ?? [];
    list.push({ text: body, at: now });
    while (list.length > cfg.perChatMax) list.shift();
    byChat.set(id, list);
  }

  /** 取窗口内的话（顺便把过期条目清掉）。 */
  function recent(chatId) {
    const id = String(chatId ?? '');
    const list = byChat.get(id);
    if (!list) return [];
    const now = Date.now();
    const alive = list.filter((item) => now - item.at <= cfg.windowMs);
    if (alive.length !== list.length) {
      if (alive.length === 0) byChat.delete(id);
      else byChat.set(id, alive);
    }
    return alive.map((item) => item.text);
  }

  /** 判定 + （命中时）不留痕。纯查询，不改状态。 */
  function check(chatId, candidate) {
    if (cfg.enabled === false) return { echo: false, score: 0, hit: '' };
    return detectEcho(candidate, recent(chatId), cfg);
  }

  /** 清空（自测用，也给出站闸的开关一个干净的入口）。 */
  function clear() {
    byChat.clear();
  }

  /** 观测面用：各会话记了几条。 */
  function stats() {
    const out = {};
    for (const [id, list] of byChat) out[id] = list.length;
    return out;
  }

  return { remember, recent, check, clear, stats, cfg };
}

/**
 * 进程内共享的那一份记忆。
 *
 * 为什么挂 `globalThis` 而不是让 `index.js` 建一个实例传下去：
 *
 * 写的人和判的人是**两个不同模块**（`voice.js` 记语音、`guard.js` 判正文），
 * 它们各自被 `index.js` 创建，中间隔着好几层。更关键的是 —— 热重载会重建
 * 整棵插件实例，如果记忆跟着实例走，一次热重载就把「刚说过的话」抹掉，
 * 而那正是这条例最需要它的时候（改完代码马上就在聊）。
 *
 * 内存态 + 120 秒窗口，留着也不会有隔夜脏数据（过期的读的时候就清）。
 * 键名带 `echo.` 前缀，与 `stats` 那批 `globalThis.__onebotCompanion*` 同风格。
 */
export function sharedEchoMemory(options = {}) {
  const key = '__onebotCompanionEchoMemory';
  const g = globalThis;
  const existing = g[key];
  if (existing && typeof existing.check === 'function') {
    // 已经有实例了：只把新配置合进去（热重载改阈值能立刻生效）。
    Object.assign(existing.cfg, options);
    return existing;
  }
  const created = createEchoMemory(options);
  g[key] = created;
  return created;
}
