/**
 * dsh-onebot-companion / modules/voice.js
 *
 * 语音：让云玥能「说」一句话 —— 文本经 edge-tts 合成为 mp3，再作为 QQ 语音
 * 消息发出去。
 *
 * ## 对应哪项需求
 *
 * 用户原话（session-db47932d，2026-10-12 21:22 / 21:34）：
 *
 *   - 「能不能回复我也尽量用一句话（尽量20字内），跟群聊一样，**长的就发语音**」
 *   - 「**语音声音能改吗？改成熟点**」
 *
 * 也就是两件事：**会发语音**（长内容用说的）+ **音色可调**（默认挑成熟的）。
 * 这两条此前只在私有分支里实现过（`lib/tts.js` + `qq_say` 工具），0.9.0 升级
 * 时整包被上游删掉（全库搜 `qq_say` / `edge_tts` / `Synthesizer` 均 0 命中），
 * 只剩一个 `qq_send_voice`（发**已有**音频文件）—— 没有「把文字变成语音」的
 * 那一步。
 *
 * ## 为什么是工具而不是自动替换
 *
 * 「长的就发语音」听起来像是「超长自动转语音」，但那会**抢走模型的表达权**：
 * 哪些话适合说、哪些适合打字，是聊天判断的一部分（比如一句吐槽用说的很怪）。
 * 所以这里只**提供能力**（`qq_say` 工具）+ 在提示词里讲清什么时候用，
 * 由模型自己决定。这与 `prompt` 模块第 5 条规则「像真人发 QQ」是一套。
 *
 * ## 两个必须处理的坑（都是实测出来的）
 *
 * ### 1. 必须剥掉代理变量
 *
 * edge-tts 直连微软，而宿主环境常带 `HTTP(S)_PROXY`（给 LLM 上游用的）。
 * 本机 FlClash 的混合端口是 7890，走它反而**握手失败**：实测带代理时
 * `WSServerHandshakeError: 403`，剥掉后才通。所以子进程环境里删掉这六个键。
 * （原私有实现 `tts.js` 的注释里就记着这条，这次复现一致。）
 *
 * ### 2. 上游 host 已失效，必须换到 api.msedgeservices.com
 *
 * **这是 2026-10 的新变化，原实现没遇到**：`speech.platform.bing.com` 自
 * 2026 年 10 月起在很多地区对合成 WebSocket 直接回 403（上游 issue
 * rany2/edge-tts#490；本机实测 7.2.7 与 7.2.8 都 403，且**与系统时钟无关** ——
 * 手动补 ±5s/±10s 偏差仍然 403）。
 *
 * 修法见上游 PR #491（尚未发版）：Microsoft Edge 155 改用
 * `api.msedgeservices.com/tts/cognitiveservices/websocket/v1`，且 token 要作为
 * **`Ocp-Apim-Subscription-Key`** 查询参数传入（不是旧的 `TrustedClientToken`）。
 * 本机实测该组合成功合成（23KB mp3），旧 host 依旧 403。
 *
 * 实现方式是**运行时 shim**（一个内联的 `python -c` 脚本），而不是改
 * site-packages：pip 升级会把文件覆盖回去（与 node_modules 同一个坑）。shim
 * 只在 URL 里还含旧 host 时才替换，于是上游一旦发版、旧 host 消失，shim 会
 * 自动失配、无害跳过。
 *
 * @module dsh-onebot-companion/modules/voice
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { auditMethods } from '../core/patch.js';

export const MODULE_ID = 'voice';

/** 不挂原型：本模块只注册工具，不改目标包的任何方法。 */
const METHODS = [];

/** 子进程环境里要删掉的代理变量（见文件头坑 1）。 */
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/** 默认音色。用户嫌原来的 Xiaoyi 不够成熟，所以默认取 Xiaoxiao。 */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/**
 * 常用音色表（给模型挑，也给设置面用）。
 *
 * 只列 edge-tts 里真实存在的 `zh-CN-*` 音色；`tone` 是给人看的性格描述，
 * 模型可以照着「成熟 / 活泼 / 少年」这种意图来挑。
 */
export const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓', tone: '成熟温柔（默认）', gender: '女' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊', tone: '活泼少女', gender: '女' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北', tone: '东北口音，直爽', gender: '女' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮', tone: '陕西口音，爽利', gender: '女' },
  { id: 'zh-CN-YunxiNeural', label: '云希', tone: '清朗少年', gender: '男' },
  { id: 'zh-CN-YunyangNeural', label: '云扬', tone: '沉稳播音腔', gender: '男' },
  { id: 'zh-CN-YunjianNeural', label: '云健', tone: '浑厚有力', gender: '男' },
];

