/**
 * hands —— 给云玥一双「社交的手」。
 *
 * ## 为什么需要这个模块（2026-10-19）
 *
 * 当时提的需求：能不能给她加个手。此前的 `ability` 规则把她的边界写死成
 * 「你只有嘴，没有手」—— 那是对**当时**能力的如实描述：除了发文字、表情、语音，
 * 她什么都做不了。但 OneBot/NapCat 其实给了不少安全的社交动作（戳一戳、名片赞、
 * 给消息贴表情回应），这些不需要任何审批、也伤不到人，白白不用很浪费。
 *
 * 对「加好友 / 加群」的要求：**要经审批，自己拉进去的除外**。
 * 所以：
 *
 * - **戳 / 赞 / 贴表情**：直接给她，随时能用（群里被别人要求戳一下也无所谓）；
 * - **同意好友申请 / 同意入群邀请**：她自己按不下去。调用只会生成一张
 *   **审批单**发给示例用户（私聊），示例用户回 `/同意 编号` 才真正执行。
 *   「我拉的除外」体现在：群邀请如果发起人本来就是管理员，直接放行、不走审批。
 *
 * ## 审批为什么要绕一圈 QQ 私聊
 *
 * 因为这是**唯一的硬闸**。如果让模型自己「确认一下再调」，那只是提示词层面的
 * 自觉，它完全可以在 reasoning 里写「我知道要审批」然后照样直接调 —— 这个会话
 * 里已经发生过一模一样的事（亲密关系那段：reasoning 明写「没法真的点开」，正文
 * 却输出「已经点开了」）。所以真正的把关必须在代码里：`authorizations` 只由
 * **管理员本人在私聊里说的那句命令**写入，模型无论怎么调用工具都写不进去。
 *
 * ## 与其它模块的关系
 *
 * - `isolation` 决定哪些工具在「群友说话的那一轮」可用；本模块把 `qq_poke`
 *   / `qq_react` / `qq_like` 加进它的白名单（见 `index.js` 的 `ALLOWED_TOOLS`）。
 * - 审批命令的拦截挂在与 `linkcard` / `emoji` 同一层
 *   （`InboundPipeline.prototype.processInbound`）：在消息被投给模型**之前**先看
 *   一眼，命中命令就直接执行并吞掉，模型根本看不到这条消息 —— 不然她会给
 *   「/同意 a3f9」回一句「好呀」，那画面很怪。
 */

import { describeThrown, loadTargetClass } from '../core/profile.js';
import { createIntimate, resolveIntimateType, TYPE_NAMES, DEFAULTS as INTIMATE_DEFAULTS } from './intimate.js';

export const MODULE_ID = 'hands';

/** 挂载目标：与 linkcard / emoji-media 同一层。 */
const TARGET = { file: 'inbound.js', exportName: 'InboundPipeline' };

const METHODS = ['processInbound'];

/** 审批编号的长度（够短、好念，又不容易撞）。 */
const CODE_LENGTH = 4;

/** 编号字母表：去掉 0/O/1/I/l 这些容易看错的。 */
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * QQ 表情回应（`set_msg_emoji_like`）的常用 id。
 *
 * 这套 id 和「QQ 原生表情」的 face id **不是同一套**（后者见 `faces.js` 的
 * 329 条表），是 QQ 侧「表情回应」专用的编号。表里只放最常用的几个，
 * 认不出来的就直接把数字透传给 NapCat —— 传错只会得到一条报错，不会误伤。
 */
export const REACT_PRESETS = {
  赞: '76',
  点赞: '76',
  赞一个: '76',
  ok: '76',
  笑: '178',
  笑哭: '178',
  大笑: '178',
  666: '181',
  鼓掌: '182',
  比心: '200',
  爱心: '200',
  哭: '5',
  委屈: '5',
  惊讶: '14',
  疑问: '32',
  问号: '32',
};

/** 把「赞 / 76 / 128077」都归一成一个字符串 id。认不出就返回 null。 */
export function resolveReactId(raw) {
  if (raw === undefined || raw === null || raw === '') return '76';
  const text = String(raw).trim();
  if (/^\d{1,6}$/.test(text)) return text;
  const hit = REACT_PRESETS[text] ?? REACT_PRESETS[text.toLowerCase()];
  return hit ?? null;
}

