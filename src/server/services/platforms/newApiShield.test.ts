import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NewApiAdapter } from './newApi.js';
import { fetchJsonWithShieldCookieRetry } from './newApiShield.js';
import { readFileSync } from 'node:fs';
import { solveNewApiAcwScV2 } from './newApiShield.js';

const challengeHtml = readFileSync(new URL('./__fixtures__/shield-challenge.html', import.meta.url), 'utf8');
const expectedChallengeCookie = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';

describe('acw challenge calculation', () => {
  it('keeps the main event loop responsive while challenge code is running', async () => {
    let timerRan = false;
    const timer = setTimeout(() => { timerRan = true; }, 0);
    const script = `<script>var arg1='${'A'.repeat(40)}';while(true){}</script>`;
    try {
      expect(await solveNewApiAcwScV2(script)).toBeNull();
      expect(timerRan).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it('contains asynchronous rejection objects without touching the parent error handlers', async () => {
    const script = `<script>var arg1='${'A'.repeat(40)}';Promise.reject({toString(){while(true){}}});document.cookie='acw_sc__v2=${expectedChallengeCookie};path=/';</script>`;
    expect(await solveNewApiAcwScV2(script)).toBeNull();
    expect(await solveNewApiAcwScV2(challengeHtml)).toBe(expectedChallengeCookie);
  });

  it('also accepts equivalent seed expressions', async () => {
    expect(await solveNewApiAcwScV2(challengeHtml.replace('p=L(0x115)', 'p=L(0x115+0x0)'))).toBe(expectedChallengeCookie);
  });

  it('bounds execution even when a decoder loops forever', async () => {
    const script = `<script>var arg1='${'A'.repeat(40)}';function decoder(){while(true){}}decoder();</script>`;
    const started = Date.now();
    expect(await solveNewApiAcwScV2(script)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not expose host modules or execute external scripts', async () => {
    const script = `<script>var arg1='${'A'.repeat(40)}';if(typeof process==='undefined' && typeof require==='undefined' && typeof fetch==='undefined') document.cookie='acw_sc__v2=${expectedChallengeCookie};path=/';</script>`;
    expect(await solveNewApiAcwScV2(script)).toBe(expectedChallengeCookie);
    expect(await solveNewApiAcwScV2(script.replace('<script>', '<script src="https://other.example/script.js">'))).toBeNull();
  });

  it('uses the script semantics for equivalent zero-based permutations', async () => {
    const mappingMatch = challengeHtml.match(/for\(var m=\[([^\]]+)\]/)!;
    const equivalent = challengeHtml
      .replace(mappingMatch[0], `for(var m=[${mappingMatch[1].split(',').map((value) => Number(value) - 1).join(',')}]`)
      .replace('m[z]==x+0x1', 'm[z]==x');
    expect(equivalent).not.toBe(challengeHtml);
    expect(await solveNewApiAcwScV2(equivalent)).toBe(expectedChallengeCookie);
  });
});

import {
  buildNewApiCookieCandidates,
  classifyShieldGateFailureText,
  isShieldCooldownActive,
  isShieldDenyPage,
  registerShieldCooldown,
  resetShieldCooldownsForTests,
} from './newApiShield.js';

describe('shield retry transport', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let requests: Array<{ path: string; cookie: string; method: string }>;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;

  beforeEach(async () => {
    resetShieldCooldownsForTests();
    requests = [];
    handler = (request, response) => {
      if (!String(request.headers.cookie || '').includes(`acw_sc__v2=${expectedChallengeCookie}`)) {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(challengeHtml);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: true, data: { quota: 500000, used_quota: 0 }, message: 'checked in' }));
      }
    };
    server = createServer((request, response) => {
      requests.push({ path: request.url || '/', cookie: request.headers.cookie || '', method: request.method || 'GET' });
      handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetShieldCooldownsForTests();
  });

  it.each([403, 500])('never consumes HTTP %i JSON as a successful balance', async (status) => {
    handler = (_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { quota: 500000, used_quota: 0 } }));
    };
    const result = await fetchJsonWithShieldCookieRetry(`${url}/api/user/self`);
    expect(result).toMatchObject({ status, ok: false });
    await expect(new NewApiAdapter().getBalance(url, 'offline-test', 42)).rejects.toThrow(`HTTP ${status}`);
  });

  it.each([200, 403])('recognizes explicit JSON http_ratelimit at HTTP %i', async (status) => {
    handler = (_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, message: 'denied by http_ratelimit' }));
    };
    const result = await fetchJsonWithShieldCookieRetry(`${url}/api/user/self`);
    expect(result.failure).toMatchObject({ code: 'upstream_rate_limited', terminal: true });
    await expect(new NewApiAdapter().getBalance(url, 'offline-test', 42)).rejects.toThrow('http_ratelimit');
    expect(requests).toHaveLength(1);
  });

  it('does not treat rate-limit words in successful business data as an error', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: { note: 'http_ratelimit' } }));
    };
    const result = await fetchJsonWithShieldCookieRetry(`${url}/api/user/self`);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('stops token revocation when listing tokens is rate limited', async () => {
    handler = (_request, response) => {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, message: 'rate limit exceeded' }));
    };
    await expect(new NewApiAdapter().deleteApiToken(url, 'offline-test', 'target-key', 42)).rejects.toThrow('限流');
    expect(requests).toHaveLength(1);
  });

  it('does not claim token deletion succeeded when listing failed', async () => {
    handler = (_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, message: 'unauthorized' }));
    };
    expect(await new NewApiAdapter().deleteApiToken(url, 'offline-test', 'target-key', 42)).toBe('unconfirmed');
  });

  it.each([{ success: true }, { success: true, data: { items: [], total: 1 } }])('does not infer token absence from an unverified or incomplete list: %j', async (payload) => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    expect(await new NewApiAdapter().deleteApiToken(url, 'offline-test', 'target-key', 42)).toBe('unconfirmed');
  });

  it('does not invent a default group when all responses are non-JSON errors', async () => {
    handler = (_request, response) => {
      response.writeHead(404, { 'Content-Type': 'text/html' });
      response.end('<html>not found</html>');
    };
    await expect(new NewApiAdapter().getUserGroups(url, 'offline-test', 42)).rejects.toThrow();
  });

  it('only reports an absent token after reading a valid empty token list', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: true, data: [] }));
    };
    expect(await new NewApiAdapter().deleteApiToken(url, 'offline-test', 'target-key', 42)).toBe('verified-absent');
  });

  it('does not replace a rate-limited group response with a default group', async () => {
    handler = (_request, response) => {
      response.writeHead(429, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ success: false, message: 'rate limit exceeded' }));
    };
    await expect(new NewApiAdapter().getUserGroups(url, 'offline-test', 42)).rejects.toThrow('限流');
    expect(requests).toHaveLength(1);
  });

  it('solves a challenge without any prior or response cookies', async () => {
    const result = await fetchJsonWithShieldCookieRetry<{ success: boolean }>(`${url}/api/user/self`, {
      headers: { Authorization: 'Bearer offline-test' },
    });
    expect(result.data?.success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1].cookie).toContain(`acw_sc__v2=${expectedChallengeCookie}`);
  });

  it('keeps redirect response cookies for the challenge retry', async () => {
    handler = (request, response) => {
      if (request.url === '/api/user/self') {
        response.writeHead(302, { Location: '/canonical/self', 'Set-Cookie': 'cdn_sec_tc=redirect-seed; Path=/; HttpOnly' });
        response.end();
        return;
      }
      const cookie = String(request.headers.cookie || '');
      if (!cookie.includes(`acw_sc__v2=${expectedChallengeCookie}`)) {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(challengeHtml);
      } else {
        response.writeHead(cookie.includes('cdn_sec_tc=redirect-seed') ? 200 : 403, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: cookie.includes('cdn_sec_tc=redirect-seed') }));
      }
    };
    const result = await fetchJsonWithShieldCookieRetry<{ success: boolean }>(`${url}/api/user/self`, {
      headers: { Authorization: 'Bearer offline-test' },
    });
    expect(result.data?.success).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2].cookie).toContain('cdn_sec_tc=redirect-seed');
  });

  it('preserves the final rate-limit reason and stops credential fallback requests', async () => {
    handler = (request, response) => {
      if (!String(request.headers.cookie || '').includes(`acw_sc__v2=${expectedChallengeCookie}`)) {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(challengeHtml);
      } else {
        response.writeHead(403, { 'Content-Type': 'text/html', 'x-tengine-error': 'denied by http_ratelimit' });
        response.end('<html><title>403 Forbidden</title><p>Denied by http_ratelimit</p></html>');
      }
    };
    await expect(new NewApiAdapter().getBalance(url, 'offline-test', 42)).rejects.toThrow('http_ratelimit');
    expect(requests).toHaveLength(2);
    const retry = await new NewApiAdapter().checkin(url, 'offline-test', 42);
    expect(retry.success).toBe(false);
    expect(retry.message).toContain('http_ratelimit');
    expect(requests).toHaveLength(2);
  });

  it('keeps a cookie-path rate-limit error instead of the earlier bearer failure', async () => {
    handler = (request, response) => {
      if (request.headers.authorization) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: false, message: 'invalid access token' }));
      } else {
        response.writeHead(403, { 'Content-Type': 'text/html' });
        response.end('<html><title>403 Forbidden</title><p>Denied by http_ratelimit</p></html>');
      }
    };
    await expect(new NewApiAdapter().getBalance(url, 'session=offline-test', 42)).rejects.toThrow('http_ratelimit');
    expect(requests).toHaveLength(2);
  });

  it('stops session checkin fallback after an explicit challenge denial', async () => {
    handler = (_request, response) => {
      response.writeHead(403, { 'Content-Type': 'text/html' });
      response.end('<html><title>403 Forbidden</title></html>');
    };
    const result = await new NewApiAdapter().checkin(url, 'session=offline-test', 42);
    expect(result.success).toBe(false);
    expect(result.message).toContain('403');
    expect(requests).toHaveLength(1);
  });

  it('stops credential retries when the upstream returns JSON rate limiting', async () => {
    handler = (_request, response) => {
      response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '120' });
      response.end(JSON.stringify({ success: false, message: 'rate limit exceeded' }));
    };
    const result = await fetchJsonWithShieldCookieRetry(`${url}/api/user/self`);
    expect(result.failure).toMatchObject({ code: 'upstream_rate_limited', status: 429 });
    expect(requests).toHaveLength(1);
  });

  it('does not silently discard a refused cross-origin redirect', async () => {
    handler = (_request, response) => {
      response.writeHead(302, { Location: 'https://other.example.invalid/receive' });
      response.end();
    };
    const result = await fetchJsonWithShieldCookieRetry(`${url}/api/user/self`, {
      headers: { Authorization: 'Bearer offline-test', Cookie: 'session=private-test' },
    });
    expect(result.failure).toMatchObject({ code: 'upstream_redirect_blocked', terminal: true });
    expect(requests).toHaveLength(1);
  });

  it('recovers the bearer balance path without requiring Set-Cookie', async () => {
    const result = await new NewApiAdapter().getBalance(url, 'offline-test', 42);
    expect(result.balance).toBe(1);
    expect(requests.length).toBeLessThanOrEqual(3);
  });
});