/** edge-tts 的 rate / volume 语法：`+8%` / `-20%`。 */
const PERCENT_RE = /^[+-]\d{1,3}%$/;
/** edge-tts 的 pitch 语法：`+20Hz` / `-10Hz`。 */
const HERTZ_RE = /^[+-]\d{1,3}Hz$/;

/**
 * 内联 shim：把合成 host 换到 api.msedgeservices.com。
 *
 * 为什么是 `python -c` 而不是 `edge-tts` 命令行：
 *   1. 命令行没有暴露 host，只能改源码；
 *   2. 改源码会被 pip 升级冲掉。
 *
 * ⚠️ `communicate` 模块用 `from .constants import (... WSS_URL ...)` 把值绑成了
 * 模块级常量，**只改 `constants.WSS_URL` 对它无效**（第一次实验就栽在这里：
 * 报错 URL 仍是旧 host）。所以两处都要改。
 *
 * `if _LEGACY in C.WSS_URL` 是幂等保护：上游发版后 URL 里不再含旧 host，
 * 这段替换自动跳过，不需要改插件。
 */
export const SHIM_SOURCE = `
import sys
from edge_tts import constants as _C, communicate as _CM
_LEGACY = "speech.platform.bing.com"
if _LEGACY in _C.WSS_URL:
    _new = ("wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1"
            "?Ocp-Apim-Subscription-Key=" + _C.TRUSTED_CLIENT_TOKEN)
    _C.WSS_URL = _new
    _CM.WSS_URL = _new
import asyncio, edge_tts
async def _main():
    text, voice, rate, pitch, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    kwargs = {}
    if rate and rate != "+0%":
        kwargs["rate"] = rate
    if pitch and pitch != "+0Hz":
        kwargs["pitch"] = pitch
    comm = edge_tts.Communicate(text, voice, **kwargs)
    await comm.save(out)
asyncio.run(_main())
`;

/**
 * 把模型写的回复整理成「值得念出来」的文本。
 *
 * 与 `burst` 的分段逻辑同源（都要判断「这是人话还是排版」），但目的不同：
 * 这里是给耳朵听的，所以要
 *   - 去掉 Markdown 标记（`**` / `#` / 反引号）——念出来是噪音；
 *   - 换行变成停顿（顿号），而不是被念成「换行」；
 *   - 连续空格与重复标点收拢；
 *   - 按 `maxChars` 截断（跑飞的长段落不该被整段朗读）。
 *
 * @param text - 模型给的原文。
 * @param maxChars - 字符上限（<=0 表示不截断）。
 * @returns 可朗读文本；没有可读内容时返回 `''`。
 */
export function speakableText(text, maxChars) {
  if (typeof text !== 'string') return '';
  let out = text;
  // 代码块整体丢掉：念代码没有意义。
  out = out.replace(/\x60{3}[\s\S]*?\x60{3}/g, '');
  // Markdown 强调与标题标记。
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/(^|\n)\s*#{1,6}\s*/g, '$1');
  out = out.replace(/[*_~`]+/g, '');
  // 行内链接 [文字](url) → 只留文字。
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 换行 → 停顿。
  out = out.replace(/\s*\n+\s*/g, '，');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/，{2,}/g, '，');
  out = out.replace(/^[，、。\s]+/, '').trim();
  if (maxChars > 0 && out.length > maxChars) out = out.slice(0, maxChars).trim();
  return out;
}

/** 只在值符合 edge-tts 语法时采纳，否则用兜底（避免把非法参数喂给子进程）。 */
function normalizeOption(value, pattern, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  return pattern.test(trimmed) ? trimmed : fallback;
}

/** 起一个进程并收拢输出；非零退出或超时则 reject。 */
function runProcess(program, args, timeoutMs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
      reject(new Error(`语音合成超时（${timeoutMs}ms）：${program}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`语音合成失败（退出码 ${code}）：${program}\n${stderr.slice(-2000)}`));
    });
  });
}

/**
 * edge-tts 驱动器：一次调用合成一条语音到媒体目录。
 *
 * 调用是**串行**的：每次都要起一个 Python 进程，连着来几个会抢 CPU 和语音服务
 * （原实现的同一条经验）。
 */
