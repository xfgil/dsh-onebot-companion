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
import { sharedEchoMemory } from './echo.js';
import { auditMethods, createPatcher } from '../core/patch.js';
import { describeThrown, loadTargetClass } from '../core/profile.js';

/** 模块 id：出现在日志、`patched` 记录与脱链判定里。 */
export const MODULE_ID = 'guard';

/**
 * `dsh-onebot-qq` 的「任务运行中」排队提示（本地改动 2026-10-14，用户 m02154）。
 *
 * 原文是 `dsh-onebot-qq/lib/bridge.js:33` 的 `QUEUE_NOTICE_TEXT`，逐字复制到这里，
 * 由闸门在出站口精确匹配拦掉 —— 这是**刻意**的硬编码，不是漏了 import：
 * bridge.js 是 node_modules 里的第三方包，升级会把它整个换掉；抄字面量能让本模块
 * 在包被升级后继续工作（匹配不上时静态检查会失败，正好提醒来更新常量）。
 *
 * 为什么要拦：`bridge.js:624-630` 在 queue 模式下每运行回合必发一条，用户连发几句
 * 就会在聊天里堆一排 ⏳。它是固定文案、不是模型说话，所以可以安全地按字面量吞掉，
 * 不会误伤云玥的正常输出（真实消息不会以 ⏳ + 这句话开头）。
 *
 * 代价（用户已知情并接受）：云玥跑长任务时，你发的消息会静默排队，聊天里没有任何
 * 「已收到」反馈。要恢复提示，把配置 `guard.muteQueueNotice` 置 false 即可。
 */
export const QUEUE_NOTICE_TEXT = '⏳ 当前任务运行中，新消息已排队，将在当前任务结束后依次处理。';

/** 这条出站文本是不是那条排队提示（允许首尾空白）。 */
export function isQueueNotice(text) {
  if (typeof text !== 'string' || text === '') return false;
  return text.trim() === QUEUE_NOTICE_TEXT;
}

/**
 * 非管理员发斜杠命令时的拒绝回执（`dsh-onebot-qq/lib/commands.js:124`）。
 *
 * 逐字复制上游字面量，理由与 `QUEUE_NOTICE_TEXT` 完全相同：`commands.js` 在
 * `node_modules` 里，升级会整个换掉；抄字面量能让本模块在包被升级后继续工作。
 *
 * ## 为什么要吞掉它（2026-10-18 00:32 实测）
 *
 * 群友 `58462qwq` 在群里发了 `/skin 58462qwq`，`tryHandleCommand` 判定非管理员后
 * 直接 `await ctx.sendToChat(chatId, '该命令仅管理员可用。')` —— **模型全程没被
 * 调用**（命令在入站管线里就被吃掉了）。于是群里出现一条「云玥发了个系统提示」：
 *
 * ```
 * 00:32:46 云玥 | 发送 -> 群聊 [...] 该命令仅管理员可用。
 * ```
 *
 * 这是**框架回执，不是她在说话**。真人不会因为别人打了句斜杠命令就冒出来念一句
 * 「该命令仅管理员可用」。用户当场指出「？这你不沉默？」。
 *
 * 注意它**不能**靠提示词解决：`[[silent]]` 那套只作用于模型输出，而这条回执
 * 在模型之前就发出去了。只能在出站口拦。
 *
 * ## 代价（与排队提示同一笔）
 *
 * 吞掉后，群友发斜杠命令**没有任何反馈**——他可能以为没发出去。这是有意的取舍：
 * 那群人本来就不该用命令，静默比念系统话更像人。
 */
export const ADMIN_ONLY_NOTICE_TEXT = '该命令仅管理员可用。';

/** 这条出站文本是不是「仅管理员可用」回执（允许首尾空白）。 */
export function isAdminOnlyNotice(text) {
  if (typeof text !== 'string' || text === '') return false;
  return text.trim() === ADMIN_ONLY_NOTICE_TEXT;
}

/** 挂载点。 */
const TARGET = { file: 'outbound.js', exportName: 'OutboundPipeline' };
const METHODS = ['sendToChat', 'sendMsg'];

/**
 * 清洗一条出站文本。
 *
 * 判别逻辑全部交给 `aside.js`（沉默标记 + 括号旁白的整块判定），这里只做配置
 * 映射与「旁白开关」的透传。
 *
 * @returns {{ silent: boolean, text: string, hit: 'blocked'|'stripped'|'muted'|null }}
 */
export function sanitizeText(raw, cfg) {
  if (typeof raw !== 'string' || raw === '') return { silent: false, text: raw, hit: null };
  // 排队提示先判、且不受 stripAside 影响 —— 它是插件回执，不是模型输出。
  if (cfg.muteQueueNotice !== false && isQueueNotice(raw)) return { silent: true, text: '', hit: 'muted' };
  // 「该命令仅管理员可用」同理：框架回执，不是她在说话。2026-10-18 新增。
  if (cfg.muteAdminOnlyNotice !== false && isAdminOnlyNotice(raw)) {
    return { silent: true, text: '', hit: 'muted' };
  }
  return sanitizeOutbound(raw, {
    aside: cfg.stripAside !== false,
    narration: cfg.stripNarration !== false,
  });
}

