/**
 * dsh-onebot-companion / core/patch.js
 *
 * 给目标类的原型方法挂包装 —— 各模块（guard / adopt / rhythm / stamp / persona）
 * 共用同一套挂载与脱链逻辑。
 *
 * 为什么统一到这里：合并前 guard 与 rhythm 各写了一份 `patchMethod`，语义还不
 * 一样（guard 只脱自己的旧包装、rhythm 一路脱到链底）。同一个宿主进程里跑两份
 * 微妙的差异逻辑，是 bug 的温床。现在只有一份。
 *
 * ## 为什么必须区分「谁的包装」（合并后最容易踩的坑）
 *
 * 多个模块可能挂在**同一个**方法上（见下表），热重载会让同一个方法上留下旧包装。
 * 朴素的「一路脱到链底」在这里是**错的**：它会把别的模块的包装一起剥掉，
 * 于是另一个功能静默失效。所以脱链必须按模块身份来。
 *
 *   | 模块    | 挂载点                                                  |
 *   |---------|---------------------------------------------------------|
 *   | guard   | `OutboundPipeline.prototype.sendToChat` / `sendMsg`      |
 *   | rhythm  | `ChatBridge.prototype.dispatchFollowup` / `sendToChat`   |
 *   | persona | `ChatBridge.prototype.handleInbound` / `onSessionEvent` |
 *   | stamp   | `ChatBridge.prototype.handleInbound` / `dispatchFollowup`|
 *   | prompt  | 不挂原型，走 `agent/pre-step` 注入                       |
 *
 * 脱链规则：**穿透整条链，剥掉本模块的所有层**（无论它被压在谁下面），遇到链底
 * 停下。于是无论挂载顺序如何、扫描多少轮，每个模块在链上最多留一层，且互不吞并。
 *
 * ## ⚠️ 为什么脱链不能只看链头（2026-10-14 实测抓到的真 bug）
 *
 * 原实现只剥「链头连续的本模块层」，幂等判定也只看链头。这在**单模块占一个挂载
 * 点**时看不出问题，一旦两个模块共享同一个方法就立刻烂掉 —— 而这正是 stamp 进场
 * 后的形态（stamp 与 rhythm 都挂 `dispatchFollowup`，stamp 与 persona 都挂
 * `handleInbound`）。`test/exp-shared-mount.mjs` 复现的链演化：
 *
 *     A 挂 -> A          （链头 A）
 *     B 挂 -> B -> A     （链头变成 B）
 *     A 再挂：链头是 B ≠ A，幂等判定落空 -> 把整条链（含 B）当 original 再包一层
 *             -> A -> B -> A
 *     B 再挂：同理 -> B -> A -> B -> A
 *
 * 每轮 `scanAll`（默认 3 秒一次）链长 **+2，永不收敛**：`stats.patched` 每轮白推
 * 两条，投递路径上的层数无限增长，而 `lost` 因为被清空反而看不出毛病。
 *
 * 另外一个同源缺陷：`auditMethods` 只看链头，本模块的层被压在别人下面时会被误报
 * 成「丢了」。它同样改成扫整条链。
 *
 * 顺序说明：谁在外层由 `MODULE_PRIORITY` **唯一决定**（数字大的在外），与挂载时序
 * 无关。`scanAll()` 改成串行只是为了让「同一轮里各模块的 scan 不互相踩 stats」，
 * **不再是**顺序的来源。stamp 必须排在 rhythm 外层，理由见 `MODULE_PRIORITY` 的
 * 取值注释与 `modules/stamp.js` 头注释。
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
 * ★ 层上指向「它自己的 owner」的引用（值就是那个 owner symbol）。
 *
 * ## 为什么必须有它
 *
 * `owner` 是每个模块实例**私有**的普通 Symbol，挂在层上的键名就是那个 symbol
 * 本身（`layer[owner] = owner` 这种形态）。别的模块看一层时，连「该用哪个键去
 * 问它」都不知道 —— `layer[myOwnOwner]` 自然是 `undefined`。
 *
 * 2026-10-14 实测踩到：A 重建链时想沿用 B 那层原有的 owner（不打断 B 的身份），
 * 写的是 `layer[owner]`，但那里的 `owner` 是 **A 自己的**变量，问的是 B 层上不
 * 存在的键，于是 B 的新层拿到 `owner: undefined`，**当场丢失身份**。后果是 B 下
 * 一轮自查/幂等判定都不再认得自己那层，于是反复重建（`test/exp-idem3.mjs` 打出
 * 的 `ownerA属性=undefined`）。
 *
 * 有了这个稳定的键，任何模块都能读出任意一层的 owner 并原样传下去。
 */
