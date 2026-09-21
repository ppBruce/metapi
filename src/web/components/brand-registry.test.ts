import { describe, expect, it } from 'vitest';
import {
  BRAND_ICON_COLORS,
  MONO_ICON_KEYS,
  getAllBrandIconKeys,
  getAllBrands,
  brandIconBadgeColor,
  getBrand,
} from './brandRegistry.js';
import { getBrandIconUrl, normalizeBrandIconKey } from './brandRegistry.js';

describe('brand icon registry', () => {
  it('never rewrites a declared icon key through the legacy alias table', () => {
    // 别名表只服务于历史数据里存过的旧键。一旦某个键成了品牌槽或模型槽的正规
    // icon，别名就不能再改写它 —— 品牌槽和模型槽都要查，模型标被改写就会
    // 出现「模型槽显示厂商标」这种静默回退（zhipu-color 曾被改写成 zai）。
    const rewritten = getAllBrandIconKeys()
      .filter((icon) => normalizeBrandIconKey(icon) !== icon)
      .map((icon) => `${icon} -> ${normalizeBrandIconKey(icon)}`);
    expect(rewritten).toEqual([]);
  });

  it('resolves every brand icon through the shared icon proxy', () => {
    for (const brand of getAllBrands()) {
      if (!brand.icon) continue;
      const url = getBrandIconUrl(brand.icon, 'light');
      expect(url, `${brand.name} (${brand.icon})`).toMatch(/^\/api\/brand-icon\?icon=/);
      // 字标/横幅变体在方形徽标里会缩成一条细线，正规键里不允许出现。
      expect(url, `${brand.name} (${brand.icon})`).not.toMatch(/-brand|(-|_)(text)($|&)/);
    }
  });

  it('classifies every icon key as either coloured or mono, exactly once', () => {
    // 主色表由 `npm run brand:colors` 生成。新增图标键而没重跑生成脚本时，
    // 这里的差集就会失败，提示去重跑，而不是让徽标悄悄退回手写色。
    const keys = getAllBrandIconKeys();
    expect(keys.length).toBeGreaterThan(0);

    const coloured = new Set(Object.keys(BRAND_ICON_COLORS));
    const mono = new Set(MONO_ICON_KEYS);
    const uncovered = keys.filter((key) => !coloured.has(key) && !mono.has(key));
    const ambiguous = keys.filter((key) => coloured.has(key) && mono.has(key));
    const stale = [...coloured, ...mono].filter((key) => !keys.includes(key));

    expect(uncovered, '未录入主色表（需 npm run brand:colors）').toEqual([]);
    expect(ambiguous, '同时被标为彩色和单色').toEqual([]);
    expect(stale, '主色表里有已废弃的键').toEqual([]);
  });

  it('tints a badge with the mark色 it actually renders', () => {
    // 彩色标：徽标用图标自己的主色，和旁边的字形一致。
    const glm = getBrand('glm-4.6');
    expect(glm?.modelIcon).toBe('zhipu-color');
    expect(brandIconBadgeColor([glm?.modelIcon, glm?.icon], glm?.color)).toBe('#3859ff');
    const claude = getBrand('claude-sonnet-4.5');
    expect(brandIconBadgeColor([claude?.modelIcon, claude?.icon], claude?.color)).toBe('#d97757');

    // 单色标（kimi/grok/openai/zai）在 lobehub 里也只有黑白，没有任何色相可采：
    // 表里查不到就不编色，回落调用方给的基色（品牌自身的 ink），再由哈希扰动
    // 给同标的不同模型拉开区分度（黑白标厂商多，不能都变成同一个灰）。
    const kimi = getBrand('kimi-k2.5');
    expect(kimi?.modelIcon).toBe('kimi');
    expect(brandIconBadgeColor([kimi?.modelIcon, kimi?.icon], kimi?.color)).toBe(kimi?.color);

    // lobehub 声明 #000/#fff 的键不出现在色表里，调用方的基色原样返回。
    expect(brandIconBadgeColor(['zai'], '#000000')).toBe('#000000');
    expect(brandIconBadgeColor(['openai'], '#000000')).toBe('#000000');
    expect(brandIconBadgeColor([null, undefined], null)).toBeNull();
  });
});
