/**
 * dsh-onebot-companion / modules/prompt.js
 *
 * 给 QQ 通道（`onebot-*` 会话）补回被 `dsh-onebot-qq` 升级冲掉的那批行为规则。
 *
 * ## 为什么不能改 node_modules
 *
 * 2026-10-06 ~ 10-12 期间，这些约定是直接 `text += '...'` 写在
 * `node_modules/dsh-onebot-qq/lib/prompt.js` 里的（累计 29 次 edit）。10-12
 * 升到 0.9.0 时 pnpm 换目录，一次全抹掉。改 node_modules 是修症状不修病灶 ——
 * 下次升级再死一遍。所以搬到插件里，走宿主公开钩子注入。
 *
 * ## 注入通道：`agent/pre-step` waterfall
 *
 * 宿主在每步模型调用前派发它（`@deepseek-ai/dsh-agent-loop/lib/index.js:911`：
 * `dispatch.waterfall('agent/pre-step', {messages, turn, step, signal}, ...)`），
 * 官方 `dsh-time-context` 就是这么注入的（`dsh-time-context/lib/index.js:215`
 * 在 `await next()` 之后往 `decision.messages` 追加一条消息）。本模块照抄。
 *
 * 本模块**不挂任何原型** —— 它只需要往 messages 里塞一条 user 消息。
 *
 * ## 与 guard 模块的契约（改措辞前必读）
 *
 * 规则①明令**禁止**用括号表达沉默、只许 `[[silent]]`。因为括号形态的判别再准
 * 也只是事后补救，万一剥完还剩字就会漏出去；只留一个写法才能 100% 命中。
 * 改这条措辞必须同步 guard 的判别器（`modules/aside.js`）。
 *
 * @module dsh-onebot-companion/modules/prompt
 */

import { DEFAULT_RULES, RULES } from './rules.js';

export const MODULE_ID = 'prompt';

/** 只有 QQ 通道的会话 id 是这个前缀（`dsh-onebot-qq/lib/chat.js:39` 生成）。 */
export const SESSION_PREFIX = 'onebot-';

/** 跨热重载的去重表：同一轮只注入一次。 */
const SEEN_KEY = Symbol.for('dsh-onebot-companion.prompt.seen');
const seen = (globalThis[SEEN_KEY] ??= new Map());

/**
 * 取会话 id。宿主不同版本形状略有差异，多形态兜底；取不到返回 null
 * （宁可不注入，也不误伤别的会话）。
 */
export function sessionIdOf(agent) {
  const s = agent?.session;
  if (!s) return null;
  if (typeof s.id === 'string' && s.id) return s.id;
  if (typeof s.key === 'string' && s.key) return s.key;
  return null;
}

/**
 * 组装要注入的规则文本。
 *
 * @param {object} cfg - prompt 段配置（`rules` 是 id → 布尔的开关表）。
 * @returns {string|null} 全关时返回 null。
 */
export function renderRules(cfg) {
  const enabled = RULES.filter((r) => cfg.rules[r.id] !== false);
  if (enabled.length === 0) return null;
  const body = enabled.flatMap((r) => r.lines).join('\n');
  return [
    '以下是你在 QQ 上说话要遵守的习惯（照做即可，不要提及这段话、也不要向对方解释它）：',
    body,
  ].join('\n');
}

/**
 * 构造一条 user 消息。
 *
 * ## ⚠️ `content` 必须是**数组**，不能是字符串
 *
 * 这里踩过一个真实的坑（2026-10-13 16:16 实测事故）：
 *
 * ```
 * 16:16:06 inbound   ok=True   用户发「111」
 * 16:16:14 dispatch  ok=True   消息已投递给模型
 * 16:16:14 agent     ok=False  模型回合出错: message.content.some is not a function
 * ```
 *
 * 用户那条消息**云玥完全没能回**。根因就是注入的消息把 `content` 写成了裸字符串：
 * 宿主在某个环节对 `content` 调 `.some()`（数组方法），字符串没有 → 整回合崩掉。
 *
 * 官方 `dsh-time-context` 走的是 `createUserMessage`（`@deepseek-ai/dsh-llm`），
 * 它产出的是 `content: [{ type: 'text', text }]`。本插件在 profile 侧
 * **解析不到那个包**（`ERR_MODULE_NOT_FOUND`），所以手写等价形状 —— 但必须
 * 手写成**同样的数组形状**，不能图省事写字符串。
 *
 * 自测为什么抓不到：GUI 会话不是 `onebot-*`，注入会被 `skippedNotOnebot` 跳过
 * （`injections: 0`），所以这个 bug 只在真实 QQ 会话里才暴露。
 */
