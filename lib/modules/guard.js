/**
 * dsh-onebot-companion / modules/guard.js
 *
 * 出站守卫：拦住 QQ 通道里「本该是沉默、却被当正文发出去」的模型输出。
 *
 * ## 背景（2026-10-13 实测取证）
 *
 * `dsh-onebot-qq` 升到 0.9.0 后，`[[silent]]` 这套约定整个丢了 —— 整包源码里
 * 精确搜 `[[silent]]` 是 0 命中，`stripSilentMarker` / `isSilentReply` /
 * `stripAsideLines` / 出站沉默闸一个都不剩。而模型仍会输出 `[[silent]]`
 * （会话历史里它自己这么干过，被当成有效行为延续），于是
 * split.js → stripMarkdown → sendMsg 一路透传，用户就在群里看到字面量。
 *
 * 改 node_modules 能立刻止血，但那正是被上一次升级冲掉的做法 —— 同样的坑会
 * 再踩一遍。所以从外面挂闸：**不动 node_modules**。
 *
 * ## 为什么挂在 `OutboundPipeline.prototype` 而不是 `ChatBridge`
 *
 * `dsh-onebot-qq` 的所有出站路径（inbound 回复、interim 中间态、deferred 延迟
 * 投递、命令回执）最终都汇聚到 `OutboundPipeline.sendToChat`；媒体/卡片走
 * `sendMsg` 的 segments。包住这两个方法就覆盖了全部出口 —— 比在 bridge 层拦
 * 更靠近「真的要发出去」的那一刻，任何绕过 bridge 的路径也逃不掉。
 *
 * 注意与 `rhythm` 模块的分工：rhythm 挂 `ChatBridge.prototype.sendToChat`，
 * 在**上游**把长回复切成多条；本模块在**下游**逐条清洗。于是 guard 的闸落在
 * 每一个分条上（比原来整条清洗更准），两者不冲突也不互相吞并（见 core/patch.js）。
 *
 * ## 行为
 *
 * - 整条就是沉默标记（`[[silent]]`）→ 不发送，返回空结果（调用方视角是
 *   「成功发送 0 条」，不会触发重试或报错）；
 * - 标记混在正文里 → 剥掉标记后发剩余正文；
 * - 剥完只剩空白 → 视为沉默，不发。
 *
 * @module dsh-onebot-companion/modules/guard
 */

import { sanitizeOutbound } from './aside.js';
import { auditMethods, createPatcher } from '../core/patch.js';
import { describeThrown, loadTargetClass } from '../core/profile.js';

/** 模块 id：出现在日志、`patched` 记录与脱链判定里。 */
export const MODULE_ID = 'guard';

/** 挂载点。 */
const TARGET = { file: 'outbound.js', exportName: 'OutboundPipeline' };
const METHODS = ['sendToChat', 'sendMsg'];

/**
 * 清洗一条出站文本。
 *
 * 判别逻辑全部交给 `aside.js`（沉默标记 + 括号旁白的整块判定），这里只做配置
 * 映射与「旁白开关」的透传。
 *
 * @returns {{ silent: boolean, text: string, hit: 'blocked'|'stripped'|null }}
 */
export function sanitizeText(raw, cfg) {
  if (typeof raw !== 'string' || raw === '') return { silent: false, text: raw, hit: null };
  return sanitizeOutbound(raw, { aside: cfg.stripAside !== false });
}

