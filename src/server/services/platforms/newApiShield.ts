import type { RequestInit as UndiciRequestInit, Headers as UndiciHeaders } from 'undici';
import { Worker } from 'node:worker_threads';
import { withSiteProxyRequestInit } from '../siteProxy.js';
import { withManagementRequestTimeout } from './upstreamRequestTimeout.js';

const SHIELD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36';

export type NewApiShieldFailure = {
  code: 'upstream_rate_limited' | 'upstream_challenge_denied' | 'upstream_challenge_unsolved'
    | 'upstream_challenge_repeated' | 'upstream_html_response' | 'upstream_redirect_blocked' | 'upstream_http_error';
  status: number;
  message: string;
  terminal: boolean;
  responseMessage?: string;
};

export class NewApiShieldError extends Error {
  readonly name = 'NewApiShieldError';
  constructor(readonly failure: NewApiShieldFailure) {
    super(failure.message);
  }
}

export type NewApiShieldResult<T> = {
  data: T | null;
  cookieHeader: string;
  status: number;
  ok: boolean;
  failure?: NewApiShieldFailure;
};

// An on-demand backoff, not a scheduler. Preserve the observed error so a
// skipped call cannot masquerade as a new request or an authentication error.
const SHIELD_COOLDOWN_MS = 60_000;
const shieldCooldownByOrigin = new Map<string, { until: number; failure?: NewApiShieldFailure }>();

function resolveShieldHostKey(url: string): string {
  try { return new URL(url).origin.toLowerCase(); }
  catch { return String(url || '').toLowerCase(); }
}

function getShieldCooldown(url: string, nowMs = Date.now()) {
  const key = resolveShieldHostKey(url);
  const entry = shieldCooldownByOrigin.get(key);
  if (entry && entry.until <= nowMs) {
    shieldCooldownByOrigin.delete(key);
    return undefined;
  }
  return entry;
}

export function isShieldCooldownActive(url: string, nowMs = Date.now()): boolean {
  return !!getShieldCooldown(url, nowMs);
}

export function registerShieldCooldown(url: string, nowMs = Date.now(), failure?: NewApiShieldFailure): void {
  shieldCooldownByOrigin.set(resolveShieldHostKey(url), { until: nowMs + SHIELD_COOLDOWN_MS, failure });
}

export function resetShieldCooldownsForTests(): void {
  shieldCooldownByOrigin.clear();
}

export function buildNewApiCookieCandidates(token: string): string[] {
  const trimmed = (token || '').trim();
  if (!trimmed) return [];

  const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
  const candidates: string[] = [];

  const cookieName = raw.slice(0, raw.indexOf('='));
  const isCookieHeader = raw.includes(';')
    ? /(?:^|;\s*)[A-Za-z_][A-Za-z0-9_-]*=/.test(raw)
    : cookieName.length > 0 && cookieName.length <= 40
      && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(cookieName)
      && raw.length > raw.indexOf('=') + 1;
  if (raw.includes('=') && isCookieHeader) {
    candidates.push(raw);
  }

  candidates.push(`session=${raw}`);
  candidates.push(`token=${raw}`);

  return Array.from(new Set(candidates));
}

export function hasUsableSessionCookie(cookieHeader: string): boolean {
  if (!cookieHeader) return false;
  const ignored = new Set(['acw_tc', 'acw_sc__v2', 'cdn_sec_tc']);
  const pairs = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim().toLowerCase();
    if (!name || ignored.has(name)) continue;
    if (
      name === 'session'
      || name === 'token'
      || name === 'auth_token'
      || name === 'access_token'
      || name === 'jwt'
      || name === 'jwt_token'
      || name.includes('session')
      || name.includes('token')
      || name.includes('auth')
    ) {
      return true;
    }
  }
  return false;
}

