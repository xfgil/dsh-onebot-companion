/**
 * dsh-onebot-companion —— 一个插件，把 QQ 通道该有的四件事都装回来。
 *
 * ## 为什么是一个插件而不是四个
 *
 * 用户原话：「我发现 p1p2 合并成一个插件啊 p3p4 也是，甚至 4 个都可以合并成
 * 一个」。于是合并成一个包、内部按职责分成四个模块：
 *
 *   | 模块      | 干什么                                   | 挂在哪                                    |
 *   |-----------|------------------------------------------|-------------------------------------------|
 *   | `guard`   | 出站闸：拦 `[[silent]]` 与括号旁白        | `OutboundPipeline.prototype.sendToChat/sendMsg` |
 *   | `prompt`  | 每轮注入 5 条行为规则 + 情绪/风格行       | 宿主 `agent/pre-step`（不挂原型）          |
 *   | `rhythm`  | 入站合并（连打三行 = 一个回合）+ 出站分段 | `ChatBridge.prototype.dispatchFollowup/sendToChat` |
 *   | `persona` | 情绪四变量 + 随机主动发言 + 风格学习      | `ChatBridge.prototype.handleInbound/onSessionEvent` |
 *
 * 四个模块挂在**不同**的方法上，靠 `core/patch.js` 的模块身份标记共存，互不吞并。
 *
 * ## 为什么必须从外面挂（改 node_modules 是死路）
 *
 * 2026-10-06 ~ 10-12 这些功能原本是直接改 `node_modules/dsh-onebot-qq/lib/*.js`
 * 实现的（`prompt.js` 累计 29 次 edit、`bridge.js` 66 次）。10-12 升到 0.9.0 时
 * pnpm 换了目录，**一次全抹掉**。所以本插件一行都不改 node_modules，只从外面给
 * 原型挂包装 —— 升级不会再把功能冲掉。
 *
 * ## 刻意不导出 Config schema
 *
 * 沿用 guard / prompt 的实测结论：profile 侧解析不到宿主的 `schemastery`，导出
 * 非 schema 对象会让 loader 投影 config 时报错。配置走 `{...DEFAULTS, ...config}`。
 *
 * ## 状态文件
 *
 * `$DSH_HOME/onebot-companion/state.json`（本插件的运行态：挂了哪些闸、扫了几次、
 * 命中多少）。**情绪与风格画像不在里面** —— 它们继续写
 * `config.mediaDir`（云玥的 `D:\path\to\qq-bot\.dsh-media\`），于是换插件也能
 * 继承历史数据。
 *
 * @module dsh-onebot-companion
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createHandler, registerHttp } from './core/http.js';
import { JsonStore } from './core/jsonstore.js';
import { createPatcher } from './core/patch.js';
import { createGuard, DEFAULTS as GUARD_DEFAULTS } from './modules/guard.js';
import { createPersona, DEFAULTS as PERSONA_DEFAULTS } from './modules/persona.js';
import { createPrompt, DEFAULTS as PROMPT_DEFAULTS } from './modules/prompt.js';
import { createRhythm, DEFAULTS as RHYTHM_DEFAULTS } from './modules/rhythm.js';

export const name = 'onebot-companion';

/** 本插件不依赖宿主的任何服务（`webServer` 走 inject，没有也能跑）。 */
export const inject = [];

/** 状态文件默认位置：`$DSH_HOME/onebot-companion/state.json`。 */
export function defaultStateFile(override) {
  if (typeof override === 'string' && override !== '') return override;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'onebot-companion', 'state.json');
}

const DEFAULTS = {
  /** 总开关：关掉后四个模块全部原样放行。 */
  enabled: true,
  /** 目标包名（要挂的 QQ 通道插件）。 */
  packageName: 'dsh-onebot-qq',
  /** profile 目录；留空则多路自动探测。 */
  profileDir: '',
  /** 补挂扫描周期（毫秒）。目标包被升级换目录后靠它自愈。 */
  pollMs: 3000,
  /** 本插件运行态落盘位置；留空用 `$DSH_HOME/onebot-companion/state.json`。 */
  stateFile: '',
  guard: { ...GUARD_DEFAULTS },
  prompt: { ...PROMPT_DEFAULTS },
  rhythm: { ...RHYTHM_DEFAULTS },
  persona: { ...PERSONA_DEFAULTS },
};

/**
 * 深合并两层：顶层 + 四个模块段。
 *
 * 模块段内部的嵌套（`rhythm.inbound` / `rhythm.burst`）交给各模块自己的默认值，
 * 这里只保证「用户给了部分键」不会把整段默认值顶掉。
 *
 * **`packageName` / `profileDir` 要下发到每一段**：四个模块都要 `import()` 目标包
 * （`core/profile.js` 读的是 `cfg.packageName`），让调用方在每个模块段里重复写一遍
 * 是纯粹的陷阱 —— 实测就是这么踩到的：段里没有 `packageName`，`resolveProfileDirs`
 * 去找「含 undefined 的 profile 目录」，四个模块全部挂不上，而插件还报告一切正常。
 */
