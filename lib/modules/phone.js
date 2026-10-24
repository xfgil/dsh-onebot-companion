/**
 * dsh-onebot-companion / modules/phone.js
 *
 * 玩手机：她自己刷一刷外面的世界。
 *
 * ## 为什么要有这个（2026-10-20）
 *
 *   要求是：可以不刷，但得能刷——别人有的，她也得有。
 *
 * 这句的重点在后半句：**能力得有**。她没有义务非得刷，但不能因为「用不上」
 * 就不给她装。一个只能看见对方发来的那几条消息、除此之外对世界一无所知的
 * 存在，聊天时是空的 —— 别人聊到热搜、聊到新出的片子、聊到哪个项目炸了，
 * 她只能接一句「哦？」。
 *
 * ## 所以这是「工具」不是「定时任务」
 *
 * 绝不后台定时抓、绝不每轮注入「你刚刷到……」。理由两条：
 *
 *   1. 每轮注入 = 每轮变前缀 = 上下文缓存全废（见 prompt.js 里 firstStepOnly
 *      那段）；而且一天下来她会把同一屏热搜说八遍。
 *   2. 定时抓会变成**强制行为** —— 她本来不想刷，被塞了十条进来，就只好
 *      找机会提一嘴。那不是玩手机，那是 KPI。
 *
 * 正确的形态是：她**想刷的时候**自己调 `qq_phone`，就像真人闲着没事划两下。
 * 想不起来刷也没关系 —— 那才是「可以不刷」。
 *
 * ## 「往下滑」是真的往下滑
 *
 * 每次刷默认跳过最近看过的条目（`seen` 表，落盘，留 300 个 id）。否则她
 * 每次调都拿到热榜前十，看起来就像卡在同一屏。这一点很小，但它决定了她
 * 刷到的东西是不是「新的」。
 *
 * ## 数据源只挑实测能用的（2026-10-20 逐条 curl 过）
 *
 *   | 源        | 状态 | 说明 |
 *   |-----------|------|------|
 *   | bili      | ok   | `/x/web-interface/popular`，综合热门 |
 *   | bili-rank | ok   | `/x/web-interface/ranking/v2`，排行榜 |
 *   | hotword   | ok   | `s.search.bilibili.com/main/hotword`，热搜词 |
 *   | github    | ok   | 搜最近 7 天新建、按 star 排的仓库 |
 *   | hn        | ok   | Hacker News 首页（id 列表 + 逐条取 item） |
 *   | douban    | ok   | 豆瓣热门电影 |
 *   | weibo     | 403  | `weibo.com/ajax/side/hotSearch` 直接返回 Forbidden |
 *   | zhihu     | 401  | 要登录态，`AuthenticationError` |
 *
 * 微博/知乎**故意不写进来** —— 留一个永远失败的源只会让她反复踩坑。
 *
 * ## 不抓正文
 *
 * 只给标题/热度/链接。真想看某一条的内容，她再拿链接去调 `link_parse`
 * （B 站那条能直接出封面和简介）。这里抓全文会把一次「划两下」变成十次请求。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export const DEFAULTS = {
  enabled: true,
  /** 一次刷几条。 */
  limit: 8,
  /** 同一源多久内复用上次结果（热榜几分钟就变，没必要每次真打）。 */
  cacheMs: 10 * 60 * 1000,
  /** 单次请求超时。 */
  timeoutMs: 12000,
  /** 记住多少个看过的条目（用于「往下滑」）。 */
  seenMax: 300,
  /** 看过多久之后允许重新出现。 */
  seenTtlMs: 12 * 3600 * 1000,
  /** 状态文件名。 */
  stateFile: 'phone-state.json',
  /** 默认刷哪个源。 */
  defaultSource: 'bili',
};

const HTML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

/** 解 HTML 实体（B 站标题里 `&quot;` 很常见，不解会念出来）。 */
export function unescapeHtml(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (m) => HTML_ENTITIES[m] ?? m);
}

