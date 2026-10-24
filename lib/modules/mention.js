/**
 * dsh-onebot-companion / modules/mention.js
 *
 * 让「群里叫她的名字」也算被叫到（2026-10-15）。
 *
 * ## 为什么要这个模块
 *
 * 上游 `dsh-onebot-qq/lib/cq.js` 的 `detectMention` 只认两件事：`at` 段指向
 * 机器人、或 `reply` 段（引用）指向机器人。**在群里直接喊「云玥」不算。**
 * 这跟真人群聊的习惯不一样 —— 真人被叫名字就知道在叫自己。
 *
 * 参照社区实现 `pinganbbOvO/ai-companion-kit` 的 `packages/companion/src/wake.js`，
 * 它的 `Waker.shouldWake()` 里有两条本模块采纳的判据：
 *
 * - **`nameMention`**：文本里出现她的名字 → 醒。原实现写法是
 *   `this.names.find((n) => text.includes(n))`。
 * - **`diving`**：平时处于「潜水」状态不吭声，被叫醒之后聊一小会儿，然后
 *   自己潜回去（`dive(key, ms)`，`ms === 0` 表示无限期）。
 *
 * ## 挂在哪
 *
 * 包住 `InboundPipeline.prototype.processInbound`（`inbound.js:94`）。
 *
 * 已经核过：**`inbound.segments` 在整个包里只有一个消费者** ——
 * `inbound.js:119` 的 `detectMention(inbound.segments, ...)`（`outbound.js:332`
 * 那处是构造出站参数，与入站对象无关）。所以往 `segments` 里追加一个段，
 * 影响面就是 `detectMention` 一个判据，不会污染正文、媒体或引用展开
 * （正文早在 `normalizeOneBot11` 里就由 `parseMessage` 算进 `inbound.text` 了）。
 *
 * ## 怎么表达「她听见了」
 *
 * 追加一个 `{ type: 'at', data: { qq: bot } }` 段 —— 也就是**复用上游「被 @」
 * 这条现成的语义**：`detectMention` 的 `at` 分支会返回 true，
 * `requireMention` 闸放行，群前缀盖上 `[@我]`，模型看到的就是「有人点名找你」。
 *
 * 不自己造新标记，是为了不引入第二套「被叫」语义；将来上游改了 @ 的处理，
 * 这里跟着一起变。
 *
 * ## 本模块**不**做什么
 *
 * - **不碰引用段。** 上游 `detectMention` 的 reply 分支是 fail-open
 *   （`const qq = seg.data.qq ?? ''; if (qq === '' || qq === bot) return true;`），
 *   而 NapCat 的 reply 段只有 `id`、从不带 `qq`，于是「群里甲引用乙」也会被
 *   判成 @ 了机器人 —— 这是另一个独立的毛病，修它要么联网问 `get_msg` 查真值
 *   （太重，用户 2026-10-15 明确否掉），要么把语义收紧成「引用谁都不算」
 *   （会漏掉「引用云玥」）。本模块**保持上游原样**，这个取舍留给用户定。
 * - **不联网。** 全部判据都是本地字符串匹配与内存状态，零 RPC、零依赖。
 *
 * ## 缺省是保守的
 *
 * `diving` 默认**关**。开它意味着「醒着的一小段时间里，群里不 @ 她也会插话」，
 * 而用户 2026-10-15 的反馈恰恰是「发言频率太高」。所以它作为一个可选项存在，
 * 想开在 profile 配置里写一行即可。
 *
 * `topics`（判据三）同样默认**关**。2026-10-17 用户要求「设置几个云玥可能
 * 感兴趣的方向，群里有人聊到了可以一块聊」—— 这是**在群里自己开口**，所以
 * 与 `diving` 一样必须显式打开。打开后也不是「放进所有群聊消息」：
 *
 * | 闸 | 作用 |
 * | --- | --- |
 * | 关键词命中 | 正文里出现她感兴趣的具体字眼（`DEFAULT_TOPIC_GROUPS`） |
 * | 掷骰子 | 命中不等于必答，`chance` 默认 0.4 |
 * | 每群冷却 | `cooldownMs` 默认 30 分钟 |
 * | 每日上限 | `maxPerDay` 默认 3 次 |
 * | 安静时段 | `quietStart`/`quietEnd` 默认 1:00–8:00 |
 * | 群白名单 | `chats` 非空时只在这些群生效 |
 *
 * 命中后放行的**那一条**消息会在正文末尾多一行 `[群里在聊「…」…]`
 * （`topicHint`），把「没人点你的名，只是聊到了」说清楚 —— 因为闸门借用的
 * 是上游「被 @」的语义，群前缀会盖上 `[@我]`，不解释她会反问「叫我干嘛」。
 *
 * 窗口分两张表：`awake` 只管 `diving`，`topicAwake` 只管话题插话。混在一张
 * 表里就分不清「这个窗口是谁开的」，于是「潜水关着也不该吭声」会被话题
 * 窗口悄悄破坏（2026-10-17 自测里抓到过这一幕）。
 *
 * @module dsh-onebot-companion/modules/mention
 */

import { auditMethods } from '../core/patch.js';
import { describeThrown, loadTargetClass, moduleUrl } from '../core/profile.js';

/** 模块 id：出现在日志、`patched` 记录与脱链判定里。 */
export const MODULE_ID = 'mention';

/** 挂载点：`detectMention` 的唯一调用者。 */
const TARGET = { file: 'inbound.js', exportName: 'InboundPipeline' };
const METHODS = ['processInbound'];

/** 上游判定函数的出处。 */
const CQ_FILE = 'cq.js';
const CQ_EXPORT = 'detectMention';

/** 默认被叫的名字。`yara` 是人设里 `云玥（Yara）` 的英文名。 */
export const DEFAULT_NAMES = ['云玥', '玥玥', 'Yara'];

/** 潜水默认参数：醒着 5 分钟，之后重新潜下去。 */
export const DEFAULT_AWAKE_MS = 300000;

/**
 * 文本里有没有人喊她的名字。
 *
 * 与 `wake.js` 的原实现一致，用 `includes` 而不是分词 —— 中文没有词边界，
 * 分词器反而会把「玥玥在吗」切错。代价是「萧玥玥」这种嵌在别人名字里的也会
 * 命中；在群聊场景下这是可接受的（宁可多听一句，也别漏掉真在叫她）。
 *
 * @param {string} text
 * @param {string[]} names
 * @returns {string} 命中的名字（没命中返回 `''`）。
 */
export function findNameMention(text, names) {
  if (typeof text !== 'string' || text === '') return '';
  if (!Array.isArray(names)) return '';
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue;
    if (text.includes(name)) return name;
  }
  return '';
}

