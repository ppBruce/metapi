import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('App login gate', () => {
  it('validates the admin token against the guarded verify endpoint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8').replace(/\r\n/g, '\n');

    // The gate must not validate against /api/settings/auth/info: that route is
    // public (desktop bootstrap) and accepts any Authorization header, which
    // let wrong tokens "sign in" and then fail every subsequent request.
    const start = source.indexOf('const handleLogin');
    const end = source.indexOf('className="login-shell"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handleLogin = source.slice(start, end);
    expect(handleLogin).toContain("'/api/settings/auth/verify'");
    expect(handleLogin).not.toContain("'/api/settings/auth/info'");

    // The first-run bootstrap hint must keep reading the public endpoint.
    expect(source).toContain("fetch('/api/settings/auth/info')");
  });
});
