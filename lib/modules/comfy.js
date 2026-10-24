/**
 * dsh-onebot-companion / modules/comfy.js
 *
 * 让她自己画一张图 —— 接本地 ComfyUI 的 HTTP API（2026-10-22）。
 *
 * ## 为什么做这个
 *
 * 起因是当时提的建议：现有表情不够用，不如装个 ComfyUI 随便画。
 * 她要的不是「调接口出图」，是**能在聊天里顺手甩一张自己画的**。
 *
 * ## ComfyUI 侧的前提（都实测过）
 *
 * - 装在 `D:\ruanjian\ComfyUI`，独立 venv，torch cu128 + RTX 4060（8G）。
 * - 启动：`venv\Scripts\python.exe main.py --port 8188 --listen 127.0.0.1`
 * - 底模 `models/checkpoints/v1-5-pruned-emaonly.safetensors`（SD1.5，4GB）。
 * - 提交 `POST /prompt`，轮询 `GET /history/{prompt_id}`，
 *   图落在 `output/` 下。实测 512×512 / 20 步 / 8.1 秒。
 *
 * ## 三个设计取舍
 *
 * 1. **工作流写死在代码里，不读用户导出的 workflow.json**。SD1.5 那套
 *    节点（CheckpointLoaderSimple → CLIPTextEncode ×2 → EmptyLatentImage →
 *    KSampler → VAEDecode → SaveImage）是稳定的，写死的好处是不依赖
 *    她在盘上放的任何文件 —— 用户换个底模只要改 `ckptName`。
 *
 * 2. **轮询而不是 WebSocket**。ComfyUI 的实时进度走 ws，但那要额外一条连接
 *    和一套握手；画一张八秒的图，1 秒一次轮询足够，而且失败模式简单得多。
 *
 * 3. **超时纪律**。8G 显存跑 SDXL 会爆、模型第一次加载要几十秒，所以
 *    `timeoutMs` 默认给 180 秒，参数里另外把 `steps` 夹在 [1, 60]、
 *    尺寸夹在 [256, 1024] 并**对齐到 8 的倍数**（SD 的 latent 要求）。
 *
 * ## 它不做什么
 *
 * 不自动发到聊天里 —— 那是 `qq_send_image` 的事。这里只负责「画出来、落盘、
 * 把路径交出去」。这样她在群里（被 isolation 限成只能发声的）不会被这条工具
 * 绕过去往外发图。
 *
 * @module dsh-onebot/comfy
 */

/**
 * 「她自己」的固定形象描述 —— 每个预设都拼在它后面。
 *
 * 这条是**基准**，改它等于改她长什么样。2026-10-22 实测：白毛 + 短 + 猫耳 +
 * 红蓝异瞳在这个底模（Counterfeit V2.5）上很稳，四条一起写就出得来。
 */
export const SELF_ANCHOR = [
  '1girl',
  'white hair',
  'short hair',
  '(cat ears:1.2)',
  '(heterochromia:1.5)',
  '(one red eye:1.4)',
  '(one blue eye:1.4)',
].join(', ');

/**
 * 表情包预设（2026-10-22）。
 *
 * ## 为什么要有预设
 *
 * 用户问「画应景的表情怎么样」。手试了三轮才摸对：
 *
 *   1. 只写 `chibi, sticker` → 出来一张**全身立绘**，完全不是表情包；
 *   2. 加上 `head focus` / `bust shot`，再把 `full body` / `cowboy shot`
 *      塞进负面 → 头肩景对了，但背景还是场景（云、海、星空）；
 *   3. 加 `(pure white background:1.4)` 并负面掉 `scenery, sky, clouds` →
 *      终于是一张能当表情包用的白底头肩图。
 *
 * 这三轮的经验如果只留在会话里，下次还得重来一遍。所以固化成预设：
 * 每个预设 = 一句情绪描述，其余（构图、白底、形象、负面）全部共用。
 *
 * ## 为什么表情词写得这么「标准」
 *
 * SD1.5 时代的标签全靠 danbooru 那套词汇。写「有点不高兴」它看不懂，
 * 写 `pouting, puffed cheeks, blush` 它立刻懂。所以每个预设下面都附了
 * 原始标签 —— 想加新预设就照这个粒度写。
 */
