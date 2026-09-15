import { afterEach, describe, expect, it } from 'vitest';

import { resolveSystemProxyUrl, withSystemProxyRequestInit } from './systemProxy.js';

describe('system proxy resolution', () => {
  const KEY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'] as const;
  let saved: Record<string, string | undefined> = {};

  const withEnv = (vars: Partial<Record<(typeof KEY_NAMES)[number], string>>) => {
    for (const key of KEY_NAMES) delete process.env[key];
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  };

  afterEach(() => {
    for (const key of KEY_NAMES) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('prefers HTTPS_PROXY over the others', () => {
    saved = Object.fromEntries(KEY_NAMES.map((key) => [key, process.env[key]]));
    withEnv({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:8080',
      ALL_PROXY: 'http://127.0.0.1:9090',
    });
    expect(resolveSystemProxyUrl(process.env)).toBe('http://127.0.0.1:7897');
  });

  it('falls back to lowercase and ALL_PROXY forms', () => {
    withEnv({ http_proxy: 'socks5://127.0.0.1:1080' });
    expect(resolveSystemProxyUrl(process.env)).toBe('socks5://127.0.0.1:1080');
    withEnv({ ALL_PROXY: 'http://127.0.0.1:7897' });
    expect(resolveSystemProxyUrl(process.env)).toBe('http://127.0.0.1:7897');
  });

  it('treats unset or invalid values as direct connection', () => {
    withEnv({});
    expect(resolveSystemProxyUrl(process.env)).toBeNull();
    withEnv({ HTTPS_PROXY: 'not a url' });
    expect(resolveSystemProxyUrl(process.env)).toBeNull();
    withEnv({ HTTPS_PROXY: '   ' });
    expect(resolveSystemProxyUrl(process.env)).toBeNull();
  });

  it('attaches a real dispatcher when a proxy is configured', () => {
    withEnv({ HTTPS_PROXY: 'http://127.0.0.1:7899' });
    const init = withSystemProxyRequestInit(process.env, { signal: AbortSignal.timeout(1000) });
    expect(init.signal).toBeTruthy();
    expect((init as { dispatcher?: object }).dispatcher).toBeDefined();
  });

  it('returns the caller options untouched when no proxy is configured', () => {
    withEnv({});
    const signal = AbortSignal.timeout(1000);
    const init = { signal };
    const result = withSystemProxyRequestInit(process.env, init);
    expect(result).toBe(init);
  });
});
