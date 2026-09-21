import { describe, expect, it } from 'vitest';
import { getAllBrands } from '../../server/shared/modelBrand.js';
import { BRAND_ICON_COLORS, brandBadgeColors } from './brandRegistry.js';

describe('brandBadgeColors', () => {
  it('derives tint, border, and text from the brand color', () => {
    // DeepSeek brand color #4d6bfe (77,107,254) is darkened slightly (luminance
    // clamp 0.40) for readable label text; the tint follows the darkened label
    // hue so bg and text stay in the same family.
    expect(brandBadgeColors(BRAND_ICON_COLORS['deepseek-color']!)).toEqual({
      bg: 'rgba(71,98,233,0.12)',
      border: 'rgba(71,98,233,0.25)',
      text: '#4762e9',
    });
  });

  it('gives GLM and Qwen their own tints instead of one shared theme color', () => {
    // 色来自 lobehub：zhipu-color 是智谱（GLM 的模型标），qwen-color 是通义千问。
    const zhipu = brandBadgeColors(BRAND_ICON_COLORS['zhipu-color']!);
    const qwen = brandBadgeColors(BRAND_ICON_COLORS['qwen-color']!);

    expect(zhipu.bg).not.toBe(qwen.bg);
    expect(zhipu.text).not.toBe('var(--color-primary)');
    expect(qwen.text).not.toBe('var(--color-primary)');
  });

  it('darkens light brand colors so the label stays readable', () => {
    // NVIDIA green (#74b71b, lobehub 声明色) is bright enough that using it
    // verbatim as label text on a 12% tint is hard to read.
    const nvidia = brandBadgeColors(BRAND_ICON_COLORS['nvidia-color']!);
    expect(nvidia.text).not.toBe('#74b71b');
    expect(nvidia.text).toBe('#4b7711');
  });

  it('supports shorthand hex and falls back when no color is present', () => {
    expect(brandBadgeColors('#abc').bg).toBe('rgba(94,103,113,0.12)');
    expect(brandBadgeColors(null)).toEqual({
      bg: 'var(--color-selection-bg)',
      border: 'rgba(79,70,229,0.15)',
      text: 'var(--color-primary)',
    });
    expect(brandBadgeColors('rgb(1,2,3)').text).toBe('var(--color-primary)');
  });

  it('perturbs the palette per name so same-brand items differ', () => {
    const a = brandBadgeColors(BRAND_ICON_COLORS['deepseek-color']!, 'light', 'deepseek-chat');
    const b = brandBadgeColors(BRAND_ICON_COLORS['deepseek-color']!, 'light', 'deepseek-reasoner');
    expect(a.text).not.toBe(b.text);
    expect(a.bg).not.toBe(b.bg);
    // Perturbation stays in the same blue family (±20° hue).
    const parse = (hex: string) => hex.match(/#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)!.slice(1).map((v) => Number.parseInt(v, 16));
    const [ar, ag] = parse(a.text);
    expect(ar).toBeLessThan(ag); // blue-dominant: red < green
  });

  it('lightens dark brand colors so the label stays readable on dark themes', () => {
    // 下的上抬逻辑，而不是依赖某家品牌色。
    const dark = brandBadgeColors('#111', 'dark');
    expect(dark.text).not.toBe('#111111');
    // The lifted text must be a hex with noticeable luminance.
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(dark.text);
    expect(m).not.toBeNull();
    const luminance = 0.2126 * (Number.parseInt(m![1]!, 16) / 255)
      + 0.7152 * (Number.parseInt(m![2]!, 16) / 255)
      + 0.0722 * (Number.parseInt(m![3]!, 16) / 255);
    expect(luminance).toBeGreaterThan(0.18);
  });

  it('keeps black/white brands distinguishable instead of collapsing to one grey', () => {
    // OpenAI/Kimi/xAI/Z.ai 的图标 lobehub 只声明黑或白，徽标必须靠哈希在
    // 中性区间内散开，不能因为 clamp 全部落到同一个灰（曾经 gpt-5 和 gpt-4o
    // 完全同色）。
    const names = ['gpt-5', 'gpt-4o', 'kimi-k2', 'kimi-k1.5', 'grok-4', 'glm-4.6', 'openai-o3'];
    const seen = new Map<string, string>();
    for (const name of names) {
      const text = brandBadgeColors('#000000', 'light', name).text;
      expect(text).not.toBe('var(--color-primary)');
      expect(seen.has(text)).toBe(false);
      seen.set(text, name);
    }
  });

  it('covers every registered brand so none fall back to the shared tint', () => {
    const brands = getAllBrands();
    expect(brands.length).toBeGreaterThan(60);

    const fellBack = brands.filter(
      (brand) => brandBadgeColors(brand.color).text === 'var(--color-primary)',
    );
    expect(fellBack).toEqual([]);
  });
});