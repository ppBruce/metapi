import { BRAND_ICON_COLORS } from './brandIconColors.js';

/**
 * The badge colour for a brand is never hand-written: it is looked up from the
 * icon key in `brandIconColors.ts`, which is generated from lobehub (see
 * `npm run brand:colors`). Keys that lobehub itself only draws in black/white
 * carry no colour and fall through to the theme ink + per-name hash.
 */
function brandColorFor(icon: string): string {
  return BRAND_ICON_COLORS[icon] ?? '#000000';
}

export interface BrandMatchContext {
  raw: string;
  cleaned: string;
  segments: string[];
  candidates: string[];
}

/**
 * Icon key convention (lobehub @1.97 static PNGs).
 *
 * `icon`/`modelIcon` may be any key from lobehub, but the *variant* must stay
 * legible in BOTH themes: the badge renders the mark directly on the page with
 * no tile behind it, so a mark that is near-white on light or near-black on
 * dark disappears.
 *
 * - `<key>-color` is a fixed mark: identical pixels in light and dark. Use it
 *   only when it clears ~3:1 contrast against both backgrounds (verified: the
 *   color variants of antgroup/nova/stepfun are ~106-121 mean luminance, ok;
 *   kimi-codex-nanobanana-openrouter are ~209-243 which is invisible on white,
 *   deepl/essentialai are ~38-41 which is invisible on dark).
 * - `<key>` (no suffix) is theme-aware: black ink for light, white ink for
 *   dark, ~17.8:1 in both. This is the safe default whenever the color variant
 *   fails, and it is what lobehub itself shows for marks like StepFun.
 *
 * To re-verify: fetch `/light|dark/<key>.png`, average luminance over pixels
 * with alpha > 40, then require <=195 for light and >=60 for dark.
 * Never use `-text`/`-brand` wordmark variants: the badge is square.
 */
export interface BrandInfo {
  name: string;
  icon: string;
  color: string;
  /**
   * Model-family mark, when the family has its own logo distinct from the
   * vendor's (Kimi vs Moonshot, Grok vs xAI, Claude vs Anthropic, Gemma vs
   * Google). The brand slot keeps `icon` (the vendor mark); the model slot
   * renders this one. null/undefined = the family has no separate mark, the
   * model slot falls back to the vendor icon.
   */
  modelIcon?: string | null;
}

export type BrandMatchMode = 'includes' | 'startsWith' | 'segment' | 'boundary' | 'regex';

type BrandRule = {
  keyword: string;
  mode: BrandMatchMode;
  /** Model-family icon for models matched by this rule (see BrandInfo.modelIcon). */
  icon?: string;
};

type BrandDefinition = Omit<BrandInfo, 'color'> & {
  rules: BrandRule[];
};