function mergeConfig(raw) {
  const out = { ...DEFAULTS, ...(raw ?? {}) };
  for (const key of ['guard', 'prompt', 'rhythm', 'persona']) {
    out[key] = {
      packageName: out.packageName,
      profileDir: out.profileDir,
      ...DEFAULTS[key],
      ...(raw?.[key] ?? {}),
    };
  }
  return out;
}

/** 导出给自测用：测的就是生产路径上的这份合并。 */
export { mergeConfig };

/**
 * 统计放在 `globalThis`（`Symbol.for` 键）—— 热重载换了模块实例，数字不清零。
 *
 * 一个对象服务四个模块：字段名互不冲突（guard 用顶层 `blocked`/`stripped`，
 * rhythm 用 `inbound`/`burst`，persona 用 `proactive`，prompt 用 `steps`/
 * `injections`），共享的 `scans`/`patched`/`lost`/`profileDir` 本来就是全局的。
 */
const STATS_KEY = Symbol.for('dsh-onebot-companion.stats');
const stats = (globalThis[STATS_KEY] ??= {
  version: 1,
  startedAt: null,
  generations: 0,
  scans: 0,
  lastScanAt: null,
  enabled: DEFAULTS.enabled,
  resolveError: null,
  profileDir: '',
  patched: [],
  lost: [],
  lastError: null,
  // guard
  blocked: 0,
  stripped: 0,
  lastHitAt: null,
  lastHitKind: null,
  lastHitText: null,
  lastHitChat: null,
  // prompt
  steps: 0,
  injections: 0,
  skippedNotOnebot: 0,
  skippedNotFirstStep: 0,
  lastInjectionAt: null,
  lastSessionId: null,
  activeRules: [],
  // rhythm
  inbound: { held: 0, merged: 0, flushed: 0, dropped: 0, pending: 0 },
  burst: { replies: 0, messages: 0, folded: 0, aborted: 0 },
  // persona
  proactive: { fired: 0, lastFiredAt: null, lastChatId: null },
});

/** guard 的命中环形数组（跨热重载保留最近 200 条）。 */
const HITS_KEY = Symbol.for('dsh-onebot-companion.hits');
const hits = (globalThis[HITS_KEY] ??= []);