/**
 * 复述闸：这条正文是不是在把刚发出去的语音再讲一遍？
 *
 * 单独一个函数（而不是塞进 `sanitizeText`）的理由：它需要**会话 id**——
 * 记忆是按会话分开的，而 `sanitizeText` 是纯函数，只吃文本。
 *
 * 命中即整条丢弃（不是剥掉某段）：复述的特征就是「整句都在讲同一件事」，
 * 剥掉半句会剩下更像碎片的东西。
 *
 * @param {string} chatId
 * @param {string} text 已过旁白清洗的正文
 * @param {object} cfg guard 段配置
 * @returns {{ echo: boolean, score: number, hit: string }}
 */
export function checkEcho(chatId, text, cfg) {
  if (cfg.stripEcho === false) return { echo: false, score: 0, hit: '' };
  try {
    return sharedEchoMemory({ ...(cfg.echo ?? {}) }).check(chatId, text);
  } catch {
    // 判据自身出错就放行 —— 绝不能因为一个启发式让对话卡住。
    return { echo: false, score: 0, hit: '' };
  }
}

/** 记下「刚说过的话」，供后续正文比对。 */
export function rememberEcho(chatId, text, cfg) {
  if (cfg.stripEcho === false) return;
  try {
    sharedEchoMemory({ ...(cfg.echo ?? {}) }).remember(chatId, text);
  } catch {
    /* 记忆失败不影响发送 */
  }
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
    else if (kind === 'muted') stats.muted = (stats.muted ?? 0) + 1;
    else if (kind === 'echo') stats.echoDropped = (stats.echoDropped ?? 0) + 1;
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
        const label = kind === 'blocked' ? '下沉默输出' : kind === 'muted' ? '下排队提示' : kind === 'echo' ? '下复述' : '下并剥离标记';
        log('info', `拦${label} chat=${chatId ?? '-'} text=${JSON.stringify(String(original).slice(0, 120))}`);
      } catch {
        /* 日志失败不影响出站 */
      }
    }
  }

  /**
   * 摘闸：把原型上本模块的层剥掉，其余模块的层原样保留并重接。
   *
   * 为什么关掉开关时不能只是「不再挂新闸」：上一轮挂上的闸**还留在原型上**。
   * 闸内部确实会读同一个 `cfg`（访问器）而看起来跟着关，但只要有人拿着旧 cfg
   * 快照（热重载前的实例、自测里的独立实例），关掉就不生效。所以「关掉」的语义
   * 要走到底 —— 把层剥掉，让原型回到没人碰过的样子。
   *
   * 剥层必须用 `patchMethod.unpatch`（core/patch.js），**不在这里自己写**：自己写
   * 的那版是「从链头往下，只要链头是本模块就剥」，本模块的层一旦被别的模块压在
   * 下面就摘不掉，而 `POST /module` 还报成功（见 core/patch.js 的 unpatchMethod
   * 注释里那段历史）。
   *
   * @returns {Promise<boolean>} 是否真的剥掉了一层。
   */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  /**
   * 一次补挂扫描：import 出站模块，给未挂的方法挂上。
   * @returns {Promise<{ok: boolean, error?: string, patched?: number, detached?: boolean}>}
   */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.enabled = cfg.enabled;
    if (!cfg.enabled) {
      // 关掉时把闸摘掉，而不是留着（见 detach 的注释）。
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

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
          // 复述闸（见 echo.js 文件头）：语音刚说完，正文又用第三人称讲一遍。
          // 放在旁白清洗**之后**——先剥掉括号旁白，剩下的才是真正要说的话。
          const e = checkEcho(chatId, r.text, cfg);
          if (e.echo) {
            note('echo', chatId, text, '');
            return Promise.resolve([]);
          }
          rememberEcho(chatId, r.text, cfg);
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
          // 复述闸**只在 sendToChat 那一层判**，这里绝不能判。
          //
          // 2026-10-19 踩过的坑：`OutboundPipeline.sendToChat` 内部最后是调
          // `this.sendMsg(...)` 发出去的，而 sendMsg 也被本模块包了。sendToChat
          // 那层在调 original 之前就把正文 remember 进了复述记忆，于是走到
          // sendMsg 这层时，候选文本跟记忆里刚记下的自己是同一个字符串 ——
          // 覆盖率 1.0，稳稳命中，整条消息被吞。结果就是**所有纯文本回复发不出去**，
          // 而且悄无声息（guard 自己 catch 不到，因为压根没抛错）。
          //
          // 所以判据只留在"模型输出入口"那一层；sendMsg 是底层发送通道
          // （sendToChat 内部、媒体/segments 也走它），它只做旁白清洗，不参与复述判定。
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
      // 本地改动 2026-10-14：排队提示（⏳）必须被吞，且不能误伤正常消息。
      { name: '排队提示（必须吞掉）', text: QUEUE_NOTICE_TEXT },
      { name: '排队提示带空白（必须吞掉）', text: `  ${QUEUE_NOTICE_TEXT}  ` },
      { name: '正文里提到排队提示（不能被吞）', text: `她说了一句：${QUEUE_NOTICE_TEXT} 你觉得呢` },
      // 本地改动 2026-10-19：自述/报幕（用户截图指认「这些文字部分不该露出来吧」）。
      { name: '自述·等他回话（必须吞掉）', text: '话说完了，就等着他回话。' },
      { name: '自述·问完了（必须吞掉）', text: '问完了，等他说明白这事。' },
      { name: '自述·复盘（必须吞掉）', text: '说完这些，我就安静下来等他反应了。这事怪我，没早点讲清楚。' },
      { name: '自述·看他那边（必须吞掉）', text: '我已经发了一句过去，就看他那边能不能看见邀请。' },
      // 边界：第二人称「等你」是正常对话，绝不能拦。
      { name: '正常·等你回话（必须发出）', text: '等你回话呢，说啊' },
      { name: '正常·等他正文（必须发出）', text: '等他来了我们再点吧，你说呢' },
      // 本地改动 2026-10-19：复述闸（用户截图问「怎么还有这种给第三方讲解的」）。
      // `seedVoice` = 这一步之前 qq_say 真发出去的语音文本，先塞进记忆再发正文。
      {
        name: '复述·下午三点五十（必须吞掉）',
        seedVoice: '三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫',
        text: '他下午三点五十就吃了，到现在整八个钟头，我让他去弄点东西垫垫。',
      },
      {
        name: '复述·催他睡觉（必须吞掉）',
        seedVoice: '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
        text: '我催他去睡了，别又熬到一点多。',
      },
      // 边界：同一段语音之后，正常接话绝不能被误伤。
      {
        name: '正常·语音后接新话（必须发出）',
        seedVoice: '那就行。这会儿还不睡？明天又有早课吧，别又搞到一点多',
        text: '那你现在饿不饿呀',
      },
    ];

    const results = [];
    const restore = ctl.suspended;
    try {
      ctl.suspended = true; // 自测的 BLOCKED 不该污染生产命中数
      for (const c of cases) {
        sent.length = 0;
        // 每个用例都从干净的复述记忆开始：
        // 上一条用例发出去的正文会被记进记忆，不清理就会让后面的用例
        // 莫名其妙被判成复述（自测里最典型的假阳性来源）。
        const memory = sharedEchoMemory({ ...(cfg.echo ?? {}) });
        memory.clear();
        if (typeof c.seedVoice === 'string') memory.remember('private:1', c.seedVoice);
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
      // 自测结束把记忆清干净，否则最后一条用例发出去的正文会留在生产记忆里。
      try {
        sharedEchoMemory({ ...(cfg.echo ?? {}) }).clear();
      } catch {
        /* 清理失败不影响自测结论 */
      }
    }
    return { ok: true, cases: results };
  }

  return { MODULE_ID, scan, detach, selfTest, sanitizeText, sanitizeSegments, METHODS, TARGET };
}