/**
 * 把正文里「@ 她自己的 QQ 号」改写成 `@你`。
 *
 * 上游 `cq.js` 的 `case 'at'` 把 at 段渲染成裸数字（`@100000002`）—— 人的视角
 * 那是「我的昵称」，模型的视角是一串陌生号码。2026-10-16 23:10 实测到后果：
 * 用户在群里同时 @ 了两个人（其中一个就是她自己），她的内心独白原文是
 *   「示例用户 @了 100000003（喵喵）和 100000002（另一个号），没有 @我」
 * —— 群前缀明明盖着 `[@我]`，她被正文里的裸号带偏，判成「在叫别人」，整场沉默。
 *
 * 只改**指向自己的**那一个号。别人的号保持裸号：拿不到昵称，硬编一个更糟。
 *
 * 配套改动：`rules.js` 的 `R_CHANNEL` 第三条原本写着「@ 后面的数字是**别人的**
 * 号」，她于是把自己那个号也划进「别人」。现在多一句「写的是『你』就是你自己」，
 * 否则提示词会跟这里的改写打架。
 *
 * @param {string} text - 入站正文（`inbound.text`）。
 * @param {string} botId - 机器人自己的 QQ。
 * @returns {string} 改写后的正文（没命中或参数不合法时原样返回）。
 */
export function rewriteSelfMention(text, botId) {
  if (typeof text !== 'string' || text === '') return text;
  if (typeof botId !== 'string' || botId === '') return text;
  // botId 理论上是纯数字，但仍转义一次：正则元字符流进来会抛错或匹配错东西。
  const escaped = botId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `(?!\d)`：`@1000000020` 这种以自己号开头的更长号码不该被误伤。
  return text.replace(new RegExp(`@${escaped}(?!\\d)`, 'g'), '@你');
}

/**
 * 云玥感兴趣的聊天方向（默认表）。
 *
 * 用户 2026-10-17 逐字：「你设置几个云玥可能感兴趣的方向，群里有人聊到了可以一块聊」。
 *
 * 取材于 `preset-yara` 角色卡里【云玥自己的生活线】那一句 ——「上课、追番、撸猫、
 * 喝咖啡、和朋友吐槽、打游戏、偶尔摆烂」—— 每个方向拆成**具体到能指认的字眼**。
 * 刻意不用「娱乐」「生活」「技术」这类上位词：它们什么都匹配，等于没有判据。
 *
 * 允许少量误伤（「熊猫」也会命中「猫」）。误伤由 `chance` 掷骰子、每群冷却与
 * 每日上限一起稀释；判据本身宁宽勿窄，因为漏掉真在聊的话题是**静默**的，
 * 而误伤的代价只是她偶尔多接一句 —— 后者看得见、可调，前者看不见。
 */
export const DEFAULT_TOPIC_GROUPS = {
  追番看剧: ['追番', '新番', '番剧', '动漫', '动画', '剧场版', '声优', '漫画', '这季', '补番', '看完了'],
  猫: ['猫', '喵', '猫猫', '橘猫', '狸花', '布偶', '撸猫', '流浪猫', '猫粮', '猫咖', '猫砂'],
  游戏: ['打游戏', '开黑', '上分', '排位', 'steam', '原神', '王者', '星穹', '抽卡', '队友', '这游戏'],
  咖啡吃喝: ['咖啡', '奶茶', '拿铁', '美式', '好吃', '外卖', '夜宵', '火锅', '烧烤', '探店', '螺蛳粉'],
  听歌: ['这首歌', '歌单', '听歌', '耳机', '专辑', '演唱会', '音乐节', 'bgm', '单曲循环'],
  摆烂日常: ['摆烂', '躺平', '摸鱼', '划水', '好累', '不想动', '睡了一整天', '熬夜', '追剧'],
  吐槽八卦: ['离谱', '吐槽', '吃瓜', '有瓜', '什么瓜', '笑死', '绷不住', '太抽象'],
};

/**
 * 话题插话的默认参数。
 *
 * `enabled` 默认 **false** —— 与 `diving` 同一条理由（见文件头「缺省是保守的」）：
 * 开了它等于「群里聊到她感兴趣的东西，她可以自己开口」。这是用户 2026-10-17
 * 明确要的，但默认值留给配置文件显式开，免得将来换群、换场景时无声地刷屏。
 *
 * | 键 | 含义 |
 * | --- | --- |
 * | `groups` | 方向名 → 关键词数组。给 `[]` 等效关掉该方向。 |
 * | `chats` | 只在这些群生效（纯群号或 `group:xxx` 都认）。空 = 所有群。 |
 * | `cooldownMs` | 同一个群两次「话题插话」之间至少隔多久。 |
 * | `maxPerDay` | 同一个群每天最多插几次。 |
 * | `chance` | 关键词命中后还要掷的骰子 —— 命中不等于必答。 |
 * | `minChars` | 消息短于这个长度不判（「猫」一个字不算在聊猫）。 |
 * | `quietStart` / `quietEnd` | 本地小时，安静时段内完全不插话（支持跨零点）。 |
 * | `awakeMs` | 插话成功后打开的活跃窗口：这段时间内该群的消息可以直接进来续话，不用再命中关键词。 |
 */
export const DEFAULT_TOPICS = {
  enabled: false,
  groups: DEFAULT_TOPIC_GROUPS,
  chats: [],
  cooldownMs: 1800000,
  maxPerDay: 3,
  chance: 0.4,
  minChars: 4,
  quietStart: 1,
  quietEnd: 8,
  awakeMs: 600000,
};

/**
 * 取一个有限数值；非法或越界时回退默认。
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min - 下界（含）。
 * @param {number} [max] - 上界（含）。给了就不再夹紧，而是**回退默认** ——
 *   概率写成 99 时静默变成「必接」比退回 0.4 危险得多。
 */
function pickNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return fallback;
  if (typeof max === 'number' && n > max) return fallback;
  return n;
}

/**
 * 把配置里的 `topics` 段规整成完整形状。
 *
 * **必须做**：`mergeConfig` 对模块段只做**浅**合并（`lib/index.js`），用户写
 * `mention: { topics: { enabled: true } }` 会把整个 `DEFAULT_TOPICS` 顶掉 ——
 * 没有这一层兜底，`groups` 就成了 `undefined`，判据静默失效，而开关看起来是开的。
 *
 * `groups` 走**合并**而不是替换：用户加一组不影响默认那几组；想把某组关掉就写
 * `组名: []`。这样配置里只需要写他真正关心的那一条。
 *
 * @param {object|undefined} raw
 * @returns {object} 完整的 topics 配置。
 */
