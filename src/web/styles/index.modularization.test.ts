import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss from 'postcss';

const entry = resolve(process.cwd(), 'src/web/index.css');

function expandImports(file: string): string {
  const content = readFileSync(file, 'utf8');
  return content.replace(/@import "(\.\/styles\/[^"\n]+\.css)";\n/g, (_, specifier: string) =>
    expandImports(resolve(file, '..', specifier)));
}

function rules(source: string): string[] {
  return postcss.parse(source).nodes.flatMap((node) => node.type === 'atrule' && node.name === 'import' ? [] : [node.toString()]);
}

const extractedStyles = [
  { path: 'src/web/styles/oauth.css', marker: '.oauth-toolbar-card', minRules: 20 },
  { path: 'src/web/styles/login.css', marker: '.login-shell', minRules: 20 },
  { path: 'src/web/styles/route-cards.css', marker: '.route-filter-bar', minRules: 20 },
  { path: 'src/web/styles/dashboard-endpoints.css', marker: '.dashboard-endpoint-card', minRules: 10 },
];

describe('index.css source modularization', () => {
  it('inlines each extracted stylesheet intact at its import position', () => {
    const expanded = expandImports(entry);
    const expandedRules = rules(expanded);
    for (const stylesheet of extractedStyles) {
      const stylesheetRules = rules(readFileSync(resolve(process.cwd(), stylesheet.path), 'utf8'));
      expect(stylesheetRules.length, stylesheet.path).toBeGreaterThan(stylesheet.minRules);
      expect(stylesheetRules.some((rule) => rule.includes(stylesheet.marker)), stylesheet.path).toBe(true);
      const start = expandedRules.indexOf(stylesheetRules[0]!);
      expect(start, `${stylesheet.path} should be present in the expanded cascade`).toBeGreaterThanOrEqual(0);
      expect(expandedRules.slice(start, start + stylesheetRules.length)).toEqual(stylesheetRules);
    }
  });

  it('preserves page imports in source order after design tokens', () => {
    const source = readFileSync(entry, 'utf8');
    const oauth = source.indexOf('@import "./styles/oauth.css";');
    const login = source.indexOf('@import "./styles/login.css";');
    const routes = source.indexOf('@import "./styles/route-cards.css";');
    const endpoints = source.indexOf('@import "./styles/dashboard-endpoints.css";');
    expect(oauth).toBeGreaterThan(0);
    expect(login).toBeGreaterThan(oauth);
    expect(routes).toBeGreaterThan(login);
    expect(endpoints).toBeGreaterThan(routes);
    expect(expandImports(entry)).toContain('[data-theme="dark"] .login-brand-panel-light');
    expect(expandImports(entry)).toContain('@media (max-width: 640px)');
  });
});