export const OWNER = Symbol.for('dsh-onebot-companion.owner');

/**
 * 挂载优先级：**数字大的在外层**（更早看到调用）。
 *
 * ## 为什么需要一张表，而不是靠 `scanAll` 的调用顺序
 *
 * 原设计是「最后挂的在最外层」，于是顺序由谁先跑完 `scan` 决定。这在**单模块占
 * 一个挂载点**时成立，一共享就失效，而且失效方式很隐蔽：
 *
 *     A(rhythm) 挂 -> rhythm@A
 *     B(stamp)  挂 -> stamp@B -> rhythm@A        （stamp 在外层，正确）
 *     C(rhythm) 重挂（新实例/热重载）-> rhythm@C -> stamp@B
 *     B(stamp)  再挂 -> **返回 false（幂等）**
 *
 * 最后一行是关键：stamp 的层还在链上，只是被顶到里面了，于是幂等判定直接跳过，
 * 它**永远回不到外层**。顺序就此永久停错，而 `stats` 里看不出任何异常。
 *
 * （`test/exp-chain-order.mjs` 复刻了这四步。）
 *
 * 所以顺序不能依赖挂载时序，必须是**各层自带的属性**：每次挂载都把整条链按优先
 * 级重排。这样链形状由优先级唯一决定，与挂载顺序、扫描轮数、热重载全都无关。
 *
 * ## 取值
 *
 * 只有共享挂载点的相对次序是有意义的，其余给同一个基准值即可（同优先级内部保持
 * 原有相对顺序，稳定的）。
 *
 *   - `stamp` = 20：`dispatchFollowup` 上必须在 `rhythm` **外**——先给每条消息各自
 *     注入它那一刻的 `time=`/`gap=`，再由 rhythm 合并成一批。反过来只会在合并后
 *     拿到一整批文本，而 `injectStamp` 只改第一个开标签，整批就只剩第一个块有时间。
 *     `handleInbound` 上在外层也合理（最早看到事件、先记账）。
 *   - 其余 = 10：没有互相约束，保持它们既有的相对顺序。
 */
export const MODULE_PRIORITY = {
  // sleep = 30：processInbound 上必须在 mention **外**层。mention 对「喊名字 /
  // 话题插话」命中的消息会往 segments 里补一个 at 段（借用上游「被 @」语义）；
  // 睡意闸若在内层，那个补出来的 at 就会被当成「有人 @ 我」，喊一句名字就把
  // 睡着的人叫醒、插一句话更会被叫醒 —— 闸形同虚设。放在外层，判的是用户
  // **原始** segments，补出来的 at 此刻还不存在。
  sleep: 30,
  guard: 10,
  adopt: 10,
  persona: 10,
  rhythm: 10,
  prompt: 10,
  stamp: 20,
};

/** 查一个模块的挂载优先级（未登记 = 0）。 */
export function priorityOf(moduleId) {
  return MODULE_PRIORITY[moduleId] ?? 0;
}

