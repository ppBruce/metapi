import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Sites status badge toggle', () => {
  it('keeps the site status badge as the enable/disable control', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');

    expect(source.match(/className="btn-as-badge"/g)).toHaveLength(2);
    expect(source.match(/onClick=\{\(\) => handleToggleStatus\(site\)\}/g)).toHaveLength(4);
    expect(source.match(/aria-label=\{`\$\{site\.status === 'disabled' \? '启用' : '禁用'\}站点 \$\{site\.name\}`\}/g)).toHaveLength(2);
    expect(source).toContain('await api.updateSite(site.id, { status: nextStatus });');
  });
});