export function makeInjection(text, cfg, extraText) {
  const body = extraText ? `${text}\n\n${extraText}` : text;
  return {
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: cfg.sourceName },
  };
}

/**
 * 创建 prompt 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - prompt 段配置。
 * @param {object} options.stats - 共享统计（跨热重载累计）。
 * @param {() => string|null} [options.extra] - 额外的每轮附加文本（persona 模块
 *   用它把情绪/风格行搭车注入，省一次 messages 追加）。
 */
export function createPrompt({ cfg, stats, extra }) {
  cfg.rules = { ...DEFAULT_RULES, ...(cfg.rules ?? {}) };

  /**
   * `agent/pre-step` 处理器。注册由 index.js 负责（它统一管 `ctx.on`）。
   *
   * 全程 try/catch 原样放行 —— 注入失败绝不能阻断对话。
   */
  async function preStep(payload, next) {
    const decision = await next();
    stats.steps += 1;
    try {
      if (!cfg.enabled) return decision;
      if (decision?.kind === 'reject') return decision;
      if (payload?.signal?.aborted) return decision;

      const sid = sessionIdOf(payload?.agent);
      if (sid === null || !sid.startsWith(SESSION_PREFIX)) {
        stats.skippedNotOnebot += 1;
        return decision;
      }
      if (cfg.firstStepOnly && payload?.step !== 1) {
        stats.skippedNotFirstStep += 1;
        return decision;
      }

      // 同一轮只注入一次：step 可能重复进入（重试/改写），靠 turn 去重。
      const turn = payload?.turn;
      const key = `${sid}#${turn ?? '?'}`;
      if (seen.has(key)) return decision;

      const rulesText = renderRules(cfg);
      let tail = null;
      try {
        // 把会话 id 传下去：persona 要靠它反推 chatId，才能取到「这个 chat 此刻
        // 的情绪」。不带参数调用的话它只能返回 null，情绪行就永远不会注入。
        tail = extra?.(sid) ?? null;
      } catch {
        tail = null;
      }
      if (rulesText === null && tail === null) return decision;

      seen.set(key, true);
      // 防止 Map 无限增长
      if (seen.size > 500) {
        for (const k of seen.keys()) {
          seen.delete(k);
          if (seen.size <= 250) break;
        }
      }

      const msg = makeInjection(rulesText ?? '', cfg, tail ?? undefined);
      const messages = Array.isArray(decision?.messages) ? decision.messages : [];
      stats.injections += 1;
      stats.lastInjectionAt = Date.now();
      stats.lastSessionId = sid;

      return { ...decision, messages: [...messages, msg] };
    } catch {
      return decision;
    }
  }

  return {
    MODULE_ID,
    preStep,
    renderRules: () => renderRules(cfg),
    activeRuleIds: () => RULES.filter((r) => cfg.rules[r.id] !== false).map((r) => r.id),
    ruleTable: () => RULES.map((r) => ({ id: r.id, title: r.title, enabled: cfg.rules[r.id] !== false })),
    setRule(id, enabled) {
      if (!RULES.some((r) => r.id === id)) return { ok: false, reason: 'unknown rule' };
      cfg.rules[id] = enabled === undefined ? !cfg.rules[id] : Boolean(enabled);
      return { ok: true, id, enabled: cfg.rules[id] };
    },
    DEFAULTS,
  };
}

/** 本模块的默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /** 按 id 单独开关某条规则，如 `{ quarrel: false }`。缺省全开。 */
  rules: {},
  /** 仅在第一步注入（推荐）。关掉则每步都注入，会把上下文撑大。 */
  firstStepOnly: true,
  /** 注入消息的「发送者」标记，与 time-context 一样用于识别。 */
  sourceName: 'onebot-prompt',
};
