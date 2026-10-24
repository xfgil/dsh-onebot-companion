/**
 * HTTP 观测面（loopback only）。
 *
 * 从 `index.js` 抽出来的：这一块原本在 apply() 里占了 450 行，而它几乎只读
 * （除了 /toggle、/module、/rule、/rescan、/burst、/face、/say、/voice-config
 * 这几个「改一下再试」的入口），跟插件装配逻辑混在一起以后很难看出哪个模块
 * 到底被拉起来了。
 *
 * 依赖全部从 `deps` 进来，这一层不 import 任何本仓库的状态模块 —— 它只认
 * 「给我一个对象，我把它挂成路由」。这样接口的形状就是显式的：想加一条
 * 观测路由，得先想清楚它要读谁。
 */
import { createHandler } from './core/http.js';
import { FACE_COUNT, resolveFaceId, suggestFaces } from './modules/faces.js';
import { buildPhysical } from './modules/physical.js';
import { selfTest as selfTestTier, tierSnapshot } from './modules/tier.js';

export function createHttpHandler(deps) {
  const {
    cfg,
    stats,
    log,
    name,
    hits,
    persist,
    scanAll,
    ctx,
    getStickerLib,
    persona,
    prompt,
    rhythm,
    stamp,
    mention,
    guard,
    adopt,
    diary,
    promise,
    unsaid,
    quota,
    phone,
    voice,
    lastword,
    isolation,
    emoji,
    linkcard,
    hands,
    temper,
    circadian,
    sleep,
    tempo,
    interrupt,
    comfy,
    recall,
  } = deps;

  const handler = createHandler({
    prefix: `/${name}`,
    log,
    // 只给体检表数据面开跨源：本地 file:// 打开的 html 要读它（origin 是 null）。
    corsPaths: ['/physical'],
    status: () => ({
      ok: true,
      name,
      generations: stats.generations,
      startedAt: stats.startedAt,
      config: cfg,
      stats: {
        ...stats,
        patched: stats.patched.map((p) => `${p.moduleId}:${p.method}`),
        lost: stats.lost.map((l) => `${l.moduleId}:${l.method}`),
        inbound: { ...stats.inbound, pending: rhythm.pendingCount() },
      },
      modules: {
        guard: { methods: guard.METHODS, hits: hits.length },
        prompt: { rules: prompt.ruleTable() },
        rhythm: { pending: rhythm.pendingCount() },
        stamp: {
          methods: stamp.METHODS,
          stamped: stats.stamped,
          seen: stamp.seenCount(),
          baseline: stamp.baselineCount(),
        },
        persona: { mediaDir: persona.dir() },
        // mention 单独列出来：话题插话的配额与「现在醒着几个群」只有这里看得到，
        // 否则「她怎么没接话」只能靠翻 trace。
        mention: {
          enabled: cfg.mention.enabled !== false,
          names: cfg.mention.names,
          diving: cfg.mention.diving,
          awake: mention.awakeNow(),
          topicEnabled: cfg.mention.topics?.enabled === true,
          topicGroups: Object.keys(cfg.mention.topics?.groups ?? {}),
          topicQuota: mention.topicSnapshot(),
          stats: {
            named: stats.mentionNamed ?? 0,
            dived: stats.mentionDived ?? 0,
            upstream: stats.mentionUpstream ?? 0,
            selfid: stats.mentionSelfId ?? 0,
            topic: stats.mentionTopic ?? 0,
            topicAlive: stats.mentionTopicAlive ?? 0,
            topicAwake: stats.mentionTopicAwake ?? 0,
            lastTopic: stats.lastMentionTopic,
            lastMentionAt: stats.lastMentionAt,
          },
        },
        voice: voice.snapshot(),
        // 她最后真的开口是什么时候 —— 面板上最有信息量的一行（见 modules/lastword.js）。
        lastword: lastword.snapshot(),
        faces: { count: FACE_COUNT, sent: stats.faces.sent },
        // isolation 单列：这是安全闸，能不能拒、拒了几次必须一眼看到。
        isolation: {
          enabled: cfg.isolation?.enabled !== false,
          guardInstalled: stats.isolationGuardInstalled === true,
          allowedTools: cfg.isolation?.allowedTools ?? [],
          allowLinks: cfg.isolation?.allowLinks !== false,
          blockedTurns: stats.isolationBlockedTurns ?? 0,
          denied: stats.isolationDenied ?? 0,
          allowedCalls: stats.isolationAllowedCalls ?? 0,
          lastDenied: stats.lastIsolationDenied ?? null,
          mediaDir: isolation.effectiveMediaDir?.() ?? '',
          active: isolation.snapshot(),
        },
        emoji: {
          enabled: cfg.emoji?.enabled !== false,
          names: cfg.emoji?.names !== false,
          muteUnknownFaces: cfg.emoji?.muteUnknownFaces !== false,
          annotated: stats.emojiAnnotated ?? 0,
          resolved: stats.emojiResolved ?? 0,
          noPath: stats.emojiNoPath ?? 0,
          muted: stats.emojiMuted ?? 0,
          lastMuted: stats.lastEmojiMuted ?? null,
          resolveError: stats.emojiResolveError ?? null,
          lastError: stats.emojiLastError ?? null,
        },
        linkcard: {
          enabled: cfg.linkcard?.enabled !== false,
          annotated: stats.linkcardAnnotated ?? 0,
          linked: stats.linkcardLinked ?? 0,
          resolveError: stats.linkcardResolveError ?? null,
          lastError: stats.linkcardLastError ?? null,
        },
        hands: hands?.snapshot?.() ?? { enabled: cfg.hands?.enabled !== false },
        // 长期底色（2026-10-21）：只报一个偏离值和最偏的一项，够看趋势了。
        // 别把整张乘数表吐出来 —— 那九个数字对排查没有帮助，只会让人对着它猜。
        temper: {
          enabled: cfg.temper?.enabled !== false,
          ...(temper?.snapshot?.() ?? {}),
          lines: stats.temperLines ?? 0,
          lastError: stats.temperLastError ?? null,
        },
        // 生物钟（2026-10-21）：只报「够不够用 + 峰值在几点 + 几个夜」，不吐
        // 24 个数 —— 那条曲线是给人看的图，不是给终端看的表。
        circadian: {
          enabled: cfg.circadian?.enabled !== false,
          ...(circadian?.snapshot?.() ?? {}),
          lines: stats.circadianLines ?? 0,
          lastError: stats.circadianLastError ?? null,
        },
        stickers: getStickerLib()?.snapshot?.() ?? { enabled: cfg.stickers?.enabled !== false },
        // 生活节奏 / 未完成意图（2026-10-22）。只报「每个会话的密度倍率」与
        // 「有几条没说完的半句」—— 都是数，不吐原文：体检单是看状态的，不是读剧本的。
        tempo: {
          enabled: cfg.tempo?.enabled !== false,
          ...(tempo?.snapshot?.() ?? {}),
        },
        interrupt: {
          enabled: cfg.interrupt?.enabled !== false,
          ...(interrupt?.snapshot?.() ?? {}),
        },
        // 自己画图（2026-10-22）：只报「画过几张 / 上次多久」，不在这里探测
        // ComfyUI 死活 —— 体检表是同步渲染的，探测是网络请求。
        comfy: {
          enabled: cfg.comfy?.enabled !== false,
          ...(comfy?.snapshot?.() ?? {}),
        },
        // 撤回（2026-10-23）：每个会话还有几条在窗口内可撤。
        recall: {
          enabled: cfg.recall?.enabled !== false,
          ...(recall?.snapshot?.() ?? {}),
        },
        sleep: {
          enabled: cfg.sleep?.enabled !== false,
          autoByMood: cfg.sleep?.autoByMood !== false,
          entered: stats.sleepEntered ?? 0,
          blocked: stats.sleepBlocked ?? 0,
          woke: stats.sleepWoke ?? 0,
          resolveError: stats.sleepResolveError ?? null,
          lastBlocked: stats.lastSleepBlocked ?? null,
          lastEntered: stats.lastSleepEntered ?? null,
          sleeping: sleep?.snapshot?.() ?? {},
        },
        // 小本子 / 约定 / 关系阶段（2026-10-19）。
        // 阶段是投影值，顺手把 affinity 一起报出来，方便对照 tier 边界。
        diary: {
          enabled: cfg.diary?.enabled !== false,
          ...(diary?.snapshot?.() ?? {}),
          written: stats.diaryWritten ?? 0,
          duplicates: stats.diaryDuplicates ?? 0,
          forgotten: stats.diaryForgotten ?? 0,
          lastError: stats.diaryLastError ?? null,
        },
        promise: {
          enabled: cfg.promise?.enabled !== false,
          ...(promise?.snapshot?.() ?? {}),
          added: stats.promiseAdded ?? 0,
          done: stats.promiseDone ?? 0,
          dropped: stats.promiseDropped ?? 0,
          reminded: stats.promiseReminded ?? 0,
          lastError: stats.promiseLastError ?? null,
        },
        unsaid: {
          enabled: cfg.unsaid?.enabled !== false,
          ...(unsaid?.snapshot?.() ?? {}),
          held: stats.unsaidHeld ?? 0,
          said: stats.unsaidSaid ?? 0,
          dropped: stats.unsaidDropped ?? 0,
          duplicates: stats.unsaidDuplicates ?? 0,
          lastText: stats.unsaidLastText ?? null,
          lastError: stats.unsaidLastError ?? null,
        },
        quota: {
          enabled: cfg.quota?.enabled !== false,
          ...(quota?.snapshot?.() ?? {}),
          lastError: stats.quotaLastError ?? null,
        },
        phone: {
          enabled: cfg.phone?.enabled !== false,
          ...(phone?.snapshot?.() ?? {}),
          lastError: stats.phoneLastError ?? null,
        },
        tier: {
          enabled: cfg.tier?.enabled !== false,
          byChat: (() => {
            const out = {};
            try {
              for (const chatId of Object.keys(persona?.snapshot?.() ?? {})) {
                const affinity = persona?.moodOf?.(chatId)?.affinity;
                if (Number.isFinite(affinity)) {
                  out[chatId] = { affinity: Math.round(affinity * 10) / 10, ...tierSnapshot(affinity) };
                }
              }
            } catch {
              /* 观测面失败不影响主流程 */
            }
            return out;
          })(),
        },
      },
      endpoints: [
        'GET  /',
        'GET  /status',
        'GET  /hits?limit=',
        'GET  /mood',
        'GET  /style',
        'GET  /voice',
        'GET  /faces',
        'GET  /lastword',
        'GET  /physical     体检表数据面（跨源可读，给本地 html 用）',
        'POST /toggle        {"enabled": bool}',
        'POST /module        {"module": "guard|mention|emoji|linkcard|hands|adopt|prompt|rhythm|stamp|persona|voice|isolation|sleep|lastword|diary|promise|unsaid|quota|tier", "enabled": bool}',
        'POST /rule          {"id": "silent", "enabled": bool}',
        'POST /rescan',
        'POST /selftest',
        'POST /selftest-adopt  会话换代防护的自测（不碰真 registry）',
        'POST /selftest-mention  群里叫名字的判定自测（纯本地，不发网）',
        'POST /selftest-stamp  时间/间隔注入的自测（纯函数 + 假 proto）',
        'POST /burst         {"text": "…"}',
        'POST /seed-style    {"chatId": "private:100000001", "profile": {…}}  灌离线画像（不收原话）',
        'POST /unarchive     {"sessionId": "onebot-group-…"}  取消归档（不传则释放所有 onebot-* 归档会话）',
        'POST /say           {"text": "…"}  试合成（只落盘，不发送）',
        'POST /voice-config  {"backend": "local|edge", "ref": "…", "localUrl": "…"}  运行时改语音配置（不写回 cordis.yml）',
        'POST /face          {"faces": ["笑哭"]}  只解析名字→id，不发送',
        'POST /reset-hits',
        'POST /selftest-diary  小本子的分级与遗忘自测（纯函数 + 假存储）',
        'POST /selftest-promise  约定的到点判定自测（纯函数 + 假时间）',
        'POST /selftest-unsaid  咽回去的话的过期与淡化自测（纯函数 + 假存储）',
        'POST /selftest-quota  自己的额度的换日线与阈值自测（纯函数 + 假实例）',
        'POST /selftest-phone  玩手机的「往下滑」与抓取容错自测（纯函数 + 假 fetch）',
        'POST /selftest-tier  关系阶段投影自测（纯函数）',
        'POST /selftest-lastword  「最后开口」补挂自测（真原型链）',
        'POST /selftest-circadian  生物钟的衰减/曲线/夜间掩码自测（纯函数 + 假实例）',
        'GET  /circadian     此刻学出来的作息投影（样本数/峰值小时/夜的小时数）',
        'GET  /tempo         此刻的生活节奏与每个会话的对话密度倍率',
        'GET  /interrupt     还没说完的半句（条数与最近一条的时间，不含原文）',
        'GET  /comfy         自己画图的配置与统计（含 ComfyUI 是否在跑）',
        'GET  /recall        撤回窗口内还剩几条自己发出去的消息可撤',
      ],
    }),
    gets: {
      '/hits': (url) => {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        return { ok: true, total: hits.length, hits: hits.slice(-limit).reverse() };
      },
      '/mood': () => ({ ok: true, mood: persona.snapshot() }),
      // 小本子与欠账：给人工核对留个只读窗口。JSON 文件本身也能翻，但那要
      // 自己算过期 —— 这里返回的是**投影后**的视图（过期的已经不在里面了）。
      '/diary': () => ({ ok: true, diary: diary.snapshot() }),
      '/promise': () => ({ ok: true, promise: promise.snapshot() }),
      '/unsaid': () => ({ ok: true, unsaid: unsaid.snapshot() }),
      '/quota': () => ({ ok: true, quota: quota.snapshot() }),
      // 生物钟（2026-10-21）：只给「够不够用 / 峰值在几点 / 几个夜」的投影，
      // 想调阈值就直接改配置 —— 这条路由是给人核对用的，不是编辑器。
      '/circadian': () => ({ ok: true, circadian: circadian?.snapshot?.() ?? { enabled: cfg.circadian?.enabled !== false } }),
      // 生活节奏（2026-10-22）：每个会话的对话密度与倍率。想知道「她现在该多急」就查它。
      '/tempo': () => ({ ok: true, tempo: tempo?.snapshot?.() ?? { enabled: cfg.tempo?.enabled !== false } }),
      // 未完成意图：只给条数，不给原文 —— 那是她心里没说完的半句话，
      // 体检单没有理由把它念出来。
      '/interrupt': () => ({ ok: true, interrupt: interrupt?.snapshot?.() ?? { enabled: cfg.interrupt?.enabled !== false } }),
      // 画图（2026-10-22）：ComfyUI 的连通性单独探，不塞进同步路由。
      '/comfy': async () => ({
        ok: true,
        comfy: {
          ...(comfy?.snapshot?.() ?? { enabled: cfg.comfy?.enabled !== false }),
          alive: await (comfy?.alive?.() ?? Promise.resolve(false)),
        },
      }),
      // 撤回（2026-10-23）：只报「还有几条可撤」，不吐 message_id ——
      // 那些 id 只能由 `qq_recall` 自己从内部表里取（见 modules/recall.js）。
      '/recall': () => ({ ok: true, recall: recall?.snapshot?.() ?? { enabled: cfg.recall?.enabled !== false } }),
      '/phone': () => ({ ok: true, phone: phone.snapshot() }),
      '/style': () => ({ ok: true, style: persona.styleSnapshot() }),
      '/voice': () => ({ ok: true, voice: voice.snapshot() }),
      // 最后开口：她上次真的说出话是什么时候、说了什么、隔了多久。
      '/lastword': () => ({ ok: true, lastword: lastword.snapshot() }),
      /**
       * 体检表数据面。纯投影，一次把「她还好吗」需要的东西全给出来
       * （见 modules/physical.js 头注释）。
       *
       * 唯一允许跨源读取的 GET 端点：体检表是本地 `file://` 打开的 html，
       * 其 origin 是 `null`，不放行就 fetch 不到。范围刻意收到这一条路径，
       * 且只放 GET —— 别的端点里有能改运行时配置的 POST。
       */
      '/physical': async () => {
        const now = Date.now();
        // 这几条会读磁盘（首次），是 async 的，所以整个处理器也 async。
        let diaryRecent = [];
        let promiseOpen = [];
        try {
          diaryRecent = await diary.list({ limit: 6 });
        } catch {
          diaryRecent = [];
        }
        try {
          promiseOpen = await promise.list({ status: 'open', limit: 6 });
        } catch {
          promiseOpen = [];
        }
        let patches = [];
        try {
          patches = stats.patched.map((p) => ({ moduleId: p.moduleId, method: p.method, patched: true }));
        } catch {
          patches = [];
        }
        return {
          ok: true,
          physical: buildPhysical({
            now,
            stats,
            cfg,
            moods: persona.snapshot(),
            body: persona.bodySnapshot(now),
            people: persona.peopleSnapshot(now),
            diary: diary.snapshot(),
            promise: promise.snapshot(),
            lastword: lastword.snapshot(),
            diaryRecent,
            promiseOpen,
            tierOf: (affinity) => tierSnapshot(affinity),
            patches,
            // 连接状态：三条路依次试，全问不到才给 null（未知 ≠ 断了）。
            // 1) `lastword` 记下的出站管线 ctx —— 热重载后仍然有效，`ctx.connected()`
            //    正是出站管线自己用来决定「发还是排队」的那口判定（outbound.js:59）；
            // 2) `lastReceiver.deps.connection.connected`（`OneBotConnection` 上的
            //    getter，lib/connection.js:113）；
            // 3) 都拿不到 → null。
            connected: (() => {
              try {
                const viaOutbound = lastword.snapshot()?.connected;
                if (typeof viaOutbound === 'boolean') return viaOutbound;
              } catch {
                /* 落到下一条路 */
              }
              try {
                const c = persona.state.lastReceiver?.deps?.connection?.connected;
                return typeof c === 'boolean' ? c : null;
              } catch {
                return null;
              }
            })(),
          }),
        };
      },
      // 表情表：确认 qq_send_face 的数据面在不在（名字→id 的映射）。
      '/faces': () => ({
        ok: true,
        count: FACE_COUNT,
        sent: { ...stats.faces },
        // 挑几个常用表情回显，方便肉眼核对 id 对不对
        sample: ['微笑', '呲牙', '偷笑', '笑哭', '委屈', '害羞', '调皮', '大哭'].map((n) => {
          const r = resolveFaceId(n);
          return { name: n, id: r.ok === true ? r.id : null };
        }),
      }),
    },
    posts: {
      '/toggle': (payload) => {
        cfg.enabled = payload.enabled === undefined ? !cfg.enabled : Boolean(payload.enabled);
        stats.enabled = cfg.enabled;
        persist();
        return { ok: true, enabled: cfg.enabled };
      },
      '/module': (payload) => {
        const key = String(payload.module ?? '');
        const MODULES = ['guard', 'mention', 'emoji', 'linkcard', 'hands', 'adopt', 'prompt', 'rhythm', 'stamp', 'persona', 'voice', 'isolation', 'sleep', 'lastword', 'diary', 'promise', 'unsaid', 'quota', 'phone', 'tier', 'stickers', 'focus', 'solitude', 'temper', 'circadian', 'tempo', 'interrupt', 'comfy', 'recall'];
        if (!MODULES.includes(key)) {
          return { ok: false, reason: 'unknown module', modules: MODULES };
        }
        cfg[key].enabled = payload.enabled === undefined ? !cfg[key].enabled : Boolean(payload.enabled);
        if (key === 'persona') {
          try {
            if (cfg.persona.enabled === false) persona.stop();
            else persona.start();
          } catch {
            /* ignore */
          }
        }
        persist();
        return { ok: true, module: key, enabled: cfg[key].enabled };
      },
      '/rule': (payload) => prompt.setRule(String(payload.id ?? ''), payload.enabled),
      '/rescan': async () => {
        const patched = await scanAll().catch(() => 0);
        persist();
        return { ok: true, patched, error: stats.resolveError };
      },
      '/selftest': async () => guard.selfTest(ctx),
      /**
       * 灌离线画像。语料（几万条真实聊天）在盘上，运行时只能一条条学，
       * 所以留这个口子把「算好的画像」直接放进来。算法仍由 style.js 完成，
       * 这里只做转发 + 画像本身的形状校验（不接原话，见 normalizeStyleProfile）。
       */
      '/seed-style': (payload) => {
        const chatId = String(payload.chatId ?? '');
        if (chatId === '') return { ok: false, error: 'chatId 不能为空' };
        const profile = payload.profile;
        if (profile === null || typeof profile !== 'object') {
          return { ok: false, error: 'profile 必须是对象（用 style.js 算出来的画像）' };
        }
        const r = persona.seedStyle(chatId, profile);
        if (r.ok === true) persist();
        return r;
      },
      /**
       * 取消归档 onebot 会话。
       *
       * 为什么需要这个口子：宿主有个 `archived-session-gate`，被归档的会话每提出
       * 一次 step 就被 reject 成 `{kind:'reject'}`，回合直接以 `blocked` 收场——
       * 表现是「消息进来了，云玥一个字都不回，日志里连 step/start 都没有」。
       * 归档集在 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds`，
       * 只能在运行时经 workspaceRegistry 改（手改文件会被内存态覆盖，重启才读）。
       *
       * 传 `{sessionId}` 释放指定会话；不传则把所有 `onebot-*` 的归档会话全放出来
       * （包括带换代后缀的旧 id —— 它们同样是归档的，留在集合里没意义）。
       */
      '/unarchive': async (payload) => {
        const registry = ctx.get?.('workspaceRegistry');
        if (registry === undefined || typeof registry.unarchiveSession !== 'function') {
          return { ok: false, error: 'workspaceRegistry 不可用' };
        }
        const targets = [];
        const explicit = String(payload?.sessionId ?? '').trim();
        if (explicit !== '') {
          targets.push(explicit);
        } else {
          for (const id of registry.archivedSessionIds ?? []) {
            if (String(id).startsWith('onebot-')) targets.push(String(id));
          }
        }
        if (targets.length === 0) return { ok: true, released: [], reason: '没有 onebot-* 的归档会话' };
        const released = [];
        const failed = [];
        for (const id of targets) {
          try {
            await registry.unarchiveSession(id);
            released.push(id);
          } catch (error) {
            failed.push({ id, error: String(error?.message ?? error) });
          }
        }
        return { ok: failed.length === 0, released, failed };
      },
      '/selftest-adopt': async () => adopt.selfTest(),
      '/selftest-mention': async () => mention.selfTest(),
      '/selftest-stamp': async () => stamp.selfTest(),
      '/selftest-diary': async () => diary.selfTest(),
      '/selftest-promise': async () => promise.selfTest(),
      '/selftest-unsaid': async () => unsaid.selfTest(),
      '/selftest-quota': async () => quota.selfTest(),
      '/selftest-phone': async () => phone.selfTest(),
      '/selftest-tier': async () => selfTestTier(),
      '/selftest-circadian': async () => circadian?.selfTest?.() ?? { ok: false, error: 'circadian 未装配' },
      '/selftest-lastword': async () => lastword.selfTest(ctx),
      '/burst': (payload) => {
        const sample =
          typeof payload.text === 'string'
            ? payload.text
            : '嗯，我想想啊。这个事吧，其实也没那么复杂，就是得慢慢来。';
        return {
          ok: true,
          input: sample,
          chunks: rhythm.splitBurstChunks(sample, {
            maxChars: Number(payload.maxChars) || cfg.rhythm.burst.maxChars,
            maxChunks: Number(payload.maxChunks) || cfg.rhythm.burst.maxChunks,
          }),
        };
      },
      // 试解析：只把名字翻成 id，不发到 QQ —— 用来确认表情表与查表逻辑。
      '/face': (payload) => {
        const list = Array.isArray(payload.faces) ? payload.faces : [];
        if (list.length === 0) return { ok: false, error: 'faces 不能为空' };
        const faces = list.map((item) => {
          const r = resolveFaceId(item);
          return r.ok === true
            ? { input: item, ok: true, id: r.id, name: r.name, known: r.known, segment: { type: 'face', data: { id: r.id } } }
            : { input: item, ok: false, error: r.error, hint: suggestFaces(item) };
        });
        return { ok: faces.every((f) => f.ok === true), faces };
      },
      '/reset-hits': () => {
        hits.length = 0;
        stats.blocked = 0;
        stats.stripped = 0;
        stats.muted = 0;
        persist();
        return { ok: true };
      },
      // 试合成：只落盘、不发送 —— 用来确认链路与音色，不必真的发到 QQ。
      '/say': async (payload) => {
        const text = String(payload.text ?? '').trim() || '你好呀，我是云玥，今天过得怎么样？';
        try {
          const dir = cfg.voice.mediaDir || persona.dir();
          // 本地后端自己写 outputs/，mediaDir 为空不算错（与 voice.say() 一致）。
          if (!dir && voice.synth.backend !== 'local') {
            return { ok: false, error: '语音目录未配置（voice.mediaDir / dsh-onebot 的 mediaDir 都为空）' };
          }
          voice.synth.dir = dir;
          const r = await voice.synth.speak(text);
          persist();
          return { ok: true, path: r.path, bytes: r.bytes, voice: r.voice, spoken: r.text };
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
          return { ok: false, error: stats.lastError };
        }
      },
      /**
       * 运行时改语音配置。
       *
       * `cordis.yml` 的插件配置在启动时就被 loader 解析进 entry 了，改文件不会
       * 热生效（`dsh-hot-reloader` 只盯源码）。换音色属于「试一试」的操作，
       * 为此重启 DSH 不划算 —— 尤其是它还带着正在进行的会话。
       * 这里改的是内存里的活配置，**不写回 yml**：重启后仍以 yml 为准。
       */
      '/voice-config': (payload) => {
        const r = voice.applyConfig(payload ?? {});
        if (r.applied.length > 0) persist();
        return { ok: r.applied.length > 0 || r.ignored.length === 0, ...r, voice: voice.snapshot() };
      },
    },
  });

  return handler;
}