/** 清洗 segments 数组里的文本段；返回 `drop: true` 表示整条应当丢弃。 */
export function sanitizeSegments(segments, cfg) {
  if (!Array.isArray(segments)) return { segments, hit: null, drop: false };
  let hit = null;
  let textCount = 0;
  let textKept = 0;
  const out = [];
  for (const seg of segments) {
    if (seg && typeof seg === 'object' && seg.type === 'text' && seg.data && typeof seg.data.text === 'string') {
      textCount += 1;
      const r = sanitizeText(seg.data.text, cfg);
      if (r.hit) hit = r.hit;
      if (r.silent) continue; // 丢掉这一段
      if (r.text !== seg.data.text) {
        out.push({ ...seg, data: { ...seg.data, text: r.text } });
      } else {
        out.push(seg);
      }
      textKept += 1;
      continue;
    }
    out.push(seg);
  }
  // 整条只由文本组成、且文本全被吃掉 → 丢弃整条
  const nonText = out.some((s) => !(s && typeof s === 'object' && s.type === 'text'));
  const drop = textCount > 0 && textKept === 0 && !nonText;
  return { segments: out, hit, drop };
}

/** 把 segments 里的文本拼起来（只为命中记录，不参与发送）。 */
function joinSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((s) => s?.data?.text ?? '')
    .join('')
    .trim();
}

/**
 * 创建 guard 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - guard 段配置（`enabled` / `stripAside` / `logHits`）。
 * @param {object} options.stats - 共享统计对象（放 globalThis，跨热重载累计）。
 * @param {object} options.hits - 命中环形数组。
 * @param {() => boolean} options.isCounting - 是否计入统计（自测期间挂起）。
 * @param {Function} options.patchMethod - 来自 core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 */
