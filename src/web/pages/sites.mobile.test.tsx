import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Sites mobile layout', () => {
  it('uses mobile cards with a drag handle instead of move arrows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');
    expect(source).toContain('mobile-card');
    expect(source).toContain('aria-label="拖拽调整站点顺序"');
    expect(source).not.toContain('handleMoveCustomOrder');
  });
});
