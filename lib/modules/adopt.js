/**
 * dsh-onebot-companion / modules/adopt.js
 *
 * 把「会话换代」那处补丁从 `node_modules` 里搬出来（2026-10-14，用户 m02696）。
 *
 * ## 病灶
 *
 * `dsh-onebot-qq` 的 `registry.createChat()` 这样决定会话 id（上游 0.9.0/0.9.2 都一样）：
 *
 * ```js
 * let sessionId = makeSessionId(sessionIdForChat(chatId));   // 裸 id
 * if (this.isSessionIdBlocked(sessionId)) {
 *   sessionId = this.freshSessionId(chatId);                 // 带 Date.now() 后缀
 * } else if (await this.hasPersistedLog(sessionId)) {
 *   this.retireSession(sessionId);                           // ← 病根
 *   sessionId = this.freshSessionId(chatId);
 * }
 * ```
 *
 * 裸 id（`onebot-private-100000001`）上**已经有一份持久化日志**时，上游认为
 * 「复用会撞车」，于是把裸 id 退休并另开一个带后缀的新会话。但 `retireSession`
 * 是**永久**的（写进 `retired-sessions.json`），于是此后每一次 `createChat` 都从
 * 第一个分支掉进 `freshSessionId`，每条消息都开一个全新的会话、上下文从零开始
 * —— 用户看到的「一句话一个会话」。
 *
 * 关键事实：**只有 `agents.create()` 会和已存在的日志撞车；`agents.resume()`
 * 正是「接管这份日志」的那个调用。** 所以裸 id 有日志时正确的动作是 resume
 * 它，而不是退休它。
 *
 * ## 为什么之前是改 node_modules
 *
 * 上游没有配置面能改变这个决定，最省事的做法就是直接改 `registry.js`。代价是
 * 那份补丁**藏在第三方包里**：市场升级、`pnpm install`、任何一次重装都会把它
 * 整个换掉，而症状要等到下次有人发消息才会显形。2026-10-14 的故障正是这个
 * 链条——补丁没了，换代复发。
 *
 * ## 本模块的做法
 *
 * 不动 `node_modules`，改成**从外面包住** `ChatRegistry.prototype.createChat`：
 * 在进入原方法之前先自己做那个决定——裸 id 有持久化日志且没被 blocked 时，直接
 * `resumeChat()` 接管并返回；其余一切情况原样交给原方法。所以本模块**不是**在
 * 与上游赛跑覆盖它的行为，而是在**上游之前**把最该走的那条路走掉。
 *
 * 三种「不该由我们插手」的情形都明确放行给原方法：
 *
 *   1. `evictedChats` 里有这个 chat —— 那份快照记录的会话 id 比裸 id 更权威
 *      （`/workspace` 切换、`/new` 之后的设置载体会存在那里），原方法会正确地
 *      resume 它。
 *   2. 裸 id 已被 blocked（退休/损坏）—— 尊重现有记录，别把被明确退休的会话
 *      复活。
 *   3. 裸 id 没有持久化日志 —— 那就该按原方法建新会话，没有可接管的。
 *
 * ## 与原方法内部的（旧）补丁并存
 *
 * 若 `registry.js` 里那处 LOCAL PATCH 还在，两条路都指向「resume 裸 id」，方向
 * 一致：我们的闸先接管成功就根本不会进原方法；闸没成立时原方法自己照旧处理。
 * 所以并存不会打架，可以先把闸装上、再从容还原 `node_modules`。
 *
 * @module dsh-onebot-companion/modules/adopt
 */

import { auditMethods } from '../core/patch.js';
import { describeThrown, loadTargetClass } from '../core/profile.js';

/** 模块 id：出现在日志、`patched` 记录与脱链判定里。 */
export const MODULE_ID = 'adopt';

/** 挂载点：决定会话 id 的那个方法。 */
const TARGET = { file: 'registry.js', exportName: 'ChatRegistry' };
const METHODS = ['createChat'];

/**
 * 裸会话 id 的来源。
 *
 * 用上游自己的 `chat.js#sessionIdForChat`，而不是在这里再抄一份 `'onebot-' +
 * chatId.replace(...)`：抄一份就等于给自己埋一次「上游改了规则而我们还按老规则
 * 算 id」的机会，而算错 id 的后果是「采纳了一个不存在的会话」，比不采纳更糟。
 * 拿不到这个函数时本模块直接放弃挂载（见 `scan`），不会退化成猜。
 */
const CHAT_FILE = 'chat.js';
const CHAT_EXPORT = 'sessionIdForChat';