export function createGuard({ cfg, stats, hits, ctl, patchMethod, log }) {
  const HITS_MAX = 200;

  function note(kind, chatId, original, cleaned) {
    if (ctl.suspended) return;
    const now = Date.now();
    stats.lastHitAt = now;
    stats.lastHitKind = kind;
    stats.lastHitText = String(original).slice(0, 500);
    stats.lastHitChat = chatId ?? null;
    if (kind === 'blocked') stats.blocked += 1;
    else stats.stripped += 1;
    hits.push({
      at: now,
      kind,
      chatId: chatId ?? null,
      original: String(original).slice(0, 500),
      cleaned: String(cleaned).slice(0, 500),
    });
    if (hits.length > HITS_MAX) hits.splice(0, hits.length - HITS_MAX);
    if (cfg.logHits) {
      try {
        log('info', `拦${kind === 'blocked' ? '下沉默输出' : '下并剥离标记'} chat=${chatId ?? '-'} text=${JSON.stringify(String(original).slice(0, 120))}`);
      } catch {
        /* 日志失败不影响出站 */
      }
    }
  }

  /**
   * 一次补挂扫描：import 出站模块，给未挂的方法挂上。
   * @returns {Promise<{ok: boolean, error?: string, patched?: number}>}
   */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.enabled = cfg.enabled;
    if (!cfg.enabled) return { ok: true, patched: 0 };

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.resolveError = found.error;
      if (found.profileDir === undefined) stats.profileDir = '';
      return { ok: false, error: found.error };
    }
    stats.profileDir = found.profileDir;
    stats.resolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    // 体检：原型上这个方法还是不是我们挂的？（市场升级换掉包目录时模块实例会变新）
    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;

    if (patchMethod(proto, 'sendToChat', MODULE_ID, (original) =>
      function companionGuardSendToChat(chatId, text, options = {}) {
        try {
          if (!cfg.enabled) return original.call(this, chatId, text, options);
          const r = sanitizeText(text, cfg);
          if (r.hit) note(r.hit, chatId, text, r.text);
          if (r.silent) return Promise.resolve([]);
          return original.call(this, chatId, r.text, options);
        } catch (error) {
          // 闸门自身异常时按原文放行 —— 宁可漏发一条，也不能让对话卡死。
          log('warn', `sendToChat 闸门异常，按原文放行: ${describeThrown(error)}`);
          return original.call(this, chatId, text, options);
        }
      }, rel)) patched += 1;

    if (patchMethod(proto, 'sendMsg', MODULE_ID, (original) =>
      function companionGuardSendMsg(chatId, segments, options) {
        try {
          if (!cfg.enabled) return original.call(this, chatId, segments, options);
          const r = sanitizeSegments(segments, cfg);
          if (r.hit) note(r.hit, chatId, joinSegments(segments), '');
          if (r.drop) return Promise.resolve(undefined);
          return original.call(this, chatId, r.segments, options);
        } catch (error) {
          log('warn', `sendMsg 闸门异常，按原文放行: ${describeThrown(error)}`);
          return original.call(this, chatId, segments, options);
        }
      }, rel)) patched += 1;

    return { ok: true, patched };
  }

  /**
   * 真·端到端自测：**造一个假的 pipeline 实例**，把请求喂进真实的
   * `OutboundPipeline.prototype.sendToChat`，底层 `ctx.call` 只记录不发网。
   *
   * 比只测纯函数强的地方：它验证「补丁确实挂在原型上、且真的会被调用到」——
   * 所以能抓到「函数写对了但根本没接上线」这类问题。全程不碰 QQ。
   */
  async function selfTest(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return { ok: false, error: found.error };

    const sent = [];
    const fakeCtx = {
      connected: () => true,
      selfId: () => '0',
      isStopping: () => false,
      log: () => undefined,
      trace: () => undefined,
      getChat: () => undefined,
      config: {
        botQQ: '0',
        sensitivePatterns: [],
        textImageThreshold: 0, // 关键：关掉文字图，避免 t2i 渲染
        maxImageBytes: 1 << 20,
        cardFooter: '',
        fontFiles: [],
        fontFamilies: [],
      },
      call: async (action, params, chatId) => {
        sent.push({ action, params, chatId });
        return { message_id: `fake-${sent.length}` };
      },
    };

    const cases = [
      { name: '纯沉默标记', text: '[[silent]]' },
      { name: '标记带空白', text: '  [[silent]]  ' },
      { name: '标记带强调', text: '**[[silent]]**' },
      { name: '中文方括号变体', text: '【silent】' },
      { name: '纯括号旁白', text: '（不再出声）' },
      { name: '旁白+正文', text: '今天好累啊喵\n（这条不是点我，不接话）' },
      { name: '跨行旁白（burst 风险）', text: '（他们俩在聊配置的事，我刚说过一句了，这会儿插进去反而多余。\n安静看着就好）' },
      { name: '正常消息（必须原样发出）', text: '你今天怎么样呀喵~' },
      { name: '正常带括号', text: '看这个（笑）' },
      { name: '序号不是旁白', text: '（1）第一点\n（2）第二点' },
    ];

    const results = [];
    const restore = ctl.suspended;
    try {
      ctl.suspended = true; // 自测的 BLOCKED 不该污染生产命中数
      for (const c of cases) {
        sent.length = 0;
        const fake = new found.klass(fakeCtx);
        let error = null;
        try {
          await fake.sendToChat('private:1', c.text, {});
        } catch (e) {
          error = describeThrown(e);
        }
        const texts = sent
          .flatMap((s) => (Array.isArray(s.params?.message) ? s.params.message : []))
          .filter((s) => s?.type === 'text')
          .map((s) => s.data.text);
        results.push({
          name: c.name,
          input: c.text,
          sentCount: sent.length,
          sentText: texts,
          error,
          verdict: error !== null ? 'ERROR' : sent.length === 0 ? 'BLOCKED' : 'PASSED',
        });
      }
    } finally {
      ctl.suspended = restore;
    }
    return { ok: true, cases: results };
  }

  return { MODULE_ID, scan, selfTest, sanitizeText, sanitizeSegments, METHODS, TARGET };
}

/** 默认配置（由 index.js 汇总，这里只声明本模块的键）。 */
export const DEFAULTS = {
  enabled: true,
  /** 是否连「整行一对括号」的旁白一起剥（关掉就只拦沉默标记）。 */
  stripAside: true,
  /** 命中时是否写一条宿主日志。 */
  logHits: true,
};
