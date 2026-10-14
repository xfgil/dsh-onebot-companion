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
import { FACE_COUNT, resolveFaceId, suggestFaces } from './modules/faces.js';
import { createGuard, DEFAULTS as GUARD_DEFAULTS } from './modules/guard.js';
import { createPersona, chatIdOfSession, DEFAULTS as PERSONA_DEFAULTS } from './modules/persona.js';
import { createPrompt, DEFAULTS as PROMPT_DEFAULTS } from './modules/prompt.js';
import { createRhythm, DEFAULTS as RHYTHM_DEFAULTS } from './modules/rhythm.js';
import { createVoice, DEFAULTS as VOICE_DEFAULTS, VOICES } from './modules/voice.js';

export const name = 'onebot-companion';

/**
 * 硬声明 `tools` 依赖。
 *
 * 2026-10-13 实证：`inject = []` 时，下面 `ctx.inject(['tools'], cb)` 的回调
 * **永远不会被调用** —— 插件报告一切正常，但工具根本没注册上（`stats.tools`
 * 恒为 `[]`，QQ 会话的工具表里也查不到）。对照 `dsh-mnemon`
 * （`inject = ['tools', 'settings', ...]`）与 `dsh-onebot-qq`
 * （`inject = ['tools', 'systemPrompt', ...]`）都用模块级声明，工具正常可见。
 *
 * `webServer` 仍走运行时 `ctx.inject`（没有也能跑，只是少一个 HTTP 观测面）。
 */
export const inject = ['tools'];

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
  voice: { ...VOICE_DEFAULTS },
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
  for (const key of ['guard', 'prompt', 'rhythm', 'persona', 'voice']) {
    const seg = {
      packageName: out.packageName,
      profileDir: out.profileDir,
      ...DEFAULTS[key],
      ...(raw?.[key] ?? {}),
    };
    // 用户对**本模块**的意图（顶层总开关之外的那一层）。`undefined` 视为开。
    let wanted = seg.enabled !== false;
    // 顶层总开关一票否决：`enabled:false` 关掉全部模块。
    //
    // 这里必须用**访问器**而不是一次性赋值：`POST /toggle` 在运行时只改顶层的
    // `out.enabled`，各模块早就拿着自己的 `cfg` 子对象了。若 `enabled` 是普通
    // 数据属性，模块读到的永远是启动那一刻的快照，总开关点了等于没点 ——
    // 2026-10-14 实测：toggle 置 false 后 guard/prompt/rhythm/persona 的
    // `enabled` 仍报 true，行为照旧（全文只有 4 处读 `out.enabled`，且全在
    // 统计与状态显示里）。访问器让「读」始终是「顶层开关 ∧ 本模块意图」的合成值。
    Object.defineProperty(seg, 'enabled', {
      enumerable: true,
      configurable: true,
      get: () => out.enabled !== false && wanted,
      set: (v) => {
        wanted = v !== false;
      },
    });
    out[key] = seg;
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
  // voice
  voice: { sent: 0, lastSentAt: null, lastChatId: null, lastBytes: 0, lastText: null },
  // face（qq_send_face 工具）
  faces: { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null },
  // 已注册的工具名
  tools: [],
});

/** guard 的命中环形数组（跨热重载保留最近 200 条）。 */
const HITS_KEY = Symbol.for('dsh-onebot-companion.hits');
const hits = (globalThis[HITS_KEY] ??= []);

/**
 * 把新增的统计字段补进**已经存在**的 stats 对象。
 *
 * 为什么需要：`stats` 挂在 `globalThis` 上跨热重载复用，`??=` 只在首次创建时
 * 填入完整形状。之后再往模板里加字段（比如这次的 `voice`），热重载拿到的是
 * **旧对象** —— 新字段是 `undefined`，于是 `stats.voice.sent += 1` 直接抛
 * `TypeError`。实测就是这么暴露的：`voice` 段落盘是空的 `{}`。
 *
 * 补法是「只在缺失时填」：已有值（累计的计数）绝不覆盖。
 */
