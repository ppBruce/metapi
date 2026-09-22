import { describe, expect, it } from 'vitest';
import { getAllBrands, getBrand, getMatchingBrandNames } from './modelBrand.js';

describe('modelBrand matching helpers', () => {
  it('returns all matched provider and vendor brands while preserving display priority', () => {
    expect(getMatchingBrandNames('openrouter/anthropic/claude-3-7-sonnet')).toEqual(['Anthropic', 'OpenRouter']);
    expect(getMatchingBrandNames('deepinfra/meta-llama/llama-3.3-70b-instruct')).toEqual(['Meta', 'DeepInfra']);
    expect(getMatchingBrandNames('azureai/gpt-4o')).toEqual(['OpenAI', 'Azure AI']);
    expect(getMatchingBrandNames('bedrock/us.amazon.nova-pro-v1:0')).toEqual(['Amazon Nova', 'AWS Bedrock']);

    expect(getBrand('openrouter/anthropic/claude-3-7-sonnet')?.name).toBe('Anthropic');
    expect(getBrand('deepinfra/meta-llama/llama-3.3-70b-instruct')?.name).toBe('Meta');
  });

  it('classifies custom marketplace model brands', () => {
    expect(getBrand('agnes-2.0-flash')?.name).toBe('Agnes');
    expect(getBrand('hy-mt2:7b')?.name).toBe('腾讯混元');
    expect(getBrand('hy3')?.name).toBe('腾讯混元');
    expect(getBrand('hy4-preview')?.name).toBe('腾讯混元');
    expect(getBrand('hy4-preview-f')?.name).toBe('腾讯混元');
    expect(getBrand('hy5')?.name).toBe('腾讯混元');
    expect(getBrand('hy4-omni')?.name).toBe('腾讯混元');
    expect(getBrand('hybrid-token')?.name).not.toBe('腾讯混元');
    expect(getBrand('big-pickle')?.name).toBe('OpenCode');
    expect(getBrand('north-mini-code-free')?.name).toBe('OpenCode');
    expect(getBrand('poolside/laguna-xs.2:free')?.name).toBe('OpenCode');
    expect(getBrand('kilo-auto')?.name).toBe('Kilo');
    expect(getBrand('codex-auto-review')?.name).toBe('OpenAI');
  });

  it('keeps classifying future model generations without touching the rule list', () => {
    // 厂商词用 includes 匹配：厂商出新代际（v9/glm-5/k3/qwen4）时就该自动归类。
    // 这条断言是契约——若有人把 includes 换成字面量，这里会先红。
    expect(getBrand('deepseek-v9')?.name).toBe('DeepSeek');
    expect(getBrand('deepseek-r2')?.name).toBe('DeepSeek');
    expect(getBrand('glm-5.3-flash')?.name).toBe('智谱 AI');
    expect(getBrand('chatglm9')?.name).toBe('智谱 AI');
    expect(getBrand('kimi-k3')?.name).toBe('Moonshot');
    expect(getBrand('moonshot-v2')?.name).toBe('Moonshot');
    expect(getBrand('qwen4-max')?.name).toBe('通义千问');
    expect(getBrand('qwq-32b')?.name).toBe('通义千问');
  });

  it('classifies product-name and alias families that carry no vendor word', () => {
    // Google 的 Gemini 图像模型以产品名出现，两种拼写都要覆盖。
    expect(getBrand('Nano Banana 2')?.name).toBe('Google');
    expect(getBrand('nano banana pro')?.name).toBe('Google');
    expect(getBrand('nano-banana-3')?.name).toBe('Google');
    // 火山方舟的 endpoint id（ep-<数字>-<后缀>）代表火山引擎上的模型。
    expect(getBrand('ep-20260122002118-6sj2g')?.name).toBe('火山引擎');
    // Upstage 的 Solar 家族、蚂蚁百灵的 Ling 家族。
    expect(getBrand('solar-pro4')?.name).toBe('Upstage');
    expect(getBrand('ling-3.0-flash-fin')?.name).toBe('蚂蚁百灵');
    expect(getBrand('inclusionai/ling-3.0-flash:free')?.name).toBe('蚂蚁百灵');
  });

  it('leaves vendors without an icon in the shared icon set unclassified', () => {
    // 图标只来自 lobehub（公共图标集）。图标集里没有的品牌不再注册成品牌条目 ——
    // 它们的模型直接落回"其他"，避免出现"有名字没图标"的半吊子品牌，
    // 也意味着别人上游站点冒出的新厂商不需要我们逐个补图。
    expect(getBrand('minicpm5-2b')).toBeNull();
    expect(getBrand('ornith-1.5-35b')).toBeNull();
    expect(getBrand('TeleAI/TeleSpeechASR')).toBeNull();
    expect(getBrand('PaddlePaddle/PaddleOCR-VL-1.5')).toBeNull();
    expect(getBrand('mxbai-embed-large:335m')).toBeNull();
    expect(getBrand('bce-reranker-base_v1')).toBeNull();
  });

  it('classifies open-weight families and vendor aliases that the icon set covers', () => {
    expect(getBrand('seedream-4-5')?.name).toBe('豆包');
    expect(getBrand('muse-glimmer-30b')?.name).toBe('Meta');
    expect(getBrand('agnes-2.0-flash')?.name).toBe('Agnes');
    expect(getBrand('omni1.1-flash')?.name).toBe('Google');
    expect(getBrand('omni-flash')?.name).toBe('Google');
    // Muse Glimmer 的锚定规则不能吃掉讯飞的 muse-spark
    expect(getBrand('muse-spark-1.3')?.name).toBe('讯飞星火');
  });

  it('does not let short substrings steal a model from a more specific brand', () => {
    // 短 token 一律锚定匹配：这几条是包含式匹配会踩的坑（参考实现正是这么踩的）。
    expect(getBrand('minimaxai/minimax-m3')?.name).toBe('MiniMax');
    expect(getBrand('sensenova-6.7-flash-lite')?.name).toBe('SenseNova');
    expect(getBrand('hybrid-token')?.name).not.toBe('腾讯混元');
    expect(getBrand('solaris-1b')?.name).not.toBe('Upstage');
    expect(getBrand('ephemeral-x')?.name).not.toBe('火山引擎');
  });

  it('keeps the vendor mark for the brand slot and the family mark for the model slot', () => {
    // 两个槽位可以不同：品牌槽永远是厂商标，模型槽优先用该模型家族自己的标。
    const kimi = getBrand('kimi-k2.5');
    expect(kimi?.name).toBe('Moonshot');
    expect(kimi?.icon).toBe('moonshot');
    expect(kimi?.modelIcon).toBe('kimi');

    const grok = getBrand('grok-4.20-fast');
    expect(grok?.name).toBe('xAI');
    expect(grok?.icon).toBe('xai');
    expect(grok?.modelIcon).toBe('grok');

    const gemma = getBrand('gemma-4-31b-it');
    expect(gemma?.name).toBe('Google');
    expect(gemma?.icon).toBe('google-color');
    expect(gemma?.modelIcon).toBe('gemma-color');

    const claude = getBrand('claude-sonnet-4.5');
    expect(claude?.icon).toBe('anthropic');
    expect(claude?.modelIcon).toBe('claude-color');

    // 家族没有独立标时不给模型槽造标，让它回落到厂商标。
    expect(getBrand('moonshot-v1-8k')?.modelIcon ?? null).toBeNull();
    expect(getBrand('gpt-5')?.modelIcon ?? null).toBeNull();
  });

  it('only declares square glyph icon keys, never banner/wordmark variants', () => {
    // 徽标容器是正方形且 objectFit:contain，横幅字标（-brand/-brand-color）与纯文字标（-text）
    // 塞进去会缩成一条看不清的细线。图标是 lobehub 的键，取值必须是方形字型版。
    const offenders = getAllBrands()
      .filter((brand) => brand.icon && (brand.icon.includes('-brand') || brand.icon.endsWith('-text')))
      .map((brand) => `${brand.name}: ${brand.icon}`);
    expect(offenders).toEqual([]);
    // 无底色徽标直接贴页面背景，近白（白底隐形）或近黑（暗底 1.2:1）的 -color
    // 变体一律不可用，改用主题感知的单色键。复核办法见 modelBrand.ts 头部注释。
    const washedOut = [
      'kimi-color',
      'nanobanana-color',
      'codex-color',
      'openrouter-color',
      'deepl-color',
      'essentialai-color',
    ];
    const reintroduced = [
      ...getAllBrands().map((brand) => `${brand.name} (品牌槽): ${brand.icon}`),
      ...['kimi-k2.5', 'nano-banana-pro', 'codex-mini', 'gpt-5-codex'].map(
        (model) => `模型槽 ${model}: ${getBrand(model)?.modelIcon ?? ''}`,
      ),
    ].filter((entry) => washedOut.some((key) => entry.endsWith(key)));
    expect(reintroduced).toEqual([]);

    // 模型槽的标同样必须是方形字型版。
    const modelOffenders = ['kimi-k2.5', 'grok-4', 'gemma-3-27b', 'claude-sonnet-4.5', 'gemini-2.5-pro', 'glm-4.6']
      .map((model) => getBrand(model)?.modelIcon)
      .filter((icon): icon is string => Boolean(icon))
      .filter((icon) => icon.includes('-brand') || icon.endsWith('-text'));
    expect(modelOffenders).toEqual([]);
  });
});