describe('newApiShield gate handling', () => {
  it('does not treat base64 padding as a cookie name', () => {
    const session = Buffer.from('a long session payload that ends with base64 padding').toString('base64');
    expect(session).toContain('=');
    expect(buildNewApiCookieCandidates(session)).toEqual([`session=${session}`, `token=${session}`]);
    expect(buildNewApiCookieCandidates('session=abc; acw_tc=seed')[0]).toBe('session=abc; acw_tc=seed');
  });
  it('recognizes deny/interstitial pages but not solvable challenges', () => {
    expect(isShieldDenyPage('<!DOCTYPE html><html lang="zh-CN"><head><title>403 Forbidden</title>')).toBe(true);
    expect(isShieldDenyPage('<html><head><title>Just a moment...</title>')).toBe(true);
    expect(isShieldDenyPage('<html><head><title>Attention Required! | Cloudflare</title>')).toBe(true);
    expect(isShieldDenyPage("<html><script>var arg1='3E87';(function(a,c){var G=a0j")).toBe(false);
    expect(isShieldDenyPage('{"success":false}')).toBe(false);
  });

  it('turns gate-page JSON parse failures into honest messages', () => {
    expect(
      classifyShieldGateFailureText('Unexpected token \'<\', "<html><scr"... is not valid JSON'),
    ).toContain('风控');
    expect(
      classifyShieldGateFailureText('Unexpected token \'<\', "<!DOCTYPE h"... is not valid JSON'),
    ).toContain('风控');
    expect(classifyShieldGateFailureText('access token 无效')).toBeNull();
    expect(classifyShieldGateFailureText(null)).toBeNull();
  });

  it('cools down a host after a gate failure and expires after the window', () => {
    resetShieldCooldownsForTests();
    expect(isShieldCooldownActive('https://anyrouter.top/api/user/self', 1_000)).toBe(false);
    registerShieldCooldown('https://anyrouter.top/api/user/self', 1_000);
    expect(isShieldCooldownActive('https://anyrouter.top/api/user/self', 1_001)).toBe(true);
    expect(isShieldCooldownActive('https://anyrouter.top/api/user/checkin', 30_000)).toBe(true);
    expect(isShieldCooldownActive('https://other.example/api/user/self', 1_001)).toBe(false);
    expect(isShieldCooldownActive('https://anyrouter.top/api/user/self', 61_001)).toBe(false);
    resetShieldCooldownsForTests();
  });
});