function ensureStatsShape(target) {
  const template = {
    version: 1,
    startedAt: null,
    generations: 0,
    scans: 0,
    lastScanAt: null,
    enabled: true,
    resolveError: null,
    profileDir: '',
    patched: [],
    lost: [],
    lastError: null,
    blocked: 0,
    stripped: 0,
    lastHitAt: null,
    lastHitKind: null,
    lastHitText: null,
    lastHitChat: null,
    steps: 0,
    injections: 0,
    skippedNotOnebot: 0,
    skippedNotFirstStep: 0,
    lastInjectionAt: null,
    lastSessionId: null,
    activeRules: [],
    inbound: { held: 0, merged: 0, flushed: 0, dropped: 0, pending: 0 },
    burst: { replies: 0, messages: 0, folded: 0, aborted: 0 },
    proactive: { fired: 0, lastFiredAt: null, lastChatId: null },
    voice: { sent: 0, lastSentAt: null, lastChatId: null, lastBytes: 0, lastText: null },
    faces: { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null },
    /** 已注册的工具名（`ctx.inject(['tools'])` 的回调真的跑过才会出现）。 */
    tools: [],
  };
  for (const [key, value] of Object.entries(template)) {
    if (target[key] === undefined) {
      target[key] = value !== null && typeof value === 'object' ? structuredClone(value) : value;
      continue;
    }
    // 嵌套段（inbound / burst / proactive / voice）同样补齐缺失的键。
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (target[key][k] === undefined) target[key][k] = v;
      }
    }
  }
  return target;
}

ensureStatsShape(stats);

/**
 * 记一笔「工具真的注册上了」。
 *
 * 为什么要有这个：`ctx.inject(['tools'], cb)` 的回调**可能永远不被调用**（宿主
 * 没提供 `tools` 服务时静默跳过），而插件报告一切正常 —— 2026-10-13 补
 * `qq_send_face` 时正需要区分「注册失败」与「注册成功但模型没调用」。
 * 只记名字，不记 disposer。
 */