/** 默认配置（由 index.js 汇总，这里只声明本模块的键）。 */
export const DEFAULTS = {
  enabled: true,
  /** 是否连「整行一对括号」的旁白一起剥（关掉就只拦沉默标记）。 */
  stripAside: true,
  /**
   * 是否丢掉「纯自述/报幕」的整条消息（2026-10-19 新增）。
   *
   * 实测泄漏：「问完了，等他说明白这事。」「话说完了，就等着他回话。」
   * 「说完这些，我就安静下来等他反应了。这事怪我，没早点讲清楚。」
   * 用户在截图里指着这些字问「这些文字部分不该露出来吧」。
   * 规则层（`R_ASIDE`）早就写了别报幕，模型不听，所以在闸里兜底。
   * 判据见 `aside.js` 的 `isNarrationOnly`（宁漏勿错）。
   */
  stripNarration: true,
  /** 是否吞掉 `dsh-onebot-qq` 的 ⏳ 排队提示（本地改动，见文件头常量注释）。 */
  muteQueueNotice: true,
  /**
   * 是否吞掉「该命令仅管理员可用。」回执（2026-10-18 新增）。
   * 那是 `commands.js:124` 发给非管理员的**框架回执**，模型全程没参与，
   * 出现在群里就像她突然念了句系统提示。见 `ADMIN_ONLY_NOTICE_TEXT` 注释。
   */
  muteAdminOnlyNotice: true,
  /** 命中时是否写一条宿主日志。 */
  logHits: true,
  /**
   * 复述闸：拦掉「把刚发出去的语音再用第三人称讲一遍」（2026-10-19 新增）。
   *
   * 实测泄漏（用户截图问「怎么还有这种给第三方讲解的」）：
   *   qq_say 发「三点五十……那都八个钟头了，现在肚子不饿吗？要不下去买点啥垫垫」
   *   紧接着正文「他下午三点五十就吃了，到现在整八个钟头，我让他去弄点东西垫垫。」
   *
   * 判据见 `echo.js`（覆盖率 + 第三人称，两簇实测分得开）。
   */
  stripEcho: true,
  /** 复述闸的细调参数（windowMs / minCoverage / strongCoverage / maxLen / minLen）。 */
  echo: {},
};