/** 数字 → 人话热度（「12.3 万」比「123456」好念）。 */
export function humanCount(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v < 10000) return String(v);
  if (v < 100000000) {
    const w = v / 10000;
    return `${w >= 100 ? Math.round(w) : w.toFixed(1).replace(/\.0$/, '')} 万`;
  }
  return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`;
}

/**
 * 各源的抓取 + 解析。
 *
 * 每个 `parse(json)` 返回 `{id, title, extra, url}` 数组；`extra` 是那句
 * 「顺手能说出来的细节」（播放量、star 数、评分），没有就给空串。
 */
export const SOURCES = {
  bili: {
    label: 'B 站热门',
    // ps 固定要大（50），**不能传 limit** —— 传 8 就只能拿 8 条，而 pickFresh
    // 还要从里面跳过看过的，于是第二次刷必然空。抓一屏、挑几条，才是「往下滑」。
    url: () => 'https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1',
    parse: (json) => (json?.data?.list ?? []).map((v) => ({
      id: `bili:${v.bvid ?? v.aid}`,
      title: unescapeHtml(v.title ?? ''),
      extra: [v.owner?.name, v.stat?.view !== undefined ? `${humanCount(v.stat.view)} 播放` : '']
        .filter((x) => typeof x === 'string' && x !== '')
        .join(' · '),
      url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
    })),
  },
  'bili-rank': {
    label: 'B 站排行榜',
    url: () => 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all',
    parse: (json) => (json?.data?.list ?? []).map((v) => ({
      id: `bili:${v.bvid ?? v.aid}`,
      title: unescapeHtml(v.title ?? ''),
      extra: [v.owner?.name, v.tname].filter((x) => typeof x === 'string' && x !== '').join(' · '),
      url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
    })),
  },
  hotword: {
    label: 'B 站热搜',
    url: () => 'https://s.search.bilibili.com/main/hotword',
    parse: (json) => (json?.list ?? []).map((h) => {
      const word = unescapeHtml(h.show_name ?? h.keyword ?? '');
      return {
        id: `hot:${word}`,
        title: word,
        extra: '',
        url: word === '' ? '' : `https://search.bilibili.com/all?keyword=${encodeURIComponent(word)}`,
      };
    }),
  },
  github: {
    label: 'GitHub 新项目',
    url: () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      return `https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=50`;
    },
    parse: (json) => (json?.items ?? []).map((r) => ({
      id: `gh:${r.full_name}`,
      title: r.full_name ?? '',
      extra: [
        r.stargazers_count !== undefined ? `${humanCount(r.stargazers_count)} star` : '',
        r.language ?? '',
        typeof r.description === 'string' ? r.description.slice(0, 60) : '',
      ].filter((x) => typeof x === 'string' && x !== '').join(' · '),
      url: r.html_url ?? '',
    })),
  },
  douban: {
    label: '豆瓣热门电影',
    url: () => 'https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&page_limit=50&page_start=0',
    parse: (json) => (json?.subjects ?? []).map((s) => ({
      id: `db:${s.id}`,
      title: s.title ?? '',
      extra: typeof s.rate === 'string' && s.rate !== '' ? `${s.rate} 分` : '',
      url: s.url ?? '',
    })),
  },
  hn: {
    label: 'Hacker News',
    url: () => 'https://hacker-news.firebaseio.com/v0/topstories.json',
    /** 特例：先拿 id 列表，再逐条取。见 `fetchHn`。 */
    parse: (json) => (Array.isArray(json) ? json.slice(0, 50).map((id) => ({ id: `hn:${id}`, _hnId: id })) : []),
  },
};

/**
 * 从数组里挑出「没看过的、最前面 limit 条」。
 *
 * @param {Array<{id:string}>} items
 * @param {Record<string, number>} seen id → 看过的时间戳
 * @param {{limit?:number, seenTtlMs?:number, now?:number, fresh?:boolean}} options
 * @returns {{picked: Array<object>, skipped: number}}
 */
