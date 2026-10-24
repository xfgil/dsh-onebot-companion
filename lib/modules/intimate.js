/**
 * intimate —— 让她真的能「接住」QQ 亲密关系邀请。
 *
 * ## 为什么单开一个模块（2026-10-19）
 *
 * 起因是一次真实的翻车：示例用户把「和我成为情侣」的卡片发过来，云玥在 reasoning
 * 里明明写着「无法真的点开操作（需要登录）」，正文却输出「已经点开了」这类确认。
 * 用户随后追问「没办法给她加个手吗」——他要的不是更漂亮的措辞，是**这件事真能做**。
 *
 * ## 这条链路是怎么挖出来的
 *
 * NapCat 的 OneBot 动作表里**没有任何**亲密关系接口（`intimate` / `亲密` / `情侣`
 * 在 napcat.mjs 里 0 命中），所以这不是「调个 API」的事。真正的入口在
 * `https://ti.qq.com/hybrid-h5/intimate/list` 这个 H5 的 bundle 里，它通过 oidb
 * 私有协议走 dcapi 网关：
 *
 * | 用途 | 端点 | body |
 * | --- | --- | --- |
 * | 查已绑定的关系 | `https://ti.qq.com/proxy/domain/oidb.tim.qq.com/v3/oidbinterface/oidb_0xd00_1` | `{"sub_cmd":2}` |
 * | 发起 / 接受 / 解除 | `https://ti.qq.com/proxy/domain/oidb.tim.qq.com/v3/oidbinterface/oidb_0xcf3_1` | `{"sub_cmd":0\|1\|2,"target_uin":N,"intimate_type":T,"source":0}` |
 * | 查待处理邀请 | `https://ti.qq.com/intimate/api/json/love_pair/getPairState` | `{"req_comm":{"opuin":U,"uin":U},"check_qqfriend":true}` |
 *
 * `sub_cmd` 的语义是从 bundle 的 `launchNotLoverFunc`（0）/ `unbindNotLoverFunc`（2）
 * 反推的，1 是「接受」，实测确认（见下）。
 *
 * `intimate_type`：`1`=情侣、`2`=闺蜜、`3`=基友、`26`=死党。注意 bundle 里
 * `launchNotLover` 对 2/3/26 还额外查了「名额满了没」，情侣走另一条路（`launchLover`）。
 *
 * ## 认证
 *
 * 走的是**她自己**的登录态：`get_cookies` 这个 OneBot action 能拿到
 * `pt4_token` / `p_skey` / `skey` 与 `bkn`（csrf token），把它们塞进 Cookie 头
 * 直接请求 ti.qq.com 即可。实测 `get_cookies({domain:'ti.qq.com'})` 返回
 * `bkn=538165189`，用这组 cookie 打 oidb 返回 `ErrorCode:0`。
 *
 * ## 副作用（写清楚，免得以后又忘）
 *
 * - `sub_cmd:1` 是**真的会建立关系**的，不是「发个邀请」。反过来 `sub_cmd:0`
 *   才是发起邀请。2026-10-19 我就是用 sub_cmd:1 对 100000001 实测的
 *   （先绑上、再 `sub_cmd:2` 解绑），所以这一步必须走审批闸。
 * - oidb 返回 `ActionStatus:"FAIL"` 时不一定真失败——比如对已绑定的好友再绑，
 *   会返回 `10006 你和该好友已经绑定亲密关系`，这其实说明「已经成了」。
 */

import { describeThrown } from '../core/profile.js';

export const MODULE_ID = 'intimate';

/** 亲密度类型：数字是 oidb 里的 `intimate_type`。 */
export const INTIMATE_TYPES = {
  lover: 1,
  ladybro: 2,
  buddy: 3,
  bestfriend: 26,
};

/** 数字 / 英文 / 中文三种写法都能认。 */
export const TYPE_ALIASES = {
  1: 1,
  2: 2,
  3: 3,
  26: 26,
  lover: 1,
  情侣: 1,
  恋人: 1,
  ladybro: 2,
  闺蜜: 2,
  buddy: 3,
  基友: 3,
  bestfriend: 26,
  死党: 26,
};