// 品牌规则按数组顺序决定优先级：getBrand() 取第一个命中的品牌。
// 作者约定（新增品牌/规则时请遵守）：
// 1. 越具体的品牌越靠前（例如 360gpt 在 GPT 之前、nemotron 在 llama 之前），
//    否则一个宽泛的规则会先把名字抢走。
// 2. 厂商词足够长且独特（deepseek/glm/qwen/kimi…≥4 字符）→ 用 includes，
//    这样厂商每出一代新模型（deepseek-v9、glm-5、kimi-k3、qwen4-max）都自动归类，无需改代码。
// 3. 短缩写或容易被他家名字包含的 token（hy、ds、nova、xai…）绝不能用 includes 匹配子串，
//    必须用 startsWith / segment / boundary / regex 锚定；
//    反例：包含式匹配会让 minimaxai/… 落到 xai、让 sensenova-… 落到 nova。
// 4. 缩写要覆盖整个命名代际时用 regex（如 ^hy\d+(-|$) 覆盖 hy3/hy4/hy5…），
//    而不是每出一个版本号就补一条 startsWith。
const BRAND_DEFINITIONS: BrandDefinition[] = [
  {
    name: 'OpenAI',
    icon: 'openai',
    rules: [
      { keyword: 'gpt', mode: 'startsWith' },
      { keyword: 'chatgpt', mode: 'startsWith' },
      { keyword: 'dall-e', mode: 'startsWith' },
      { keyword: 'whisper', mode: 'startsWith' },
      { keyword: 'text-embedding', mode: 'startsWith' },
      { keyword: 'text-moderation', mode: 'startsWith' },
      { keyword: 'davinci', mode: 'startsWith' },
      { keyword: 'babbage', mode: 'startsWith' },
      { keyword: 'codex-mini', mode: 'startsWith', icon: 'codex' },
      { keyword: 'codex-auto-review', mode: 'startsWith', icon: 'codex' },
      { keyword: 'codex-', mode: 'startsWith', icon: 'codex' },
      { keyword: 'o1', mode: 'startsWith' },
      { keyword: 'o3', mode: 'startsWith' },
      { keyword: 'o4', mode: 'startsWith' },
      { keyword: 'tts', mode: 'startsWith' },
    ],
  },
  {
    name: 'Anthropic',
    icon: 'anthropic',
    rules: [
      { keyword: 'claude', mode: 'includes', icon: 'claude-color' },
    ],
  },
  {
    name: 'Google',
    icon: 'google-color',
    rules: [
      { keyword: 'gemini', mode: 'includes', icon: 'gemini-color' },
      { keyword: 'gemma', mode: 'includes', icon: 'gemma-color' },
      { keyword: 'google/', mode: 'includes' },
      { keyword: 'palm', mode: 'includes' },
      { keyword: 'paligemma', mode: 'includes' },
      { keyword: 'shieldgemma', mode: 'includes' },
      { keyword: 'recurrentgemma', mode: 'includes' },
      { keyword: 'deplot', mode: 'includes' },
      { keyword: 'codegemma', mode: 'includes' },
      { keyword: 'imagen', mode: 'includes' },
      { keyword: 'nano banana', mode: 'includes', icon: 'nanobanana' },
      { keyword: 'nano-banana', mode: 'includes', icon: 'nanobanana' },
      { keyword: 'omni1.1', mode: 'startsWith' },
      { keyword: 'omni-flash', mode: 'startsWith' },
      { keyword: 'learnlm', mode: 'includes' },
      { keyword: 'aqa', mode: 'includes' },
      { keyword: 'veo', mode: 'startsWith' },
      { keyword: 'google/', mode: 'startsWith' },
    ],
  },
  {
    name: 'DeepSeek',
    icon: 'deepseek-color',
    rules: [
      { keyword: 'deepseek', mode: 'includes' },
      { keyword: 'ds-chat', mode: 'segment' },
    ],
  },
  {
    name: '通义千问',
    icon: 'qwen-color',
    rules: [
      { keyword: 'qwen', mode: 'includes' },
      { keyword: 'qwq', mode: 'includes' },
      { keyword: 'tongyi', mode: 'includes' },
    ],
  },
  {
    name: '智谱 AI',
    icon: 'zai',
    rules: [
      { keyword: 'glm', mode: 'includes', icon: 'zhipu-color' },
      { keyword: 'chatglm', mode: 'includes', icon: 'zhipu-color' },
      { keyword: 'codegeex', mode: 'includes' },
      { keyword: 'cogview', mode: 'includes' },
      { keyword: 'cogvideo', mode: 'includes' },
    ],
  },
  {
    name: 'Meta',
    icon: 'meta-color',
    rules: [
      { keyword: 'llama', mode: 'includes' },
      { keyword: 'code-llama', mode: 'includes' },
      { keyword: 'codellama', mode: 'includes' },
      { keyword: 'muse-glimmer', mode: 'startsWith' },
    ],
  },
  {
    name: 'Mistral',
    icon: 'mistral-color',
    rules: [
      { keyword: 'mistral', mode: 'includes' },
      { keyword: 'mixtral', mode: 'includes' },
      { keyword: 'codestral', mode: 'includes' },
      { keyword: 'pixtral', mode: 'includes' },
      { keyword: 'ministral', mode: 'includes' },
      { keyword: 'voxtral', mode: 'includes' },
      { keyword: 'magistral', mode: 'includes' },
    ],
  },
  {
    name: 'Moonshot',
    icon: 'moonshot',
    rules: [
      { keyword: 'moonshot', mode: 'includes' },
      { keyword: 'kimi', mode: 'includes', icon: 'kimi' },
    ],
  },
  {
    name: '零一万物',
    icon: 'yi-color',
    rules: [
      { keyword: 'yi-', mode: 'startsWith' },
      { keyword: 'yi', mode: 'boundary' },
    ],
  },
  {
    name: '文心一言',
    icon: 'wenxin-color',
    rules: [
      { keyword: 'ernie', mode: 'includes' },
      { keyword: 'eb-', mode: 'includes' },
    ],
  },
  {
    name: '讯飞星火',
    icon: 'spark-color',
    rules: [
      { keyword: 'spark', mode: 'includes' },
      { keyword: 'generalv', mode: 'includes' },
    ],
  },
  {
    name: '腾讯混元',
    icon: 'hunyuan-color',
    rules: [
      { keyword: 'hunyuan', mode: 'includes' },
      { keyword: 'tencent-hunyuan', mode: 'includes' },
      { keyword: 'hy-', mode: 'startsWith' },
      // hy + 数字代际（hy3 / hy4-preview / hy4-preview-f / hy5…）一次覆盖；
      // 若未来出现不含数字后缀的同族命名（如 hy-omni），再补 startsWith。
      { keyword: '^hy\\d+(-|$)', mode: 'regex' },
    ],
  },
  {
    name: '豆包',
    icon: 'doubao-color',
    rules: [
      { keyword: 'doubao', mode: 'includes' },
      { keyword: 'seedream', mode: 'includes' },
    ],
  },
  {
    name: 'MiniMax',
    icon: 'minimax-color',
    rules: [
      { keyword: 'minimax', mode: 'includes' },
      { keyword: 'abab', mode: 'includes' },
      { keyword: 'mini2.1', mode: 'segment' },
    ],
  },
  {
    name: 'Cohere',
    icon: 'cohere-color',
    rules: [
      { keyword: 'command', mode: 'includes' },
      { keyword: 'c4ai-', mode: 'includes' },
      { keyword: 'aya', mode: 'includes' },
      { keyword: 'embed-', mode: 'startsWith' },
    ],
  },
  {
    name: 'Microsoft',
    icon: 'microsoft-color',
    rules: [
      { keyword: 'microsoft/', mode: 'includes' },
      { keyword: 'phi-', mode: 'includes' },
      { keyword: 'kosmos', mode: 'includes' },
      { keyword: 'phi4', mode: 'segment' },
    ],
  },
  {
    name: 'xAI',
    icon: 'xai',
    rules: [
      { keyword: 'grok', mode: 'includes', icon: 'grok' },
    ],
  },
  {
    name: 'Agnes',
    icon: 'agnesai',
    rules: [
      { keyword: 'agnes', mode: 'includes' },
    ],
  },
  {
    name: 'OpenCode',
    icon: 'opencode',
    rules: [
      { keyword: 'opencode', mode: 'includes' },
      { keyword: 'big-pickle', mode: 'includes' },
      { keyword: 'north-mini-code', mode: 'includes' },
      { keyword: 'laguna', mode: 'includes' },
      { keyword: 'poolside/', mode: 'startsWith' },
      { keyword: 'poolside', mode: 'includes' },
    ],
  },
  {
    name: 'Kilo',
    icon: 'kilocode',
    rules: [
      { keyword: 'kilocode', mode: 'includes' },
      { keyword: 'kilo-auto', mode: 'includes' },
      { keyword: 'kilo-', mode: 'startsWith' },
      { keyword: 'kilo', mode: 'boundary' },
    ],
  },
  {
    name: '阶跃星辰',
    icon: 'stepfun',
    rules: [
      { keyword: 'stepfun', mode: 'includes' },
      { keyword: 'step-', mode: 'startsWith' },
      { keyword: 'step3', mode: 'startsWith' },
    ],
  },
  {
    name: '百川智能',
    icon: 'baichuan-color',
    rules: [
      { keyword: 'baichuan', mode: 'includes' },
    ],
  },
  {
    name: 'AI21 Labs',
    icon: 'ai21',
    rules: [
      { keyword: 'ai21', mode: 'includes' },
      { keyword: 'jamba', mode: 'startsWith' },
      { keyword: 'jamba', mode: 'includes' },
    ],
  },
  {
    name: 'AI2',
    icon: 'ai2-color',
    rules: [
      { keyword: 'allenai', mode: 'includes' },
      { keyword: 'olmo', mode: 'includes' },
    ],
  },
  {
    name: 'Amazon Nova',
    icon: 'nova-color',
    rules: [
      { keyword: 'amazon/nova', mode: 'startsWith' },
      { keyword: 'amazon.nova', mode: 'includes' },
      { keyword: 'us.amazon.nova', mode: 'includes' },
      { keyword: 'nova-', mode: 'startsWith' },
      { keyword: 'nova-lite', mode: 'startsWith' },
      { keyword: 'nova-pro', mode: 'startsWith' },
      { keyword: 'nova-micro', mode: 'startsWith' },
      { keyword: 'nova-canvas', mode: 'startsWith' },
      { keyword: 'nova-reel', mode: 'startsWith' },
    ],
  },
  {
    name: 'Stability',
    icon: 'stability-color',
    rules: [
      { keyword: 'flux', mode: 'includes' },
      { keyword: 'stablediffusion', mode: 'includes' },
      { keyword: 'stable-diffusion', mode: 'includes' },
      { keyword: 'sdxl', mode: 'includes' },
      { keyword: 'sd3', mode: 'startsWith' },
    ],
  },
  {
    name: 'NVIDIA',
    icon: 'nvidia-color',
    rules: [
      { keyword: 'nvidia/', mode: 'includes' },
      { keyword: 'nvclip', mode: 'includes' },
      { keyword: 'nemotron', mode: 'includes' },
      { keyword: 'nemoretriever', mode: 'includes' },
      { keyword: 'neva', mode: 'includes' },
      { keyword: 'riva-translate', mode: 'includes' },
      { keyword: 'cosmos', mode: 'includes' },
      { keyword: 'nv-', mode: 'startsWith' },
    ],
  },
  {
    name: 'IBM',
    icon: 'ibm',
    rules: [
      { keyword: 'ibm/', mode: 'includes' },
      { keyword: 'granite', mode: 'includes' },
    ],
  },
  {
    name: 'BAAI',
    icon: 'baai',
    rules: [
      { keyword: 'baai/', mode: 'includes' },
      { keyword: 'bge-', mode: 'includes' },
    ],
  },
  {
    name: 'ByteDance',
    icon: 'bytedance-color',
    rules: [
      { keyword: 'bytedance', mode: 'includes' },
      { keyword: 'seed-oss', mode: 'includes' },
      { keyword: 'kolors', mode: 'includes' },
      { keyword: 'kwai', mode: 'includes' },
      { keyword: 'kwaipilot', mode: 'includes' },
      { keyword: 'wan-', mode: 'startsWith' },
      { keyword: 'kat-', mode: 'startsWith' },
    ],
  },
  {
    name: 'InternLM',
    icon: 'internlm-color',
    rules: [
      { keyword: 'internlm', mode: 'includes' },
    ],
  },
  {
    name: 'Midjourney',
    icon: 'midjourney',
    rules: [
      { keyword: 'midjourney', mode: 'includes' },
      { keyword: 'mj_', mode: 'startsWith' },
    ],
  },
  {
    name: 'DeepL',
    icon: 'deepl',
    rules: [
      { keyword: 'deepl-', mode: 'startsWith' },
      { keyword: 'deepl/', mode: 'includes' },
    ],
  },
  {
    name: 'Jina AI',
    icon: 'jina',
    rules: [
      { keyword: 'jina', mode: 'includes' },
    ],
  },
  {
    name: 'Relace',
    icon: 'relace',
    rules: [
      { keyword: 'relace', mode: 'includes' },
    ],
  },
  {
    name: 'Arcee',
    icon: 'arcee-color',
    rules: [
      { keyword: 'arcee-ai', mode: 'includes' },
      { keyword: 'arcee', mode: 'includes' },
    ],
  },
  {
    name: 'AionLabs',
    icon: 'aionlabs-color',
    rules: [
      { keyword: 'aion-labs', mode: 'includes' },
      { keyword: 'aionlabs', mode: 'includes' },
    ],
  },
  {
    name: 'DeepCogito',
    icon: 'deepcogito-color',
    rules: [
      { keyword: 'deepcogito', mode: 'includes' },
    ],
  },
  {
    name: 'Essential AI',
    icon: 'essentialai',
    rules: [
      { keyword: 'essentialai', mode: 'includes' },
    ],
  },
  {
    name: 'Inception',
    icon: 'inception',
    rules: [
      { keyword: 'inception', mode: 'includes' },
    ],
  },
  {
    name: 'Inflection',
    icon: 'inflection',
    rules: [
      { keyword: 'inflection', mode: 'includes' },
    ],
  },
  {
    name: 'Liquid AI',
    icon: 'liquid',
    rules: [
      { keyword: 'liquid', mode: 'includes' },
      { keyword: 'lfm-', mode: 'startsWith' },
    ],
  },
  {
    name: 'LongCat',
    icon: 'longcat-color',
    rules: [
      { keyword: 'longcat', mode: 'includes' },
    ],
  },
  {
    name: 'Morph',
    icon: 'morph-color',
    rules: [
      { keyword: 'morph/', mode: 'includes' },
      { keyword: 'morph-', mode: 'startsWith' },
    ],
  },
  {
    name: 'Nous Research',
    icon: 'nousresearch',
    rules: [
      { keyword: 'nousresearch', mode: 'includes' },
    ],
  },
  {
    name: 'Upstage',
    icon: 'upstage-color',
    rules: [
      { keyword: 'upstage', mode: 'includes' },
      { keyword: 'solar-', mode: 'startsWith' },
    ],
  },
  {
    name: 'Xiaomi MiMo',
    icon: 'xiaomimimo',
    rules: [
      { keyword: 'xiaomi/mimo', mode: 'includes' },
      { keyword: 'xiaomimimo', mode: 'includes' },
      { keyword: 'mimo-v', mode: 'startsWith' },
    ],
  },
  {
    name: 'Z.ai',
    icon: 'zai',
    rules: [
      { keyword: '2zai', mode: 'startsWith' },
      { keyword: 'z-ai', mode: 'startsWith' },
    ],
  },
  {
    name: 'SenseNova',
    icon: 'sensenova-color',
    rules: [
      { keyword: 'sensenova', mode: 'includes' },
    ],
  },
  {
    name: '蚂蚁百灵',
    icon: 'antgroup-color',
    rules: [
      { keyword: 'inclusionai', mode: 'includes' },
      { keyword: 'ling-', mode: 'startsWith' },
    ],
  },
  {
    name: 'Perplexity',
    icon: 'perplexity-color',
    rules: [
      { keyword: 'perplexity', mode: 'includes' },
      { keyword: 'pplx-', mode: 'startsWith' },
    ],
  },
  {
    name: 'OpenRouter',
    icon: 'openrouter',
    rules: [
      { keyword: 'openrouter', mode: 'includes' },
      { keyword: 'openrouter-', mode: 'startsWith' },
    ],
  },
  {
    name: 'Groq',
    icon: 'groq',
    rules: [
      { keyword: 'groq', mode: 'includes' },
    ],
  },
  {
    name: 'Fireworks',
    icon: 'fireworks-color',
    rules: [
      { keyword: 'fireworks-ai', mode: 'includes' },
      { keyword: 'fireworks', mode: 'includes' },
    ],
  },
  {
    name: 'DeepInfra',
    icon: 'deepinfra-color',
    rules: [
      { keyword: 'deepinfra', mode: 'includes' },
    ],
  },
  {
    name: 'Together AI',
    icon: 'together-color',
    rules: [
      { keyword: 'together.ai', mode: 'includes' },
      { keyword: 'together', mode: 'includes' },
    ],
  },
  {
    name: 'Replicate',
    icon: 'replicate',
    rules: [
      { keyword: 'replicate', mode: 'includes' },
    ],
  },
  {
    name: 'SambaNova',
    icon: 'sambanova-color',
    rules: [
      { keyword: 'sambanova', mode: 'includes' },
    ],
  },
  {
    name: 'Cerebras',
    icon: 'cerebras-color',
    rules: [
      { keyword: 'cerebras', mode: 'includes' },
    ],
  },
  {
    name: 'Ollama',
    icon: 'ollama',
    rules: [
      { keyword: 'ollama', mode: 'includes' },
    ],
  },
  {
    name: 'ModelScope',
    icon: 'modelscope-color',
    rules: [
      { keyword: 'modelscope', mode: 'includes' },
    ],
  },
  {
    name: 'SiliconCloud',
    icon: 'siliconcloud-color',
    rules: [
      { keyword: 'siliconcloud', mode: 'includes' },
      { keyword: 'siliconflow', mode: 'includes' },
    ],
  },
  {
    name: 'Azure AI',
    icon: 'azureai-color',
    rules: [
      { keyword: 'azureai', mode: 'includes' },
      { keyword: 'azure-openai', mode: 'includes' },
      { keyword: 'azure/openai', mode: 'includes' },
    ],
  },
  {
    name: 'AWS Bedrock',
    icon: 'bedrock-color',
    rules: [
      { keyword: 'bedrock', mode: 'includes' },
    ],
  },
  {
    name: 'Vertex AI',
    icon: 'vertexai-color',
    rules: [
      { keyword: 'vertexai', mode: 'includes' },
    ],
  },
  {
    name: 'Google Cloud',
    icon: 'googlecloud-color',
    rules: [
      { keyword: 'googlecloud', mode: 'includes' },
      { keyword: 'google-cloud', mode: 'includes' },
    ],
  },
  {
    name: '百度智能云',
    icon: 'baiducloud-color',
    rules: [
      { keyword: 'baiducloud', mode: 'includes' },
      { keyword: 'qianfan', mode: 'includes' },
    ],
  },
  {
    name: '百炼',
    icon: 'bailian-color',
    rules: [
      { keyword: 'bailian', mode: 'includes' },
      { keyword: 'dashscope', mode: 'includes' },
    ],
  },
  {
    name: '阿里云',
    icon: 'alibabacloud-color',
    rules: [
      { keyword: 'alibabacloud', mode: 'includes' },
    ],
  },
  {
    name: '火山引擎',
    icon: 'volcengine-color',
    rules: [
      { keyword: 'volcengine', mode: 'includes' },
      { keyword: '^ep-\\d{6,}', mode: 'regex' },
    ],
  },
  {
    name: '七牛云',
    icon: 'qiniu-color',
    rules: [
      { keyword: 'qiniu', mode: 'includes' },
    ],
  },
];

