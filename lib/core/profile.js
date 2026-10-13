/**
 * dsh-onebot-companion / core/profile.js
 *
 * 定位 profile 目录，并 import 目标包里的模块。
 *
 * 合并前 `dsh-onebot-guard` 与 `dsh-onebot-rhythm` 各有一份**逐字重复**的
 * `resolveProfileDirs()`（约 75 行）。它之所以写那么长，是因为没有一条路是
 * 可靠的：宿主不同版本暴露的信息不一样，只能把能想到的全试一遍，取第一个命中的。
 *
 * 这个函数的存在意义：本插件**不改 node_modules**，只从外面给原型挂包装。要挂
 * 就必须先 `import()` 到目标模块 —— 而 ESM 的模块缓存按 URL 去重，所以必须用
 * 绝对 `file://` URL，且要与宿主 loader 解析出的那份**完全一致**，否则拿到的是
 * 另一个模块实例，改了也没用。
 *
 * @module dsh-onebot-companion/core/profile
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 从任意路径里抠出 `.../profiles/<name>` 这一段。 */
const PROFILE_RE = /^(.*?[\\/]profiles[\\/][^\\/]+)(?:[\\/]|$)/i;

/**
 * 探测 profile 目录（且确认里面装了 `packageName`）。
 *
 * 探测顺序（从最可靠到最后的兜底）：
 *   1. 配置里显式给的 `profileDir`
 *   2. `DSH_PROFILE_DIR` 环境变量
 *   3. `DSH_HOME` + `DSH_PROFILE`
 *   4. loader 树里每个 entry 的 `parent.tree.ctx.baseUrl`（宿主自己最清楚）
 *   5. 当前 ctx 的 `baseUrl`
 *   6. 宿主命令行参数（带着 profile 绝对路径）
 *   7. 进程工作目录
 *   8. 扫 `$DSH_HOME/profiles/*` 看哪个装了目标包
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} cfg - 需要 `profileDir` 与 `packageName`。
 * @returns {string[]} 命中的 profile 目录（已确认含目标包），按可靠性排序。
 */
export function resolveProfileDirs(ctx, cfg) {
  const found = [];
  const seen = new Set();

  const consider = (p) => {
    if (typeof p !== 'string' || p === '') return;
    let s = p;
    if (s.startsWith('file:')) {
      try {
        s = fileURLToPath(s);
      } catch {
        return;
      }
    }
    const m = PROFILE_RE.exec(s);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      found.push(m[1]);
    }
  };

  if (cfg?.profileDir) consider(cfg.profileDir);
  consider(process.env.DSH_PROFILE_DIR);

  const home = process.env.DSH_HOME;
  const profile = process.env.DSH_PROFILE;
  if (home && profile) consider(join(home, 'profiles', profile));

  try {
    for (const entry of ctx?.loader?.entries?.() ?? []) consider(entry?.parent?.tree?.ctx?.baseUrl);
  } catch {
    /* loader 不可用时跳过 */
  }
  try {
    consider(ctx?.baseUrl);
  } catch {
    /* ignore */
  }
  // 宿主命令行里带着 profile 绝对路径，是最后一个不依赖服务的兜底。
  try {
    for (const arg of process.argv ?? []) consider(String(arg));
  } catch {
    /* ignore */
  }
  try {
    consider(process.cwd());
  } catch {
    /* ignore */
  }

  if (home) {
    try {
      for (const nm of readdirSync(join(home, 'profiles'))) {
        const dir = join(home, 'profiles', nm);
        try {
          if (existsSync(join(dir, 'node_modules', cfg.packageName)) && !seen.has(dir)) {
            seen.add(dir);
            found.push(dir);
          }
        } catch {
          /* 单个目录读失败不影响其它 */
        }
      }
    } catch {
      /* profiles 目录不存在 */
    }
  }

  // 前面几条路可能来自「另一个 profile」，那里没装目标包 —— 过滤掉。
  return found.filter((d) => {
    try {
      return existsSync(join(d, 'node_modules', cfg.packageName));
    } catch {
      return false;
    }
  });
}

/**
 * 定位目标包里某个 lib 文件并返回它的 `file://` URL。
 *
 * 关键：这个 URL 必须与宿主 loader 解析出的那份**逐字一致**，否则 `import()`
 * 会新建一个模块实例，包装挂在没人用的那份上（表现为「插件说挂好了，但功能
 * 完全不生效」）。宿主从 profile 的 `node_modules` 解析，所以这里也走同一个路径。
 *
 * @returns {string|null} URL；找不到 profile 目录时返回 null。
 */
export function moduleUrl(ctx, cfg, fileName) {
  const dirs = resolveProfileDirs(ctx, cfg);
  if (dirs.length === 0) return null;
  return pathToFileURL(join(dirs[0], 'node_modules', cfg.packageName, 'lib', fileName)).href;
}

/**
 * 解析 profile 目录 + import 目标模块 + 取出指定导出类。
 *
 * 把「探测 → import → 取类 → 拿 prototype」这套四步收成一次调用：四个模块都
 * 要干这件事，出错信息也要统一。
 *
 * @returns {Promise<{ok: true, klass: Function, proto: object, url: string, profileDir: string}
 *   | {ok: false, error: string, url?: string}>}
 */
export async function loadTargetClass(ctx, cfg, fileName, exportName) {
  const dirs = resolveProfileDirs(ctx, cfg);
  if (dirs.length === 0) {
    return { ok: false, error: `未找到含 ${cfg.packageName} 的 profile 目录` };
  }
  const url = pathToFileURL(join(dirs[0], 'node_modules', cfg.packageName, 'lib', fileName)).href;
  let mod;
  try {
    mod = await import(url);
  } catch (error) {
    return { ok: false, error: `import ${fileName} 失败: ${describeThrown(error)}`, url };
  }
  const klass = mod?.[exportName];
  if (typeof klass !== 'function') {
    return { ok: false, error: `${fileName} 未导出 ${exportName}`, url };
  }
  return { ok: true, klass, proto: klass.prototype, url, profileDir: dirs[0] };
}

/** 一行文本化一个抛出的值（Error 取 message，其它 String()）。 */
export function describeThrown(error) {
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}
