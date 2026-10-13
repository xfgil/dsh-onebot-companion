/**
 * 说话风格画像（style）：从聊天里离线学习「对方平时怎么说话」。
 *
 * 设计要点（对齐 mood.js 的约束）：
 * - 零 import、纯函数：不改入参、不读写文件、不打印、不调网络，可用裸 node 单测。
 * - 不做语义理解、不调用模型：只统计可数的语感特征（句长、语气词、标点、
 *   emoji），再留几条真实原话当样本。这样绝不会幻觉出对方没说过的口癖。
 * - 画像只描述「对方怎么说话」，不描述「你是谁」——人设归人设，语感归语感。
 */

/** 一条消息最多贡献多少个字符的长度统计（超长的粘贴内容不该拉高平均句长）。 */
export const STYLE_MAX_COUNTED_CHARS = 120;
/** 原话样本最多留几条 / 每条最长多少字符（注入提示词的预算）。 */
export const STYLE_MAX_SAMPLES = 3;
export const STYLE_MAX_SAMPLE_CHARS = 40;
/** 语气词表的容量上限：只留最常用的若干个，防止长尾把提示词撑爆。 */
export const STYLE_MAX_PARTICLES = 12;
/** 单条消息里同一个语气词最多计几次（「哈哈哈哈哈哈」不该算 6 次）。 */
const PARTICLE_CAP_PER_MESSAGE = 3;
/** 单条消息最多计多少个 emoji。 */
const EMOJI_CAP_PER_MESSAGE = 5;

/**
 * 常见语气词 / 口头禅候选表。只统计表内命中项——比自动切词稳，不会把
 * 「今天天气」这种普通词组当成口癖。
 */
export const PARTICLE_CANDIDATES = [
    '哈哈', '哈哈哈', '嘿嘿', '嘻嘻', '呵呵', '笑死', '笑死我', '草', '卧槽', '我靠', '淦',
    '嗯嗯', '嗯', '哦哦', '哦', '啊这', '啊', '呀', '诶', '唉', '哎', '唔', '呃', 'emmm', 'emmm',
    '嘛', '呢', '吧', '啦', '咯', '咧', '哟', '哈', '嘿',
    '好家伙', '绝了', '离谱', '救命', '牛', '牛逼', '牛批', '6', '太6了', '麻了', '绷不住',
    '确实', '真的', '话说', '话说回来', '反正', '话说',
    '喵', '呜', '呜呜', '呜呜呜', '哼', '嘤',
];

const PUNCTUATION_CHARS = ['。', '！', '？', '…', '~', '～', '!', '?', '，', ',', '、'];

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** 造一份空的风格画像。 */
export function createStyleProfile() {
    return {
        samples: 0,
        totalChars: 0,
        particles: {},
        punctuation: {},
        emoji: 0,
        emojiMessages: 0,
        samples_: [],
        updatedAt: 0,
    };
}

/** 从一条消息里数出各语气词出现次数（同一词单条最多计 PARTICLE_CAP_PER_MESSAGE 次）。 */
function countParticles(text) {
    const out = {};
    for (const word of PARTICLE_CANDIDATES) {
        let from = 0;
        let count = 0;
        while (count < PARTICLE_CAP_PER_MESSAGE) {
            const at = text.indexOf(word, from);
            if (at === -1) break;
            count += 1;
            from = at + word.length;
        }
        if (count > 0) out[word] = count;
    }
    return out;
}

/** 从一条消息里数出标点使用情况。 */
function countPunctuation(text) {
    const out = {};
    for (const char of PUNCTUATION_CHARS) {
        let count = 0;
        let from = 0;
        while (true) {
            const at = text.indexOf(char, from);
            if (at === -1) break;
            count += 1;
            from = at + char.length;
        }
        if (count > 0) out[char] = count;
    }
    return out;
}

/**
 * 把一条对方发来的消息并入画像。返回**新的**画像对象（不改入参）。
 * @param profile - 现有画像（可为 undefined，按空画像处理）。
 * @param text - 消息正文（已去掉框架包裹的纯文本）。
 * @param now - 当前时刻（毫秒）。
 * @param options - `{ sample: false }` 时不记入原话样本（群聊里陌生人的话
 *   不适合当「对方语感」样本）。
 */