export const FACE_PRESETS = Object.freeze({
  happy: 'happy, big smile, closed eyes, blush, arms up, peace sign',
  smug: 'smug, half-closed eyes, smirk, confident, looking at viewer',
  cry: 'crying, streaming tears, sad, trembling lip, big watery eyes',
  angry: 'angry, puffed cheeks, blush, pouting, frown',
  shock: 'shocked, wide eyes, open mouth, sweat drop, surprised',
  sleepy: 'sleepy, half-closed eyes, yawning, tired, dazed',
  think: 'thinking, hand on chin, raised eyebrow, puzzled',
  shy: 'shy, blushing heavily, looking away, embarrassed smile',
});

/**
 * 表情包/头肩像共用的构图前缀（2026-10-22 三轮试出来的那条）。
 *
 * `sticker` 与 `white outline` 给一点贴纸感；`head focus` + `bust shot`
 * 压住构图；白底与负面里的 `scenery/sky/clouds` 一起保证背景干净。
 */
export const FACE_FRAMING = [
  'masterpiece, best quality',
  '(sticker:1.2), (white outline:1.2)',
  '(head focus:1.3), (bust shot:1.3), close-up, portrait, face detail',
  '(pure white background:1.4), simple background',
].join(', ');

/** 表情包专用负面：比通用那套额外禁掉全身景与背景场景。 */
export const FACE_NEGATIVE = [
  '(worst quality, low quality:1.4), lowres, bad anatomy, blurry',
  'watermark, signature, text',
  '(full body:1.4), (cowboy shot:1.3), standing, wide shot',
  'realistic, photorealistic, multiple views, comic panel, deformed, ugly, extra limbs',
  'yellow eyes, green eyes, same color eyes, orange eyes',
  'dark background, scenery, sky, clouds',
].join(', ');

/**
 * 从一个表情预设组出完整提示词（纯函数，给自测钉住）。
 *
 * @param {string} preset - `FACE_PRESETS` 的键
 * @param {string} [extra] - 追加的自由描述
 * @returns {{ok:boolean, prompt?:string, negative?:string, reason?:string}}
 */
export function facePromptOf(preset, extra = '') {
  const key = typeof preset === 'string' ? preset.trim() : '';
  const emotion = FACE_PRESETS[key];
  if (typeof emotion !== 'string') {
    return { ok: false, reason: `没有这个表情预设：${key || '(空)'}` };
  }
  const tail = typeof extra === 'string' ? extra.trim() : '';
  return {
    ok: true,
    prompt: `${FACE_FRAMING}, ${SELF_ANCHOR}, ${emotion}${tail === '' ? '' : `, ${tail}`}`,
    negative: FACE_NEGATIVE,
  };
}

export const MODULE_ID = 'comfy';

export const DEFAULTS = Object.freeze({
  /**
   * 默认开 —— 用户明确要这个功能（「给你个整 comfyUI 耍」）。
   * ComfyUI 没在跑的时候工具会老实报「连不上」，不会静默失败。
   */
  enabled: true,
  /** ComfyUI 的地址。默认本机 8188。 */
  baseUrl: 'http://127.0.0.1:8188',
  /**
   * 底模文件名（必须在 ComfyUI 的 models/checkpoints 或 extra_model_paths 里）。
   *
   * 2026-10-23 第三次换：**WAI-illustrious-SDXL v17**（6.6GB，SDXL 架构）。
   *
   * 三代底模的演进，每一步都是因为上一代真不够用：
   *   1. 原版 SD1.5 —— 画人脸往写实靠，用户看了直说「恐怖谷」；
   *   2. Counterfeit-V2.5 —— 动漫风对了，但 512 尺寸画不出细节，脸糊；
   *   3. WAI-illustrious —— Illustrious 是 2024-2025 的动漫底模，SDXL 架构，
   *      832×1216 原生分辨率。实测猫耳、红蓝异瞳、发丝、布纹全都干净，
   *      而且**不需要**堆一长串负面词去救。代价是 32 秒一张（还是比云端快）。
   *
   * 模型放在 **E 盘**（`E:\ruanjian\comfy-models\checkpoints`），通过
   * `ComfyUI/extra_model_paths.yaml` 挂进来 —— 按用户的落盘约定，模型这种
   * 冷数据不该占 D 盘。老模型都还在，改这一行就能换回去。
   */
  ckptName: 'waiIllustriousSDXL_v170.safetensors',
  /** 默认尺寸与步数。SDXL 原生 1024 系，竖图 832×1216 最稳（且 8G 显存扛得住）。 */
  width: 832,
  height: 1216,
  steps: 28,
  /**
   * SDXL / Illustrious 那套的 cfg 惯例是 **5~7**，比 SD1.5 的 7~8 低。
   * 调高会把画面推成塑料感，猫耳那种软边也会变硬。
   */
  cfg: 5.5,
  samplerName: 'euler_ancestral',
  scheduler: 'normal',
  /** 负面提示词的兜底值（Illustrious / SDXL 风格）。 */
  negative:
    'worst quality, low quality, bad quality, normal quality, '
    + 'lowres, blurry, jpeg artifacts, watermark, signature, text, '
    + 'bad anatomy, bad hands, extra limbs, missing fingers, '
    + 'realistic, photorealistic, 3d, '
    + 'yellow eyes, green eyes, same color eyes',
  /** 整张图的超时（含排队与首次加载模型）。 */
  timeoutMs: 180000,
  /** 轮询间隔。 */
  pollMs: 1000,
  /** 出图后最多往回等多久让它落盘。 */
  grabWaitMs: 5000,
});