export function apply(ctx, config) {
  const cfg = mergeConfig(config);
  const log = (level, message) => {
    try {
      ctx?.logger?.[level]?.(message);
    } catch {
      /* 日志失败不影响业务 */
    }
  };

  stats.generations += 1;
  stats.startedAt ??= Date.now();
  stats.enabled = cfg.enabled;

  /**
   * 「本次实例挂的」标记。普通 Symbol —— 每次 `apply()` 都是新的一个，于是热重载
   * 后旧包装不被认成自己人，会重新挂一遍（新配置要生效，这是**想要的**行为）。
   */
  const owner = Symbol('dsh-onebot-companion.owner');

  /** 挂载器：四个模块共用，按模块身份脱链（见 core/patch.js）。 */
  const patchMethod = createPatcher({ owner, log, stats, label: name });

  /** guard 自测期间静音（自测的 BLOCKED 不该污染生产命中数）。 */
  const ctl = { suspended: false };

  // ── 四个模块 ─────────────────────────────────────────────────────────────
  const guard = createGuard({ cfg: cfg.guard, stats, hits, ctl, patchMethod, log });

  // prompt 与 persona 搭车：规则文本 + 情绪/风格行合成一条注入消息。
  let persona;
  const prompt = createPrompt({
    cfg: cfg.prompt,
    stats,
    extra: (sessionId) => {
      try {
        return persona?.extraFor?.(sessionId) ?? null;
      } catch {
        return null;
      }
    },
  });

  const rhythm = createRhythm({ cfg: cfg.rhythm, stats, patchMethod, log });
  persona = createPersona({ cfg: cfg.persona, stats, patchMethod, log });

  // ── 状态落盘：从文件系统就能看出插件在不在跑 ──────────────────────────────
  const store = new JsonStore({
    file: defaultStateFile(cfg.stateFile),
    log,
    label: name,
    normalize: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined,
  });

  const persist = () => {
    try {
      store.set('self', {
        at: Date.now(),
        generations: stats.generations,
        packageName: cfg.packageName,
        profileDir: stats.profileDir,
        resolveError: stats.resolveError,
        enabled: cfg.enabled,
        attached: stats.patched.map((p) => `${p.moduleId}:${p.method}`),
        lost: stats.lost.map((l) => `${l.moduleId}:${l.method}`),
        scans: stats.scans,
        lastScanAt: stats.lastScanAt,
        guard: {
          blocked: stats.blocked,
          stripped: stats.stripped,
          lastHitAt: stats.lastHitAt,
          lastHitKind: stats.lastHitKind,
          lastHitChat: stats.lastHitChat,
        },
        prompt: {
          steps: stats.steps,
          injections: stats.injections,
          skippedNotOnebot: stats.skippedNotOnebot,
          skippedNotFirstStep: stats.skippedNotFirstStep,
          activeRules: prompt.activeRuleIds(),
        },
        rhythm: {
          inbound: { ...stats.inbound, pending: rhythm.pendingCount() },
          burst: { ...stats.burst },
        },
        persona: {
          mediaDir: persona.dir(),
          proactive: { ...stats.proactive },
        },
        lastError: stats.lastError,
      });
      store.saveDebounced();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }
  };

  void store
    .load()
    .then(() => persist())
    .catch(() => undefined);

  // ── 宿主钩子：每步模型调用前注入规则 + 状态 ───────────────────────────────
  //
  // 只有 `onebot-*` 会话会命中（模块内部判定），别的会话原样放行。
  try {
    ctx.on('agent/pre-step', (payload, next) => prompt.preStep(payload, next));
  } catch (error) {
    log('warn', `[${name}] agent/pre-step 注册失败: ${error?.message ?? error}`);
  }

  // ── 周期补挂 ─────────────────────────────────────────────────────────────
  let disposed = false;
  let timer = null;

  const scanAll = async () => {
    const results = await Promise.allSettled([guard.scan(ctx), rhythm.scan(ctx), persona.scan(ctx)]);
    let patched = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.ok === true) patched += r.value.patched ?? 0;
    }
    return patched;
  };

  ctx.effect(() => {
    void scanAll()
      .then(() => persist())
      .catch(() => undefined);

    const period = Math.max(500, Number(cfg.pollMs) || DEFAULTS.pollMs);
    timer = setInterval(() => {
      if (disposed) return;
      void scanAll()
        .then(() => persist())
        .catch(() => undefined);
    }, period);
    try {
      timer.unref?.();
    } catch {
      /* ignore */
    }

    // 主动发言调度器：无 cron，只有随机间隔（见 modules/proactive.js）。
    try {
      persona.start();
    } catch (error) {
      stats.lastError = String(error?.message ?? error);
    }

    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = null;
      try {
        persona.stop();
      } catch {
        /* ignore */
      }
      try {
        rhythm.stop();
      } catch {
        /* ignore */
      }
      void store.flush().catch(() => undefined);
    };
  });

  // ── HTTP 观测面（loopback only）──────────────────────────────────────────
  const handler = createHandler({
    prefix: `/${name}`,
    log,
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
        persona: { mediaDir: persona.dir() },
      },
      endpoints: [
        'GET  /',
        'GET  /status',
        'GET  /hits?limit=',
        'GET  /mood',
        'GET  /style',
        'POST /toggle        {"enabled": bool}',
        'POST /module        {"module": "guard|prompt|rhythm|persona", "enabled": bool}',
        'POST /rule          {"id": "silent", "enabled": bool}',
        'POST /rescan',
        'POST /selftest',
        'POST /burst         {"text": "…"}',
        'POST /reset-hits',
      ],
    }),
    gets: {
      '/hits': (url) => {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 20));
        return { ok: true, total: hits.length, hits: hits.slice(-limit).reverse() };
      },
      '/mood': () => ({ ok: true, mood: persona.snapshot() }),
      '/style': () => ({ ok: true, style: persona.styleSnapshot() }),
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
        if (!['guard', 'prompt', 'rhythm', 'persona'].includes(key)) {
          return { ok: false, reason: 'unknown module', modules: ['guard', 'prompt', 'rhythm', 'persona'] };
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
      '/reset-hits': () => {
        hits.length = 0;
        stats.blocked = 0;
        stats.stripped = 0;
        persist();
        return { ok: true };
      },
    },
  });

  registerHttp(ctx, { prefix: `/${name}`, handler });

  log(
    'info',
    `[${name}] 启动：目标=${cfg.packageName}，周期=${cfg.pollMs}ms；` +
      `guard=${cfg.guard.enabled ? '开' : '关'}，` +
      `prompt=${cfg.prompt.enabled ? '开' : '关'}（${prompt.activeRuleIds().length} 条规则），` +
      `rhythm=${cfg.rhythm.enabled ? '开' : '关'}（入站 ${cfg.rhythm.inbound.enabled ? '合并' : '关'} / 出站 ${cfg.rhythm.burst.enabled ? '分段' : '关'}），` +
      `persona=${cfg.persona.enabled ? '开' : '关'}（情绪 ${cfg.persona.moodEnabled ? '开' : '关'} / 主动 ${cfg.persona.proactiveEnabled ? '开' : '关'} / 风格 ${cfg.persona.styleEnabled ? '开' : '关'}）`,
  );
}

export default { name, apply };
