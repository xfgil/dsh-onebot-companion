/**
 * dsh-onebot-companion / core/http.js
 *
 * 统一的 HTTP 观测面。
 *
 * 合并前三个插件各写了一份**几乎逐字相同**的 handler（loopback 判定、JSON 头、
 * 前缀剥离、body 解析、404 兜底，约 30 行）。现在只有一份，各模块只提供自己的
 * 端点处理器。
 *
 * ## 两个必须自己处理的坑（都实测过）
 *
 * 1. **前缀不会自动剥掉**：宿主用 `register({kind:'prefix', path:'/dsh-onebot-companion'})`
 *    挂载后，handler 拿到的 `url.pathname` 仍然带着前缀。不剥就会全部落进 404。
 * 2. **只允许 loopback**：这些端点能改运行时配置（toggle/reset），不能对外网开。
 *    判定覆盖 `::1`、`127.*`、`::ffff:127.*` 与字面量 `localhost`。
 *
 * @module dsh-onebot-companion/core/http
 */

/** 这个连接是不是来自本机。 */
export function isLoopback(req) {
  const remote = req?.socket?.remoteAddress ?? '';
  return (
    remote === '::1' ||
    remote.startsWith('127.') ||
    remote === 'localhost' ||
    /^::ffff:127\./.test(remote)
  );
}

/** 读完请求体并尽力解析成 JSON（解析失败给空对象，不抛）。 */
export async function readJsonBody(req) {
  let body = '';
  try {
    for await (const chunk of req) body += chunk;
  } catch {
    return {};
  }
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 组装一个 `webServer` 用的 handler。
 *
 * @param {object} options
 * @param {string} options.prefix - 挂载前缀，如 `/dsh-onebot-companion`。
 * @param {() => object} options.status - 返回状态对象（`GET <prefix>`）。
 * @param {Record<string, (payload: object, url: URL) => any>} [options.posts]
 *   POST 端点：键是相对路径（`/toggle`），值是处理器；返回 `undefined` 表示
 *   未处理（继续往下找，最后 404）。
 * @param {Record<string, (url: URL) => any>} [options.gets] - GET 端点，同上。
 * @param {string[]} [options.corsPaths] - 允许跨源读取的 GET 路径（如 `/physical`）。
 *   给本地 `file://` 打开的「体检表」页面用：`file://` 的 origin 是 `null`，
 *   浏览器默认会拦掉 fetch 回环端点的响应，必须显式放行。
 * @param {object} [options.log]
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler({ prefix, status, posts = {}, gets = {}, corsPaths = [], log }) {
  const cors = new Set(Array.isArray(corsPaths) ? corsPaths : []);
  return async function handler(req, res) {
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (!isLoopback(req)) {
      res.statusCode = 403;
      res.end(JSON.stringify({ ok: false, reason: 'loopback only' }));
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, reason: 'bad url' }));
      return;
    }

    // 宿主按 kind:'prefix' 挂载，pathname 仍带前缀 —— 自行剥离。
    const path = (url.pathname ?? '/').replace(new RegExp(`^${prefix}`), '') || '/';

    // CORS 只给**明确列出**的路径，且只给 GET：这些端点里也有能改运行时配置的
    // POST（toggle/reset），一律开放等于把控制面交给任意网页。
    if (cors.has(path)) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
    }

    try {
      if (req.method === 'OPTIONS' && cors.has(path)) {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'POST') {
        const payload = await readJsonBody(req);
        const fn = posts[path];
        if (typeof fn === 'function') {
          const out = await fn(payload, url);
          if (out !== undefined) {
            res.end(JSON.stringify(out, null, 2));
            return;
          }
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ ok: false, reason: 'unknown action', path }));
        return;
      }

      const fn = gets[path];
      if (typeof fn === 'function') {
        res.end(JSON.stringify(await fn(url), null, 2));
        return;
      }
      if (path === '/' || path === '/status') {
        res.end(JSON.stringify(await status(), null, 2));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, reason: 'not found', path }));
    } catch (error) {
      try {
        log?.('warn', `[onebot-companion] HTTP ${path} 处理失败: ${error?.message ?? error}`);
      } catch {
        /* ignore */
      }
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, reason: String(error?.message ?? error) }));
    }
  };
}

/**
 * 注册观测面到 `webServer` 服务。
 *
 * 用 `inject(['webServer'])` 而不是硬依赖：宿主没这个服务时插件照样能用，只是
 * 少了观测面。`webCtx.effect` 保证插件卸载时自动注销路由。
 *
 * @returns {boolean} 是否注册成功（webServer 服务不存在时 false）。
 */
export function registerHttp(ctx, options) {
  const { prefix, handler } = options;
  let registered = false;
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: prefix, handler }),
        'onebot-companion: http',
      );
      registered = true;
    });
  } catch {
    /* 没有 webServer 服务：跳过观测面 */
  }
  return registered;
}
