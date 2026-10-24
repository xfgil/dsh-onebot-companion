/**
 * dsh-onebot-companion / core/config.js
 *
 * 把默认值**就地**填进调用方给的配置对象。
 *
 * ## 为什么是「就地」而不是返回新对象
 *
 * `index.js` 的 HTTP 面（`POST /module`）改的是 `cfg[key].enabled` —— 它拿的是
 * 自己那份 `cfg`。如果模块在 `createXxx` 里新建一个合并对象，两边的引用就断了：
 * 观测面上显示「已关闭」，模块里照旧开着。所以必须写回同一个对象。
 *
 * ## 为什么要深合并两层
 *
 * `rhythm.inbound` / `rhythm.burst` 是嵌套段。浅合并时调用方只给
 * `inbound: { quietMs: 500 }` 会把整个 `inbound` 换成只有一个键的对象，其余键
 * 变 `undefined`，运行时行为诡异（超时全变 NaN）。这里的 `nested` 参数就是干这个的。
 *
 * @module dsh-onebot-companion/core/config
 */

/**
 * 就地把 `DEFAULTS` 填进 `cfg`（已存在的键不动）。
 *
 * @param {object} cfg - 调用方给的配置对象（会被修改）。
 * @param {object} DEFAULTS - 该模块的默认值。
 * @param {string[]} [nested] - 需要深合并一层的子对象键名。
 * @returns {object} 同一个 `cfg` 引用。
 */
export function fillDefaults(cfg, DEFAULTS, nested = []) {
  const target = cfg !== null && typeof cfg === 'object' ? cfg : {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (target[key] === undefined) {
      target[key] = value;
      continue;
    }
    if (nested.includes(key)) {
      target[key] = { ...value, ...(target[key] ?? {}) };
    }
  }
  return target;
}