/** 审批命令：`/同意 a3f9`、`/拒绝 a3f9`、`/批准 a3f9`。 */
const APPROVE_RE = /^[/／](同意|通过|批准|approve|ok)\s+([a-zA-Z0-9]{2,8})\s*$/;
const DENY_RE = /^[/／](拒绝|驳回|deny|no)\s+([a-zA-Z0-9]{2,8})\s*$/;

/**
 * 解析一条审批命令。
 *
 * @param {string} text - 消息正文。
 * @returns {{approve: boolean, code: string}|null}
 */
export function parseApprovalCommand(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  let m = APPROVE_RE.exec(trimmed);
  if (m !== null) return { approve: true, code: m[2].toLowerCase() };
  m = DENY_RE.exec(trimmed);
  if (m !== null) return { approve: false, code: m[2].toLowerCase() };
  return null;
}

/** 生成一个审批编号。 */
export function makeCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)] ?? 'a';
  }
  return out;
}

/**
 * 从 `get_group_system_msg` 的返回里挑出待处理的邀请 / 申请。
 *
 * NapCat 把两类混在一个响应里：`invited_requests` 是「有人邀请她进群」，
 * `join_requests` 是「有人申请进她的群」。两者语义相反，审批时
 * `set_group_add_request` 的 `sub_type` 也不同（`invite` / `add`）。
 *
 * @param {object} data - action 返回的 data。
 * @returns {Array<object>} 归一化后的清单。
 */
export function normalizeGroupRequests(data) {
  const out = [];
  const push = (item, kind) => {
    if (item === null || typeof item !== 'object') return;
    const flag = item.flag ?? item.request_id ?? item.seq;
    if (flag === undefined || flag === null) return;
    out.push({
      kind: 'group',
      subType: kind,
      flag: String(flag),
      groupId: String(item.group_id ?? item.groupId ?? item.group?.group_id ?? ''),
      groupName: String(item.group_name ?? item.groupName ?? item.group?.group_name ?? ''),
      userId: String(item.invitor_uin ?? item.invitorUin ?? item.requester_uin ?? item.requesterUin ?? item.user_id ?? ''),
      nickname: String(item.invitor_nick ?? item.requester_nick ?? item.nickname ?? ''),
      message: String(item.message ?? item.comment ?? ''),
    });
  };
  for (const item of data?.invited_requests ?? data?.InvitedRequest ?? []) push(item, 'invite');
  for (const item of data?.join_requests ?? data?.JoinRequest ?? []) push(item, 'add');
  return out;
}

/**
 * 归一化 `get_doubt_friends_add_request` 的返回。
 *
 * 这个接口直接给一个数组（不是 `{list: []}` 那种壳），每项有 `flag` 与
 * `uin`/`nick`/`msg`。字段名在 NapCat 版本间换过，所以按候选键名逐个试。
 *
 * @param {any} data - action 返回的 data。
 * @returns {Array<object>}
 */
export function normalizeFriendRequests(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : Array.isArray(data?.requests) ? data.requests : [];
  const out = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const flag = item.flag ?? item.request_id ?? item.seq;
    if (flag === undefined || flag === null) continue;
    out.push({
      kind: 'friend',
      subType: 'add',
      flag: String(flag),
      userId: String(item.uin ?? item.user_id ?? item.requester_uin ?? item.invitor_uin ?? ''),
      nickname: String(item.nick ?? item.nickname ?? item.name ?? ''),
      message: String(item.msg ?? item.message ?? ''),
    });
  }
  return out;
}

/** 一句话描述一个待批项，用来拼审批消息。 */
export function describeRequest(item) {
  const who = item.nickname !== '' ? item.nickname : item.userId !== '' ? item.userId : '某人';
  if (item.kind === 'intimate') {
    const tname = TYPE_NAMES[Number(item.intimateType)] ?? '亲密关系';
    return `${who}（${item.userId || '?'}）要和我建立「${tname}」关系`;
  }
  if (item.kind === 'friend') {
    const tail = item.message !== '' ? `，留言「${item.message}」` : '';
    return `${who}（${item.userId || '?'}）想加我好友${tail}`;
  }
  const gname = item.groupName !== '' ? item.groupName : item.groupId;
  if (item.subType === 'invite') {
    return `${who}（${item.userId || '?'}）邀请我进群「${gname}」（${item.groupId}）`;
  }
  return `${who}（${item.userId || '?'}）申请加入群「${gname}」（${item.groupId}）`;
}