function normalizeInput(value: string): string {
  return String(value || '').trim().toLowerCase();
}

export function stripCommonWrappers(value: string): string {
  return value
    .replace(/^(?:\[[^\]]+\]|【[^】]+】)\s*/g, '')
    .replace(/^re:\s*/g, '')
    .replace(/^\^+/, '')
    .replace(/\$+$/, '')
    .trim();
}

export function collectBrandCandidates(modelName: string): string[] {
  const queue: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeInput(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    queue.push(normalized);
  };

  push(modelName);

  for (let index = 0; index < queue.length; index += 1) {
    const candidate = queue[index]!;
    const cleaned = stripCommonWrappers(candidate);
    push(cleaned);

    if (cleaned.includes('/')) {
      for (const part of cleaned.split('/')) push(part);
    }
    if (cleaned.includes(':')) {
      for (const part of cleaned.split(':')) push(part);
    }
    if (cleaned.includes(',')) {
      for (const part of cleaned.split(',')) push(part);
    }
  }

  return queue;
}

function buildMatchContext(modelName: string): BrandMatchContext {
  const candidates = collectBrandCandidates(modelName);
  const raw = candidates[0] || normalizeInput(modelName);
  const cleaned = stripCommonWrappers(raw);
  const segments = Array.from(new Set(
    candidates
      .flatMap((candidate) => candidate.split(/[/:,\s]+/g))
      .map((segment) => segment.trim())
      .filter(Boolean),
  ));

  return {
    raw,
    cleaned,
    segments,
    candidates,
  };
}

