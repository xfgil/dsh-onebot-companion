/**
 * dsh-onebot-companion / core/patch.js
 *
 * 给目标类的原型方法挂包装 —— 四个模块（guard / prompt / rhythm / persona）
 * 共用同一套挂载与脱链逻辑。
 *
 * 为什么统一到这里：合并前 guard 与 rhythm 各写了一份 `patchMethod`，语义还不
 * 一样（guard 只脱自己的旧包装、rhythm 一路脱到链底）。同一个宿主进程里跑两份
 * 微妙的差异逻辑，是 bug 的温床。现在只有一份。
 *
 * ## 为什么必须区分「谁的包装」（合并后最容易踩的坑）
 *
 * 四个模块挂在**不同**的方法上（见下表），但热重载会让同一个方法上留下旧包装。
 * 朴素的「一路脱到链底」在这里是**错的**：它会把别的模块的包装一起剥掉，
 * 于是另一个功能静默失效。所以脱链必须按模块身份来。
 *
 *   | 模块    | 挂载点                                                  |
 *   |---------|---------------------------------------------------------|
 *   | guard   | `OutboundPipeline.prototype.sendToChat` / `sendMsg`      |
 *   | rhythm  | `ChatBridge.prototype.dispatchFollowup` / `sendToChat`   |
 *   | persona | `ChatBridge.prototype.handleInbound` / `onSessionEvent`  |
 *   | prompt  | 不挂原型，走 `agent/pre-step` 注入                       |
 *
 * 脱链规则：**只剥链头连续的「本模块」包装**，遇到别的模块的层立刻停手。
 * 于是无论挂载顺序如何，每个模块在链上最多留一层，且互不吞并。
 *
 * ## 跨热重载的两类标记
 *
 * - `owner`：**普通 Symbol**，每次模块重新求值都是新的一个。回答「这个包装
 *   是不是**当前这个实例**挂的」。热重载后必须重新包装（新配置要生效），所以
 *   这里不能是 `Symbol.for`。
 * - `patched` / `module`：`Symbol.for` 键，**跨模块实例稳定**。服务于「体检」与
 *   「脱链」——判断原型上这个方法是哪个模块的包装。没有它的话，每次热重载旧包装
 *   都不带新 owner，会被误判成「闸丢了」，`lost` 刷成一片噪声（实测 16 次重载
 *   = 16 条假 lost），真丢了反而看不出来。
 *
 * @module dsh-onebot-companion/core/patch
 */

/** 包装上指向「链底原方法」的属性名（普通字符串，跨模块实例可读）。 */
export const ORIGINAL = '__onebotCompanionOriginal';

/** 跨实例稳定的「我们挂过」标记。 */
export const PATCHED = Symbol.for('dsh-onebot-companion.patched');

/** 跨实例稳定的「哪一层是哪个模块挂的」标记。 */
export const MODULE = Symbol.for('dsh-onebot-companion.module');

/**
 * 兼容读取：合并前 `dsh-onebot-guard` 与 `dsh-onebot-rhythm` 各自的属性名。
 *
 * 迁移期两者可能短暂共存（旧插件还没禁用、新插件已加载），原型上会挂着它们的
 * 包装。认得出这两个名字，才能正确脱链，而不是把它们当成「别人的包装」包在
 * 外面 —— 那会导致同一条消息被投递两次。
 */
const LEGACY_ORIGINALS = ['__onebotGuardOriginal', '__onebotRhythmOriginal'];

/** 从任意包装上取它攥着的原方法（含旧版属性名）。 */
export function originalOf(fn) {
  if (typeof fn !== 'function') return undefined;
  if (typeof fn[ORIGINAL] === 'function') return fn[ORIGINAL];
  for (const key of LEGACY_ORIGINALS) {
    if (typeof fn[key] === 'function') return fn[key];
  }
  return undefined;
}

/**
 * 创建一个绑定到某次 `apply()` 的挂载器。
 *
 * @param {object} options
 * @param {symbol} options.owner - 本次实例的标记（普通 Symbol）。
 * @param {(level: string, message: string) => void} [options.log]
 * @param {{ patched: object[], lost: object[] }} [options.stats] - 观测数据。
 * @param {string} [options.label] - 日志前缀。
 * @returns {(proto: object, method: string, moduleId: string, makeWrapper: Function, urlForLog?: string) => boolean}
 */
export function createPatcher({ owner, log, stats, label = 'onebot-companion' }) {
  const note = (level, message) => {
    try {
      log?.(level, `[${label}] ${message}`);
    } catch {
      /* 日志失败不影响业务 */
    }
  };

  return function patchMethod(proto, method, moduleId, makeWrapper, urlForLog = '') {
    if (!proto || typeof proto[method] !== 'function') return false;
    const existing = proto[method];

    // 本实例（本次 apply）已经挂过**这个方法**，幂等跳过。
    //
    // 判定必须同时看 moduleId：同一个实例可以往同一个方法上挂两个模块的闸吗？
    // 实际上不会（挂载点表里四个模块互不重叠），但**幂等判定只看 owner 是错的** ——
    // 那会让「同一实例给同一方法挂另一个模块」被静默吞掉。自测里就是这么抓到它的：
    // 同一个 patcher 先挂 guard 再挂 rhythm，第二次返回 false、闸根本没上。
    if (existing[owner] === owner && existing[MODULE] === moduleId) return false;

    // 剥掉链头连续的「本模块」包装（热重载或上一轮扫描留下的）。
    // 遇到别的模块的层 / 别人的包装立刻停手 —— 那一层归别人管。
    let original = existing;
    const walked = new Set();
    while (
      typeof original === 'function' &&
      original[MODULE] === moduleId &&
      original[PATCHED] === true &&
      !walked.has(original)
    ) {
      walked.add(original);
      const inner = originalOf(original);
      if (typeof inner !== 'function') break;
      original = inner;
    }

    const wrapped = makeWrapper(original);
    if (typeof wrapped !== 'function') return false;

    wrapped[PATCHED] = true;
    wrapped[MODULE] = moduleId;
    wrapped[owner] = owner;
    wrapped[ORIGINAL] = original;
    proto[method] = wrapped;

    if (stats) {
      stats.patched.push({ url: urlForLog, method, moduleId, at: Date.now() });
      if (stats.patched.length > 50) stats.patched.splice(0, stats.patched.length - 50);
      // 闸回来了就不再算「丢」——热重载/重挂都会走到这里，不清的话 `lost`
      // 会一直留着早就修好的历史噪声。
      for (let i = stats.lost.length - 1; i >= 0; i--) {
        if (stats.lost[i].method === method && stats.lost[i].moduleId === moduleId) {
          stats.lost.splice(i, 1);
        }
      }
    }

    note('info', `已挂载 ${moduleId} 闸: ${method}${urlForLog ? ` @ ${urlForLog}` : ''}`);
    return true;
  };
}

/**
 * 体检：原型上这些方法还在不在**这个模块**手里。
 *
 * 用 `module`（跨实例稳定）判定，不用 `owner` —— 否则每次热重载旧包装都会被
 * 误报成「丢了」。命中说明目标包被换过（市场升级换了目录、模块实例变新），
 * 下一次 `scanOnce` 会重新挂上。
 *
 * @returns {string[]} 丢了的方法名。
 */
export function auditMethods(proto, methods, moduleId) {
  const lost = [];
  for (const method of methods) {
    const fn = proto?.[method];
    if (typeof fn === 'function' && fn[MODULE] !== moduleId) lost.push(method);
  }
  return lost;
}
