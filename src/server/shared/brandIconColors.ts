/**
 * GENERATED FILE — do not edit by hand. Run `npm run brand:colors`.
 *
 * The colour a badge is tinted with, per brand icon key. Two sources, both
 * lobehub's, so nothing here is invented:
 *   - 'icon': the dominant saturated colour of the PNG the badge renders
 *     (1.97.0, light theme) — the chip matches the glyph.
 *   - 'declared': the mark itself is monochrome, but @lobehub/icons@5.18.0
 *     declares a brand colour for it (Groq #F55036, IBM #0F62FE, …).
 * Keys listed in `MONO_ICON_KEYS` have neither (lobehub declares black/white
 * only, e.g. OpenAI #000, xAI #fff): their badge uses the theme ink plus the
 * per-name hash, never a made-up hue.
 */
export const BRAND_ICON_COLORS: Record<string, string> = {
  'ai2-color': '#f0529c',
  'ai21': '#E91E63',
  'aionlabs-color': '#081a2b',
  'alibabacloud-color': '#ff6a00',
  'antgroup-color': '#0999ff',
  'arcee-color': '#008c8c',
  'azureai-color': '#1371ec',
  'baichuan-color': '#ff7134',
  'baiducloud-color': '#2464f5',
  'bailian-color': '#00cec9',
  'bedrock-color': '#4385fe',
  'bytedance-color': '#00c8d2',
  'cerebras-color': '#f15a29',
  'claude-color': '#d97757',
  'cohere-color': '#ff7759',
  'deepcogito-color': '#4e81ee',
  'deepinfra-color': '#2a3275',
  'deepl': '#0F2B46',
  'deepseek-color': '#4d6bfe',
  'doubao-color': '#1e37fc',
  'fireworks-color': '#5019c5',
  'gemini-color': '#3186ff',
  'gemma-color': '#3588ff',
  'google-color': '#fbbc05',
  'googlecloud-color': '#fbbc05',
  'groq': '#F55036',
  'hunyuan-color': '#00bcff',
  'ibm': '#0F62FE',
  'inflection': '#038247',
  'internlm-color': '#1B3882',
  'longcat-color': '#29e154',
  'meta-color': '#0081fa',
  'microsoft-color': '#7fba00',
  'minimax-color': '#e82670',
  'mistral-color': '#ffd700',
  'modelscope-color': '#36ced0',
  'morph-color': '#99d52a',
  'nanobanana': '#FCD53F',
  'nova-color': '#e234fa',
  'nvidia-color': '#74b71b',
  'openrouter': '#C8FF00',
  'perplexity-color': '#22b8cd',
  'qiniu-color': '#06aeef',
  'qwen-color': '#653eea',
  'replicate': '#EA2805',
  'sambanova-color': '#ee7624',
  'sensenova-color': '#06fdb7',
  'siliconcloud-color': '#6e29f6',
  'spark-color': '#ea0100',
  'stability-color': '#e80000',
  'together-color': '#fc4c02',
  'upstage-color': '#896efb',
  'vertexai-color': '#4285f4',
  'volcengine-color': '#006eff',
  'wenxin-color': '#0c59c8',
  'yi-color': '#00ff25',
  'zhipu-color': '#3859ff',
};

/** Icons with no brand hue anywhere in lobehub (mono black/white marks). */
export const MONO_ICON_KEYS: readonly string[] = [
  'agnesai',
  'anthropic',
  'baai',
  'codex',
  'essentialai',
  'grok',
  'inception',
  'jina',
  'kilocode',
  'kimi',
  'liquid',
  'midjourney',
  'moonshot',
  'nousresearch',
  'ollama',
  'openai',
  'opencode',
  'relace',
  'stepfun',
  'xai',
  'xiaomimimo',
  'zai',
];