/**
 * 造一个 `createChat` 的包装。
 *
 * 抽成独立工厂是为了**可测**：自测里塞一个假的 `original`，就能把「采纳 / 放行 /
 * 失败退休」三条分支全跑一遍，而不用真的建出一个 `ChatRegistry`（那要一整套
 * agent / persistence 依赖）。
 *
 * @param {object} options
 * @param {Function} options.original - 链底的原 `createChat`。
 * @param {object} options.cfg - adopt 段配置（`enabled` / `logAdoptions`）。
 * @param {(level: string, message: string) => void} options.log
 * @param {(kind: string, chatId: string, sessionId: string) => void} options.note - 记账。
 * @param {(chatId: string) => string} options.bareSessionIdOf - 裸 id 推导。
 * @returns {Function} 可直接挂到原型上的方法。
 */
export function makeAdoptCreateChat({ original, cfg, log, note, bareSessionIdOf }) {
  return function companionAdoptCreateChat(chatId, nickname) {
    const self = this;
    /** 把这次调用原样交还给上游。 */
    const passThrough = () => original.call(self, chatId, nickname);

    return (async () => {
      if (!cfg.enabled) return passThrough();

      let bare;
      try {
        // 原方法第一件事就是等 mapping 落盘；在那之前 chats / evictedChats 都还
        // 没填好，抢在前面判断会误判成「没有可接管的会话」。
        if (typeof self?.mappingLoaded?.then === 'function') await self.mappingLoaded;

        // 已经有活着的 chat：原方法（经 ensureChat 的幂等）也会走这条，但在这里
        // 挡掉可以省掉一次无谓的持久化查询。
        if (typeof self?.chats?.has === 'function' && self.chats.has(chatId)) {
          return self.chats.get(chatId);
        }

        // 1. 有 evicted 快照 → 快照里的 id 更权威，交给原方法。
        if (typeof self?.evictedChats?.has === 'function' && self.evictedChats.has(chatId)) {
          return await passThrough();
        }

        if (typeof bareSessionIdOf !== 'function' || typeof self?.isSessionIdBlocked !== 'function'
          || typeof self?.hasPersistedLog !== 'function' || typeof self?.resumeChat !== 'function') {
          // 上游这几个内部方法少了一个 —— 说明包结构变了。宁可完全不插手，
          // 也不要凭半套接口猜出一个会话 id。
          log('warn', `registry 接口与预期不符，采纳闸跳过 chat=${chatId}`);
          return await passThrough();
        }

        bare = String(bareSessionIdOf(chatId));

        // 2. 裸 id 已被明确退休/标记损坏 → 尊重记录，不复活它。
        if (self.isSessionIdBlocked(bare)) return await passThrough();

        // 3. 裸 id 没有持久化日志 → 没有可接管的，按原方法建新的。
        if (!(await self.hasPersistedLog(bare))) return await passThrough();

        let resumed;
        try {
          resumed = await self.resumeChat(chatId, bare);
        } catch (error) {
          // 日志确实用不了（外来 id 或损坏）——退休它并另开一个，正是原方法在
          // 「create 撞车」时的做法。退休之后原方法会从第一个分支掉进
          // freshSessionId，不会再来试一次同样的 resume。
          try {
            self.retireSession?.(bare);
          } catch {
            /* 退休写盘失败不该盖住真正的失败原因 */
          }
          log('warn', `采纳既有日志失败，退休后另开会话 chat=${chatId} id=${bare}: ${describeThrown(error)}`);
          return await passThrough();
        }

        note('adopted', chatId, bare);
        // 补丁版在这里也补了一次 saveMapping（采纳不经过原方法的返回路径，
        // 不写的话映射要等到下一条消息才落盘）。写完失败不影响本次会话。
        try {
          void self.saveMapping?.();
        } catch {
          /* 映射落盘失败不影响会话本身 */
        }
        return resumed;
      } catch (error) {
        // 闸门自身异常时按原流程放行 —— 宁可走上游那条老路，也不能让消息卡死。
        log('warn', `采纳闸门异常，按原流程放行 chat=${chatId}: ${describeThrown(error)}`);
        return await passThrough();
      }
    })();
  };
}

/**
 * 创建 adopt 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - adopt 段配置。
 * @param {object} options.stats - 共享统计对象。
 * @param {Function} options.patchMethod - 来自 core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 */
