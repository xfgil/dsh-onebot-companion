/**
 * dsh-onebot-companion / modules/physical.js
 *
 * 「体检表」的数据面：一份只读快照，回答一个问题 —— **她还好吗**。
 *
 * ## 为什么要有这个
 *
 * 2026-10-19 用户贴了别人家（卡戎）的控制台截图，里头是「大脑 √ / 桥接 √ /
 * QQ 网关 √ / 最后说话 19:31」这样一列。我们这边的观测面是十几个各自为政的
 * JSON 端点：`/status` 有 stats、`/mood` 有情绪、`/diary` 有日记，但**没有任何
 * 一个地方能一眼回答「她是不是还正常说话」**。
 *
 * 更关键的是那些端点回答不了的两类问题：
 *
 * 1. **绿着但不干活**。进程在、模块都 patched，可她三小时没说过一句话 ——
 *    上游超时、会话被堵、step 卡住，全是这种形态。逐项检查（√ 开着）永远
 *    是全绿的，只有「她最后说话」那一行能看出来。
 * 2. **攒着的欠账**。日记里写着什么、答应了谁什么还没兑现 —— 这些散落在
 *    磁盘 JSON 里，得逐个文件翻。
 *
 * 所以这里做**纯投影**：把已经算好的东西拼成一份给人看的形状，不做任何判断、
 * 不写任何状态。`buildPhysical(deps)` 是纯函数，输入全是现成的快照对象，
 * 输出一个扁平的大对象；测试里可以直接喂假数据断言。
 *
 * ## 刻意不做的
 *
 * - 不做健康评分/红绿灯。给 0–100 分就会有人去追这个分数，而真正要紧的是
 *   「最后开口距今多久」这种原始事实。
 * - 不主动上报。这是给人看的表，不是告警系统。
 *
 * ## 2026-10-20：分层之后必须分块显示
 *
 * 那天把四个量拆成了三层（见 `persona.js` 的 `moodOf()` 注释）：精力全局一份、
 * 亲密度按账号、心情与热情按会话。**表没跟上**，于是三行会话并排显示三个
 * 一样的精力值 73 —— 数是对的，读起来却是「三个会话各有一份电量」，
 * 正好把改造要说清的那件事说反了。用户一句「体检表你是不是没更新」点出来的。
 *
 * 所以现在分三块：
 *   - `body`   全局精力（一具身体，只有一份）
 *   - `people` 认识的人（亲密度按账号，私聊与群聊共用）
 *   - `chats`  各会话（心情、热情是「此刻在这个场合」的状态）
 *
 * `chats[].energy` / `chats[].affinity` 仍然保留 —— 它们是**合成后**的值，
 * 和提示词、概率门看到的完全一致，删掉反而让人对不上账。只是表上不再重复显示
 * 它们，改在新块里各说一次。
 *
 * @module dsh-onebot-companion/modules/physical
 */

/**
 * 把毫秒时间写成「3 分钟前」。
 * @param {number|null} at
 * @param {number} now
 * @returns {string}
 */
