import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('OAuthManagement mobile layout', () => {
  it('uses class-based mobile wrappers for trigger rows and connection actions', () => {
    const pageSource = readFileSync(resolve(process.cwd(), 'src/web/pages/OAuthManagement.tsx'), 'utf8');
    const cssSource = [
      'src/web/index.css',
      'src/web/styles/oauth.css',
    ].map((path) => readFileSync(resolve(process.cwd(), path), 'utf8')).join('\n');

    expect(pageSource).toContain('className="mobile-filter-row oauth-mobile-trigger-row"');
    expect(pageSource).toContain('className="mobile-card-actions oauth-mobile-actions"');
    expect(pageSource).toContain('className="oauth-row-actions"');
    expect(cssSource).toContain('.oauth-row-actions');
    expect(cssSource).toContain('.oauth-mobile-trigger-row');
    expect(cssSource).toContain('.oauth-toolbar-actions');
  });
});
