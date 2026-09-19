import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ProxyLogs mobile layout', () => {
  it('renders compact mobile summary cards for proxy logs', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');
    expect(source).toContain('MobileCard');
    expect(source).toContain(
      'import ResponsiveFilterPanel from \'../components/ResponsiveFilterPanel.js\';',
    );
    expect(source).toContain('<ResponsiveFilterPanel');
    expect(source).toContain('compact');
    expect(source).toContain('mobile-summary-grid');
    expect(source).toContain('subtitle={formatDateTimeLocal(log.createdAt)}');
  });

  it('surfaces the routed model next to the model name in both layouts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ProxyLogs.tsx'), 'utf8');
    expect(source).toContain(
      'import ActualModelTrigger from \'../components/ActualModelTrigger.js\';',
    );
    // Desktop table row: the badge owns the reveal, fed by the log's actual model.
    expect(source).toContain('actualModel={log.modelActual}');
    // Mobile card title: same glyph right after the model name.
    expect(source).toContain('actualModel={detailLog.modelActual}');
  });
});