/** 类型 → 中文名（写进审批单与回执）。 */
export const TYPE_NAMES = { 1: '情侣', 2: '闺蜜', 3: '基友', 26: '死党' };

/** 把各种写法归一成 oidb 的 `intimate_type`。认不出返回 null。 */
export function resolveIntimateType(raw) {
  if (raw === undefined || raw === null || raw === '') return 1;
  const key = String(raw).trim().toLowerCase();
  const hit = TYPE_ALIASES[key] ?? TYPE_ALIASES[String(raw).trim()];
  return hit ?? null;
}

/** oidb 的 ErrorCode → 人话。没收录的原样返回后端文案。 */
export function describeIntimateError(code, info) {
  const text = typeof info === 'string' ? info : '';
  if (code === 0) return '';
  if (code === 10001) return '不能和自己绑亲密关系';
  if (code === 10006) return '你们已经绑定过了';
  if (code === 10007) return '你们还不是好友，加了好友才能绑';
  if (text !== '') return text;
  return `后端返回错误码 ${code}`;
}

/** 从 `getPairState` 的 `lst_invite` 里挑出待处理邀请。 */
export function normalizeInvites(data) {
  const list = Array.isArray(data?.lst_invite) ? data.lst_invite : [];
  return list.map((item) => ({
    userId: String(item?.frd_uin ?? item?.uin ?? ''),
    type: Number(item?.intimate_type ?? 1),
    typeName: TYPE_NAMES[Number(item?.intimate_type ?? 1)] ?? '亲密关系',
    at: Number(item?.time ?? 0),
  }));
}

/** 从 `oidb_0xd00_1` 的 `intimate_list` 里挑出已绑定的关系。 */
export function normalizeBonds(data) {
  const list = Array.isArray(data?.intimate_list) ? data.intimate_list : [];
  const out = [];
  for (const item of list) {
    const uin = String(item?.frd_uin ?? '');
    if (uin === '') continue;
    const kind = item?.lover
      ? 1
      : item?.ladybro
        ? 2
        : item?.buddy
          ? 3
          : item?.bestfriend
            ? 26
            : 0;
    out.push({ userId: uin, type: kind, typeName: TYPE_NAMES[kind] ?? '亲密关系' });
  }
  return out;
}

/**
 * 造一个 intimate 能力对象。
 *
 * @param {{callAction: (action: string, params: object) => Promise<any>, cfg?: object, stats?: object, log?: Function}} deps
 */