/**
 * 包装工厂登记表：`proto → method → moduleId → { makeWrapper, owner }`。
 *
 * ## 为什么必须有它（只有优先级重排是不够的）
 *
 * 每一层包装都**闭包捕获**了它被造出来时收到的 `original`：
 *
 *     (original) => function wrapper(...args) { return original.call(this, ...args); }
 *
 * 所以「重新串一下 ORIGINAL 指针」**改不动已经造好的层** —— 指针变了，闭包还指
 * 着旧函数。2026-10-14 实测：stamp 层被注册到 rhythm 层下面之后，虽然链头指向
 * 没错，stamp 每次调用仍走**过期的** rhythm 层，行为断言直接失败
 * （`test/exp-chain-order.mjs`）。
 *
 * 要修正一层的连接，只能**用它自己的 `makeWrapper` 重造一层**。而当前模块手里
 * 没有别人的 `makeWrapper` —— 于是把每次挂载收到的那个登记下来，任何模块重排链
 * 时都能正确地重建别人的层。
 *
 * 存的是**上次**的 `makeWrapper`（同一模块的等价代码），不是本次的：这样本模块
 * 重挂时不会拿新闭包去动别人的层。
 *
 * 挂在 `globalThis`（`Symbol.for` 键）上跨热重载存活；`WeakMap` 以 `proto` 为
 * 键，目标包换目录后旧条目自然回收。
 *
 * ## ★ 硬约束：`makeWrapper` 必须是纯函数
 *
 * 上面那条「只能重造」意味着**每轮有模块重挂时，链上所有层都会被重新造一遍**
 * （不只是动的那个）。2026-10-14 对抗审计（`test/audit-sideeffect-cycle.mjs`）
 * 把它钉成了断言：bb 进场时 aa 的工厂被**第二次**调用。
 *
 * 所以工厂里**不能有任何副作用** —— 不许写 `stats`、不许注册监听、不许自增计数、
 * 不许改动外部状态。要副作用就放在**包装函数的调用期**（真正被调用时才发生）。
 * 当前五个模块的工厂都符合（清一色 `(original) => makeXxx({ ... })` 或内联闭包），
 * 但这是**约定而非机制**，没有东西会在违反时报错。
 *
 * 违反的后果不是崩溃而是**计数与注册成倍增长**：真实调用 1 次，`stats` 里记 3 次。
 */
const REGISTRY_KEY = Symbol.for('dsh-onebot-companion.registry');
const REGISTRY = (globalThis[REGISTRY_KEY] ??= new WeakMap());

