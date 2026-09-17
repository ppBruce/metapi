import type { PlatformAdapter } from './base.js';
import { NewApiAdapter } from './newApi.js';
import { OneApiAdapter } from './oneApi.js';
import { MetApiAdapter } from './metapi.js';
import { withManagementRequestTimeout } from './upstreamRequestTimeout.js';

import { Sub2ApiAdapter } from './sub2api.js';
import { OpenAiAdapter } from './openai.js';
import { CodexAdapter } from './codex.js';
import { ClaudeAdapter } from './claude.js';
import { GeminiAdapter } from './gemini.js';
import { GeminiCliAdapter } from './geminiCli.js';
import { AntigravityAdapter } from './antigravity.js';
import { detectPlatformByTitle } from './titleHint.js';
import { detectPlatformByUrlHint, normalizePlatformAlias } from '../../../shared/platformIdentity.js';

const adapters: PlatformAdapter[] = [
  // Specific forks before generic adapters for better auto-detection.
  new OpenAiAdapter(),
  new CodexAdapter(),
  new ClaudeAdapter(),
  new GeminiAdapter(),
  new GeminiCliAdapter(),
  new AntigravityAdapter(),

  new NewApiAdapter(),
  new Sub2ApiAdapter(),
  new OneApiAdapter(),
  new MetApiAdapter(),
];

function normalizePlatform(platform: string): string {
  return normalizePlatformAlias(platform);
}

export function getAdapter(platform: string): PlatformAdapter | undefined {
  const normalized = normalizePlatform(platform);
  return adapters.find((a) => a.platformName === normalized);
}

const titleFirstPlatforms = new Set<string>(['sub2api']);

async function looksLikeOpenAiCompatibleGateway(url: string): Promise<boolean> {
  const candidates = [
    `${url.replace(/\/+$/, '')}/v1/models`,
    `${url.replace(/\/+$/, '')}/models`,
    `${url.replace(/\/+$/, '')}/api/v1/models`,
  ];
  for (const target of candidates) {
    try {
      const { fetch } = await import('undici');
      const res = await fetch(target, withManagementRequestTimeout({ method: 'GET' }));
      const text = await res.text();
      const lowered = text.toLowerCase();
      if (
        lowered.includes('missing_api_key')
        || lowered.includes('api key is required')
        || lowered.includes('invalid_api_key')
        || lowered.includes('incorrect api key')
        || (res.status === 401 && (lowered.includes('unauthorized') || lowered.includes('api key')))
      ) {
        return true;
      }
      // Many compatible gateways (e.g. DeepSeek) reply 401 with their own
      // wording ("Authentication Fails (governor)") that matches no known
      // phrase. A 401 on /v1/models is itself the OpenAI-style gate signal:
      // the route exists and demands a key.
      if (res.status === 401 || res.status === 403) {
        return true;
      }
      try {
        const payload = JSON.parse(text) as { data?: unknown; object?: unknown };
        if (Array.isArray(payload.data) || payload.object === 'list') return true;
      } catch {
        // ignore non-json
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

/** Detect an Anthropic-compatible gateway via its /v1/messages endpoint. */
async function looksLikeAnthropicCompatibleGateway(url: string): Promise<boolean> {
  const candidates = [
    `${url.replace(/\/+$/, '')}/v1/messages`,
    `${url.replace(/\/+$/, '')}/api/v1/messages`,
  ];
  for (const target of candidates) {
    try {
      const { fetch } = await import('undici');
      const res = await fetch(target, withManagementRequestTimeout({ method: 'POST' }));
      const text = await res.text();
      const lowered = text.toLowerCase();
      if (
        lowered.includes('x-api-key')
        || lowered.includes('anthropic')
        || lowered.includes('invalid_api_key')
        || (res.status === 401 && (lowered.includes('unauthorized') || lowered.includes('authentication')))
      ) {
        return true;
      }
      // An authenticated /v1/messages is also a strong Claude-compat signal,
      // but requiring auth keeps 404-pages from matching.
      if ((res.status === 401 || res.status === 403) && lowered.length > 0) {
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

export async function detectPlatform(url: string): Promise<PlatformAdapter | undefined> {
  const urlHint = detectPlatformByUrlHint(url);
  if (urlHint) {
    return getAdapter(urlHint);
  }

  const titleHint = await detectPlatformByTitle(url);
  if (titleHint && titleFirstPlatforms.has(titleHint)) {
    return getAdapter(titleHint);
  }

  for (const adapter of adapters) {
    if (await adapter.detect(url)) return adapter;
  }

  if (titleHint) {
    return getAdapter(titleHint);
  }

  if (await looksLikeOpenAiCompatibleGateway(url)) {
    return getAdapter('openai');
  }

  // Anthropic-compatible gateways expose /v1/messages. Check it last so
  // OpenAI-compatible sites (which also carry /v1/models) are not misread
  // as Claude by a stray /v1/messages route.
  if (await looksLikeAnthropicCompatibleGateway(url)) {
    return getAdapter('claude');
  }

  return undefined;
}