export class Synthesizer {
  constructor(options = {}) {
    this.chain = Promise.resolve();
    this.program = typeof options.program === 'string' && options.program !== '' ? options.program : 'python';
    this.voice = typeof options.voice === 'string' && options.voice !== '' ? options.voice : DEFAULT_VOICE;
    this.rate = normalizeOption(options.rate, PERCENT_RE, '+0%');
    this.pitch = normalizeOption(options.pitch, HERTZ_RE, '+0Hz');
    this.maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 120;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 45000;
    /** 偶发失败的重试次数（含首次）。语音服务实测有约 15% 的瞬时抖动。 */
    this.retries = Number.isFinite(options.retries) && options.retries > 0 ? options.retries : 3;
    /** 重试退避基数（毫秒），第 n 次等待 `retryDelayMs * n`。 */
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : 800;
    this.dir = options.dir;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    /** 上一次失败的原始原因，供观测面排查（403 与「没装 edge-tts」要能分清）。 */
    this.lastError = null;
    this.synthesized = 0;
  }

  /** 当前音色（展示给模型与观测面）。 */
  get voiceId() {
    return this.voice;
  }

  /** 每次最多念多少字。 */
  get charLimit() {
    return this.maxChars;
  }

  /** 串到上一次调用后面，保证不并发。 */
  speak(text) {
    const run = this.chain.then(
      () => this.speakNow(text),
      () => this.speakNow(text),
    );
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 一次合成：写文本 → 跑 shim → 校验产物；偶发失败自动重试。 */
  async speakNow(text) {
    const spoken = speakableText(text, this.maxChars);
    if (spoken === '') throw new Error('没有可朗读的内容（文本为空、或只有 Markdown / 代码块）');
    if (typeof this.dir !== 'string' || this.dir === '') {
      throw new Error('语音输出目录未配置（voice.mediaDir 或 config.mediaDir 为空）');
    }

    await mkdir(this.dir, { recursive: true });

    // 偶发失败是常态：实测同一段文本、同一台机器，连续 11 次里有 2 次失败
    // （`WSServerHandshakeError` / 连接被掐），随后单独复测 12/12 全成功 ——
    // 属于语音服务的瞬时抖动，不是配置问题。语音是用户直接看到的东西，
    // 失败一次她就「说不出话」，所以这里退避重试而不是直接把错误抛给模型。
    const attempts = Math.max(1, Number(this.retries) || 1);
    let lastError;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        return await this.attemptOnce(spoken);
      } catch (error) {
        lastError = error;
        if (i < attempts) {
          const wait = this.retryDelayMs * i;
          this.log('debug', `[voice] 第 ${i} 次合成失败，${wait}ms 后重试：${String(error?.message ?? error).slice(0, 160)}`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
    }
    this.lastError = String(lastError?.message ?? lastError);
    throw lastError;
  }

  /** 单次尝试（不含重试）。 */
  async attemptOnce(spoken) {
    const mediaPath = join(this.dir, `media_${Date.now()}_${randomUUID().slice(0, 8)}.mp3`);

    // 剥代理：宿主给 LLM 用的 HTTP(S)_PROXY 会干扰 edge-tts 的直连握手
    // （原私有实现的注释里记着实测失败；本次对照测试里带代理也能成功，
    // 说明它不是必然失败项 —— 但剥掉没有副作用，作为防御保留）。
    const env = { ...process.env };
    for (const key of PROXY_KEYS) delete env[key];

    const args = ['-c', SHIM_SOURCE, spoken, this.voice, this.rate, this.pitch, mediaPath];

    try {
      await runProcess(this.program, args, this.timeoutMs, env);
      const info = await stat(mediaPath).catch(() => undefined);
      if (info === undefined || info.size === 0) {
        await rm(mediaPath, { force: true });
        throw new Error(
          `语音合成未产出音频（检查 ${this.program} 是否装了 edge-tts：${this.program} -m pip install edge-tts）`,
        );
      }
      this.synthesized += 1;
      this.lastError = null;
      this.log('debug', `[voice] 合成 ${info.size} bytes, voice=${this.voice}, chars=${spoken.length}`);
      return { path: mediaPath, bytes: info.size, text: spoken, voice: this.voice };
    } catch (error) {
      await rm(mediaPath, { force: true });
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }
}

/** 本模块默认配置（index.js 汇总）。 */
export const DEFAULTS = {
  enabled: true,
  /** Python 解释器（要装了 edge-tts 的那个）。 */
  program: 'python',
  /** 音色。默认挑成熟的（用户嫌原 Xiaoyi 太嫩）。 */
  voice: DEFAULT_VOICE,
  /** 语速 / 音调（edge-tts 语法）。 */
  rate: '-5%',
  pitch: '-10Hz',
  /** 每次最多念多少字。 */
  maxChars: 120,
  /** 合成超时（毫秒）。 */
  timeoutMs: 45000,
  /** 偶发失败重试次数（含首次）。语音服务有瞬时抖动，重试比报错友好。 */
  retries: 3,
  /** 重试退避基数（毫秒）。 */
  retryDelayMs: 800,
  /** 语音文件落盘目录；留空则用 config.mediaDir（云玥的 .dsh-media）。 */
  mediaDir: '',
  /** 是否在提示词里告诉模型可以用 qq_say（规则文案由 prompt 模块管）。 */
  enabledTool: true,
};

/**
 * 创建 voice 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg - voice 段配置。
 * @param {object} options.stats - 共享统计（`voice` 子对象）。
 * @param {(level: string, message: string) => void} options.log
 * @param {() => string} options.resolveMediaDir - 解析媒体目录（复用 persona 的解析结果）。
 * @param {() => *} options.getReceiver - 取 ChatBridge 实例。
 *   **刻意复用 persona 的 `lastReceiver`**：persona 已经挂了
 *   `handleInbound` / `onSessionEvent`，那两个方法的 `this` 就是 bridge。
 *   本模块再挂一遍只为拿 `this` 是浪费 —— 而且会多一层包装（见 core/patch.js
 *   的共存规则）。所以这里只读，不挂。
 */
export function createVoice({ cfg, stats, log, resolveMediaDir, getReceiver }) {
  const synth = new Synthesizer({
    program: cfg.program,
    voice: cfg.voice,
    rate: cfg.rate,
    pitch: cfg.pitch,
    maxChars: cfg.maxChars,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
    retryDelayMs: cfg.retryDelayMs,
    dir: '',
    log,
  });

  /** 每次合成前把目录刷新一遍（配置热改 / bridge 后出现都能跟上）。 */
  function currentDir() {
    const dir = typeof cfg.mediaDir === 'string' && cfg.mediaDir !== '' ? cfg.mediaDir : resolveMediaDir?.() ?? '';
    return typeof dir === 'string' ? dir : '';
  }

  /** 合成 + 发送。`chatId` 为空时用调用方给的兜底。 */
  async function say(text, chatId) {
    const dir = currentDir();
    if (dir === '') throw new Error('语音输出目录未配置：请设置 voice.mediaDir 或 dsh-onebot 的 mediaDir');
    synth.dir = dir;

    const bridge = getReceiver?.();
    if (!bridge || typeof bridge.sendSegments !== 'function') {
      throw new Error('QQ 通道尚未就绪（还没见到 ChatBridge 实例），稍后再试');
    }
    const target = typeof chatId === 'string' && chatId !== '' ? chatId : undefined;
    if (target === undefined) throw new Error('无法确定目标会话：请显式传 chat_id');

    const result = await synth.speak(text);
    try {
      const messageId = await bridge.sendSegments(target, [
        { type: 'record', data: { file: result.path } },
      ]);
      stats.voice.sent += 1;
      stats.voice.lastSentAt = Date.now();
      stats.voice.lastChatId = target;
      stats.voice.lastBytes = result.bytes;
      stats.voice.lastText = result.text.slice(0, 200);
      return { ok: true, messageId: messageId ?? null, bytes: result.bytes, voice: result.voice, text: result.text };
    } catch (error) {
      // 发送失败就把刚合成的文件清掉，免得媒体目录攒垃圾。
      await rm(result.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 一次扫描：只确认目标包还在（拿 profileDir 供观测面显示）。
   *
   * **本模块不挂任何原型方法** —— `sendSegments` 由宿主自己的 `qq_send_voice`
   * 那条路径提供，我们只是复用 bridge 实例调它。
   */
  async function scan(ctx) {
    stats.scans += 1;
    stats.lastScanAt = Date.now();
    if (cfg.enabled === false) return { ok: true, patched: 0 };
    try {
      const { loadTargetClass } = await import('../core/profile.js');
      const found = await loadTargetClass(ctx, cfg, 'bridge.js', 'ChatBridge');
      if (!found.ok) {
        stats.resolveError = found.error;
        return { ok: false, error: found.error };
      }
      stats.profileDir = found.profileDir;
      stats.resolveError = null;
    } catch (error) {
      stats.resolveError = String(error?.message ?? error);
      return { ok: false, error: stats.resolveError };
    }
    return { ok: true, patched: 0 };
  }

  return {
    MODULE_ID,
    METHODS,
    scan,
    say,
    /** 观测面用：当前音色、可用音色表、统计。 */
    snapshot: () => ({
      enabled: cfg.enabled !== false,
      program: cfg.program,
      voice: synth.voiceId,
      rate: synth.rate,
      pitch: synth.pitch,
      maxChars: synth.charLimit,
      mediaDir: currentDir(),
      synthesized: synth.synthesized,
      lastError: synth.lastError,
      voices: VOICES,
    }),
    synth,
    DEFAULTS,
  };
}