const CHALLENGE_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { createContext, runInContext } = require('node:vm');
let failed = false;
let answer = null;
// Never stringify untrusted errors or forward their objects to the parent.
const reject = () => { failed = true; };
process.on('unhandledRejection', reject);
process.on('uncaughtException', reject);
try {
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  runInContext(
    "let challengeCookie = null;" +
    "globalThis.document = Object.create(null);" +
    "Object.defineProperty(document, 'cookie', {" +
    "get() { return challengeCookie ? 'acw_sc__v2=' + challengeCookie : ''; }," +
    "set(value) { const m = /^acw_sc__v2=([0-9a-f]{40})(?:;|$)/i.exec(String(value)); if(m) challengeCookie=m[1]; }" +
    "}); document.location = { reload() {} };",
    context, { timeout: 100 },
  );
  runInContext(workerData, context, { timeout: 100 });
  const result = runInContext('challengeCookie', context, { timeout: 100 });
  if (typeof result === 'string' && /^[0-9a-f]{40}$/i.test(result)) answer = result;
} catch { failed = true; }
// Give rejected promises a turn to report failure, inside this worker only.
setImmediate(() => { parentPort.postMessage(failed ? null : answer); parentPort.close(); });
`;

/** Run upstream computation outside the service thread, with hard limits. */
export async function solveNewApiAcwScV2(html: string): Promise<string | null> {
  if (html.length > 128 * 1024) return null;
  const script = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))
    .find((match) => !/\bsrc\s*=/i.test(match[1])
      && /\b(?:var|let|const)\s+arg1\s*=\s*['"][0-9a-f]{40}['"]/i.test(match[2]))?.[2];
  if (!script) return null;

  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(CHALLENGE_WORKER_SOURCE, {
        eval: true, workerData: script, env: {}, execArgv: [],
        stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
      });
    } catch { resolve(null); return; }
    let settled = false;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const answer = typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value) ? value : null;
      void worker.terminate().then(() => resolve(answer), () => resolve(null));
    };
    const deadline = setTimeout(() => finish(null), 1500);
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.once('message', finish);
    worker.once('messageerror', () => finish(null));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}

function isShieldChallenge(contentType: string, text: string): boolean {
  const normalizedType = (contentType || '').toLowerCase();
  if (normalizedType.includes('text/html') && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) {
    return true;
  }
  return /var\s+arg1\s*=/.test(text);
}

/**
 * The site answered with an explicit deny/interstitial page instead of the
 * solvable challenge (403 risk page, Cloudflare cue, …). Retrying immediately
 * cannot succeed — callers should back off briefly.
 */
export function isShieldDenyPage(text: string): boolean {
  const head = String(text || '');
  return /<title>\s*403 Forbidden\s*<\/title>/i.test(head)
    || /Just a moment\.\.\./i.test(head)
    || /Attention Required/i.test(head);
}

/**
 * Turn a raw JSON-parse failure caused by a gate page into an honest,
 * actionable message for API consumers (instead of `Unexpected token '<'`).
 */
export function classifyShieldGateFailureText(message?: string | null): string | null {
  const text = String(message || '').trim();
  if (!text) return null;
  const looksHtml = /Unexpected token '</i.test(text)
    || /<html|<!DOCTYPE/i.test(text);
  if (!looksHtml) return null;
  if (/Just a moment|Attention Required|_cf_chl/i.test(text)) {
    return '站点返回 Cloudflare 验证页，本次请求未完成';
  }
  if (/403 Forbidden/i.test(text)) {
    return '站点返回 403 风控验证页，本次请求未完成';
  }
  return '上游返回 HTML 风控验证页，本次请求未完成';
}

function normalizeHeaders(headers?: UndiciRequestInit['headers']): Record<string, string> {
  const output: Record<string, string> = {};
  if (!headers) return output;

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      output[String(key).toLowerCase()] = String(value);
    }
    return output;
  }

  const maybeIterable = headers as { forEach?: (fn: (value: string, key: string) => void) => void };
  if (typeof maybeIterable.forEach === 'function') {
    maybeIterable.forEach((value, key) => {
      output[key.toLowerCase()] = value;
    });
    return output;
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    output[key.toLowerCase()] = String(value);
  }
  return output;
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function collectSetCookieHeaders(headers: Headers | UndiciHeaders): string[] {
  const getSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    return getSetCookie.call(headers) || [];
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

type RequestCookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  expiresAt: number;
};

function storeResponseCookies(jar: Map<string, RequestCookie>, url: URL, values: string[]): void {
  for (const value of values) {
    const [pair, ...attributes] = value.split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim();
    const attrs = new Map(attributes.map((attribute) => {
      const split = attribute.indexOf('=');
      return split < 0
        ? [attribute.trim().toLowerCase(), '']
        : [attribute.slice(0, split).trim().toLowerCase(), attribute.slice(split + 1).trim()];
    }));
    const domain = attrs.get('domain')?.replace(/^\./, '').toLowerCase();
    if (domain && url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
    const path = attrs.get('path')?.startsWith('/')
      ? attrs.get('path')!
      : url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const maxAge = attrs.get('max-age');
    const expires = attrs.get('expires');
    const expiry = expires ? Date.parse(expires) : Number.POSITIVE_INFINITY;
    const expiresAt = maxAge !== undefined && /^-?\d+$/.test(maxAge)
      ? Date.now() + Number(maxAge) * 1000
      : Number.isNaN(expiry) ? Number.POSITIVE_INFINITY : expiry;
    jar.set(`${path}\0${name}`, {
      name, value: pair.slice(equals + 1), path,
      secure: attrs.has('secure'), expiresAt,
    });
  }
}

function requestCookieHeader(jar: Map<string, RequestCookie>, url: URL): string {
  return [...jar.values()]
    .filter((cookie) => cookie.expiresAt > Date.now()
      && (!cookie.secure || url.protocol === 'https:')
      && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

export async function fetchJsonWithShieldCookieRetry<T>(
  url: string,
  options?: UndiciRequestInit,
): Promise<NewApiShieldResult<T>> {
  const { fetch } = await import('undici');
  const headers = normalizeHeaders({
    'content-type': 'application/json',
    'user-agent': SHIELD_USER_AGENT,
    ...normalizeHeaders(options?.headers),
  });
  let currentUrl = new URL(url);
  const initialOrigin = currentUrl.origin;
  const cooldown = getShieldCooldown(url);
  if (cooldown) return {
    data: null, cookieHeader: '', status: cooldown.failure?.status ?? 0, ok: false,
    failure: cooldown.failure ? {
      ...cooldown.failure,
      message: `${cooldown.failure.message}；本次未发送请求（限流退避中）`,
    } : undefined,
  };
  // Apply the site/request priority before creating the jar. Do not discard a
  // site-only cookie or let the original request bypass a configured override.
  const initialOptions = await withSiteProxyRequestInit(url, withManagementRequestTimeout({ ...options, headers }));
  const baseHeaders = normalizeHeaders(initialOptions.headers);
  const cookies = new Map<string, RequestCookie>();
  for (const pair of (baseHeaders.cookie || '').split(';').filter(Boolean)) {
    storeResponseCookies(cookies, currentUrl, [`${pair.trim()}; Path=/`]);
  }
  delete baseHeaders.cookie;
  let cookieHeader = requestCookieHeader(cookies, currentUrl);
  const failed = (failure: NewApiShieldFailure): NewApiShieldResult<T> => {
    if (failure.code === 'upstream_rate_limited') registerShieldCooldown(url, Date.now(), failure);
    return { data: null, cookieHeader, status: failure.status, ok: false, failure };
  };
  let method = options?.method || 'GET';
  let body = options?.body ?? undefined;
  let redirects = 0;
  let challenges = 0;
  for (let requestCount = 0; requestCount < 8; requestCount += 1) {
    cookieHeader = requestCookieHeader(cookies, currentUrl);
    const response = await fetch(currentUrl, {
      ...initialOptions,
      method,
      body,
      redirect: 'manual',
      headers: { ...baseHeaders, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    });
    storeResponseCookies(cookies, currentUrl, collectSetCookieHeaders(response.headers));
    cookieHeader = requestCookieHeader(cookies, currentUrl);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects >= 5 || options?.redirect === 'error') return failed({
        code: 'upstream_redirect_blocked', status: response.status, terminal: true,
        message: `HTTP ${response.status}: 上游重定向不可跟随或超过次数限制`,
      });
      let nextUrl: URL;
      try { nextUrl = new URL(location, currentUrl); }
      catch { return failed({ code: 'upstream_redirect_blocked', status: response.status, terminal: true,
        message: `HTTP ${response.status}: 上游返回无效重定向地址` }); }
      // Never carry account credentials or challenge cookies to another origin.
      if (nextUrl.origin !== initialOrigin || nextUrl.username || nextUrl.password) return failed({
        code: 'upstream_redirect_blocked', status: response.status, terminal: true,
        message: `HTTP ${response.status}: 已阻止向其他来源重定向管理凭据`,
      });
      if (response.status === 303 || ([301, 302].includes(response.status) && method.toUpperCase() === 'POST')) {
        if (method.toUpperCase() !== 'HEAD') method = 'GET';
        body = undefined;
        delete baseHeaders['content-type'];
        delete baseHeaders['content-length'];
      }
      currentUrl = nextUrl;
      redirects += 1;
      continue;
    }

    const text = await response.text();
    const parsed = parseJsonSafe<T>(text);
    const edgeReason = response.headers.get('x-tengine-error') || '';
    const payload = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    const nested = payload?.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : null;
    const explicitError = [payload?.message, payload?.code, nested?.message, nested?.code]
      .filter((value): value is string => typeof value === 'string').join(' ');
    const rateEvidence = `${edgeReason} ${payload?.success !== true ? explicitError : ''} ${parsed === null ? text : ''}`;
    if (/http_ratelimit/i.test(rateEvidence) || response.status === 429) {
      return failed({ code: 'upstream_rate_limited', status: response.status, terminal: true,
        message: `HTTP ${response.status}: 上游限流（${/http_ratelimit/i.test(rateEvidence) ? 'http_ratelimit' : 'rate_limit'}），本次请求未完成，请稍后再试` });
    }
    if (parsed !== null) {
      if (!response.ok) return failed({
        code: 'upstream_http_error', status: response.status, terminal: response.status >= 500,
        message: `HTTP ${response.status}: ${explicitError.slice(0, 500) || '上游请求失败'}`,
        responseMessage: explicitError.slice(0, 500) || undefined,
      });
      return { data: parsed, cookieHeader, status: response.status, ok: true };
    }
    if (isShieldDenyPage(text) || /aliyun_waf_aa|AliyunCaptcha|_cf_chl|turnstile/i.test(text)) {
      return failed({ code: 'upstream_challenge_denied', status: response.status, terminal: true,
        message: `HTTP ${response.status}: 上游返回风控验证页${/captcha|aliyun_waf_aa|turnstile/i.test(text) ? '，需要浏览器验证' : ''}，本次请求未完成` });
    }
    if (!isShieldChallenge(response.headers.get('content-type') || '', text)) {
      const title = text.match(/<title>\s*([^<]+)\s*<\/title>/i)?.[1]?.split('|')[0]?.trim();
      const errorCode = text.match(/<span[^>]*>\s*Error\s*<\/span>\s*<span[^>]*>\s*(\d+)/i)?.[1];
      return failed({ code: 'upstream_html_response', status: response.status, terminal: response.status >= 500,
        message: `HTTP ${response.status}: ${title || '上游返回非 JSON 响应'}${errorCode ? ` (Error ${errorCode})` : ''}` });
    }
    const acw = await solveNewApiAcwScV2(text);
    if (!acw || challenges >= 2) {
      return failed({ code: acw ? 'upstream_challenge_repeated' : 'upstream_challenge_unsolved', status: response.status, terminal: false,
        message: acw ? '上游重复返回风控挑战，有限重试未通过' : '无法解析上游风控挑战（HTML），未继续重试' });
    }
    storeResponseCookies(cookies, currentUrl, [`acw_sc__v2=${acw}; Path=/`]);
    challenges += 1;
  }
  return failed({ code: 'upstream_challenge_repeated', status: 0, terminal: true, message: '上游请求已达到有限重试上限' });
}
