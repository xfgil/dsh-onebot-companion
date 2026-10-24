/**
 * dsh-onebot-companion / 客户端设置界面 —— 「云玥体检表」。
 *
 * ## 为什么有这个文件
 *
 * 2026-10-19 用户点开了 `/onebot-companion/physical`，看到的是裸 JSON，原话
 * （m06601）：
 *
 * > 「这是啥呀？能不能给我整个UI？或者想个法子嵌dsh界面的设置里」
 *
 * 于是把 `modules/physical.js` 那份快照投影搬进 DSH 自己的设置界面：
 * 在「设置」侧栏里多出一页「云玥体检表」。同一份数据，桌面 HTML 那份
 * （`D:\Documents\yunyue\体检表.html`）留着当离线兜底。
 *
 * ## 宿主装载契约（照 `dsh-proxy-on-demand` 与 `dsh-onebot-qq` 两份先例）
 *
 * - CJS 包裹：`window.__ModuleLoader__.load({ id, factory: (require) => {...} })`，
 *   footer `return module.exports;`；`require` 只允许平台冻结表里的 `react`。
 * - 入口导出 `inject`（客户端服务名数组）与 `apply(ctx)`。
 * - 面板注册：`ctx.slots.inject('settings.section', () => ctx.slots.register(
 *     { name:'settings.section', id, order, label, icon }, Component))`。
 *   **`settings.plugin.item` 在本机 0.2.1-rc.2 的 slot 树里不存在**（proxy-on-demand
 *   踩过：注册上去整块静默不渲染），所以只能走 `settings.section`。
 * - `package.json` 必须同时声明 `dsh.client.platform = 'web'` 与
 *   `exports['./client']`，否则这个文件不会被拼进 index.html 的
 *   `plugins/??` 清单，界面上什么都没有。
 *
 * ## 数据通道
 *
 * 全部走同源相对路径 `GET /onebot-companion/physical` —— 不写死
 * `http://127.0.0.1:5931`，这样手机经 HTTPS 反代（dshrc2.qzsecftb.dpdns.org）
 * 打开时也是同一套相对路径，不会撞混合内容拦截。
 *
 * ## 刻意不做的
 *
 * - **不做红绿灯评分**：`physical.js` 头注释写了理由 —— 真正要紧的是
 *   「最后开口距今多久」这种原始事实，不是 0–100 的分数。
 * - **不写任何状态**：这一页纯只读。要改动静默/规则/模块，用
 *   `POST /onebot-companion/module`，不在这个界面的职责里。
 *
 * 适用 DSH 版本：0.2.1-rc.2（与插件主体同一个范围，见 README「环境要求」）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-onebot-companion',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo } = React;

    const BASE = '/onebot-companion';

    /**
     * 取一次体检快照。失败时抛，交给调用方显示——**不吞错**：
     * 这一页存在的意义就是让人看见"哪里不对"，吞掉错误就白做了。
     */
    async function fetchPhysical() {
      const res = await fetch(`${BASE}/physical`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json?.ok || !json.physical) throw new Error('返回里没有 physical');
      return json.physical;
    }

    // ── 小工具 ───────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0');

    function whenAt(ms) {
      if (!ms) return '—';
      const d = new Date(ms);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
        + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    const LEVEL_LABEL = { normal: '琐事', important: '要紧', critical: '重要' };
    const levelLabel = (l) => LEVEL_LABEL[l] || l || '';

    /**
     * 距上次开口的颜色档位。**这是整页的主指标**：进程全绿但她三小时没说话，
     * 才是真正需要人看的那件事（见 modules/physical.js 头注释）。
     *
     * 阈值 12 小时 → bad，3 小时 → warn，其余 good。
     */
    function agoTone(lastAt, now) {
      if (!lastAt) return S.dim;
      const hours = (now - lastAt) / 3600000;
      if (hours > 12) return S.bad;
      if (hours > 3) return S.warn;
      return S.good;
    }

    // ── 样式 ─────────────────────────────────────────────────────────────
    // 全部用宿主主题变量，取不到时退回一套中性深色值：浅色主题下 var 会生效，
    // 变量名写错也只是"颜色不对"，不会让整页不可读。
    const V = {
      fg: 'var(--dsw-alias-label-primary, var(--dsh-label-primary, inherit))',
      fg2: 'var(--dsw-alias-label-secondary, var(--dsh-label-secondary, rgba(128,128,128,.95)))',
      fg3: 'var(--dsw-alias-label-tertiary, var(--dsh-label-tertiary, rgba(128,128,128,.75)))',
      card: 'var(--dsw-alias-bg-layer-2, var(--dsh-card-bg, rgba(128,128,128,.06)))',
      border: 'var(--dsw-alias-border-l1, var(--dsh-border, rgba(128,128,128,.30)))',
      soft: 'var(--dsw-alias-border-l2, var(--dsh-border, rgba(128,128,128,.18)))',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };

    const S = {
      wrap: { padding: '4px 2px 24px', color: V.fg, fontSize: 13, lineHeight: 1.6 },
      head: {
        display: 'flex', alignItems: 'baseline', gap: 10,
        marginBottom: 14, flexWrap: 'wrap',
      },
      title: { fontSize: 15, fontWeight: 600, margin: 0 },
      stamp: { fontSize: 12, color: V.fg3, marginLeft: 'auto' },
      btn: {
        padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
        border: `1px solid ${V.border}`, background: 'transparent', color: 'inherit',
      },
      grid: {
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
      },
      card: {
        border: `1px solid ${V.soft}`, borderRadius: 10, padding: '12px 14px',
        background: V.card, minWidth: 0,
      },
      cardWide: { gridColumn: '1 / -1' },
      cardTitle: {
        fontSize: 12, fontWeight: 600, color: V.fg2, margin: '0 0 8px',
        letterSpacing: '.02em',
      },
      big: { fontSize: 22, fontWeight: 600, lineHeight: 1.25, margin: '2px 0 2px' },
      kv: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0' },
      k: { color: V.fg3, fontSize: 12, flexShrink: 0 },
      v: { textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' },
      mono: { fontFamily: V.mono, fontSize: 12 },
      good: { color: 'var(--dsw-alias-state-success-primary, #3fb950)' },
      bad: { color: 'var(--dsw-alias-state-error-primary, #e5534b)' },
      warn: { color: 'var(--dsw-alias-state-warning-primary, #d29922)' },
      dim: { color: V.fg3 },
      quote: {
        marginTop: 8, padding: '8px 10px', borderRadius: 8,
        background: 'rgba(128,128,128,.10)', color: V.fg2,
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflowY: 'auto',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: {
        textAlign: 'left', fontWeight: 500, color: V.fg3, fontSize: 11.5,
        padding: '4px 8px 6px 0', whiteSpace: 'nowrap',
        borderBottom: `1px solid ${V.soft}`,
      },
      td: { padding: '5px 8px 5px 0', borderBottom: `1px solid ${V.soft}`, verticalAlign: 'top' },
      item: {
        display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0',
        borderBottom: `1px solid ${V.soft}`,
      },
      pill: {
        display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11,
        background: 'rgba(128,128,128,.16)', color: V.fg2, flexShrink: 0,
      },
      pillOn: {
        display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11,
        background: 'rgba(63,185,80,.18)', color: 'var(--dsw-alias-state-success-primary, #3fb950)',
        flexShrink: 0,
      },
      pillOff: {
        display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11,
        background: 'rgba(229,83,75,.16)', color: 'var(--dsw-alias-state-error-primary, #e5534b)',
        flexShrink: 0,
      },
      itemText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
      itemMeta: { color: V.fg3, fontSize: 11.5, whiteSpace: 'nowrap', flexShrink: 0 },
      empty: { color: V.fg3, fontSize: 12, padding: '6px 0' },
      err: {
        border: '1px solid rgba(229,83,75,.45)', background: 'rgba(229,83,75,.10)',
        borderRadius: 8, padding: '10px 12px', color: V.fg, whiteSpace: 'pre-wrap',
        marginBottom: 12, fontSize: 12.5,
      },
      mods: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 },
      mod: {
        fontFamily: V.mono, fontSize: 11, padding: '1px 7px', borderRadius: 6,
        background: 'rgba(128,128,128,.16)', color: V.fg2,
      },
    };

    // ── 各块 ─────────────────────────────────────────────────────────────

    /** 「她还好吗」——整页的主指标，单独一张卡放最前。 */
    function AliveCard({ alive, now }) {
      const lastAt = alive?.lastWordAt ?? null;
      const tone = agoTone(lastAt, now);
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle }, '她还好吗'),
        h('div', { style: { ...S.big, ...tone } }, alive?.lastWordAgo || '—'),
        h('div', { style: S.kv },
          h('span', { style: S.k }, '最后开口'),
          h('span', { style: { ...S.v, ...S.mono } }, whenAt(lastAt))),
        alive?.lastWordChat
          ? h('div', { style: S.kv },
              h('span', { style: S.k }, '在哪儿'),
              h('span', { style: { ...S.v, ...S.mono } }, alive.lastWordChat))
          : null,
        alive?.lastWordText ? h('div', { style: S.quote }, alive.lastWordText) : null,
      );
    }

    /** 连接：开着没开着、连上没有、原型挂了多少。 */
    function LinkCard({ link, patches, lost, errors }) {
      const mods = useMemo(() => {
        const m = {};
        for (const p of patches || []) m[p.moduleId] = (m[p.moduleId] || 0) + 1;
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
      }, [patches]);

      const conn = link?.connected;
      const connPill = conn === true ? h('span', { style: S.pillOn }, '已连接')
        : conn === false ? h('span', { style: S.pillOff }, '断开')
        : h('span', { style: S.pill }, '未知');

      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle }, '连接'),
        h('div', { style: S.kv },
          h('span', { style: S.k }, '插件'),
          h('span', { style: S.v }, link?.enabled ? '开着' : '关了')),
        h('div', { style: S.kv },
          h('span', { style: S.k }, 'QQ 桥'),
          h('span', { style: S.v }, connPill)),
        h('div', { style: S.kv },
          h('span', { style: S.k }, '挂载方法'),
          h('span', { style: S.v }, patches?.length ? `${patches.length} 个` : '—')),
        h('div', { style: S.kv },
          h('span', { style: S.k }, '丢失方法'),
          h('span', { style: S.v },
            lost ? h('span', { style: S.bad }, String(lost)) : h('span', { style: S.good }, '没有'))),
        mods.length ? h('div', { style: S.mods },
          mods.map(([k, n]) => h('span', { key: k, style: S.mod }, `${k}×${n}`))) : null,
        errors?.last
          ? h('div', { style: { ...S.quote, ...S.warn } }, errors.last)
          : null,
      );
    }

    /**
     * 精力：一具身体，全局一份。
     *
     * 2026-10-20 分层之后必须单独一张卡 —— 以前精力混在「各会话」表里，
     * 三个会话并排显示三个 73，看着像各有一份电量，正好把改造的意思说反了。
     */
    function BodyCard({ body }) {
      const energy = body?.energy;
      const show = typeof energy === 'number' && Number.isFinite(energy);
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle }, '精力'),
        h('div', { style: S.big }, show ? String(Math.round(energy)) + ' / 100' : '—'),
        h('div', { style: { ...S.dim, fontSize: 11.5 } },
          '一具身体只有一份电量：不管在私聊还是群里说话，耗的都是这一份。'),
        body?.driftAgo
          ? h('div', { style: { ...S.kv, marginTop: 4 } },
              h('span', { style: S.k }, '上次结算'),
              h('span', { style: { ...S.v, ...S.dim } }, body.driftAgo))
          : null,
      );
    }

    /**
     * 认识的人：亲密度按账号。
     *
     * 同一个人在私聊和群里说话，涨的是同一份。以前每个会话各涨各的，
     * 于是「在群里聊了三天」和「私聊聊了三天」是两条互不相干的账。
     */
    function PeopleCard({ people, unnamed }) {
      const rows = people || [];
      const ghosts = unnamed || [];
      return h('div', { style: { ...S.card, ...S.cardWide } },
        h('h3', { style: S.cardTitle }, '认识的人'),
        rows.length === 0
          ? h('div', { style: S.empty }, '还没有记下谁')
          : h('table', { style: S.table },
              h('thead', null,
                h('tr', null,
                  ['账号', '关系', '亲密度', '见过在哪', '上次说话'].map((t) =>
                    h('th', { key: t, style: S.th }, t)))),
              h('tbody', null,
                rows.map((p) => h('tr', { key: p.key },
                  h('td', { style: { ...S.td, ...S.mono } }, p.label || p.key),
                  h('td', { style: S.td },
                    p.tier ? h('span', { style: S.pill }, p.tier) : '—'),
                  h('td', { style: S.td },
                    String(Math.round(p.affinity ?? 0)),
                    p.toNext != null
                      ? h('span', { style: { ...S.dim, fontSize: 11 } }, ` (+${p.toNext})`)
                      : null),
                  h('td', { style: { ...S.td, ...S.dim, ...S.mono } },
                    (p.chatIds || []).length ? p.chatIds.join('、') : '—'),
                  h('td', { style: { ...S.td, ...S.dim } }, p.lastSeenAgo || '—'))))),
        h('div', { style: { ...S.dim, fontSize: 11, marginTop: 6 } },
          '「见过在哪」是从会话记录反推的近似值：群聊里只有最后开口的人能被认出来。'),
        ghosts.length
          ? h('div', { style: { ...S.dim, fontSize: 11, marginTop: 4 } },
              `另有 ${ghosts.length} 条记在群上的亲密度（${ghosts.map((g) => g.label || g.key).join('、')}）——`
              + '那是群里说过话但没记下是谁的，不算某个人。')
          : null,
      );
    }

    /**
     * 各会话：心情 / 热情 / 安静多久。
     *
     * 精力与亲密度**不在这里显示**了 —— 它们不属于会话，见上面两张卡。
     * 原来那两列并排显示同一个数，是这次改造留下的坑（用户点出来的）。
     */
    function ChatsCard({ chats }) {
      const rows = chats || [];
      return h('div', { style: { ...S.card, ...S.cardWide } },
        h('h3', { style: S.cardTitle }, '各会话'),
        rows.length === 0
          ? h('div', { style: S.empty }, '还没有会话')
          : h('table', { style: S.table },
              h('thead', null,
                h('tr', null,
                  ['会话', '心情', '热情', '距上次说话'].map((t) =>
                    h('th', { key: t, style: S.th }, t)))),
              h('tbody', null,
                rows.map((c) => h('tr', { key: c.chatId },
                  h('td', { style: { ...S.td, ...S.mono } }, c.chatId),
                  h('td', { style: S.td }, c.mood || '—'),
                  h('td', { style: S.td }, c.warmth ?? '—'),
                  h('td', { style: { ...S.td, ...S.dim } }, c.quiet || '—'))))),
        h('div', { style: { ...S.dim, fontSize: 11, marginTop: 6 } },
          '心情和热情属于「此刻在这个场合」，换个场合本来就该不同，所以留在这里。'),
      );
    }

    /** 小本子：她真正在意、自己写下的东西。 */
    function DiaryCard({ diary }) {
      const items = diary?.recent || [];
      const by = diary?.byLevel || {};
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle },
          '小本子',
          diary?.total ? h('span', { style: { ...S.dim, fontWeight: 400 } }, ` · 共 ${diary.total} 条`) : null),
        items.length === 0
          ? h('div', { style: S.empty }, '还没写过什么')
          : items.map((it, i) => h('div', { key: `${it.at}-${i}`, style: S.item },
              h('span', { style: S.pill }, levelLabel(it.level)),
              h('span', { style: S.itemText }, it.text || ''),
              h('span', { style: S.itemMeta }, whenAt(it.at)))),
        diary?.total ? null : h('div', { style: { ...S.dim, fontSize: 11.5, marginTop: 6 } },
          `分类：琐事 ${by.normal || 0} · 要紧 ${by.important || 0} · 重要 ${by.critical || 0}`),
      );
    }

    /** 欠着的话：她答应过、到点该提醒自己的事。 */
    function PromiseCard({ promise }) {
      const items = promise?.items || [];
      return h('div', { style: S.card },
        h('h3', { style: S.cardTitle },
          '欠着的话',
          promise?.open ? h('span', { style: { ...S.dim, fontWeight: 400 } }, ` · ${promise.open} 件没兑现`) : null),
        items.length === 0
          ? h('div', { style: S.empty }, '没有欠着的事')
          : items.map((it, i) => h('div', { key: `${it.dueAt}-${i}`, style: S.item },
              h('span', { style: S.itemText }, it.text || ''),
              h('span', { style: S.itemMeta }, `${whenAt(it.dueAt)} 到点`))),
      );
    }

    // ── 主组件 ───────────────────────────────────────────────────────────
    function Checkup() {
      const [data, setData] = useState(null);
      const [err, setErr] = useState(null);
      const [busy, setBusy] = useState(false);

      const load = useCallback(async () => {
        setBusy(true);
        try {
          const p = await fetchPhysical();
          setData(p);
          setErr(null);
        } catch (e) {
          setErr(String(e?.message || e));
        } finally {
          setBusy(false);
        }
      }, []);

      // 首次进来就拉一次；之后 30 秒自己刷——体检表是"看一眼现在怎么样"，
      // 手动刷新按钮留着，但正常情况下不该需要人点。
      useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) void load(); };
        void load();
        const timer = setInterval(tick, 30000);
        return () => { alive = false; clearInterval(timer); };
      }, [load]);

      const now = data?.at || Date.now();
      const lastAt = data?.alive?.lastWordAt ?? null;
      const tone = agoTone(lastAt, now);

      return h('div', { style: S.wrap },
        h('div', { style: S.head },
          h('h2', { style: S.title }, '云玥体检表'),
          h('button', {
            type: 'button', style: S.btn, disabled: busy, onClick: () => void load(),
          }, busy ? '读取中…' : '重新读取'),
          h('span', { style: S.stamp },
            data ? `读取于 ${whenAt(now)}` : (busy ? '读取中…' : '还没读到'))),

        err
          ? h('div', { style: S.err },
              `读不到体检数据：${err}\n\n`
              + '需要确认：① dsh-onebot-companion 已启用；'
              + '② QQ 桥（NapCat）在跑。可以另开一个标签页访问 '
              + `${BASE}/physical 看原始 JSON。`)
          : null,

        data
          ? h('div', { style: S.grid },
              h(AliveCard, { alive: data.alive, now }),
              h(LinkCard, {
                link: data.link,
                patches: data.patches,
                lost: data.errors?.lost ?? 0,
                errors: data.errors,
              }),
              h(BodyCard, { body: data.body }),
              h(PeopleCard, { people: data.people, unnamed: data.unnamed }),
              h(ChatsCard, { chats: data.chats }),
              h(DiaryCard, { diary: data.diary }),
              h(PromiseCard, { promise: data.promise }),
            )
          : (!err && h('div', { style: S.empty }, '读取中…')),

        // 一句话说明这页怎么用，省得下次再问"这是啥呀"。
        h('div', { style: { ...S.dim, fontSize: 11.5, marginTop: 14, lineHeight: 1.7 } },
          h('div', null, '数据源：', h('code', { style: S.mono }, `GET ${BASE}/physical`), '（只读投影，不改任何东西）。'),
          h('div', null, '「她还好吗」那一行是主指标：超过 3 小时不变黄、超过 12 小时变红，', 
            '这时候进程可能全绿但她根本没在说话。'),
          h('div', null, '精力、亲密度、心情/热情是三件不同的事，分成三张卡：',
            '精力一具身体一份，亲密度按账号记（私聊和群聊共用），心情与热情属于「此刻在这个场合」。'),
          h('div', null, '离线兜底：', h('code', { style: S.mono }, 'D:\\Documents\\yunyue\\体检表.html'), '（同一份数据，双击直接开）。'),
          h('div', { style: { ...tone, display: 'none' } }, '')),
      );
    }

    // ── 客户端入口 ───────────────────────────────────────────────────────
    // 只注入 slots：这一页不读写宿主配置、不用 locale、不开 Remote。
    const inject = ['slots'];

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'onebot-companion-checkup',
          order: 62,
          // label 用 thunk：与先例一致，将来接 locale 时不用改结构。
          label: () => '云玥体检表',
          icon: 'settings',
        }, Checkup));
      } catch (e) {
        console.error('[dsh-onebot-companion] 体检表界面挂载失败：', e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-onebot-companion-client';
    exports.Checkup = Checkup;
    return module.exports;
  },
});