/** 把数字夹进区间。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** SD 的 latent 要求尺寸是 8 的倍数。 */
function align8(value, fallback, min, max) {
  const i = clampInt(value, min, max, fallback);
  return Math.max(min, Math.round(i / 8) * 8);
}

/**
 * 组一张 SD1.5 的标准工作流（纯函数，给自测钉住）。
 *
 * @param {object} input
 * @param {string} input.prompt - 正面提示词
 * @param {string} [input.negative] - 负面提示词
 * @param {string} input.ckptName
 * @param {number} input.width
 * @param {number} input.height
 * @param {number} input.steps
 * @param {number} input.cfg
 * @param {string} input.samplerName
 * @param {string} input.scheduler
 * @param {number} input.seed
 * @param {string} [input.filenamePrefix]
 * @returns {object} ComfyUI 的 prompt 图
 */
export function buildWorkflow(input) {
  const seed = Number.isFinite(input?.seed) ? Math.trunc(input.seed) : 0;
  return {
    1: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: String(input?.ckptName ?? '') },
    },
    2: {
      class_type: 'CLIPTextEncode',
      inputs: { text: String(input?.prompt ?? ''), clip: ['1', 1] },
    },
    3: {
      class_type: 'CLIPTextEncode',
      inputs: { text: String(input?.negative ?? ''), clip: ['1', 1] },
    },
    4: {
      class_type: 'EmptyLatentImage',
      inputs: { width: input?.width ?? 512, height: input?.height ?? 512, batch_size: 1 },
    },
    5: {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps: input?.steps ?? 20,
        cfg: input?.cfg ?? 7,
        sampler_name: String(input?.samplerName ?? 'euler'),
        scheduler: String(input?.scheduler ?? 'normal'),
        denoise: 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    6: {
      class_type: 'VAEDecode',
      inputs: { samples: ['5', 0], vae: ['1', 2] },
    },
    7: {
      class_type: 'SaveImage',
      inputs: { filename_prefix: String(input?.filenamePrefix ?? 'yara'), images: ['6', 0] },
    },
  };
}

/**
 * 把画图请求规整成一次调用需要的全部参数（纯函数）。
 *
 * 所有夹紧都在这儿，`generate()` 不再做判断 —— 这样自测只测这一个函数
 * 就能锁住「她乱填参数不会炸」这条。
 *
 * @param {object} args - 工具参数
 * @param {object} [cfg] - comfy 段配置
 * @returns {{ok:boolean, reason?:string, prompt?:string, negative?:string, width?:number, height?:number, steps?:number, cfg?:number, seed?:number}}
 */
export function normalizeRequest(args, cfg = {}) {
  const c = cfg ?? {};
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt === '') return { ok: false, reason: 'prompt 不能为空' };
  // 提示词太长会被 CLIP 截断并浪费算力；1024 字符远超 77 token 的实际额度，
  // 但那是她的表达，不该在这里砍 —— 只设一个防跑飞的上限。
  if (prompt.length > 2000) return { ok: false, reason: 'prompt 太长（上限 2000 字符）' };

  const negative = typeof args?.negative === 'string' && args.negative.trim() !== ''
    ? args.negative.trim()
    : String(c.negative ?? DEFAULTS.negative);

  const width = align8(args?.width, c.width ?? DEFAULTS.width, 256, 1024);
  const height = align8(args?.height, c.height ?? DEFAULTS.height, 256, 1024);
  const steps = clampInt(args?.steps, 1, 60, c.steps ?? DEFAULTS.steps);
  const cfgScale = (() => {
    const n = Number(args?.cfg);
    if (!Number.isFinite(n)) return c.cfg ?? DEFAULTS.cfg;
    return Math.min(20, Math.max(1, n));
  })();
  // seed：不给就随机；给 -1 也当随机（这是 SD 生态的惯例）。
  const seed = (() => {
    const n = Number(args?.seed);
    if (!Number.isFinite(n) || n < 0) return Math.floor(Math.random() * 2147483647);
    return Math.trunc(n) % 2147483647;
  })();

  return { ok: true, prompt, negative, width, height, steps, cfg: cfgScale, seed };
}