/**
 * 造一个 hands 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - hands 段配置。
 * @param {object} options.stats - 共享统计。
 * @param {(level: string, message: string) => void} options.log
 * @param {() => *} options.getReceiver - 取 ChatBridge 实例（persona 的 lastReceiver）。
 * @param {() => string[]} options.adminUsers - 取管理员号（实时读 bridge 配置）。
 * @param {Function} options.patchMethod - `core/patch.js` 的 patchMethod。
 * @param {(chatId: string, text: string) => Promise<*>) } [options.sendText] - 发文字。
 *   默认走 bridge 的 `sendToChat`。
 */
export function createHands({ cfg, stats, log, getReceiver, adminUsers, patchMethod, sendText }) {
  /** chatId → 最近一条入站消息的 message_id（贴表情要用）。 */
  const lastMessage = new Map();

  /** 编号 → 待批项。只在内存里，重启即失效（避免拿着旧单子乱批）。 */
  const pending = new Map();

  /** 管理员已批准的授权：`kind:flag` → {approve, at}。 */
  const authorizations = new Map();

  const adminsNow = () => {
    try {
      const fromBridge = adminUsers?.();
      if (Array.isArray(fromBridge) && fromBridge.length > 0) return fromBridge.map((q) => String(q));
    } catch {
      /* 读配置失败就用兜底 */
    }
    const fallback = cfg?.adminUsers;
    return Array.isArray(fallback) ? fallback.map((q) => String(q)) : [];
  };

  const adminChatId = () => {
    const first = adminsNow()[0];
    return first === undefined ? '' : `private:${first}`;
  };

  /** 取底层 connection（`bridge.deps.connection`），没有就退到 `guardedConnectionCall`。 */
  function connectionOf(bridge) {
    const conn = bridge?.deps?.connection;
    if (conn !== undefined && typeof conn.call === 'function') return conn;
    return undefined;
  }

  /**
   * 调一个 OneBot action。
   *
   * 优先走底层 `connection.call`（不经过 inject 拦截，因为审批和戳一戳都不是
   * 「回合内回复」），退路是 `guardedConnectionCall`（受 inject 影响但能用）。
   */
  async function callAction(action, params) {
    const bridge = getReceiver?.();
    if (bridge === undefined || bridge === null) {
      throw new Error('QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试');
    }
    const conn = connectionOf(bridge);
    if (conn !== undefined) return conn.call(action, params);
    if (typeof bridge.guardedConnectionCall === 'function') {
      return bridge.guardedConnectionCall(action, params);
    }
    throw new Error('拿不到 OneBot 连接（bridge.deps.connection 缺失）');
  }

  /** 亲密关系能力（走 ti.qq.com 的 oidb 私有协议，见 modules/intimate.js）。 */
  const intimate = createIntimate({ callAction, cfg: cfg?.intimate, stats, log });

  /** 发一条文字消息（审批回执、通知）。 */
  async function say(chatId, text) {
    if (typeof sendText === 'function') return sendText(chatId, text);
    const bridge = getReceiver?.();
    if (bridge === undefined || typeof bridge.sendToChat !== 'function') {
      throw new Error('QQ 通道尚未就绪，发不出通知');
    }
    return bridge.sendToChat(chatId, text);
  }

  /** 清理过期审批单。 */
  function sweep() {
    const ttl = Number(cfg?.approveTtlMs) > 0 ? Number(cfg.approveTtlMs) : 1_800_000;
    const now = Date.now();
    for (const [code, item] of pending) {
      if (now - item.createdAt > ttl) pending.delete(code);
    }
    for (const [key, item] of authorizations) {
      if (now - item.at > ttl) authorizations.delete(key);
    }
    stats.handsPending = pending.size;
  }

  /** 列出待处理的申请（只读）。 */
  async function listRequests() {
    const out = { friends: [], groups: [], errors: [] };
    try {
      out.friends = normalizeFriendRequests(await callAction('get_doubt_friends_add_request', {}));
    } catch (error) {
      out.errors.push(`get_doubt_friends_add_request: ${describeThrown(error)}`);
    }
    try {
      out.groups = normalizeGroupRequests(await callAction('get_group_system_msg', {}));
    } catch (error) {
      out.errors.push(`get_group_system_msg: ${describeThrown(error)}`);
    }
    stats.handsListed = (stats.handsListed ?? 0) + 1;
    stats.handsLastList = {
      friends: out.friends.length,
      groups: out.groups.length,
      at: Date.now(),
    };
    return out;
  }

  /**
   * 查亲密关系：待处理邀请 + 已绑定的关系。
   *
   * 与 `listRequests` 分开是因为数据来源完全不同（一个走 OneBot action，
   * 一个走 ti.qq.com 的 oidb 私有协议），合起来报错时分不清是哪边挂了。
   */
  async function listIntimate() {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    const out = await intimate.list();
    stats.handsIntimateListed = (stats.handsIntimateListed ?? 0) + 1;
    return out;
  }

  /**
   * 戳一戳。
   *
   * @param {{user_id?: string, group_id?: string, chat_id?: string}} args
   */
  async function poke(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    const userId = String(args?.user_id ?? '').trim();
    const groupId = String(args?.group_id ?? '').trim();
    if (userId === '' && groupId === '') throw new Error('要戳谁？请给 user_id（群里还要给 group_id）');
    const params = {};
    if (userId !== '') params.user_id = userId;
    if (groupId !== '') params.group_id = groupId;
    await callAction('send_poke', params);
    stats.handsPokes = (stats.handsPokes ?? 0) + 1;
    stats.handsLastPoke = { user_id: userId, group_id: groupId, at: Date.now() };
    return { ok: true, user_id: userId, group_id: groupId };
  }

  /**
   * 给某条消息贴表情回应。
   *
   * @param {{message_id?: string, emoji_id?: string, chat_id?: string}} args
   */
  async function react(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    const chatId = String(args?.chat_id ?? '').trim();
    let messageId = args?.message_id === undefined || args?.message_id === null ? '' : String(args.message_id).trim();
    if (messageId === '' && chatId !== '') {
      messageId = String(lastMessage.get(chatId)?.messageId ?? '');
    }
    if (messageId === '') {
      throw new Error('不知道给哪条消息贴表情：请给 message_id，或在有上下文时省略（会用当前会话最近一条）');
    }
    const emojiId = resolveReactId(args?.emoji_id);
    if (emojiId === null) throw new Error(`认不出的表情名：${String(args?.emoji_id)}`);
    await callAction('set_msg_emoji_like', { message_id: messageId, emoji_id: emojiId, set: true });
    stats.handsReacts = (stats.handsReacts ?? 0) + 1;
    stats.handsLastReact = { message_id: messageId, emoji_id: emojiId, at: Date.now() };
    return { ok: true, message_id: messageId, emoji_id: emojiId };
  }

  /** 给某人的名片点赞（`send_like`，一天有次数上限，NapCat 会自己报错）。 */
  async function like(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    const userId = String(args?.user_id ?? '').trim();
    if (userId === '') throw new Error('要给谁点赞？请给 user_id');
    const times = Math.min(10, Math.max(1, Number(args?.times) || 1));
    await callAction('send_like', { user_id: userId, times });
    stats.handsLikes = (stats.handsLikes ?? 0) + 1;
    stats.handsLastLike = { user_id: userId, times, at: Date.now() };
    return { ok: true, user_id: userId, times };
  }

  /**
   * 改自己的 QQ 昵称。
   *
   * 走 `set_qq_profile`（Go-CQHTTP 兼容接口）。它要求 nickname 必填，个性签名与性别
   * 可选——省略时 NapCat 会自己读一遍当前资料再原样回填（见 napcat.mjs 的
   * `_handle`：`longNick: (e?.personal_note ?? r?.longNick) || ""`），所以只改名不会
   * 把签名冲掉。
   *
   * 用户口径（2026-10-19）：「可以自己改QQ名，改签名，这些不用我审批」——
   * 改的是她自己的资料，不打扰任何人，所以**不过审批闸**。
   */
  async function setNickname(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    if (cfg?.allowSelfProfile === false) throw new Error('改资料被关掉了（hands.allowSelfProfile）');
    const nickname = String(args?.nickname ?? '').trim();
    if (nickname === '') throw new Error('要改成什么名字？请给 nickname');
    if (Array.from(nickname).length > 24) throw new Error(`名字太长了（${Array.from(nickname).length} 字，上限 24）`);
    await callAction('set_qq_profile', { nickname });
    stats.handsNicknames = (stats.handsNicknames ?? 0) + 1;
    stats.handsLastNickname = { nickname, at: Date.now() };
    return { ok: true, nickname };
  }

  /**
   * 改自己的个性签名。
   *
   * 走 `set_self_longnick`（NapCat 扩展接口，payload 只有 `longNick` 一个字段）。
   * 同 `setNickname`：改的是自己的资料，不审批。
   */
  async function setSignature(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    if (cfg?.allowSelfProfile === false) throw new Error('改资料被关掉了（hands.allowSelfProfile）');
    const text = String(args?.text ?? args?.signature ?? '').trim();
    if (Array.from(text).length > 80) throw new Error(`签名太长了（${Array.from(text).length} 字，上限 80）`);
    await callAction('set_self_longnick', { longNick: text });
    stats.handsSignatures = (stats.handsSignatures ?? 0) + 1;
    stats.handsLastSignature = { text, at: Date.now() };
    return { ok: true, text };
  }

  /** 读自己的资料（`get_stranger_info` 查自己，用来核对改没改成）。 */
  async function readProfile() {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    const info = await callAction('get_login_info', {});
    const uin = String(info?.user_id ?? '');
    if (uin === '') throw new Error('拿不到自己的 QQ 号');
    const detail = await callAction('get_stranger_info', { user_id: uin });
    return {
      ok: true,
      user_id: uin,
      nickname: String(detail?.nick ?? detail?.nickname ?? info?.nickname ?? ''),
      signature: String(detail?.longNick ?? ''),
    };
  }

  /** 真正执行一次「同意/拒绝申请」。 */
  async function execute(item, approve) {
    if (item.kind === 'intimate') {
      if (!approve) {
        // 「拒绝亲密关系邀请」没有服务端接口（oidb 只有 launch/accept/release），
        // 只能不理会。这里不做任何调用，直接把结果告诉她。
        return;
      }
      const mode = item.mode === 'launch' ? 'launch' : item.mode === 'release' ? 'release' : 'accept';
      await intimate.respond(item.userId, Number(item.intimateType) || 1, mode);
      return;
    }
    if (item.kind === 'friend') {
      await callAction('set_doubt_friends_add_request', { flag: item.flag, approve });
      return;
    }
    await callAction('set_group_add_request', {
      flag: item.flag,
      sub_type: item.subType === 'invite' ? 'invite' : 'add',
      approve,
      reason: approve ? ' ' : ' ',
    });
  }

  /**
   * 申请执行一条审批动作。
   *
   * 两条放行路径：
   *   ① 已有管理员授权（`/同意 <编号>` 写进来的）；
   *   ② 「我拉的除外」—— 群邀请的发起人本身就是管理员。
   *
   * 都不满足就生成审批单、发私聊通知，并把 `needsApproval` 还给模型。
   *
   * @param {{kind: 'friend'|'group', flag: string, approve: boolean, subType?: string, summary?: string}} args
   */
  async function approve(args) {
    if (cfg?.enabled === false) throw new Error('hands 模块已关闭');
    sweep();
    const kind =
      args?.kind === 'friend' ? 'friend' : args?.kind === 'group' ? 'group' : args?.kind === 'intimate' ? 'intimate' : null;
    if (kind === null) throw new Error('kind 只能是 friend、group 或 intimate');
    // 亲密关系没有 flag（它不是 QQ 的「申请」，是 oidb 邀请），用对方号兜一个。
    const flag =
      kind === 'intimate'
        ? `intimate:${String(args?.user_id ?? args?.userId ?? '').trim()}`
        : String(args?.flag ?? '').trim();
    if (flag === '' || (kind === 'intimate' && flag === 'intimate:')) {
      throw new Error(
        kind === 'intimate'
          ? '亲密关系要给 user_id（对方 QQ 号）'
          : '缺少 flag（先用 qq_requests 查，把返回里的 flag 原样带过来）',
      );
    }
    const wantApprove = args?.approve !== false;

    // 参数名两种风格都吃：工具 schema 对外用 OneBot 的下划线（`sub_type` /
    // `group_id`），内部字段用驼峰。少一次「传了但没生效」的排查。
    const pick = (...names) => {
      for (const n of names) {
        const v = args?.[n];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return undefined;
    };
    const item = {
      kind,
      subType: pick('sub_type', 'subType') === 'invite' ? 'invite' : 'add',
      flag,
      userId: String(pick('user_id', 'userId') ?? ''),
      nickname: String(pick('nickname', 'nick') ?? ''),
      groupId: String(pick('group_id', 'groupId') ?? ''),
      groupName: String(pick('group_name', 'groupName') ?? ''),
      message: String(pick('message', 'msg') ?? ''),
    };
    if (kind === 'intimate') {
      item.userId = flag.slice('intimate:'.length);
      item.intimateType = resolveIntimateType(pick('intimate_type', 'type')) ?? 1;
      const mode = String(pick('mode') ?? '').trim();
      item.mode = mode === 'launch' ? 'launch' : mode === 'release' ? 'release' : 'accept';
      item.nickname = String(pick('nickname', 'nick') ?? '');
    }
    const key = `${kind}:${flag}`;

    // ① 管理员已经批过
    const auth = authorizations.get(key);
    if (auth !== undefined) {
      authorizations.delete(key);
      await execute(item, wantApprove);
      stats.handsApproved = (stats.handsApproved ?? 0) + 1;
      return { ok: true, executed: true, kind, flag, approve: wantApprove };
    }

    // ② 我拉的除外：群邀请人就是管理员
    if (wantApprove && item.subType === 'invite' && cfg?.autoApproveAdminInvites !== false) {
      const admins = adminsNow();
      if (item.userId !== '' && admins.includes(item.userId)) {
        await execute(item, true);
        stats.handsAutoApproved = (stats.handsAutoApproved ?? 0) + 1;
        return { ok: true, executed: true, kind, flag, approve: true, auto: 'admin-invite' };
      }
    }

    // ③ 生成审批单
    const code = makeCode();
    pending.set(code, { ...item, code, createdAt: Date.now(), approve: wantApprove });
    stats.handsPending = pending.size;
    const summary = args?.summary !== '' && args?.summary !== undefined ? String(args.summary) : describeRequest(item);
    const verb = wantApprove ? '同意' : '拒绝';
    const chatId = adminChatId();
    let notified = false;
    if (chatId !== '') {
      try {
        await say(
          chatId,
          `【要你点头】${summary}\n我想${verb}这个。回 /${verb} ${code} 就是准了，回 /拒绝 ${code} 就是不办。`
            + `\n（编号 ${code}，半小时内有效）`,
        );
        notified = true;
      } catch (error) {
        stats.lastError = describeThrown(error);
        log?.('warn', `审批通知发送失败: ${stats.lastError}`);
      }
    }
    return {
      ok: false,
      needsApproval: true,
      code,
      notified,
      summary,
      hint: notified
        ? '已经问过示例用户了，等他回话。别自己再调一次，也别跟对方说「同意了」。'
        : '审批通知没发出去（QQ 通道可能没连上），先别答应对方。',
    };
  }

  /** 管理员回命令：把授权写进去。 */
  async function decide(code, approve) {
    sweep();
    const item = pending.get(code);
    if (item === undefined) return { ok: false, code, error: '没有这个编号（可能已过期或已处理）' };
    pending.delete(code);
    stats.handsPending = pending.size;
    if (!approve) {
      stats.handsDenied = (stats.handsDenied ?? 0) + 1;
      return { ok: true, code, denied: true, summary: describeRequest(item) };
    }
    try {
      await execute(item, true);
      stats.handsApproved = (stats.handsApproved ?? 0) + 1;
      return { ok: true, code, executed: true, summary: describeRequest(item) };
    } catch (error) {
      stats.lastError = describeThrown(error);
      // 执行失败就退回待批（还留着编号，让她能重来）
      pending.set(code, item);
      stats.handsPending = pending.size;
      return { ok: false, code, error: stats.lastError, summary: describeRequest(item) };
    }
  }

  /**
   * 入站拦截层。
   *
   * 只做两件事：记住 message_id（贴表情要用），以及吞掉管理员的审批命令。
   */
  function makeProcessInbound({ original }) {
    return async function companionHandsProcessInbound(inbound) {
      try {
        if (cfg?.enabled !== false) {
          const chatId = typeof inbound?.chatId === 'string' ? inbound.chatId : '';
          const messageId = inbound?.messageId;
          if (chatId !== '' && messageId !== undefined && messageId !== null) {
            lastMessage.set(chatId, { messageId: String(messageId), at: Date.now() });
            if (lastMessage.size > 200) {
              // 别无限长：丢掉最旧的一批
              const keys = [...lastMessage.keys()].slice(0, lastMessage.size - 200);
              for (const k of keys) lastMessage.delete(k);
            }
          }

          const cmd = parseApprovalCommand(inbound?.text);
          if (cmd !== null) {
            const userId = String(inbound?.userId ?? '');
            const admins = adminsNow();
            const fromAdmin = admins.includes(userId);
            const privateChat = chatId.startsWith('private:');
            if (fromAdmin && privateChat) {
              const result = await decide(cmd.code, cmd.approve);
              const reply = result.ok === false
                ? `没办成：${result.error ?? '未知原因'}`
                : result.denied === true
                  ? `行，${result.summary} —— 拒了。`
                  : `办好了：${result.summary}。`;
              stats.handsCommands = (stats.handsCommands ?? 0) + 1;
              say(adminChatId(), reply).catch((error) => {
                stats.lastError = describeThrown(error);
              });
              // 吞掉：模型不该看到这句命令
              return undefined;
            }
          }
        }
      } catch (error) {
        // 拦截层出错绝不能挡住消息投递
        stats.lastError = describeThrown(error);
        log?.('warn', `hands 拦截层异常: ${stats.lastError}`);
      }
      return original.call(this, inbound);
    };
  }

  /** 挂原型（与其它模块同构）。 */
  async function scan(ctx) {
    stats.handsEnabled = cfg?.enabled !== false;
    if (cfg?.enabled === false) {
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      stats.handsResolveError = found.error;
      return { ok: false, error: found.error };
    }
    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;
    let patched = 0;
    if (patchMethod(proto, 'processInbound', MODULE_ID, (original) => makeProcessInbound({ original }), rel)) {
      patched += 1;
    }
    return { ok: true, patched };
  }

  /** 摘闸。 */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    let changed = false;
    for (const method of METHODS) {
      if (patchMethod.unpatch(found.proto, method, MODULE_ID) === true) changed = true;
    }
    return changed;
  }

  /** 诊断快照。 */
  function snapshot() {
    sweep();
    return {
      enabled: cfg?.enabled !== false,
      pending: [...pending.values()].map((item) => ({
        code: item.code,
        kind: item.kind,
        flag: item.flag,
        summary: describeRequest(item),
        approve: item.approve,
        ageMs: Date.now() - item.createdAt,
      })),
      admins: adminsNow(),
      lastMessageChats: lastMessage.size,
      autoApproveAdminInvites: cfg?.autoApproveAdminInvites !== false,
      allowSelfProfile: cfg?.allowSelfProfile !== false,
      nickname: stats.handsLastNickname ?? null,
      signature: stats.handsLastSignature ?? null,
      intimate: { enabled: cfg?.intimate?.enabled !== false },
    };
  }

  return {
    MODULE_ID,
    scan,
    detach,
    poke,
    react,
    like,
    setNickname,
    setSignature,
    readProfile,
    listRequests,
    listIntimate,
    approve,
    decide,
    snapshot,
    intimate,
    /** 供自测用：拿到绑定了本实例闭包的入站拦截层。 */
    makeProcessInbound,
    DEFAULTS,
  };
}

/** 本模块默认配置。 */
export const DEFAULTS = {
  enabled: true,
  /** 审批单有效期：超时就作废（半小时）。 */
  approveTtlMs: 1_800_000,
  /** 「我拉的除外」：群邀请发起人是管理员时直接同意。 */
  autoApproveAdminInvites: true,
  /** 允许自己改昵称/签名（改的是自己的资料，不过审批闸）。 */
  allowSelfProfile: true,
  /** 管理员号兜底（正常由 bridge 配置实时提供）。 */
  adminUsers: ['100000001'],
  /** 亲密关系子能力配置。 */
  intimate: { ...INTIMATE_DEFAULTS },
};