function noteToolRegistered(toolName) {
  if (!Array.isArray(stats.tools)) stats.tools = [];
  if (!stats.tools.includes(toolName)) stats.tools.push(toolName);
}

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

  // voice 只读 persona 的 bridge 实例（persona 已经挂了 handleInbound /
  // onSessionEvent，那两个方法的 this 就是 bridge）—— 见 modules/voice.js 注释。
  const voice = createVoice({
    cfg: cfg.voice,
    stats,
    log,
    resolveMediaDir: () => persona.dir(),
    getReceiver: () => persona.state.lastReceiver,
  });

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
        voice: { ...stats.voice },
        faces: { ...stats.faces },
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

  // ── qq_say / qq_send_face 工具 ────────────────────────────────────────────
  //
  // 注册只需一个纯 JSON 对象（name / description / parameters /
  // output{schema,render} / execute），**不 import `@deepseek-ai/dsh-tools`**
  // —— 那个包在 profile 侧解析不到（实测 ERR_MODULE_NOT_FOUND）。
  //
  // 2026-10-13：这里踩过两个坑，都记下来。
  //   ① 原写法 `ctx.inject(['tools'], (toolCtx) => …)` 的回调**从未执行过**
  //      （`stats.tools` 恒为 `[]`），工具根本没上线 —— 光看插件状态一切正常。
  //   ② 改成直接 `ctx.tools` 后抛 `cannot get property "tools" without inject`
  //      —— Cordis 用 `prop in fiber.inject` 判定，而热重载重建时
  //      `dsh-hot-reloader` 传的第三参数 `() => []` 会盖掉模块级 inject，
  //      光写 `export const inject = ['tools']` 也不够。
  // 走可选访问 `ctx.get('tools')`：不依赖 fiber.inject；拿不到就记一条
  // `stats.toolErrors`，让「注册失败」和「注册成功但模型没调用」可区分。
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    stats.toolErrors ??= [];
    stats.toolErrors.push('tools 服务不可用，qq_say/qq_send_face 未注册');
    log('warn', `[${name}] tools 服务不可用，工具未注册`);
  }

  try {
    if (tools) {
    ctx.effect(
      () =>
        tools.register({
          name: 'qq_say',
            description:
              '用语音说一句话（自己合成语音发出去，不是转发别人的录音）。适合偶尔撒娇、问候、卖萌，或者一句话太长、用说的更自然的时候。音色固定、内容是口语短句，不要每条都发，也不要念长篇内容。',
            // 注意：这是**直接** `tools.register`，不经 `defineTool()` 包装，
            // 所以要自己写成完整 JSON Schema。`defineTool()` 才吃「扁平参数映射」
            // 那种简写；直接 register 时扁平写法会被原样透传给上游，触发
            // `invalid_function_parameters` / code 11129
            // （「工具定义不合规，请新建任务重试」）—— 2026-10-14 实测踩坑。
            parameters: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: '要说的话（口语短句，建议 40 字以内；会去掉 Markdown 标记）',
                },
                chat_id: {
                  type: 'string',
                  description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
                },
              },
              required: ['text'],
            },
            output: {
              // 注意：`{ type: 'json' }` 是 `defineTool()` 的私有简写，只有经它
              // 包装才合法；直接 `tools.register` 会被宿主拒掉
              // （`unsupported JSON schema: schema.type must be one of …`）。
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    value && value.ok === true
                      ? `已发语音（${value.bytes} bytes，音色 ${value.voice}）：「${value.text}」`
                      : `发语音失败：${value?.error ?? '未知原因'}`,
                },
              ],
            },
            isConcurrencySafe: () => false,
            execute: async (args, exec) => {
              const text = String(args?.text ?? '').trim();
              if (text === '') return { ok: false, error: 'text 不能为空' };
              // 目标会话：显式 chat_id 优先；否则从调用方会话反推（persona 的
              // chatIdOfSession 是同一套规则）。
              let chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
              if (chatId === '') {
                const sid = exec?.agent?.session?.id;
                chatId = chatIdOfSession(sid) ?? '';
              }
              try {
                const r = await voice.say(text, chatId);
                persist();
                return r;
              } catch (error) {
                stats.lastError = String(error?.message ?? error);
                log('warn', `[${name}] qq_say 失败: ${stats.lastError}`);
                return { ok: false, error: stats.lastError };
              }
            },
          }),
        `${name}: qq_say`,
    );
    noteToolRegistered('qq_say');
    }
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_say: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_say 注册失败: ${error?.message ?? error}`);
  }

  // ── qq_send_face 工具：发 QQ 原生表情 ─────────────────────────────────────
  //
  // 2026-10-13 实测暴露的缺口：规则④（rules.js 的 R_FACE）要求「表情要善用：
  // qq_send_face 传表情名……」，但 `dsh-onebot-qq` 从来没注册过这个工具 ——
  // 模型照着规则调用，拿到 `Error: unknown tool "qq_send_face"`，白烧一个 step
  // （会话 seq2169/2170 实证）。这里把工具补上，让规则④不再是空头支票。
  //
  // 不用 `set_msg_emoji_like`：那是「给某条消息贴表情回应」的点赞语义，要先有
  // message_id，和「发表情」不是一回事。直接走 `bridge.sendSegments` 发
  // `{type:'face', data:{id}}` 段（OneBot 11 标准段，qq_send_image/voice 同路）。
  try {
    if (tools) {
    ctx.effect(
      () =>
        tools.register({
          name: 'qq_send_face',
            description:
              `发 QQ 原生表情（小黄脸等，共 ${FACE_COUNT} 个名字可选），不适合用文字表达情绪时用。一次最多 3 个，会拼在同一条消息里发出。也可以用数字 id 直接指定。`,            // 同 qq_say：直接 register，必须自带完整 JSON Schema（见上）。
            parameters: {
              type: 'object',
              properties: {
                faces: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '表情名列表（如 ["笑哭"]、["委屈","害羞"]）或数字 id（如 ["182"]），最多 3 个',
                },
                chat_id: {
                  type: 'string',
                  description: '目标会话，格式 private:<QQ号> 或 group:<群号>；省略时默认当前会话',
                },
              },
              required: ['faces'],
            },
            output: {
              // 同上：不能用 `defineTool()` 的 `{type:'json'}` 简写。
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    value && value.ok === true
                      ? `已发表情：${(value.faces ?? []).map((f) => f.name).join('、')}`
                      : `发表情失败：${value?.error ?? '未知原因'}`,
                },
              ],
            },
            isConcurrencySafe: () => false,
            execute: async (args, exec) => {
              const raw = Array.isArray(args?.faces) ? args.faces : [];
              if (raw.length === 0) return { ok: false, error: 'faces 不能为空' };
              if (raw.length > 3) return { ok: false, error: '一次最多 3 个表情' };

              // 名字 → id；查不到就带上候选提示，让模型下一轮自己改对
              const resolved = [];
              for (const item of raw) {
                const r = resolveFaceId(item);
                if (r.ok !== true) {
                  return { ok: false, error: `${r.error}${suggestFaces(item)}` };
                }
                resolved.push(r);
              }

              let chatId = typeof args?.chat_id === 'string' ? args.chat_id.trim() : '';
              if (chatId === '') {
                const sid = exec?.agent?.session?.id;
                chatId = chatIdOfSession(sid) ?? '';
              }

              const bridge = persona?.state?.lastReceiver;
              if (!bridge || typeof bridge.sendSegments !== 'function') {
                return { ok: false, error: 'QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试' };
              }
              if (chatId === '') return { ok: false, error: '无法确定目标会话：请显式传 chat_id' };

              try {
                const messageId = await bridge.sendSegments(
                  chatId,
                  resolved.map((r) => ({ type: 'face', data: { id: r.id } })),
                );
                stats.faces ??= { sent: 0, lastSentAt: null, lastChatId: null, lastFaces: null };
                stats.faces.sent += 1;
                stats.faces.lastSentAt = Date.now();
                stats.faces.lastChatId = chatId;
                stats.faces.lastFaces = resolved.map((r) => `${r.name}=${r.id}`);
                persist();
                return {
                  ok: true,
                  messageId: messageId ?? null,
                  chatId,
                  faces: resolved.map((r) => ({ name: r.name, id: r.id, known: r.known })),
                };
              } catch (error) {
                stats.lastError = String(error?.message ?? error);
                log('warn', `[${name}] qq_send_face 失败: ${stats.lastError}`);
                return { ok: false, error: stats.lastError };
              }
            },
          }),
        `${name}: qq_send_face`,
    );
    noteToolRegistered('qq_send_face');
    }
  } catch (error) {
    stats.toolErrors ??= [];
    stats.toolErrors.push(`qq_send_face: ${error?.message ?? error}`);
    log('warn', `[${name}] qq_send_face 注册失败: ${error?.message ?? error}`);
  }

  // ── 周期补挂 ─────────────────────────────────────────────────────────────
  let disposed = false;
  let timer = null;

  const scanAll = async () => {
    const results = await Promise.allSettled([
      guard.scan(ctx),
      rhythm.scan(ctx),
      persona.scan(ctx),
      voice.scan(ctx),
    ]);
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
        voice: voice.snapshot(),
        faces: { count: FACE_COUNT, sent: stats.faces.sent },
      },
      endpoints: [
        'GET  /',
        'GET  /status',
        'GET  /hits?limit=',
        'GET  /mood',
        'GET  /style',
        'GET  /voice',
        'GET  /faces',
        'POST /toggle        {"enabled": bool}',
        'POST /module        {"module": "guard|prompt|rhythm|persona|voice", "enabled": bool}',
        'POST /rule          {"id": "silent", "enabled": bool}',
        'POST /rescan',
        'POST /selftest',
        'POST /burst         {"text": "…"}',
        'POST /say           {"text": "…"}  试合成（只落盘，不发送）',
        'POST /face          {"faces": ["笑哭"]}  只解析名字→id，不发送',
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
      '/voice': () => ({ ok: true, voice: voice.snapshot() }),
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
        const MODULES = ['guard', 'prompt', 'rhythm', 'persona', 'voice'];
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
        persist();
        return { ok: true };
      },
      // 试合成：只落盘、不发送 —— 用来确认 edge-tts 链路与音色，不必真的发到 QQ。
      '/say': async (payload) => {
        const text = String(payload.text ?? '').trim() || '你好呀，我是云玥，今天过得怎么样？';
        try {
          const dir = cfg.voice.mediaDir || persona.dir();
          if (!dir) return { ok: false, error: '语音目录未配置（voice.mediaDir / dsh-onebot 的 mediaDir 都为空）' };
          voice.synth.dir = dir;
          const r = await voice.synth.speak(text);
          persist();
          return { ok: true, path: r.path, bytes: r.bytes, voice: r.voice, spoken: r.text };
        } catch (error) {
          stats.lastError = String(error?.message ?? error);
          return { ok: false, error: stats.lastError };
        }
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
      `persona=${cfg.persona.enabled ? '开' : '关'}（情绪 ${cfg.persona.moodEnabled ? '开' : '关'} / 主动 ${cfg.persona.proactiveEnabled ? '开' : '关'} / 风格 ${cfg.persona.styleEnabled ? '开' : '关'}），` +
      `voice=${cfg.voice.enabled ? '开' : '关'}（音色 ${cfg.voice.voice}）`,
  );
}

export default { name, apply };