/**
 * 从 ComfyUI 的 history 响应里取出第一张图的相对路径（纯函数）。
 *
 * @param {object} history - `GET /history/{id}` 的那一条
 * @param {string} [promptId]
 * @returns {{filename:string, subfolder:string, type:string}|null}
 */
export function firstImageOf(history, promptId) {
  const entry = promptId !== undefined ? history?.[promptId] : Object.values(history ?? {})[0];
  if (entry === null || typeof entry !== 'object') return null;
  const outputs = entry.outputs;
  if (outputs === null || typeof outputs !== 'object') return null;
  for (const node of Object.values(outputs)) {
    const images = node?.images;
    if (!Array.isArray(images) || images.length === 0) continue;
    const img = images[0];
    if (img === null || typeof img !== 'object') continue;
    if (typeof img.filename !== 'string' || img.filename === '') continue;
    return {
      filename: img.filename,
      subfolder: typeof img.subfolder === 'string' ? img.subfolder : '',
      type: typeof img.type === 'string' ? img.type : 'output',
    };
  }
  return null;
}

/**
 * 拼出 `/view` 的查询串（纯函数，给自测钉住不用 URL 编码踩坑）。
 *
 * @param {{filename:string, subfolder:string, type:string}} img
 * @returns {string}
 */
export function viewPathOf(img) {
  const params = new URLSearchParams();
  params.set('filename', img.filename);
  if (img.subfolder !== '') params.set('subfolder', img.subfolder);
  params.set('type', img.type);
  return `/view?${params.toString()}`;
}

/**
 * 创建 comfy 模块实例。
 *
 * @param {object} options
 * @param {object} options.cfg
 * @param {object} [options.stats]
 * @param {(level:string,message:string)=>void} [options.log]
 * @param {() => string} [options.resolveMediaDir] - 图片落盘目录（复用 mediaDir）。
 * @param {() => string} [options.getChatId] - 当前会话 id（用来给文件名分组）。
 */
