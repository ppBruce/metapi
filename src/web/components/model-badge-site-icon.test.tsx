import { describe, expect, it, vi } from 'vitest';
import { create, act } from 'react-test-renderer';

vi.mock('./ActualModelTrigger.js', () => ({
  default: () => null,
}));

import { ModelBadge } from './BrandIcon.js';

/** Raw src of the single image the badge rendered, or null when it rendered none. */
function renderedImgSrc(root: ReturnType<typeof create>): string | null {
  const imgs = root.root.findAll((node) => node.type === 'img');
  return imgs.length ? String(imgs[0]!.props.src) : null;
}

describe('ModelBadge icon fallback', () => {
  it('classifies a known vendor from the brand rules, not from the site', () => {
    const root = create(
      <ModelBadge model="deepseek-v4-flash" site={{ name: 'CAIC', url: 'https://api.example.com/v1' }} />,
    );
    const src = renderedImgSrc(root);
    expect(src).toContain('/api/brand-icon');
    expect(src).toContain('deepseek');
    expect(src).not.toContain('site-favicon');
    act(() => root.unmount());
  });

  it("borrows the upstream site's icon for a vendor nobody classified yet", () => {
    const root = create(
      <ModelBadge model="brandnew-vendor-9000" site={{ name: 'CAIC-NewAPI', url: 'https://api.example.com/v1', id: 28 }} />,
    );
    const src = renderedImgSrc(root);
    // The whole point: a brand-new vendor needs no per-brand entry — the site it
    // came from already carries an icon the server discovers and caches.
    expect(src).toContain('/api/site-favicon');
    expect(src).toContain(encodeURIComponent('https://api.example.com'));
    expect(src).toContain('siteId=28');
    act(() => root.unmount());
  });

  it("falls back to the label's initial when neither a brand nor a usable site url exists", () => {
    // 站点刚加进来、favicon 还没抓到、厂商也没收录时，徽标必须仍有一个保底
    // 的字形；空白方块会让整列看起来像坏了。
    const root = create(<ModelBadge model="brandnew-vendor-9000" />);
    expect(renderedImgSrc(root)).toBeNull();
    const json = JSON.stringify(root.toJSON());
    expect(json).toContain('"B"');
    act(() => root.unmount());
  });
});