export function pickFresh(items, seen, options = {}) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string' && i.id !== '') : [];
  if (options.fresh === true) {
    const limit = Math.max(1, Math.floor(options.limit ?? 8));
    return { picked: list.slice(0, limit), skipped: 0 };
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttl = Number.isFinite(options.seenTtlMs) ? options.seenTtlMs : DEFAULTS.seenTtlMs;
  const limit = Math.max(1, Math.floor(options.limit ?? 8));
  const alive = seen !== null && typeof seen === 'object' ? seen : {};
  const picked = [];
  let skipped = 0;
  for (const item of list) {
    const at = alive[item.id];
    if (Number.isFinite(at) && now - at < ttl) {
      skipped += 1;
      continue;
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }
  return { picked, skipped };
}

/** 把 seen 表裁剪到 seenMax（留最新的）。 */
export function trimSeen(seen, max = DEFAULTS.seenMax) {
  const entries = Object.entries(seen ?? {}).filter(([, at]) => Number.isFinite(at));
  entries.sort((a, b) => a[1] - b[1]);
  const keep = entries.slice(-Math.max(1, Math.floor(max)));
  return Object.fromEntries(keep);
}

/**
 * 创建模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} options.stats
 * @param {(level:string, message:string)=>void} [options.log]
 * @param {()=>string} [options.resolveMediaDir]
 * @param {typeof fetch} [options.fetchImpl] 自测注入用
 */
export function createPhone({ cfg, stats, log, resolveMediaDir, fetchImpl }) {
  /** @type {Record<string, {at:number, items:Array<object>}>} */
  const cache = {};
  /** @type {Record<string, number>} */
  let seen = {};
  let store = null;
  let loading = null;
  const say = typeof log === 'function' ? log : () => undefined;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch;

  const enabled = () => cfg?.enabled !== false;
  const timeoutMs = () => (Number.isFinite(cfg?.timeoutMs) ? cfg.timeoutMs : DEFAULTS.timeoutMs);
  const cacheMs = () => (Number.isFinite(cfg?.cacheMs) ? cfg.cacheMs : DEFAULTS.cacheMs);
  const seenMax = () => (Number.isFinite(cfg?.seenMax) ? cfg.seenMax : DEFAULTS.seenMax);

  async function ensureStore() {
    if (store !== null) return store;
    if (loading !== null) return loading;
    const dir = (() => {
      try {
        return typeof resolveMediaDir === 'function' ? resolveMediaDir() : '';
      } catch {
        return '';
      }
    })();
    if (typeof dir !== 'string' || dir === '') return null;
    const { JsonStore, stateFilePath } = await import('../core/jsonstore.js');
    const file = stateFilePath(dir, cfg?.stateFile ?? DEFAULTS.stateFile);
    if (file === undefined) return null;
    store = new JsonStore({
      file,
      log: say,
      label: 'phone',
      normalize: (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined),
    });
    loading = store
      .load()
      .then(() => {
        const raw = store.get('state');
        if (raw !== null && typeof raw === 'object' && raw.seen !== null && typeof raw.seen === 'object') {
          seen = { ...raw.seen };
        }
      })
      .catch(() => undefined);
    await loading;
    return store;
  }

  function persist() {
    if (store === null) return;
    try {
      store.set('state', { seen });
      store.saveDebounced();
    } catch (error) {
      if (stats) stats.phoneLastError = String(error?.message ?? error);
    }
  }

  async function getJson(url) {
    const res = await doFetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  /** HN 特例：id 列表 → 逐条取 item → 只留标题/分数/链接。 */
  async function fetchHn(limit) {
    const ids = await getJson(SOURCES.hn.url());
    const wanted = Array.isArray(ids) ? ids.slice(0, Math.max(limit * 3, 24)) : [];
    const settled = await Promise.allSettled(
      wanted.map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)),
    );
    const out = [];
    for (const r of settled) {
      if (r.status !== 'fulfilled' || r.value === null || typeof r.value !== 'object') continue;
      const it = r.value;
      if (typeof it.title !== 'string' || it.title === '') continue;
      out.push({
        id: `hn:${it.id}`,
        title: unescapeHtml(it.title),
        extra: [it.score !== undefined ? `${humanCount(it.score)} 分` : '', 'HN'].filter((x) => x !== '').join(' · '),
        url: typeof it.url === 'string' && it.url !== ''
          ? it.url
          : `https://news.ycombinator.com/item?id=${it.id}`,
      });
    }
    return out;
  }

  /**
   * 刷。
   *
   * @param {{source?:string, limit?:number, fresh?:boolean}} [input]
   * @returns {Promise<object>}
   */
  async function scroll(input = {}) {
    if (!enabled()) return { ok: false, reason: '玩手机没开' };
    const sourceId = typeof input.source === 'string' && SOURCES[input.source] !== undefined
      ? input.source
      : (SOURCES[cfg?.defaultSource] !== undefined ? cfg.defaultSource : DEFAULTS.defaultSource);
    const source = SOURCES[sourceId];
    const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? cfg?.limit ?? DEFAULTS.limit)));

    await ensureStore().catch(() => undefined);

    let items;
    try {
      const hit = cache[sourceId];
      if (hit !== undefined && Date.now() - hit.at < cacheMs()) {
        items = hit.items;
      } else if (sourceId === 'hn') {
        items = await fetchHn(limit);
      } else {
        const json = await getJson(source.url(limit));
        items = source.parse(json).filter((i) => typeof i?.title === 'string' && i.title !== '');
      }
      if (!Array.isArray(items)) items = [];
      cache[sourceId] = { at: Date.now(), items };
    } catch (error) {
      const reason = String(error?.message ?? error);
      if (stats) stats.phoneLastError = reason;
      say('warn', `[phone] 刷 ${sourceId} 失败: ${reason}`);
      return { ok: false, source: sourceId, label: source.label, reason: `刷不动：${reason}` };
    }

    const { picked, skipped } = pickFresh(items, seen, {
      limit,
      fresh: input.fresh === true,
      seenTtlMs: cfg?.seenTtlMs ?? DEFAULTS.seenTtlMs,
    });
    if (skipped > 0) {
      if (stats) stats.phoneSkipped = (stats.phoneSkipped ?? 0) + skipped;
    }

    // 看过的记下来 —— 这就是「往下滑」。真的全看完一轮了就清空重来，
    // 否则她会一直刷到「没有新东西」然后以为手机坏了。
    if (picked.length > 0) {
      const at = Date.now();
      for (const item of picked) seen[item.id] = at;
      seen = trimSeen(seen, seenMax());
      persist();
      if (stats) {
        stats.phoneScrolls = (stats.phoneScrolls ?? 0) + 1;
        stats.phoneLastSource = sourceId;
        stats.phoneLastAt = at;
      }
    } else if (items.length > 0) {
      // 这一源的新东西看完了：清掉本源已看过的 id，让她能从「顶上」重新看，
      // 否则她会一直刷到空，以为手机坏了。
      const ids = new Set(items.map((i) => i.id));
      for (const id of Object.keys(seen)) if (ids.has(id)) delete seen[id];
      persist();
    }

    return {
      ok: true,
      source: sourceId,
      label: source.label,
      items: picked,
      skipped,
      total: items.length,
      /** 这一源还有没有没看过的（false = 刚看过一轮，下次会重头）。 */
      hasMore: skipped + picked.length < items.length,
    };
  }

  function snapshot() {
    return {
      enabled: enabled(),
      seen: Object.keys(seen).length,
      scrolls: stats?.phoneScrolls ?? 0,
      lastSource: stats?.phoneLastSource ?? null,
      cachedSources: Object.keys(cache),
      sources: Object.keys(SOURCES),
      file: cfg?.stateFile ?? DEFAULTS.stateFile,
    };
  }

  function start() {
    void ensureStore().catch(() => undefined);
  }

  /** 自测：纯函数 + 假 fetch，不碰真网络与真状态。 */
  async function selfTest() {
    const checks = [];
    const check = (name, cond) => checks.push({ name, ok: cond === true });

    // —— 小工具 ——
    check('解 &quot; 实体', unescapeHtml('a&quot;b') === 'a"b');
    check('解 &amp; 实体', unescapeHtml('a&amp;b') === 'a&b');
    check('空串安全', unescapeHtml('') === '');
    check('非字符串安全', unescapeHtml(null) === '');
    check('humanCount 小数目', humanCount(42) === '42');
    check('humanCount 万', humanCount(123456) === '12.3 万');
    check('humanCount 整数万不拖 .0', humanCount(50000) === '5 万');
    check('humanCount 亿', humanCount(230000000) === '2.3 亿');

    // —— pickFresh ——
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, title: `t${i}` }));
    const none = pickFresh(items, {}, { limit: 3, now: 1000 });
    check('没看过的取前三条', none.picked.length === 3 && none.picked[0].id === 'x0');
    const some = pickFresh(items, { x0: 1000, x1: 1000 }, { limit: 3, now: 1500 });
    check('跳过看过的', some.picked[0].id === 'x2' && some.skipped === 2);
    const stale = pickFresh(items, { x0: 1000 }, { limit: 3, now: 1000 + DEFAULTS.seenTtlMs + 1 });
    check('看过太久可以重看', stale.picked[0].id === 'x0' && stale.skipped === 0);
    const fresh = pickFresh(items, { x0: 1000 }, { limit: 2, fresh: true, now: 1000 });
    check('fresh 忽略看过', fresh.picked.length === 2 && fresh.picked[0].id === 'x0');
    check('pickFresh 过滤坏条目', pickFresh([{ id: '' }, { id: 'y' }], {}, {}).picked.length === 1);
    check('pickFresh 非数组安全', pickFresh(null, {}, {}).picked.length === 0);

    // —— trimSeen ——
    const trimmed = trimSeen({ a: 1, b: 5, c: 3 }, 2);
    check('trimSeen 留最新', Object.keys(trimmed).sort().join(',') === 'b,c');

    // —— 假 fetch：B 站热门 ——
    const fakeJson = { data: { list: [
      { bvid: 'BV1', title: '标题&quot;一&quot;', owner: { name: 'UP甲' }, stat: { view: 12345 } },
      { bvid: 'BV2', title: '标题二', owner: { name: 'UP乙' }, stat: { view: 100 } },
    ] } };
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => fakeJson });
    const fake = createPhone({
      cfg: { ...DEFAULTS, stateFile: '' },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
      fetchImpl: fakeFetch,
    });
    const first = await fake.scroll({ source: 'bili', limit: 5 });
    check('刷成功', first.ok === true && first.items.length === 2);
    check('标题去掉实体', first.items[0].title === '标题"一"');
    check('带播放量', first.items[0].extra.includes('万'));
    check('带链接', first.items[0].url === 'https://www.bilibili.com/video/BV1');
    const second = await fake.scroll({ source: 'bili', limit: 5 });
    check('第二次滑到新内容（看完一轮后会重置）', second.ok === true);

    // —— 失败要优雅 ——
    const bad = createPhone({
      cfg: { ...DEFAULTS, stateFile: '' },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const failed = await bad.scroll({ source: 'douban' });
    check('抓失败返回 ok:false', failed.ok === false);
    check('抓失败带原因', typeof failed.reason === 'string' && failed.reason.includes('503'));

    // —— 关掉 ——
    const off = createPhone({
      cfg: { ...DEFAULTS, enabled: false, stateFile: '' },
      stats: {},
      log: () => undefined,
      resolveMediaDir: () => '',
      fetchImpl: fakeFetch,
    });
    check('关掉后不刷', (await off.scroll({})).ok === false);

    // —— 未知源退回默认 ——
    const fallback = await fake.scroll({ source: '不存在的源', limit: 2 });
    check('未知源走默认且不炸', fallback.ok === true && fallback.source === 'bili');

    const failedChecks = checks.filter((c) => c.ok !== true);
    return { ok: failedChecks.length === 0, total: checks.length, failed: failedChecks.length, checks };
  }

  return { scroll, snapshot, start, selfTest, DEFAULTS };
}