function matchesRule(context: BrandMatchContext, rule: BrandRule): boolean {
  switch (rule.mode) {
    case 'includes':
      return context.raw.includes(rule.keyword)
        || context.cleaned.includes(rule.keyword)
        || context.candidates.some((candidate) => candidate.includes(rule.keyword));
    case 'startsWith':
      return context.raw.startsWith(rule.keyword)
        || context.cleaned.startsWith(rule.keyword)
        || context.segments.some((segment) => segment.startsWith(rule.keyword))
        || context.candidates.some((candidate) => candidate.startsWith(rule.keyword));
    case 'segment':
      return context.segments.includes(rule.keyword);
    case 'boundary': {
      const pattern = new RegExp(`(^|[/:_\\-\\s])${escapeRegExp(rule.keyword)}(?=$|[/:_\\-\\s])`);
      return pattern.test(context.raw)
        || pattern.test(context.cleaned)
        || context.candidates.some((candidate) => pattern.test(candidate));
    }
    case 'regex': {
      // 关键词是完整正则（如 ^hy\d+(-|$)），一次覆盖整个命名代际（hy3/hy4/…），
      // 避免每出一个新版本号就补一条 startsWith。无效正则按不匹配处理。
      let pattern: RegExp;
      try {
        pattern = new RegExp(rule.keyword);
      } catch {
        return false;
      }
      return pattern.test(context.raw)
        || pattern.test(context.cleaned)
        || context.candidates.some((candidate) => pattern.test(candidate));
    }
    default:
      return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BRAND_FALLBACK_BOUNDARY_RULES = BRAND_DEFINITIONS.map((brand) => ({
  brand,
  boundaryRegex: new RegExp(`(^|[^a-z0-9])${escapeRegExp(brand.name.toLowerCase())}(?=$|[^a-z0-9])`),
}));

export function getAllBrands(): BrandInfo[] {
  return BRAND_DEFINITIONS.map(({ name, icon }) => ({ name, icon, color: brandColorFor(icon) }));
}

/**
 * Every icon key the registry can hand to a badge, brand slots and model slots
 * alike. The dominant-colour table (brandIconColors.ts) is generated from this
 * list, so a new icon key here means re-running `npm run brand:colors`.
 */
export function getAllBrandIconKeys(): string[] {
  const keys = new Set<string>();
  for (const brand of BRAND_DEFINITIONS) {
    if (brand.icon) keys.add(brand.icon);
    for (const rule of brand.rules) {
      if (rule.icon) keys.add(rule.icon);
    }
  }
  return [...keys].sort();
}

export function getAllBrandNames(): string[] {
  return BRAND_DEFINITIONS.map((brand) => brand.name);
}

function toBrandInfo(brand: BrandDefinition, modelIcon?: string): BrandInfo {
  return {
    name: brand.name,
    icon: brand.icon,
    color: brandColorFor(brand.icon),
    modelIcon: modelIcon || null,
  };
}

export function getMatchingBrands(modelName: string): BrandInfo[] {
  const context = buildMatchContext(modelName);
  const matches: BrandInfo[] = [];
  const seen = new Set<string>();

  const add = (brand: BrandDefinition, modelIcon?: string) => {
    if (seen.has(brand.name)) return;
    seen.add(brand.name);
    matches.push(toBrandInfo(brand, modelIcon));
  };

  for (const definition of BRAND_DEFINITIONS) {
    const matched = definition.rules.filter((rule) => matchesRule(context, rule));
    if (matched.length === 0) continue;
    // 第一个声明了模型标的命中规则胜出（gpt-5-codex 同时命中 gpt 与 codex- 时取后者）。
    add(definition, matched.find((rule) => rule.icon)?.icon);
  }

  for (const candidate of context.candidates) {
    for (const rule of BRAND_FALLBACK_BOUNDARY_RULES) {
      if (rule.boundaryRegex.test(candidate)) {
        add(rule.brand);
      }
    }
  }

  return matches;
}

export function getMatchingBrandNames(modelName: string): string[] {
  return getMatchingBrands(modelName).map((brand) => brand.name);
}

export function getBrand(modelName: string): BrandInfo | null {
  return getMatchingBrands(modelName)[0] || null;
}