export function createComfy({ cfg, stats, log, resolveMediaDir }) {
  const say = typeof log === 'function' ? log : () => undefined;
  const enabled = () => cfg?.enabled !== false;
  const base = () => String(cfg?.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/u, '');
  const timeout = () => {
    const n = Number(cfg?.timeoutMs);
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS.timeoutMs;
  };
  const pollMs = () => {
    const n = Number(cfg?.pollMs);
    return Number.isFinite(n) && n > 0 ? n : DEFAULTS.pollMs;
  };

  /** ComfyUI 在不在。给体检表和工具做前置检查。 */
  async function alive() {
    try {
      const res = await fetch(`${base()}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 画一张。
   *
   * @param {object} args - 工具参数（`prompt` / `negative` / `width` / `height` / `steps` / `cfg` / `seed`）
   * @returns {Promise<object>} `{ ok, path?, filename?, bytes?, ms?, seed?, reason? }`
   */
  async function generate(args) {
    if (!enabled()) return { ok: false, reason: '画图模块没开（comfy.enabled=false）' };
    const req = normalizeRequest(args, cfg);
    if (req.ok !== true) return { ok: false, reason: req.reason };

    const dir = (() => {
      try {
        return typeof resolveMediaDir === 'function' ? resolveMediaDir() : '';
      } catch {
        return '';
      }
    })();
    if (typeof dir !== 'string' || dir === '') return { ok: false, reason: '没配媒体目录（mediaDir）' };

    const startedAt = Date.now();
    const deadline = startedAt + timeout();
    const stamp = new Date(startedAt);
    const pad = (v) => String(v).padStart(2, '0');
    const prefix = `yara-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;

    const workflow = buildWorkflow({
      prompt: req.prompt,
      negative: req.negative,
      ckptName: String(cfg?.ckptName ?? DEFAULTS.ckptName),
      width: req.width,
      height: req.height,
      steps: req.steps,
      cfg: req.cfg,
      samplerName: String(cfg?.samplerName ?? DEFAULTS.samplerName),
      scheduler: String(cfg?.scheduler ?? DEFAULTS.scheduler),
      seed: req.seed,
      filenamePrefix: prefix,
    });

    let promptId = '';
    try {
      const res = await fetch(`${base()}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: `dsh-companion-${Date.now()}` }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || body === null) {
        const detail = body?.error?.message ?? body?.error ?? `HTTP ${res.status}`;
        return { ok: false, reason: `ComfyUI 拒了这次请求：${detail}` };
      }
      if (body.node_errors !== undefined && Object.keys(body.node_errors ?? {}).length > 0) {
        return { ok: false, reason: `节点报错：${JSON.stringify(body.node_errors).slice(0, 300)}` };
      }
      promptId = String(body.prompt_id ?? '');
      if (promptId === '') return { ok: false, reason: 'ComfyUI 没返回 prompt_id' };
    } catch (error) {
      const msg = String(error?.message ?? error);
      // 连不上是**最常见的失败**（人家把 ComfyUI 关了），单独说清楚。
      return {
        ok: false,
        reason: `连不上 ComfyUI（${base()}）—— 它可能没在跑：${msg}`,
      };
    }

    // ── 轮询直到出图或超时 ─────────────────────────────────────────────────
    let image = null;
    while (Date.now() < deadline) {
      await sleep(pollMs());
      try {
        const res = await fetch(`${base()}/history/${encodeURIComponent(promptId)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const history = await res.json().catch(() => null);
        const found = firstImageOf(history, promptId);
        if (found !== null) {
          image = found;
          break;
        }
      } catch {
        /* 单次轮询失败不算失败：ComfyUI 忙的时候 /history 会慢 */
      }
    }
    if (image === null) {
      return { ok: false, reason: `等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒还没出图，放弃了` };
    }

    // ── 把图抓回本地 ────────────────────────────────────────────────────────
    const grab = async () => {
      const res = await fetch(`${base()}${viewPathOf(image)}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // 文件名只用 ComfyUI 给的那个（已经带 yara-时间戳前缀），但去掉路径成分。
      const safe = image.filename.replace(/[\\/:*?"<>|]/gu, '_');
      // 统一成反斜杠：Windows 上 `qq_send_image` 那边要按路径找文件，
      // 混着正反斜杠虽然 Node 认，但混进 QQ 的消息里之后人会看不懂。
      const dirClean = dir.replace(/[\\/]+$/u, '').replace(/\//gu, '\\');
      const target = `${dirClean}\\${safe}`;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, buf);
      return { path: target, bytes: buf.length };
    };

    try {
      const saved = await grab();
      const ms = Date.now() - startedAt;
      if (stats) {
        stats.comfyDraws = (stats.comfyDraws ?? 0) + 1;
        stats.comfyLastMs = ms;
      }
      say('info', `画好一张（${ms}ms，${req.width}×${req.height}）→ ${saved.path}`);
      return {
        ok: true,
        path: saved.path,
        filename: image.filename,
        bytes: saved.bytes,
        ms,
        seed: req.seed,
        width: req.width,
        height: req.height,
      };
    } catch (error) {
      return { ok: false, reason: `图出来了但没抓到本地：${String(error?.message ?? error)}` };
    }
  }

  /**
   * 画一张表情（用预设）。`generate` 的薄包装，只是先把预设拼成提示词。
   *
   * @param {{preset?:string, extra?:string, width?:number, height?:number, steps?:number, cfg?:number, seed?:number}} args
   * @returns {Promise<object>}
   */
  async function face(args) {
    const made = facePromptOf(args?.preset, args?.extra);
    if (made.ok !== true) {
      return { ok: false, reason: made.reason, presets: Object.keys(FACE_PRESETS) };
    }
    // 表情包默认方图 1024：SDXL 的原生尺寸，方形最适合贴在聊天气泡里。
    const res = await generate({
      prompt: made.prompt,
      negative: made.negative,
      width: Number.isFinite(args?.width) ? args.width : 1024,
      height: Number.isFinite(args?.height) ? args.height : 1024,
      steps: Number.isFinite(args?.steps) ? args.steps : 30,
      cfg: Number.isFinite(args?.cfg) ? args.cfg : 5.5,
      seed: args?.seed,
    });
    return res.ok === true ? { ...res, preset: args?.preset } : res;
  }

  function snapshot() {
    return {
      enabled: enabled(),
      baseUrl: base(),
      draws: stats?.comfyDraws ?? 0,
      lastMs: stats?.comfyLastMs ?? null,
      lastError: stats?.comfyLastError ?? null,
    };
  }

  return { MODULE_ID, alive, generate, face, snapshot, DEFAULTS };
}