export function agoText(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '—';
  const ms = Math.max(0, now - at);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/**
 * 一天的起点（本地时区 00:00）。
 * @param {number} now
 * @returns {number}
 */
export function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 组装体检快照。纯函数：同样的入参永远给同样的结果（除了传进来的 now）。
 *
 * @param {object} deps
 * @param {number} [deps.now]
 * @param {object} deps.stats - 运行时统计对象
 * @param {object} deps.cfg - 合并后的配置
 * @param {Record<string, object>} deps.moods - `persona.snapshot()`（chatId → 情绪）
 * @param {object|null} [deps.body] - 全局身体状态（`persona.bodySnapshot()`）：
 *   `{ energy, lastDriftAt }`。缺了就从第一个有能量的 chat 里取，老面板不至于白屏。
 * @param {Array<object>} [deps.people] - 认识的人（`persona.peopleSnapshot()`）：
 *   `{ key, affinities... }` 的数组，按亲密度降序。
 * @param {object} deps.diary - `diary.snapshot()`
 * @param {object} deps.promise - `promise.snapshot()`
 * @param {object|null} deps.lastword - `lastword.snapshot()`
 * @param {Array<object>} [deps.diaryRecent] - 最近几条日记正文
 * @param {Array<object>} [deps.promiseOpen] - 还没兑现的约定正文
 * @param {(affinity: number) => object} deps.tierOf - 关系阶段投影
 * @param {Array<{id: string, patched: boolean}>} [deps.patches] - 各模块挂载情况
 * @param {boolean} [deps.connected] - OneBot 连接状态
 * @returns {object}
 */
export function buildPhysical(deps) {
  return buildPhysicalAt(deps, Date.now());
}

/** 单独拆出来，便于测试固定时间。 */
export function buildPhysicalAt(deps, now) {
  const d = deps ?? {};
  const stats = d.stats ?? {};
  const cfg = d.cfg ?? {};
  const moods = d.moods ?? {};
  const lastword = d.lastword ?? null;

  const chats = Object.entries(moods).map(([chatId, m]) => {
    const affinity = Number(m?.affinity ?? 0);
    let tier = null;
    try {
      tier = typeof d.tierOf === 'function' ? d.tierOf(affinity) : null;
    } catch {
      tier = null;
    }
    return {
      chatId,
      mood: m?.moodLabel ?? m?.mood ?? '—',
      energy: m?.energy ?? null,
      affinity,
      warmth: m?.warmth ?? null,
      tier: tier?.label ?? null,
      tierId: tier?.id ?? null,
      toNext: tier?.toNext ?? null,
      quiet: typeof m?.quietMs === 'number' ? agoText(now - m.quietMs, now) : '—',
    };
  });

  const diary = d.diary ?? {};
  const promise = d.promise ?? {};

  // 全局精力：优先取真·body 记录；没有就退回「第一个会话的合成值」——
  // 分层改造前的老数据只有 chat 记录，这条兜底让面板在那段时间也不至于空着。
  const bodyRec = d.body ?? null;
  const fallbackEnergy =
    chats.find((c) => typeof c.energy === 'number' && Number.isFinite(c.energy))?.energy ?? null;
  const body = {
    energy: typeof bodyRec?.energy === 'number' ? bodyRec.energy : fallbackEnergy,
    // 这份电量是「一具身体」的，不是某个会话的 —— 面板上要说清楚它影响所有人。
    driftAgo: typeof bodyRec?.lastDriftAt === 'number' ? agoText(bodyRec.lastDriftAt, now) : null,
  };

  // 认识的人：亲密度按账号。这里只投影，不判断谁重要。
  //
  // `g:` 开头的键**不是人**：那是群聊里没拿到 user_id 时的兜底，等于「这个群里
  // 有过互动，但不知道是谁」。放进「认识的人」表里会读成「有个叫 900000002 的
  // 人亲密度 100」，所以单独归到 `unnamed`，表上另说一句。
  const allPeople = (Array.isArray(d.people) ? d.people : [])
    .map((p) => {
      const affinity = Number(p?.affinity ?? 0);
      let tier = null;
      try {
        tier = typeof d.tierOf === 'function' ? d.tierOf(affinity) : null;
      } catch {
        tier = null;
      }
      const key = String(p?.key ?? '');
      return {
        key,
        kind: key.startsWith('u:') ? 'user' : 'unnamed',
        label: p?.label ?? null,
        affinity,
        tier: tier?.label ?? null,
        tierId: tier?.id ?? null,
        // 差多少到下一档：给一位小数就够了，13 位小数没人想看。
        toNext: tier?.toNext != null ? Math.round(Number(tier.toNext) * 10) / 10 : null,
        lastSeenAgo: typeof p?.lastContactAt === 'number' && p.lastContactAt > 0
          ? agoText(p.lastContactAt, now)
          : '—',
        // 这个人在哪些会话里出现过（`chatIds` 由 persona 侧拼）。
        chatIds: Array.isArray(p?.chatIds) ? p.chatIds : [],
      };
    });
  const people = allPeople
    .filter((p) => p.kind === 'user')
    .sort((a, b) => b.affinity - a.affinity);
  const unnamed = allPeople
    .filter((p) => p.kind !== 'user')
    .sort((a, b) => b.affinity - a.affinity);

  return {
    at: now,
    // —— 她还好吗 ——这些是这张表存在的理由
    alive: {
      lastWordAt: lastword?.lastAt ?? null,
      lastWordAgo: lastword?.ago ?? '—',
      lastWordText: lastword?.lastText ?? null,
      lastWordChat: lastword?.lastChat ?? null,
      // 累计出站条数（不是「今天说了几句」—— 那个要按天切桶，等真需要再加）；
      // 字段名照实叫 saidTotal，别让读的人以为是当日值。
      saidTotal: lastword?.total ?? 0,
    },
    // —— 连接与阶段 ——
    link: {
      connected: d.connected === true ? true : d.connected === false ? false : null,
      enabled: cfg.enabled !== false,
      // companion 自己的 cfg 里没有 botQQ/preset（那是 dsh-onebot-qq 的配置），
      // 所以这里**不伪造**这两个字段 —— 面板上显示 null 也比显示错的值好。
    },
    // —— 各模块挂载 ——
    patches: Array.isArray(d.patches) ? d.patches : [],
    // —— 精力：一具身体，全局一份 ——
    body,
    // —— 亲密度：按账号，不看会话 ——
    people,
    // `g:` 键 = 群里有互动但没认出是谁的兜底记录，不是人。
    unnamed,
    // —— 心情与热情：此刻在这个场合的状态 ——
    chats,
    // —— 小本子 ——
    diary: {
      enabled: diary.enabled !== false,
      total: diary.total ?? 0,
      byLevel: diary.byLevel ?? {},
      recent: Array.isArray(d.diaryRecent) ? d.diaryRecent : [],
    },
    // —— 欠着的话 ——
    promise: {
      enabled: promise.enabled !== false,
      open: promise.open ?? 0,
      due: promise.due ?? 0,
      done: promise.done ?? 0,
      items: Array.isArray(d.promiseOpen) ? d.promiseOpen : [],
    },
    // —— 出了什么错 ——
    errors: {
      last: stats.lastError ?? null,
      lost: Array.isArray(stats.lost) ? stats.lost.length : 0,
      lastHitKind: stats.lastHitKind ?? null,
    },
  };
}