export function normalizeTopics(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_TOPIC_GROUPS };
  if (src.groups !== null && typeof src.groups === 'object') {
    for (const [name, words] of Object.entries(src.groups)) {
      if (typeof name !== 'string' || name === '') continue;
      if (Array.isArray(words)) {
        merged[name] = words.filter((w) => typeof w === 'string' && w !== '');
      } else if (words === null || words === false) {
        merged[name] = [];
      }
    }
  }
  const chats = Array.isArray(src.chats)
    ? src.chats.map((c) => String(c)).filter((c) => c !== '')
    : [];
  return {
    enabled: src.enabled === true,
    groups: merged,
    chats,
    cooldownMs: pickNumber(src.cooldownMs, DEFAULT_TOPICS.cooldownMs, 0),
    maxPerDay: pickNumber(src.maxPerDay, DEFAULT_TOPICS.maxPerDay, 0),
    chance: pickNumber(src.chance, DEFAULT_TOPICS.chance, 0, 1),
    minChars: pickNumber(src.minChars, DEFAULT_TOPICS.minChars, 1),
    quietStart: pickNumber(src.quietStart, DEFAULT_TOPICS.quietStart, 0),
    quietEnd: pickNumber(src.quietEnd, DEFAULT_TOPICS.quietEnd, 0),
    awakeMs: pickNumber(src.awakeMs, DEFAULT_TOPICS.awakeMs, 0),
  };
}

/**
 * 正文里有没有聊到某个方向。
 *
 * @param {string} text
 * @param {Record<string, string[]>} groups
 * @param {number} minChars - 正文短于这个长度直接不判。
 * @returns {{topic: string, word: string}|null} 命中返回方向名与命中的那个词。
 */
export function matchTopic(text, groups, minChars) {
  if (typeof text !== 'string') return null;
  // `[文件:…]` 里的文件名/路径不算「在聊天」：`[文件:猫.jpg]` 不该命中「猫」。
  // 这是唯一夹带自由文本的机器占位符（上游 `cq.js` 的 `文件` 段）。
  // 其它占位符都固定：`[图片]` `[表情包]` `[语音]` `[视频]` `[卡片]`；
  // 表情走 `faceToEmoji` 渲染成 emoji，本来就不带汉字。见 2026-10-17 用户
  // 「我们发表情会不会被误判」的取证。
  const cleaned = text.replace(/\[文件:[^\]]*\]/g, ' ');
  const trimmed = cleaned.trim();
  if (trimmed === '' || trimmed.length < minChars) return null;
  if (groups === null || typeof groups !== 'object') return null;
  const lower = trimmed.toLowerCase();
  for (const topic of Object.keys(groups)) {
    const words = groups[topic];
    if (!Array.isArray(words)) continue;
    for (const word of words) {
      if (typeof word !== 'string' || word === '') continue;
      // 英文词按小写比（`Steam` / `BGM` 都要认）；中文不受影响。
      if (lower.includes(word.toLowerCase())) return { topic, word };
    }
  }
  return null;
}

/** 本地日期键（`YYYY-M-D`），用来翻页每日计数。 */
export function localDayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * 现在是不是安静时段。支持跨零点（`start > end`）。
 *
 * `start === end` 视为没有安静时段 —— 否则一个手滑写重了的配置会让她全天闭嘴。
 *
 * @param {number} hour - 本地小时 0..23。
 * @param {number} start
 * @param {number} end
 * @returns {boolean}
 */