export function mergeStyleSample(profile, text, now, options = {}) {
    const base = profile === undefined || profile === null ? createStyleProfile() : profile;
    if (typeof text !== 'string') return base;
    const body = text.trim();
    if (body === '') return base;
    // 纯占位符（[图片] / [语音] / [卡片] …）没有语感信息，不参与统计。
    const meaningful = body.replace(/\[[^\]]{0,40}\]/g, '').trim();
    if (meaningful === '') return base;
    const counted = meaningful.slice(0, STYLE_MAX_COUNTED_CHARS);
    const next = {
        samples: base.samples + 1,
        totalChars: base.totalChars + counted.length,
        particles: { ...base.particles },
        punctuation: { ...base.punctuation },
        emoji: base.emoji,
        emojiMessages: base.emojiMessages,
        samples_: [...base.samples_],
        updatedAt: now,
    };
    const particles = countParticles(meaningful);
    for (const [word, count] of Object.entries(particles)) {
        next.particles[word] = (next.particles[word] ?? 0) + count;
    }
    const punctuation = countPunctuation(meaningful);
    for (const [char, count] of Object.entries(punctuation)) {
        next.punctuation[char] = (next.punctuation[char] ?? 0) + count;
    }
    const emojiCount = (meaningful.match(EMOJI_RE) ?? []).length;
    if (emojiCount > 0) {
        next.emoji += Math.min(emojiCount, EMOJI_CAP_PER_MESSAGE);
        next.emojiMessages += 1;
    }
    if (options.sample !== false) {
        const sample = meaningful.replace(/\s+/g, ' ').slice(0, STYLE_MAX_SAMPLE_CHARS);
        // 同样的原话只留最新那一次，避免样本被同一句复读占满。
        next.samples_ = [...next.samples_.filter(entry => entry !== sample), sample]
            .slice(-STYLE_MAX_SAMPLES);
    }
    return next;
}

/** 画像里出现最多的语气词，按次数降序取前 limit 个。 */
export function topParticles(profile, limit = STYLE_MAX_PARTICLES) {
    if (profile === undefined || profile === null) return [];
    return Object.entries(profile.particles ?? {})
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, limit)
        .map(([word, count]) => ({ word, count }));
}

/**
 * 把画像渲染成一行注入提示词的中文描述；样本太少（< 3 条）时返回 ''，
 * 让提示词保持干净——刚认识就说「我学会了你说话的方式」很怪。
 * 恒不含花括号（宿主 prompt 插值器会把 {{name}} 当变量引用并抛错）。
 */
export function stylePromptLine(profile) {
    if (profile === undefined || profile === null) return '';
    const samples = typeof profile.samples === 'number' ? profile.samples : 0;
    if (samples < 3) return '';
    const average = profile.totalChars / samples;
    const parts = [];
    if (average <= 4) parts.push('他打字极短，经常两三个字就发出来');
    else if (average <= 10) parts.push('他一句平均 ' + Math.round(average) + ' 个字，习惯短句');
    else if (average <= 25) parts.push('他一句平均 ' + Math.round(average) + ' 个字');
    else parts.push('他习惯一次说挺长一段（平均 ' + Math.round(average) + ' 个字）');
    const particles = topParticles(profile, 6);
    if (particles.length > 0) {
        parts.push('口头禅是' + particles.map(entry => '「' + entry.word + '」').join(''));
    }
    const punctuationTotal = Object.values(profile.punctuation ?? {}).reduce((sum, n) => sum + n, 0);
    if (punctuationTotal / samples < 0.2) parts.push('基本不打标点');
    else {
        const favourite = Object.entries(profile.punctuation ?? {}).sort((l, r) => r[1] - l[1])[0];
        if (favourite !== undefined && favourite[1] >= 3) parts.push('爱用「' + favourite[0] + '」');
    }
    if (profile.emojiMessages > 0 && profile.emojiMessages / samples >= 0.3) parts.push('常带 emoji');
    let text = '- **对方平时这么说话**（从你们聊过的 ' + samples + ' 条消息里总结的）：' + parts.join('，') + '。';
    const samples_ = Array.isArray(profile.samples_) ? profile.samples_ : [];
    if (samples_.length > 0) {
        text += '他最近的原话像这样：' + samples_.map(entry => '「' + entry + '」').join('');
    }
    text += '**回话时顺着他的语感来**——他用什么调子你就用什么调子，别端着一副书面腔，也别为了迎合就丢掉自己的性格。\n';
    return text;
}