export function createIntimate({ callAction, cfg, stats, log }) {
  const cookieTtlMs = Number(cfg?.cookieTtlMs) > 0 ? Number(cfg.cookieTtlMs) : 600_000;
  let cached = null;

  /** 子能力总开关：hands.intimate.enabled 为 false 时彻底不联网。 */
  function ensureEnabled() {
    if (cfg?.enabled === false) throw new Error('亲密关系能力已关闭（hands.intimate.enabled=false）');
  }

  /** 拿她自己 ti.qq.com 的登录态（含 bkn）。有缓存，10 分钟一换。 */
  async function credentials(force = false) {
    if (!force && cached !== null && Date.now() - cached.at < cookieTtlMs) return cached;
    const data = await callAction('get_cookies', { domain: 'ti.qq.com' });
    const cookies = String(data?.cookies ?? '');
    const bkn = String(data?.bkn ?? '');
    if (cookies === '') throw new Error('拿不到 ti.qq.com 的登录态（get_cookies 返回空）');
    cached = { cookies, bkn, at: Date.now() };
    stats.intimateCookieAt = cached.at;
    return cached;
  }

  /** 统一发一个请求；失败重取一次 cookie（skey 过期很常见）。 */
  async function request(url, body, retried = false) {
    const cred = await credentials(retried);
    const headers = {
      Cookie: cred.cookies,
      'Content-Type': 'application/json',
      Referer: 'https://ti.qq.com/',
      Origin: 'https://ti.qq.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/140.0.0.0 Safari/537.36',
    };
    const full = cred.bkn === '' ? url : `${url}${url.includes('?') ? '&' : '?'}bkn=${encodeURIComponent(cred.bkn)}`;
    const res = await fetch(full, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      if (!retried) {
        cached = null;
        return request(url, body, true);
      }
      throw new Error(`登录态失效（HTTP ${res.status}），需要她在 QQ 里重新登录`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`返回不是 JSON：${text.slice(0, 200)}`);
    }
  }

  /** 查：待处理邀请 + 已绑定的关系。 */
  async function list() {
    ensureEnabled();
    const out = { invites: [], bonds: [], errors: [] };
    let selfUin = 0;
    try {
      const me = await callAction('get_login_info', {});
      selfUin = Number(me?.user_id ?? 0);
    } catch {
      /* 拿不到就退化成 0，服务端会按登录态覆盖 */
    }
    try {
      const state = await request(
        'https://ti.qq.com/intimate/api/json/love_pair/getPairState',
        { req_comm: { opuin: selfUin, uin: selfUin }, check_qqfriend: true },
      );
      out.invites = normalizeInvites(state?.data);
      out.isFriend = state?.data?.is_qqfriend === true;
    } catch (error) {
      out.errors.push(`getPairState: ${describeThrown(error)}`);
    }
    try {
      // 必须走 ti.qq.com 的 proxy 域名：直连 `http://oidb.tim.qq.com` 会被后端
      // 判成「error login sig」（ErrorCode 151），代理网关会帮着补签名。
      const bonds = await request(
        'https://ti.qq.com/proxy/domain/oidb.tim.qq.com/v3/oidbinterface/oidb_0xd00_1?sdkappid=39998&actype=2',
        { sub_cmd: 2 },
      );
      out.bonds = normalizeBonds(bonds);
      if (Number(bonds?.ErrorCode) !== 0) {
        out.errors.push(`oidb_0xd00_1: ${describeIntimateError(Number(bonds?.ErrorCode), bonds?.ErrorInfo)}`);
      }
    } catch (error) {
      out.errors.push(`oidb_0xd00_1: ${describeThrown(error)}`);
    }
    stats.intimateLists = (stats.intimateLists ?? 0) + 1;
    return out;
  }

  /**
   * 接受 / 发起 / 解除。
   *
   * @param {string} userId - 对方 QQ 号。
   * @param {number} type - `intimate_type`。
   * @param {'accept'|'launch'|'release'} mode
   */
  async function respond(userId, type, mode = 'accept') {
    ensureEnabled();
    const uin = Number(String(userId).trim());
    if (!Number.isInteger(uin) || uin <= 0) throw new Error(`对方 QQ 号不对：${String(userId)}`);
    const subCmd = mode === 'launch' ? 0 : mode === 'release' ? 2 : 1;
    const data = await request(
      'https://ti.qq.com/proxy/domain/oidb.tim.qq.com/v3/oidbinterface/oidb_0xcf3_1?sdkappid=39998&actype=2',
      { sub_cmd: subCmd, target_uin: uin, intimate_type: type, source: 0 },
    );
    const code = Number(data?.ErrorCode);
    const ok = code === 0 || code === 10006; // 10006 = 已经绑上了，对「接受」来说等于成功
    stats.intimateCalls = (stats.intimateCalls ?? 0) + 1;
    stats.intimateLast = { userId: uin, type, mode, code, at: Date.now() };
    if (!ok) {
      const message = describeIntimateError(code, data?.ErrorInfo);
      stats.intimateLastError = message;
      throw new Error(message);
    }
    return {
      ok: true,
      userId: uin,
      type,
      typeName: TYPE_NAMES[type] ?? '亲密关系',
      mode,
      already: code === 10006,
    };
  }

  return {
    MODULE_ID,
    list,
    respond,
    credentials,
    /** 自测用：注入 fetch 之外的依赖后重置缓存。 */
    reset: () => {
      cached = null;
    },
  };
}

/** 本模块默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** 登录态缓存时长（毫秒）。 */
  cookieTtlMs: 600_000,
  /** 走审批闸（关掉就意味着她自己点同意就能成，不建议）。 */
  requireApproval: true,
};