export function createAdopt({ cfg, stats, patchMethod, log }) {
  function note(kind, chatId, sessionId) {
    const now = Date.now();
    stats.lastAdoptAt = now;
    stats.lastAdoptChat = chatId ?? null;
    stats.lastAdoptSession = sessionId ?? null;
    if (kind === 'adopted') stats.adopted = (stats.adopted ?? 0) + 1;
    if (cfg.logAdoptions !== false) {
      try {
        log('info', `采纳既有会话日志 chat=${chatId} id=${sessionId}（否则会另开一个新会话）`);
      } catch {
        /* 日志失败不影响会话 */
      }
    }
  }

  /**
   * 把自己的闸从原型上摘掉，还原成链底原方法。
   *
   * 为什么需要：关掉开关时如果只是「不再挂新闸」，**上一轮挂的闸还留在原型上**，
   * 而闸内部读的是同一个 `cfg` 对象（访问器）所以行为确实会跟着变 —— 但只要有人
   * 拿着旧 `cfg` 快照（热重载前的实例、自测里的独立实例），关掉就不会生效。实测
   * 就是这么暴露的：自测里开一个 `enabled:false` 的 adopt，闸没摘，`createChat`
   * 照旧采纳。
   *
   * 所以「关掉」的语义要走到底：**把层剥掉**，让原型回到没人碰过的样子。剥链规则
   * 与 core/patch.js 一致：只剥链头连续的「本模块」层，遇到别的模块立刻停手。
   *
   * @returns {Promise<boolean>} 是否真的剥掉了一层。
   */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    // 用 core/patch.js 的 unpatch，不在模块里自己写「只看链头」那一版 —— 那种
    // 实现遇到别人压在上面就摘不掉（见 core/patch.js 的 unpatchMethod 注释）。
    const changed = patchMethod.unpatch(found.proto, 'createChat', MODULE_ID) === true;
    if (changed) log('info', '已摘除 adopt 闸（createChat 回到上游实现）');
    return changed;
  }

  /**
   * 一次补挂扫描：import registry 模块，给未挂的 `createChat` 挂上闸。
   * @returns {Promise<{ok: boolean, error?: string, patched?: number}>}
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
      // 用自己的字段记错：`resolveError` / `profileDir` 是 guard 那套的公共位，
      // 两个模块各写各的目标文件（outbound.js / registry.js），谁后写谁覆盖，
      // 会把对方的诊断信息抹掉。
      stats.adoptResolveError = found.error;
      return { ok: false, error: found.error };
    }

    // 会话 id 的推导规则必须来自上游自己，不能在这里复刻（见文件头说明）。
    const chatMod = await loadTargetClass(ctx, cfg, CHAT_FILE, CHAT_EXPORT);
    if (!chatMod.ok || typeof chatMod.klass !== 'function') {
      const error = `未取到 ${CHAT_FILE} 的 ${CHAT_EXPORT}（${chatMod.error ?? '导出不是函数'}），拒绝凭猜推导会话 id`;
      stats.adoptResolveError = error;
      return { ok: false, error };
    }
    const bareSessionIdOf = chatMod.klass;

    stats.adoptProfileDir = found.profileDir;
    stats.adoptResolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    // 体检：原型上这个方法还是不是我们挂的？（市场升级换掉包目录时模块实例会变新）
    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;
    if (patchMethod(proto, 'createChat', MODULE_ID, (original) =>
      makeAdoptCreateChat({ original, cfg, log, note, bareSessionIdOf }), rel)) {
      patched += 1;
    }

    return { ok: true, patched };
  }

  /**
   * 自测：把 `makeAdoptCreateChat` 拿假的 `original` / 假 registry 实例跑一遍。
   *
   * 不建真的 `ChatRegistry`（那要整套 agent / persistence 依赖），但**走的是真
   * 的包装函数**，所以能抓到「分支判反了」「该放行时没放行」这类逻辑错。
   */
  async function selfTest() {
    const originalCalls = [];
    const results = [];

    /** 造一个假 registry 实例。 */
    const makeFake = (over = {}) => {
      const state = {
        chats: new Map(),
        evictedChats: new Map(),
        blocked: new Set(),
        logs: new Set(),
        resumed: [],
        retired: [],
        saved: 0,
        ...over,
      };
      const fake = {
        mappingLoaded: Promise.resolve(),
        chats: state.chats,
        evictedChats: state.evictedChats,
        isSessionIdBlocked: (id) => state.blocked.has(id),
        hasPersistedLog: async (id) => state.logs.has(id),
        resumeChat: async (chatId, id) => {
          state.resumed.push({ chatId, id });
          return { chatId, sessionId: id, resumed: true };
        },
        retireSession: (id) => {
          state.retired.push(id);
          state.blocked.add(id);
        },
        saveMapping: async () => {
          state.saved += 1;
        },
        __state: state,
      };
      return fake;
    };

    const run = async (name, { fake, cfgOverride, bareOf }, expect) => {
      const callsBefore = originalCalls.length;
      const original = function fakeOriginal(chatId, nickname) {
        originalCalls.push({ chatId, nickname, viaOriginal: true });
        return Promise.resolve({ chatId, viaOriginal: true });
      };
      const wrapper = makeAdoptCreateChat({
        original,
        cfg: { enabled: true, logAdoptions: true, ...cfgOverride },
        log: () => undefined,
        note: () => undefined,
        bareSessionIdOf: bareOf ?? ((chatId) => String(chatId).replace(':', '-')),
      });
      let outcome = null;
      let error = null;
      try {
        outcome = await wrapper.call(fake, 'private:100000001', '示例用户');
      } catch (e) {
        error = describeThrown(e);
      }
      results.push({
        name,
        outcome,
        error,
        viaOriginal: originalCalls.length > callsBefore,
        resumed: fake.__state.resumed,
        retired: fake.__state.retired,
        saved: fake.__state.saved,
        expect,
        ok: expect({ outcome, error, viaOriginal: originalCalls.length > callsBefore, state: fake.__state }),
      });
    };

    // 1. 裸 id 有日志、没被 blocked → 采纳（核心用例）。
    await run('裸 id 有日志 → 采纳', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      return f;
    })() }, ({ outcome, viaOriginal, state }) =>
      viaOriginal === false && outcome?.resumed === true && state.resumed[0].id === 'private-100000001' && state.saved === 1);

    // 2. evicted 快照更权威 → 放行原方法。
    await run('有 evicted 快照 → 放行', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      f.__state.evictedChats.set('private:100000001', { session: 'x' });
      return f;
    })() }, ({ viaOriginal, state }) => viaOriginal === true && state.resumed.length === 0);

    // 3. 裸 id 已被退休 → 不复活，放行。
    await run('裸 id 已被退休 → 放行', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      f.__state.blocked.add('private-100000001');
      return f;
    })() }, ({ viaOriginal, state }) => viaOriginal === true && state.resumed.length === 0);

    // 4. 裸 id 没有日志 → 该建新的，放行。
    await run('裸 id 没有日志 → 放行', { fake: makeFake() },
      ({ viaOriginal, state }) => viaOriginal === true && state.resumed.length === 0);

    // 5. 已有活 chat → 直接返回，两条路都不走。
    await run('已有活 chat → 直接返回', { fake: (() => {
      const f = makeFake();
      f.__state.chats.set('private:100000001', { chatId: 'private:100000001', live: true });
      return f;
    })() }, ({ viaOriginal, outcome, state }) =>
      viaOriginal === false && outcome?.live === true && state.resumed.length === 0);

    // 6. 开关关掉 → 完全放行（连日志都不查）。
    await run('enabled:false → 放行', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      return f;
    })(), cfgOverride: { enabled: false } },
    ({ viaOriginal, state }) => viaOriginal === true && state.resumed.length === 0);

    // 7. resume 抛错 → 退休裸 id 后放行（原方法会从 blocked 分支另开新会话）。
    await run('resume 失败 → 退休后放行', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      f.resumeChat = async () => {
        throw new Error('日志损坏');
      };
      return f;
    })() }, ({ viaOriginal, state }) =>
      viaOriginal === true && state.retired.includes('private-100000001'));

    // 8. hasPersistedLog 抛错 → 闸门整体放行，不能把消息卡死。
    await run('持久化查询抛错 → 放行', { fake: (() => {
      const f = makeFake();
      f.hasPersistedLog = async () => {
        throw new Error('磁盘炸了');
      };
      return f;
    })() }, ({ viaOriginal, error }) => viaOriginal === true && error === null);

    // 9. 接口不齐（缺 resumeChat）→ 拒绝凭半套接口接管，放行。
    await run('registry 接口不齐 → 放行', { fake: (() => {
      const f = makeFake();
      f.__state.logs.add('private-100000001');
      f.resumeChat = undefined;
      return f;
    })() }, ({ viaOriginal, state }) => viaOriginal === true && state.resumed.length === 0);

    return { ok: true, cases: results };
  }

  return { MODULE_ID, scan, detach, selfTest, METHODS, TARGET };
}

/** 默认配置（由 index.js 汇总，这里只声明本模块的键）。 */
export const DEFAULTS = {
  enabled: true,
  /** 采纳成功时是否写一条宿主日志（便于从日志看出「这次没换代」）。 */
  logAdoptions: true,
};