export function inQuietHours(hour, start, end) {
  if (!Number.isFinite(hour) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * 话题插话的频率闸：每群冷却 + 每群每日上限。
 *
 * 状态放在内存里（`createMention` 的 `topicState`）。热重载会清零 —— 和 `awake`
 * 同样的取舍：最坏是重载后多插一次话，比为一个瞬态计数落盘划算。
 *
 * @param {Map<string, {lastAt: number, day: string, count: number}>} state
 * @param {string} chatId
 * @param {number} now
 * @param {object} cfg - 规整后的 topics 配置。
 * @returns {boolean} 是否允许插话。
 */
export function topicQuotaOk(state, chatId, now, cfg) {
  const st = state.get(chatId) ?? { lastAt: 0, day: '', count: 0 };
  const day = localDayKey(now);
  if (st.day !== day) {
    st.day = day;
    st.count = 0;
  }
  if (cfg.cooldownMs > 0 && now - st.lastAt < cfg.cooldownMs) return false;
  if (cfg.maxPerDay > 0 && st.count >= cfg.maxPerDay) return false;
  return true;
}

/** 记一次话题插话（消耗配额）。 */
export function topicQuotaSpend(state, chatId, now) {
  const st = state.get(chatId) ?? { lastAt: 0, day: localDayKey(now), count: 0 };
  if (st.day !== localDayKey(now)) {
    st.day = localDayKey(now);
    st.count = 0;
  }
  st.lastAt = now;
  st.count += 1;
  state.set(chatId, st);
}

/**
 * 配置里的群白名单是否放行这个 chat。
 *
 * 空数组 = 不限制。纯群号与完整 chatId 都认（用户写 `900000001` 或
 * `group:900000001` 都行 —— 前者是他从 QQ 里能看到的那个号）。
 */
export function topicChatAllowed(chats, chatId, groupId) {
  if (!Array.isArray(chats) || chats.length === 0) return true;
  const id = String(chatId ?? '');
  const gid = String(groupId ?? '');
  return chats.some((c) => {
    const s = String(c);
    if (s === id) return true;
    if (gid !== '' && (s === gid || s === `group:${gid}`)) return true;
    return s.startsWith('group:') && s === id;
  });
}

/**
 * 话题插话的全套闸门。命中返回 `{topic, word}`，任一关不过返回 `null`。
 *
 * 顺序刻意是**从便宜到贵**：白名单 → 安静时段 → 关键词 → 掷骰子 → 配额。
 * 配额放最后是因为它要读/写状态，而且「没插成话就不该消耗配额」。
 *
 * @param {object} args
 * @param {object} args.inbound
 * @param {object} args.topics - 规整后的 topics 配置。
 * @param {number} args.at - 当前时间。
 * @param {string} args.chatKey
 * @param {Map<string, {lastAt: number, day: string, count: number}>} args.topicState
 * @param {() => number} args.random
 * @param {(kind: string, detail: string) => void} args.note
 * @returns {{topic: string, word: string}|null}
 */
export function topicGate({ inbound, topics, at, chatKey, topicState, random, note }) {
  if (topics.chats.length > 0
    && !topicChatAllowed(topics.chats, chatKey, inbound?.groupId)) return null;
  if (inQuietHours(new Date(at).getHours(), topics.quietStart, topics.quietEnd)) return null;
  const hit = matchTopic(inbound?.text, topics.groups, topics.minChars);
  if (hit === null) return null;
  // 命中 ≠ 必答：聊到猫她可能只想听着。这一掷就是「她今天想不想插这句」。
  if (!(random() < topics.chance)) return null;
  if (!topicQuotaOk(topicState, chatKey, at, topics)) return null;
  note('topic', `${chatKey} ${hit.topic}/${hit.word}`);
  return hit;
}

/**
 * 话题命中时追加到正文末尾的一行说明。
 *
 * 为什么要写这一行：`requireMention` 闸只认「被 @/被叫名字」，话题插话只能借用
 * 同一个 at 段（见文件头「怎么表达」），于是群前缀会盖上 `[@我]`。可正文里明明
 * 没人点她的名 —— 不解释一句，她要么以为有人叫她而反问「谁叫我」，要么莫名
 * 其妙地开口。这行把真相告诉她：**是话题把你引过来的，不是谁在叫你**。
 *
 * 也给了退路（`[[silent]]`）：用户要的是「可以一块聊」，不是「必须接话」。
 *
 * @param {{topic: string}} hit
 * @returns {string}
 */
export function topicHint(hit) {
  return `[群里在聊「${hit.topic}」，你正好感兴趣就自然接一句；不想接就回 [[silent]]]`;
}

/**
 * 某个群现在是不是还在活跃窗口里。
 *
 * `diving` 与话题插话各用一张表：两边开窗口的判据不同，混在一张表里就分不清
 * 「这个窗口是谁开的」，于是「潜水关着也该不吭声」这条会被话题窗口破坏。
 *
 * @param {Map<string, number>} table - chatId → 醒到什么时候。
 * @param {string} chatId
 * @param {number} at - 当前时间。
 * @returns {boolean}
 */
export function divingWindowOpen(table, chatId, at) {
  const until = table.get(String(chatId ?? ''));
  return Number.isFinite(until) && until > at;
}

/**
 * 把配置里的 `diving` 段规整成 `{ enabled, awakeMs }`。
 *
 * `mergeConfig` 对模块段只做浅合并，所以这里必须自己兜住缺失与非法值 ——
 * 否则 `diving.awakeMs` 为 `undefined` 时 `now + undefined` 会得到 NaN，
 * 而 `now < NaN` 恒为 false，表现为「潜水窗口永远不生效」这种难查的静默故障。
 *
 * @param {object|boolean|undefined} raw
 * @returns {{enabled: boolean, awakeMs: number}}
 */
export function normalizeDiving(raw) {
  if (raw === true) return { enabled: true, awakeMs: DEFAULT_AWAKE_MS };
  if (raw === false || raw == null) return { enabled: false, awakeMs: DEFAULT_AWAKE_MS };
  const enabled = raw.enabled === true;
  const rawMs = Number(raw.awakeMs);
  const awakeMs = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : DEFAULT_AWAKE_MS;
  return { enabled, awakeMs };
}

/**
 * 目前醒着的 chat 有多少条（放进 status，便于看出潜水状态）。
 *
 * @param {Map<string, number>} awake
 * @param {number} now
 * @returns {number}
 */
export function awakeCount(awake, now) {
  let n = 0;
  for (const until of awake.values()) {
    if (Number.isFinite(until) && until > now) n += 1;
  }
  return n;
}

/**
 * 清掉已经过期的唤醒记录，避免 Map 随「这辈子进过消息的群」单调增长。
 *
 * @param {Map<string, number>} awake
 * @param {number} now
 * @returns {number} 清掉了几条
 */
export function pruneAwake(awake, now) {
  let dropped = 0;
  for (const [key, until] of awake) {
    if (!Number.isFinite(until) || until <= now) {
      awake.delete(key);
      dropped += 1;
    }
  }
  return dropped;
}

/**
 * 从 bridge ctx 里取机器人自己的 QQ。
 *
 * 规则与上游 `detectMention` 开头那句逐字对齐：
 * `const bot = selfId !== '' ? selfId : botQQ;` —— 学到的 id 优先于配置的。
 * 拿不到就返回 `''`（调用方据此放弃注入，而不是猜）。
 *
 * @param {object} ctx
 * @returns {string}
 */
export function botIdOf(ctx) {
  try {
    const learned = typeof ctx?.selfId === 'function' ? String(ctx.selfId() ?? '') : '';
    if (learned !== '') return learned;
    const configured = String(ctx?.config?.botQQ ?? '');
    return configured;
  } catch {
    return '';
  }
}

/**
 * 造一个 `processInbound` 的包装。
 *
 * @param {object} options
 * @param {Function} options.original - 链底的原方法。
 * @param {object} options.cfg - mention 段配置（`enabled` / `names` / `diving` / `logMentions`）。
 * @param {(level: string, message: string) => void} options.log
 * @param {(kind: string, detail: string) => void} options.note - 记账。
 * @param {Map<string, number>} options.awake - chatId → 醒到什么时候（毫秒时间戳）。
 * @param {Map<string, {lastAt: number, day: string, count: number}>} [options.topicState] - 话题插话的配额状态。
 * @param {() => number} [options.random] - 掷骰子，自测用。
 * @param {Function} [options.detectMentionImpl] - 上游 `detectMention` 的替身，自测用。
 * @param {() => number} [options.now] - 取当前时间，自测用。
 * @returns {Function} 可直接挂到原型上的方法。
 */
export function makeMentionProcessInbound({
  original,
  cfg,
  log,
  note,
  awake,
  topicAwake = new Map(),
  topicState = new Map(),
  random = Math.random,
  detectMentionImpl,
  now = Date.now,
}) {
  const diving = normalizeDiving(cfg?.diving);
  const names = Array.isArray(cfg?.names) ? cfg.names : DEFAULT_NAMES;
  const topics = normalizeTopics(cfg?.topics);

  return function companionMentionProcessInbound(inbound) {
    const self = this;

    return (async () => {
      if (!cfg?.enabled) return original.call(self, inbound);
      // 没有上游判定函数就不插手 —— 见文件头「为什么必须拿到真的上游判定」。
      if (typeof detectMentionImpl !== 'function') return original.call(self, inbound);

      try {
        const at = now();
        pruneAwake(awake, at);
        pruneAwake(topicAwake, at);

        const ctx = self?.ctx;
        const bot = botIdOf(ctx);

        // 正文里指向她自己的裸 QQ 号 → `@你`。**放在群聊判断之前**：
        // 私聊里用户 @ 机器人同样会渲染成裸号，写成 `@你` 语义才对。
        // 也必须在 `upstreamMentioned` 之前 —— 被 @ 的那条走提前 return，
        // 恰恰是最需要改写的一条（2026-10-16 23:10 那次沉默就栽在这里）。
        // 只动 `inbound.text`；`detectMentionImpl` 读的是 segments/raw，不受影响。
        if (bot !== '' && typeof inbound?.text === 'string') {
          const fixed = rewriteSelfMention(inbound.text, bot);
          if (fixed !== inbound.text) {
            inbound.text = fixed;
            note('selfid', String(inbound?.chatId ?? ''));
          }
        }

        // 只有群聊需要「叫名字」。私聊本来就每条都回，加名字判据没有意义，
        // 反而会让「他在跟别人提我」这种误报有机会干扰。
        if (inbound?.kind !== 'group') return await original.call(self, inbound);

        // 问**真的上游**：按它自己的判据，这条消息算不算提到了机器人。
        // 参数与 `inbound.js:119` 的调用逐位对齐。
        const learned = typeof ctx?.selfId === 'function' ? String(ctx.selfId() ?? '') : '';
        const configured = String(ctx?.config?.botQQ ?? '');
        const upstreamMentioned = detectMentionImpl(
          inbound?.segments, inbound?.raw, learned, configured,
        ) === true;
        if (upstreamMentioned) {
          // 醒着的群，任何一条投进来的消息都算续话，把窗口往后推。
          //
          // **只推潜水窗口，不推话题窗口**：话题窗口存在的理由是「她刚接了
          // 一句，允许她把这个话题聊完」。若这里也推，一次真 @ 就等于给这个群
          // 开了 10 分钟免检 —— 那又回到用户明确否掉的「群里随意搭话」了。
          if (diving.enabled && inbound?.chatId) {
            awake.set(String(inbound.chatId), at + diving.awakeMs);
          }
          note('upstream', String(inbound?.chatId ?? ''));
          return await original.call(self, inbound);
        }

        // 判据一：文本里喊了她的名字。
        const hit = findNameMention(inbound?.text, names);
        let topicHit = null;
        if (hit !== '') {
          note('name', hit);
        } else if (diving.enabled && divingWindowOpen(awake, inbound?.chatId, at)) {
          // 判据二：潜水窗口内 —— 刚被叫醒的这段时间里，群里不 @ 她也能续话。
          awake.set(String(inbound.chatId), at + diving.awakeMs);
          note('diving', String(inbound.chatId));
        } else if (topics.enabled && divingWindowOpen(topicAwake, inbound?.chatId, at)) {
          // 判据二续：话题插话开出的窗口还没过 —— 接着聊几句不必再命中关键词，
          // 否则「一块聊」就成了「只准接一句」。
          topicAwake.set(String(inbound.chatId), at + topics.awakeMs);
          note('topic-alive', String(inbound.chatId));
        } else {
          // 判据三：群里在聊她感兴趣的方向（2026-10-17 用户要求）。
          if (topics.enabled) {
            topicHit = topicGate({
              inbound,
              topics,
              at,
              chatKey: String(inbound?.chatId ?? ''),
              topicState,
              random,
              note,
            });
          }
          if (topicHit === null) return await original.call(self, inbound);
        }

        // 注入一个 at 段，借用上游「被 @」的现成语义（见文件头「怎么表达」）。
        if (bot === '' || !Array.isArray(inbound?.segments)) {
          // 不知道自己是几号，或载荷没带段数组（纯 raw / CQ 串）→ 不做改写。
          // 宁可保持上游行为，也不猜一个 qq 塞进去。
          log('warn', 'mention: 命中名字但拿不到 bot id 或 segments 非数组，按上游判据放行');
          return await original.call(self, inbound);
        }
        inbound.segments = [...inbound.segments, { type: 'at', data: { qq: bot } }];
        // 话题引来的，得在正文里说明白 —— 否则群前缀盖着 `[@我]`，正文却没人
        // 叫她，她会以为有人点名而反问。见 topicHint 的注释。
        if (topicHit !== null) {
          const hint = topicHint(topicHit);
          inbound.text = typeof inbound.text === 'string' && inbound.text !== ''
            ? `${inbound.text}\n${hint}`
            : hint;
          topicQuotaSpend(topicState, String(inbound?.chatId ?? ''), at);
          if (inbound?.chatId) topicAwake.set(String(inbound.chatId), at + topics.awakeMs);
        }
        if (diving.enabled && inbound?.chatId) {
          awake.set(String(inbound.chatId), at + diving.awakeMs);
        }

        return await original.call(self, inbound);
      } catch (error) {
        // 闸门自身异常时按原流程放行 —— 宁可回到上游的老行为，也不能让消息卡死。
        log('warn', `mention: 闸门异常，按原流程放行: ${describeThrown(error)}`);
        return await original.call(self, inbound);
      }
    })();
  };
}

/**
 * 创建 mention 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - mention 段配置。
 * @param {object} options.stats - 共享统计对象。
 * @param {Function} options.patchMethod - 来自 core/patch 的挂载器。
 * @param {(level: string, message: string) => void} options.log
 */
export function createMention({ cfg, stats, patchMethod, log }) {
  /** chatId → 醒到什么时候（潜水窗口）。热重载后归零，等价于「刚潜下去」，可接受。 */
  const awake = new Map();
  /** chatId → 话题插话开出的活跃窗口（与潜水窗口分开，见 divingWindowOpen）。 */
  const topicAwake = new Map();
  /** chatId → 话题插话的配额（冷却 + 每日计数）。与 awake 同样的瞬态取舍。 */
  const topicState = new Map();

  function note(kind, detail) {
    stats.lastMentionAt = Date.now();
    if (kind === 'name') {
      stats.mentionNamed = (stats.mentionNamed ?? 0) + 1;
      stats.lastMentionName = detail;
    } else if (kind === 'diving') {
      stats.mentionDived = (stats.mentionDived ?? 0) + 1;
    } else if (kind === 'topic-alive') {
      stats.mentionTopicAlive = (stats.mentionTopicAlive ?? 0) + 1;
    } else if (kind === 'upstream') {
      stats.mentionUpstream = (stats.mentionUpstream ?? 0) + 1;
    } else if (kind === 'selfid') {
      stats.mentionSelfId = (stats.mentionSelfId ?? 0) + 1;
    } else if (kind === 'topic') {
      stats.mentionTopic = (stats.mentionTopic ?? 0) + 1;
      stats.lastMentionTopic = detail;
    }
    stats.mentionAwake = awakeCount(awake, Date.now());
    stats.mentionTopicAwake = awakeCount(topicAwake, Date.now());
    if (cfg?.logMentions === false) return;
    const text = kind === 'name'
      ? `群里有人喊「${detail}」，已按被叫处理`
      : kind === 'diving'
        ? `潜水窗口内续话 chat=${detail}`
        : kind === 'topic-alive'
          ? `话题窗口内续话 chat=${detail}`
          : kind === 'selfid'
            ? `正文里指向自己的裸 QQ 号已改写为 @你 chat=${detail}`
            : kind === 'topic'
              ? `群里聊到她感兴趣的方向，主动接话 chat=${detail}`
              : `上游已判为提到机器人 chat=${detail}`;
    try {
      log('debug', `mention: ${text}`);
    } catch {
      /* 日志失败不影响入站 */
    }
  }

  /**
   * 把自己的闸从原型上摘掉，还原成链底原方法。
   *
   * 与 adopt / stamp 同一条理由：「关掉」的语义要走到底 —— 只停止挂新闸的话，
   * 上一轮挂在原型上的层还在（拿旧 cfg 快照的实例会继续生效）。
   */
  async function detach(ctx) {
    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) return false;
    const changed = patchMethod.unpatch(found.proto, 'processInbound', MODULE_ID) === true;
    if (changed) log('info', '已摘除 mention 闸（processInbound 回到上游实现）');
    return changed;
  }

  /**
   * 载入上游真正的 `detectMention`。
   *
   * 用 `moduleUrl` 而不是自己拼路径 —— 它保证与宿主 loader 解析出的是**同一份
   * 模块实例**（见 `core/profile.js:120-133` 的说明）。失败返回 `null`，调用方
   * 据此放弃挂载（每轮 scan 会重试，不缓存失败）。
   *
   * @param {object} ctx
   * @returns {Promise<Function|null>}
   */
  async function loadUpstreamDetect(ctx) {
    const url = moduleUrl(ctx, cfg, CQ_FILE);
    if (url === null) return null;
    try {
      const mod = await import(url);
      const fn = mod?.[CQ_EXPORT];
      return typeof fn === 'function' ? fn : null;
    } catch {
      return null;
    }
  }

  /**
   * 一次补挂扫描。
   * @returns {Promise<{ok: boolean, error?: string, patched?: number}>}
   */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    stats.enabled = cfg?.enabled === true;
    if (!stats.enabled) {
      awake.clear();
      topicAwake.clear();
      topicState.clear();
      const detached = await detach(ctx).catch(() => false);
      return { ok: true, patched: 0, detached };
    }

    const found = await loadTargetClass(ctx, cfg, TARGET.file, TARGET.exportName);
    if (!found.ok) {
      // 自己独立的错误位：`resolveError` 是 guard 那套的公共位，会互相覆盖。
      stats.mentionResolveError = found.error;
      return { ok: false, error: found.error };
    }

    // 拿不到上游判定就**不挂** —— 挂着也只是空转（见文件头「为什么必须拿到真的
    // 上游判定」）。宁可如实报错，也不要一个看起来在跑、实际什么都没做的闸。
    const upstreamDetect = await loadUpstreamDetect(ctx);
    if (upstreamDetect === null) {
      stats.mentionProfileDir = found.profileDir;
      stats.mentionResolveError = `无法加载上游 ${CQ_FILE}#${CQ_EXPORT}`;
      return { ok: false, error: stats.mentionResolveError };
    }

    stats.mentionProfileDir = found.profileDir;
    stats.mentionResolveError = null;

    const proto = found.proto;
    const rel = `${cfg.packageName}/lib/${TARGET.file}`;

    for (const method of auditMethods(proto, METHODS, MODULE_ID)) {
      stats.lost.push({ url: rel, method, moduleId: MODULE_ID, at: Date.now() });
      if (stats.lost.length > 50) stats.lost.splice(0, stats.lost.length - 50);
    }

    let patched = 0;
    if (patchMethod(proto, 'processInbound', MODULE_ID, (original) =>
      makeMentionProcessInbound({
        original, cfg, log, note, awake, topicAwake, topicState,
        detectMentionImpl: upstreamDetect,
      }), rel)) {
      patched += 1;
    }

    return { ok: true, patched };
  }

  /**
   * 自测：拿假的 `original` / 假 ctx 把包装函数跑一遍。
   *
   * 刻意不建真的 `InboundPipeline`（那要整套 ctx：policy / media / dispatchFollowup），
   * 但**走的是真的包装函数**，所以能抓到「该唤醒时没唤醒」「不该动时改了段」这类错。
   *
   * `detectMentionImpl` 传一个假的上游判定，让自测能独立于真实的 `cq.js`
   * 覆盖「上游已判 true / false」两条路。
   */
  async function selfTest() {
    const results = [];
    const BOT = '100000002';

    const run = async (name, { inbound, cfgOverride, upstreamMentioned, awakeSeed, topicAwakeSeed, randomValue, topicSeed }, expect) => {
      const awake = new Map(Object.entries(awakeSeed ?? {}));
      const topicAwake = new Map(Object.entries(topicAwakeSeed ?? {}));
      // 默认给一个「很久以前插过一次」的配额：`now` 固定成 1_000_000，若 lastAt
      // 是 0 就会落在冷却期内，把「命中该接话」那几条用例全挡掉。用例 27/28 用
      // 显式的 topicSeed 覆盖它来验冷却与上限。
      const topicState = new Map(Object.entries(
        topicSeed ?? { 'group:1': { lastAt: -10_000_000, day: '1970-1-1', count: 0 } },
      ));
      const originalCalls = [];
      const original = function fakeOriginal(input) {
        originalCalls.push(input);
        return Promise.resolve({ viaOriginal: true });
      };
      const wrapper = makeMentionProcessInbound({
        original,
        cfg: { enabled: true, logMentions: false, names: DEFAULT_NAMES, ...cfgOverride },
        log: () => undefined,
        note: () => undefined,
        awake,
        topicAwake,
        topicState,
        // 掷骰子固定成一个值，让「命中但没过概率门 / 命中且过门」可分别断言。
        random: () => (typeof randomValue === 'number' ? randomValue : 0.5),
        detectMentionImpl: () => upstreamMentioned === true,
        now: () => 1_000_000,
      });
      const fakeSelf = {
        ctx: { selfId: () => BOT, config: { botQQ: BOT } },
      };
      const input = { kind: 'group', chatId: 'group:1', text: '', segments: [], ...inbound };
      let error = null;
      try {
        await wrapper.call(fakeSelf, input);
      } catch (e) {
        error = describeThrown(e);
      }
      results.push({
        name,
        error,
        viaOriginal: originalCalls.length === 1,
        segments: input.segments,
        awakeSize: awake.size,
        expect,
        ok: expect({
          input,
          error,
          viaOriginal: originalCalls.length === 1,
          awake,
          topicAwake,
        }),
      });
    };

    /** 段数组里有没有我们注入的那个 at 段。 */
    const injectedAt = (segs) => Array.isArray(segs)
      && segs.some((s) => s?.type === 'at' && s?.data?.qq === BOT);

    // 1. 核心用例：群里有人喊「云玥」→ 注入 at 段，放行给上游。
    await run('喊名字 → 注入 at 段', {
      inbound: { text: '云玥在吗', segments: [{ type: 'text', data: { text: '云玥在吗' } }] },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && injectedAt(input.segments));

    // 2. 另一个名字（人设里的英文名）同样命中。
    await run('喊 Yara → 注入 at 段', {
      inbound: { text: 'Yara 看看这个', segments: [] },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && injectedAt(input.segments));

    // 3. 名字嵌在句子里也认（中文没有词边界，这是刻意的）。
    await run('名字嵌在句中 → 注入', {
      inbound: { text: '刚才云玥说的那个', segments: [] },
      upstreamMentioned: false,
    }, ({ input }) => injectedAt(input.segments));

    // 4. 没喊名字 → 一个段都不加，原样交给上游（让 requireMention 拦）。
    await run('没喊名字 → 不动', {
      inbound: { text: '今天天气不错', segments: [{ type: 'text', data: { text: '今天天气不错' } }] },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && input.segments.length === 1 && !injectedAt(input.segments));

    // 5. 上游已判「提到了」（真 @）→ 不重复注入。
    await run('上游已判提到 → 不重复注段', {
      inbound: { text: '云玥', segments: [{ type: 'at', data: { qq: BOT } }] },
      upstreamMentioned: true,
    }, ({ input, viaOriginal }) => viaOriginal && input.segments.length === 1);

    // 6. 上游判「提到了」但文本没名字（引用 fail-open 命中）→ 同样不插手。
    await run('上游 fail-open 命中 → 不插手', {
      inbound: { text: '你看这个', segments: [{ type: 'reply', data: { id: '1' } }] },
      upstreamMentioned: true,
    }, ({ input, viaOriginal }) => viaOriginal && input.segments.length === 1
      && input.segments[0].type === 'reply' && input.segments[0].data.qq === undefined);

    // 7. 私聊不适用（私聊本来就每条都回）。
    await run('私聊 → 不动', {
      inbound: { kind: 'private', text: '云玥', segments: [] },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 8. 名字表为空 → 无从命中。
    await run('names 为空 → 不动', {
      inbound: { text: '云玥在吗', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { names: [] },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 9. 潜水默认关：醒着的群，没喊名字也不醒。
    await run('diving 关 + 醒着 → 仍不动', {
      inbound: { text: '今天天气不错', segments: [] },
      upstreamMentioned: false,
      awakeSeed: { 'group:1': 2_000_000 },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 10. 潜水开且窗口内 → 不喊名字也续话。
    await run('diving 开 + 窗口内 → 注入', {
      inbound: { text: '那你说呢', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { diving: { enabled: true, awakeMs: 300000 } },
      awakeSeed: { 'group:1': 2_000_000 },
    }, ({ input, viaOriginal }) => viaOriginal && injectedAt(input.segments));

    // 11. 潜水开但窗口已过 → 重新潜下去，不动。
    await run('diving 开 + 窗口已过 → 不动', {
      inbound: { text: '那你说呢', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { diving: { enabled: true, awakeMs: 300000 } },
      awakeSeed: { 'group:1': 999_000 },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 12. 潜水开：喊名字之后应把窗口记下来。
    await run('diving 开 + 喊名字 → 记窗口', {
      inbound: { text: '云玥', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { diving: { enabled: true, awakeMs: 300000 } },
    }, ({ input, awake }) => injectedAt(input.segments) && awake.get('group:1') === 1_300_000);

    // 13. 潜水关：喊名字也不记窗口（省得留下没人读的状态）。
    await run('diving 关 + 喊名字 → 不记窗口', {
      inbound: { text: '云玥', segments: [] },
      upstreamMentioned: false,
    }, ({ input, awake }) => injectedAt(input.segments) && awake.size === 0);

    // 14. 拿不到 bot id → 不猜，按上游放行。
    {
      const awake = new Map();
      const originalCalls = [];
      const wrapper = makeMentionProcessInbound({
        original: (input) => { originalCalls.push(input); return Promise.resolve(1); },
        cfg: { enabled: true, logMentions: false, names: DEFAULT_NAMES },
        log: () => undefined,
        note: () => undefined,
        awake,
        detectMentionImpl: () => false,
        now: () => 1_000_000,
      });
      const input = { kind: 'group', chatId: 'group:1', text: '云玥', segments: [{ type: 'text', data: { text: '云玥' } }] };
      await wrapper.call({ ctx: { selfId: () => '', config: { botQQ: '' } } }, input);
      results.push({
        name: 'bot id 未知 → 不注入',
        ok: originalCalls.length === 1 && input.segments.length === 1,
        expect: () => true,
      });
    }

    // 15. 载荷没带段数组（纯 raw）→ 不改写。
    await run('segments 非数组 → 不注入', {
      inbound: { text: '云玥', segments: undefined },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && input.segments === undefined);

    // 16. 开关关掉 → 完全不插手。
    await run('enabled:false → 放行', {
      inbound: { text: '云玥', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { enabled: false },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // ── 话题插话（判据三）────────────────────────────────────────────────
    // 17. 默认关：聊到猫也不理（保守默认值不许被悄悄改掉）。
    await run('topics 默认关 → 聊猫也不接', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 18. 开了 + 命中 + 过概率门 → 注入 at 段，并往正文里加那行说明。
    await run('topics 开 + 聊到猫 → 接话', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal
      && injectedAt(input.segments)
      && input.text.includes('群里在聊「猫」'));

    // 19. 命中但没过概率门 → 不接（「聊到」不等于「必须接」）。
    await run('topics 开 + 掷骰没过 → 不接', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.9,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 20. 没聊到任何方向 → 不动。
    await run('topics 开 + 无关话题 → 不动', {
      inbound: { text: '今天下午三点开会记得带材料', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 21. 太短的消息不判（「猫」一个字不算在聊猫）。
    await run('topics 开 + 消息过短 → 不接', {
      inbound: { text: '猫', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 22. 群白名单：不在名单里的群，聊到也闭嘴。
    await run('topics 开 + 群不在白名单 → 不接', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, chats: ['900000001'] } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 23. 群白名单命中（用户写纯群号也认）。
    await run('topics 开 + 纯群号白名单 → 接话', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [], groupId: '900000001' },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, chats: ['900000001'] } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && injectedAt(input.segments));

    // 24. 自定义关键词组：加了「跑团」就该认。
    await run('topics 自定义关键词 → 命中', {
      inbound: { text: '今晚谁有空跑团啊', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, groups: { 跑团: ['跑团', 'dnd'] } } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && injectedAt(input.segments)
      && input.text.includes('群里在聊「跑团」'));

    // 25. 某组写空数组 = 关掉那一组，但不影响别的组。
    await run('topics 组写空 → 该组不命中', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, groups: { 猫: [] } } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 26. 话题接话会开出活跃窗口 → 下一句无关的话也能续（不用再命中关键词）。
    await run('topics 接话后开窗口', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input, topicAwake }) => injectedAt(input.segments)
      && topicAwake.get('group:1') === 1_600_000);

    // 27. 冷却：刚插过话的群，冷却期内不再插。
    await run('topics 冷却中 → 不接', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
      topicSeed: { 'group:1': { lastAt: 999_000, day: '1970-1-1', count: 1 } },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 28. 每日上限：当天插满 maxPerDay 次后不再插（把冷却绕过去，单独验上限）。
    await run('topics 当日已满 → 不接', {
      inbound: { text: '我家那只橘猫今天又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, cooldownMs: 0, maxPerDay: 2 } },
      randomValue: 0.1,
      topicSeed: { 'group:1': { lastAt: 0, day: '1970-1-1', count: 2 } },
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 29. 安静时段内不插话（1:00–8:00，用 1970-01-01 03:00 那个时刻）。
    {
      const quietWrapper = makeMentionProcessInbound({
        original: (input) => Promise.resolve(input),
        cfg: { enabled: true, logMentions: false, names: DEFAULT_NAMES, topics: { enabled: true } },
        log: () => undefined,
        note: () => undefined,
        awake: new Map(),
        topicState: new Map(),
        random: () => 0.1,
        detectMentionImpl: () => false,
        // 1970-01-01 03:00 本地时间。
        now: () => new Date(1970, 0, 1, 3, 0, 0).getTime(),
      });
      const input = { kind: 'group', chatId: 'group:1', text: '我家那只橘猫今天又拆家了', segments: [] };
      await quietWrapper.call({ ctx: { selfId: () => BOT, config: { botQQ: BOT } } }, input);
      results.push({
        name: 'topics 安静时段 → 不接',
        ok: !injectedAt(input.segments),
        expect: () => true,
      });
    }

    // 30. 话题开出的窗口内，未命中关键词也能续话（不然「一块聊」只准接一句）。
    await run('topics 窗口内续话 → 注入', {
      inbound: { text: '那你说呢', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true, awakeMs: 600000 } },
      topicAwakeSeed: { 'group:1': 1_600_000 },
      randomValue: 0.9,
    }, ({ input, topicAwake }) => injectedAt(input.segments)
      && topicAwake.get('group:1') === 1_600_000);

    // 31. 话题窗口过期 → 重新闭嘴（潜水关着，别把窗口借给潜水用）。
    {
      const topicAwake = new Map([['group:1', 999_000]]);
      const awake = new Map([['group:1', 999_000]]);
      const calls = [];
      const wrapper = makeMentionProcessInbound({
        original: (input) => { calls.push(input); return Promise.resolve(1); },
        cfg: {
          enabled: true,
          logMentions: false,
          names: DEFAULT_NAMES,
          diving: { enabled: false, awakeMs: 300000 },
          topics: { enabled: true, awakeMs: 600000 },
        },
        log: () => undefined,
        note: () => undefined,
        awake,
        topicAwake,
        topicState: new Map(),
        random: () => 0.9,
        detectMentionImpl: () => false,
        now: () => 1_000_000,
      });
      const input = { kind: 'group', chatId: 'group:1', text: '那你说呢', segments: [] };
      await wrapper.call({ ctx: { selfId: () => BOT, config: { botQQ: BOT } } }, input);
      results.push({
        name: 'topics 窗口过期 → 不动',
        ok: calls.length === 1 && !injectedAt(input.segments) && awake.size === 0,
        expect: () => true,
      });
    }

    // 32. 真 @ 她**不**给话题窗口免检：否则一次 @ 就等于给这个群开
    //     10 分钟「随便聊什么她都能接」，退回用户否掉的「群里随意搭话」。
    await run('topics 真 @ 不推话题窗口', {
      inbound: { text: '云玥 你看看', segments: [] },
      upstreamMentioned: true,
      cfgOverride: { topics: { enabled: true } },
    }, ({ viaOriginal, topicAwake }) => viaOriginal && topicAwake.size === 0);

    // 33. `[文件:猫.jpg]` 里的文件名不算「在聊天」——2026-10-17 用户担心
    //     「我们发表情会被误判」时查出来的唯一真口子。
    await run('topics 文件名带关键词 → 不接', {
      inbound: { text: '[文件:猫.jpg]', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input, viaOriginal }) => viaOriginal && !injectedAt(input.segments));

    // 34. 但同一句里真有聊天内容时照常命中（只是把 `[文件:…]` 抠掉）。
    await run('topics 文件占位符 + 真聊到 → 照接', {
      inbound: { text: '[文件:猫.jpg] 我家这只橘猫又拆家了', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ input }) => injectedAt(input.segments)
      && input.text.includes('群里在聊「猫」'));

    // 35. 表情的 emoji 渲染不带关键词，不该被误判。
    await run('topics 表情 emoji → 不接', {
      inbound: { text: '[表情包] 哈哈哈', segments: [] },
      upstreamMentioned: false,
      cfgOverride: { topics: { enabled: true } },
      randomValue: 0.1,
    }, ({ viaOriginal }) => viaOriginal);

    return { ok: true, cases: results };
  }

  /** 当前醒着的群数（放进 status，便于看出潜水状态）。 */
  function awakeNow() {
    return awakeCount(awake, Date.now());
  }

  /** 话题插话的配额快照（放进 status，便于回答「为什么她没接话」）。 */
  function topicSnapshot() {
    const out = {};
    for (const [chatId, st] of topicState) {
      out[chatId] = { ...st };
    }
    return out;
  }

  return { MODULE_ID, scan, detach, selfTest, awakeNow, topicSnapshot, METHODS, TARGET };
}

/** 默认配置（由 index.js 汇总，这里只声明本模块的键）。 */
export const DEFAULTS = {
  enabled: true,
  /** 在群里被叫到的名字。空数组 = 关掉「叫名字」这条判据。 */
  names: [...DEFAULT_NAMES],
  /**
   * 潜水模式：默认关。开了之后，被叫醒的一小段时间里群里不 @ 她也会插话 ——
   * 那会推高发言频率，所以留给用户按群开。
   */
  diving: { enabled: false, awakeMs: DEFAULT_AWAKE_MS },
  /**
   * 话题插话：默认关，见文件头「缺省是保守的」。开了之后，群里聊到她感兴趣
   * 的方向时她会自己接一句（同样受掷骰、冷却、每日上限、安静时段约束）。
   */
  topics: { ...DEFAULT_TOPICS },
  /** 命中/续话时是否写一条宿主 debug 日志。 */
  logMentions: true,
};