/** 取（或建）某条 `proto.method` 的登记子表。 */
function registryFor(proto, method) {
  let byMethod = REGISTRY.get(proto);
  if (byMethod === undefined) {
    byMethod = new Map();
    REGISTRY.set(proto, byMethod);
  }
  let table = byMethod.get(method);
  if (table === undefined) {
    table = new Map();
    byMethod.set(method, table);
  }
  return table;
}

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

  // ⚠️ 这里必须是**函数声明**而不是 `return function patchMethod(...){...}`：
  // 后者会让函数在 `return` 那一刻就交出去，后面挂 `patchMethod.unpatch` 的语句
  // 变成永远执行不到的死代码（实测：`p.unpatch is not a function`）。函数声明
  // 提升到整个 `createPatcher` 作用域，两处定义谁先谁后都无所谓。
  function patchMethod(proto, method, moduleId, makeWrapper, urlForLog = '') {
    if (!proto || typeof proto[method] !== 'function') return false;

    // ── 摊平整条链 ──────────────────────────────────────────────────────────
    //
    // `layers` 是从链头到链底的所有**包装层**；`base` 是链底那个不是包装的方法
    // （通常就是上游实现）。`seen` 防御环状链 —— 坏掉的 ORIGINAL 指针不该让扫
    // 描卡死（这是个每 3 秒跑一次的定时器）。
    const layers = [];
    const seen = new Set();
    let base = proto[method];
    while (typeof base === 'function' && !seen.has(base)) {
      seen.add(base);
      const inner = originalOf(base);
      if (typeof inner !== 'function') break;
      layers.push(base);
      base = inner;
    }

    // ── 把链描述成「层的清单」 ──────────────────────────────────────────────
    //
    // 每一层都要能重建自己。重建必须用**该层自己的** `makeWrapper`，因为每层都
    // 闭包捕获了它被造出来时收到的 `original` —— 只改 ORIGINAL 指针改不动闭包，
    // 链条会穿过过期的旧层（2026-10-14 实测：stamp 层挪到 rhythm 下面后，虽然
    // 指针没错，调用仍走旧的 rhythm 层，行为断言直接失败）。
    //
    // 本模块自己的旧层一律丢弃 —— 下面要用本次的 `makeWrapper` 重造一层。
    // 同一 moduleId 只留**最外层**那个：热重载或反复挂载可能在链上留下同模块的
    // 多层，那不是合法形态。链上出现了重复的 moduleId，清单就会短于实际层数，
    // 幂等判定随即失败并触发一次重建，把重复层清掉。
    const registry = registryFor(proto, method);
    const registrySnapshot = new Map(registry);

    const descriptors = [];
    const taken = new Set();
    // 链上**最外层冻结层**的下标。它和它下面的一切都必须原样留住（理由见下），
    // 重建只发生在它之上。-1 表示整条链都可重建。
    let frozenAt = -1;

    for (let i = 0; i < layers.length; i += 1) {
      const layer = layers[i];
      const layerModule = layer[MODULE];
      if (layerModule === moduleId) continue;

      // ── 可重建层 ──────────────────────────────────────────────────────────
      const remembered =
        typeof layerModule === 'string' ? registrySnapshot.get(layerModule) : undefined;
      const makeWrapper = remembered?.makeWrapper;
      if (typeof makeWrapper === 'function') {
        if (taken.has(layerModule)) continue; // 同一 moduleId 只留最外层那个
        taken.add(layerModule);
        descriptors.push({
          moduleId: layerModule,
          // 沿用**这一层现有的** owner，别动它的身份：下一轮那个模块自查时仍会
          // 认为「我的层还在、位置也对」，于是不会平白多重建一次。
          //
          // 必须从稳定的 `OWNER` 键读，**不能用闭包里的 `owner`** —— 那是本次调用
          // 这个模块自己的 symbol，问别人的层只会得到 undefined，重建出来的层就
          // 丢了身份（2026-10-14 实测踩到，见 OWNER 的注释）。
          owner: layer[OWNER] ?? layer[owner] ?? remembered?.owner,
          makeWrapper,
        });
        continue;
      }

      // ── 冻结层：链上有它，但谁都拿不出重建它的工厂 ────────────────────────
      //
      // 两种来源，本质是同一个困境：
      //
      //   ① MODULE 身份在、REGISTRY 里没有 —— 上一版 patch.js 热重载留下的层。
      //      REGISTRY 是 2026-10-14 这次重写才引入的表，旧层从不写它。
      //   ② 连 MODULE 都没有，只有 ORIGINAL / LEGACY_ORIGINALS —— 第三方插件，或
      //      迁移期残留的旧 guard/rhythm 包装。
      //
      // 这两种层**没有正确的重建办法**：重建必须用该层自己的 makeWrapper（见上面
      // 的说明），拿不到就只能原位复用，而原位复用只在它的直接下层恰好没变时才
      // 成立。并且它在目标形状里该排哪儿也**无良定义**（连身份都不全，优先级无从
      // 谈起）。所以：**它成了锚点，它和它下面的一切一律不碰** —— 它的闭包捕获的
      // 那个 original 因此保持有效，不需要也不允许改写。
      //
      // ⚠️ 绝不能像修复前那样用 `(() => layer)` 兜底。那个兜底会把**原层对象**
      // 交回去，紧接着重建循环对它原位写 `layer[ORIGINAL] = head` —— 指针当场被
      // 改到新位置，而它闭包里捕获的旧 original 一动不动，两者从此分叉。实测后果
      // （2026-10-14 对抗审计，`test/audit-fallback-replay.mjs` /
      // `test/audit-upgrade-ghost.mjs`）：同一个层被跑两遍，或者新挂的层被整个
      // 旁路、此后每轮幂等放行**永不自愈** —— 而 auditMethods 按 MODULE 判定
      // 「层还在」，stats 里看不出任何异常。
      frozenAt = i;
      break;
    }

    // 锚点层本身若**就是本模块的层**，那不算「被压住」—— 要换掉的正是它。它没有
    // registry 条目（上一版代码留下的），所以重建不了；但把它**换掉**是可以的：
    // 它的下层一律原样留用，我们只在那个下层之上重造本模块的新层。真实来源是热重载
    // —— 新实例的 owner 与旧实例不同、又没有旧实例的 registry 条目（新表里也没有）。
    //
    // 剩下那种（本模块的层在锚点**下面**）就真拔不出来了：拔它必须重接锚点的
    // ORIGINAL，而锚点的闭包改不动。此时宁可放弃本次重排，也不能留两层同模块的
    // 包装在链上 —— 那会让同一条消息被处理两次。
    //
    // 代价要说清楚：只要那个冻结层一直不被它自己的模块重造（它的 scan 抛异常、或
    // 被配置关掉但摘闸没成功），本模块就**一直挂不上外层**。这是刻意接受的安全
    // 取舍 —— 让位只是排序不理想，改一个闭包修不好的指针则是让同一层跑两遍或整个
    // 旁路，后者严重得多。冻结层一旦被它自己的模块重造（正常下一轮就会），本模块
    // 当场恢复。
    //
    // 但它**不能静默**：`auditMethods` 按 `MODULE` 判定「层还在」，会认为本模块
    // 一切正常，而这正是审计最担心的那种「stats 里看不出任何异常」。所以这里额外
    // 往 `lost` 推一条带原因的记录，让 `/status` 端点能看见。
    let above = base;
    if (frozenAt >= 0) {
      const anchor = layers[frozenAt];
      if (anchor[MODULE] === moduleId) {
        above = frozenAt + 1 < layers.length ? layers[frozenAt + 1] : base;
      } else {
        const buried = layers.slice(frozenAt + 1).some((layer) => layer[MODULE] === moduleId);
        if (buried) {
          const frozenBy = anchor[MODULE] ?? '(未标记身份的层)';
          note('warn', `放弃重排 ${method}: ${moduleId} 的层被冻结层 ${frozenBy} 压在下面`);
          if (stats) {
            // 先清掉本模块这一条的旧记录再推 —— 每 3 秒一轮扫描都要走这里，
            // 不清的话 `lost` 会被同一条瞬时状态灌满、把别的真丢失挤出去。
            for (let i = stats.lost.length - 1; i >= 0; i -= 1) {
              if (stats.lost[i].method === method && stats.lost[i].moduleId === moduleId) {
                stats.lost.splice(i, 1);
              }
            }
            stats.lost.push({
              method,
              moduleId,
              reason: `被冻结层 ${frozenBy} 压在下面，本次无法重排（等它自己的模块重造后自愈）`,
              at: Date.now(),
            });
            if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
          }
          return false;
        }
        above = anchor;
      }
    }

    // 目标形状：先按优先级降序（高的在外层），同优先级再按 moduleId 字典序升序。
    //
    // 两条都用**层自带的属性**，因此形状完全由「有哪些模块」唯一决定，与挂载
    // 时序、扫描轮数、热重载统统无关 —— 这是本函数最重要的性质。
    //
    // 同优先级为什么必须定死一个确定次序、而不能让「本模块排最外」：那样两个同
    // 优先级的模块会每轮把对方顶到外面一次，链形状永不收敛（A 重挂 → [A,B]，
    // B 重挂 → [B,A]，A 再重挂 → [A,B]…）。这就是修复前那个每轮 +2 的 bug 的
    // 另一种写法。字典序两者都不偏向，谁重挂都得到同一个形状。
    //
    // 有冻结层时，这一排序只在**锚点之上**生效：锚点及以下原样留用，因此它们不
    // 参与排序，也无法被换位。这是刻意的 —— 宁可局部让位，也不能改写一个闭包
    // 修不好的层。
    const ordered = [...descriptors, { moduleId, owner, makeWrapper }].sort(
      (a, b) =>
        priorityOf(b.moduleId) - priorityOf(a.moduleId) ||
        (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0),
    );

    // ── 幂等判定 ────────────────────────────────────────────────────────────
    //
    // 逐位比对「现有链」与「目标链」的模块身份与 owner。有冻结层时只比对锚点
    // 之上那一段（锚点本身与下面的一切都是原样留用的，不存在过期问题）。
    //
    // 只判「链上已有本模块的层」是**不够**的，那是 2026-10-14 踩到的坑：stamp 的
    // 层被随后重挂的 rhythm 顶到里层后，它仍在链上，于是幂等跳过，**永远回不到
    // 外层**，顺序永久停错而 stats 里看不出异常（`test/exp-chain-order.mjs`）。
    //
    // 这里不需要逐层比 `makeWrapper`：只要形状与身份完全没变，就没有任何一层挪过
    // 位置，也就没有闭包会过期（重建总是整段重建，不会留下半新半旧的链）。
    //
    // 有冻结层时只比 `layers[0 .. frozenAt-1]` 那一段：锚点本身在「锚点就是本模块
    // 的旧层」时会被换掉（那种情况下面必须重建，不能幂等跳过），其余情形则是原样
    // 留用、不存在过期问题。
    const matched = frozenAt >= 0 ? frozenAt : layers.length;
    let inPlace = ordered.length === matched;
    for (let i = 0; inPlace && i < ordered.length; i += 1) {
      if (layers[i][MODULE] !== ordered[i].moduleId) inPlace = false;
      // owner 从稳定的 `OWNER` 键读，不能用闭包里的 `owner`（那是本模块自己的
      // symbol，问别人的层只会得到 undefined，见 OWNER 的注释）。
      else if (layers[i][OWNER] !== ordered[i].owner) inPlace = false;
    }
    // 锚点就是本模块的旧层 → 必须重建（把旧层换成本次的新层），哪怕上面那段没变。
    if (inPlace && frozenAt >= 0 && layers[frozenAt][MODULE] === moduleId) inPlace = false;

    // 走到这里本模块这一轮的结论就是「链上没问题」（要么已就位、要么马上重建）。
    // 清掉本模块的 `lost` 旧记录 —— 尤其是「被冻结层压住」那条：冻结层一旦被它
    // 自己的模块重造，链上当场就正常了，而我们这轮走的是幂等分支、不做重建，
    // 于是没人去清那条记录，`lost` 会一直挂着早就不成立的假警报。
    if (stats) {
      for (let i = stats.lost.length - 1; i >= 0; i -= 1) {
        if (stats.lost[i].method === method && stats.lost[i].moduleId === moduleId) {
          stats.lost.splice(i, 1);
        }
      }
    }

    if (inPlace) return false;

    // ── 从锚点往上整条重建 ──────────────────────────────────────────────────
    //
    // 只在内存里造新层、最后一次性挂上原型，所以中途失败（某层的工厂返回非函数）
    // 只需放弃本次重排：原型上什么都没动，半截链不可能漏出去。
    //
    // `above` 是重建的起点：它是**允许被本模块改写指针的最低那层**。
    //   · 无冻结层 → `base`；
    //   · 锚点是别人的冻结层 → 锚点本身（它的 `ORIGINAL` 一字不改，闭包继续有效）；
    //   · 锚点就是本模块的旧层 → 锚点**下面**那层（我们要把锚点整个换掉）。
    let head = above;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const want = ordered[i];
      const layer = want.makeWrapper(head);
      if (typeof layer !== 'function') return false;
      layer[PATCHED] = true;
      layer[MODULE] = want.moduleId;
      layer[OWNER] = want.owner;
      // 本模块那层额外挂上自己的私有键 —— 保留原有形态（`layer[owner] === owner`
      // 是这个模块以后认领自己那层的方式），同时 `OWNER` 让所有模块都能读它。
      if (want.moduleId === moduleId) layer[owner] = owner;
      layer[ORIGINAL] = head;
      head = layer;
    }
    proto[method] = head;

    registry.set(moduleId, { makeWrapper, owner });

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
  }

  /**
   * 摘闸：把 `proto[method]` 上**本模块的所有层**剥掉，其余层原样保留并重接。
   *
   * ## 为什么必须放在这里，而不是各模块自己写
   *
   * 各模块原先各自实现了一份 detach，形态都是「从链头往下走，只要链头是本模块就
   * 剥一层，遇到别人的层就停」。那在**独占挂载点**时没问题，一共享就废：
   *
   *   `handleInbound` 的链是 `persona -> stamp -> base`，stamp 的 detach 看链头
   *   是 persona，立刻 `return false` —— **闸根本关不掉**，而 `POST /module`
   *   `{"module":"stamp","enabled":false}` 还会报告成功。
   *
   * 而且摘层和挂层是**同一件事的两面**：摘掉中间一层必须重接上下两层的指针，
   * 用的还是同一张 REGISTRY 表。拆成两份实现必然继续分叉（这份已经从「只看链头
   * 的挂载」错到「只看链头的摘除」两次了）。
   *
   * @returns {boolean} 是否真的改动过原型。
   */
  function unpatchMethod(proto, method, moduleId) {
    if (!proto || typeof proto[method] !== 'function') return false;

    const layers = [];
    const seen = new Set();
    let base = proto[method];
    while (typeof base === 'function' && !seen.has(base)) {
      seen.add(base);
      const inner = originalOf(base);
      if (typeof inner !== 'function') break;
      layers.push(base);
      base = inner;
    }

    const kept = layers.filter((layer) => layer[MODULE] !== moduleId);
    if (kept.length === layers.length) return false;

    // 同一个 moduleId 只留最外层一个 —— 与挂载路径保持一致。
    const registry = registryFor(proto, method);
    const seenModules = new Set();
    const descriptors = [];
    let anchorLayer = null;
    for (const layer of kept) {
      const layerModule = layer[MODULE];
      if (typeof layerModule !== 'string' || seenModules.has(layerModule)) continue;
      seenModules.add(layerModule);
      const remembered = registry.get(layerModule);
      const makeWrapper = remembered?.makeWrapper;
      // 冻结层（拿不到重建工厂）：它没法被重建，也没法安全地挪位置，于是成为锚点，
      // 它及以下一律原样留用。要摘的层若落在它下面，就只能放弃 —— 拔掉那层必须
      // 改锚点的 ORIGINAL 指针，而锚点的闭包改不动（与 patchMethod 里同一困境，
      // 详见那边的长注释）。宁可这次关不掉闸，也不能把闭包和指针对不上的坏层
      // 留在生产链上。
      if (typeof makeWrapper !== 'function') {
        const anchor = layers.indexOf(layer);
        if (layers.slice(anchor).some((l) => l[MODULE] === moduleId)) {
          note('warn', `放弃摘除 ${moduleId} 闸: ${method}（本模块的层被冻结层压在下面）`);
          return false;
        }
        anchorLayer = layer;
        break; // 锚点之上的层照常重建，锚点及以下不动
      }
      descriptors.push({
        moduleId: layerModule,
        owner: layer[OWNER] ?? remembered?.owner,
        makeWrapper,
      });
    }

    // 与挂载路径同一套排序，保证「摘掉一个模块」不会顺带打乱其余层的顺序。
    descriptors.sort(
      (a, b) =>
        priorityOf(b.moduleId) - priorityOf(a.moduleId) ||
        (a.moduleId < b.moduleId ? -1 : a.moduleId > b.moduleId ? 1 : 0),
    );

    // ⚠️ 这里**不能**加「剩余层顺序已经对了就跳过」的短路。
    //
    // 本模块的层不在链头时（真实：`persona -> stamp -> base` 里摘 stamp），剩下
    // 的层顺序天然就是对的，于是短路命中、直接 return false —— 而 stamp 那层
    // 还原封不动挂在原型上，闸根本没关掉（2026-10-14 实测，链形状断言当场打到）。
    //
    // 上面 `kept.length === layers.length` 已经处理了「链上本来就没有本模块的层」，
    // 走到这里就一定有层要摘，重建是必需的。
    //
    // 有冻结层时从锚点层本身起步，锚点的 `ORIGINAL` 与闭包都保持原样。
    let head = anchorLayer ?? base;
    for (let i = descriptors.length - 1; i >= 0; i -= 1) {
      const want = descriptors[i];
      const layer = want.makeWrapper(head);
      if (typeof layer !== 'function') return false;
      layer[PATCHED] = true;
      layer[MODULE] = want.moduleId;
      layer[OWNER] = want.owner;
      layer[ORIGINAL] = head;
      head = layer;
    }
    proto[method] = head;
    registry.delete(moduleId);
    note('info', `已摘除 ${moduleId} 闸: ${method}（其余层重接）`);
    return true;
  }

  // `unpatchMethod` 作为**属性**挂在返回的函数上，而不是改成返回一个对象 ——
  // 六处调用方全是 `const patchMethod = createPatcher({...})` 后直接调用，改签名
  // 会一次打断它们。
  patchMethod.unpatch = unpatchMethod;
  return patchMethod;
}

/**
 * 体检：原型上这些方法还在不在**这个模块**手里。
 *
 * 用 `module`（跨实例稳定）判定，不用 `owner` —— 否则每次热重载旧包装都会被
 * 误报成「丢了」。命中说明目标包被换过（市场升级换了目录、模块实例变新），
 * 下一次 `scanOnce` 会重新挂上。
 *
 * **要扫整条链**，不能只看链头：本模块的层可能被压在另一个模块的下面（stamp 与
 * rhythm 共享 `dispatchFollowup` 就是这样），只看链头会把它误报成「丢了」，于是
 * `lost` 里常驻一条假警报，真丢了反而看不出来。
 *
 * @returns {string[]} 丢了的方法名。
 */
export function auditMethods(proto, methods, moduleId) {
  const lost = [];
  for (const method of methods) {
    const head = proto?.[method];
    if (typeof head !== 'function') continue;
    let cur = head;
    const seen = new Set();
    let held = false;
    while (typeof cur === 'function' && !seen.has(cur)) {
      seen.add(cur);
      if (cur[MODULE] === moduleId) {
        held = true;
        break;
      }
      cur = originalOf(cur);
    }
    if (!held) lost.push(method);
  }
  return lost;
}
