import { fetch, type RequestInit as UndiciRequestInit } from 'undici';
import type { OauthQuotaEntrySnapshot, OauthQuotaSnapshot, OauthQuotaWindowSnapshot } from './quotaTypes.js';
import { withExplicitProxyRequestInit } from '../siteProxy.js';

/**
 * Provider-specific official quota/usage probes.
 *
 * Each probe hits the same endpoint the provider's own CLI uses, so the
 * numbers come from the vendor rather than from local bookkeeping. Probes
 * return `null` when the upstream shape is unrecognised — callers then fall
 * back to the generic unsupported snapshot instead of inventing values.
 */

const PROVIDER_QUOTA_TIMEOUT_MS = 10_000;
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_API_VERSION = '2023-06-01';
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const ANTIGRAVITY_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const ANTIGRAVITY_LOAD_PROJECT_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const ANTIGRAVITY_CLIENT_VERSION = '1.107.0';
const GITHUB_COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_USER_AGENT = 'GitHubCopilotChat/0.26.7';
const QODER_QUOTA_URL = 'https://openapi.qoder.sh/api/v2/quota/usage';
/** Antigravity publishes per-model buckets; the UI only needs the headliners. */
const ANTIGRAVITY_HEADLINE_MODELS = [
  'gemini-3-flash-agent',
  'gemini-3.5-flash-low',
  'gemini-3-pro-agent',
  'gemini-pro-agent',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asIsoDateTime(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Provider timestamps are seconds when below the ms epoch threshold.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function buildUnsupportedWindow(message: string): OauthQuotaWindowSnapshot {
  return { supported: false, message };
}

function buildUnsupportedSnapshot(provider: string, message?: string): OauthQuotaSnapshot {
  return {
    status: 'unsupported',
    source: 'official',
    providerMessage: message || `official quota windows are not exposed for ${provider} oauth`,
    windows: {
      fiveHour: buildUnsupportedWindow('official 5h quota window is unavailable for this provider'),
      sevenDay: buildUnsupportedWindow('official 7d quota window is unavailable for this provider'),
    },
    entries: [],
  };
}

async function fetchJson(input: {
  url: string;
  init: UndiciRequestInit;
  proxyUrl: string | null;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_QUOTA_TIMEOUT_MS);
  try {
    const response = await fetch(
      input.url,
      withExplicitProxyRequestInit(input.proxyUrl, {
        ...input.init,
        signal: controller.signal,
      }),
    );
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Claude Code OAuth: GET /api/oauth/usage returns percentage-used windows
 * (five_hour, seven_day, plus model-specific seven_day_* buckets).
 */
export async function probeClaudeQuota(input: {
  accessToken: string;
  proxyUrl: string | null;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const accessToken = asTrimmedString(input.accessToken);
  if (!accessToken) return null;

  const { ok, status, body } = await fetchJson({
    url: 'https://api.anthropic.com/api/oauth/usage',
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'anthropic-version': CLAUDE_API_VERSION,
        Accept: 'application/json',
      },
    },
    proxyUrl: input.proxyUrl,
  });
  if (!ok) {
    // 429 is the documented rate limit on this endpoint; surface it verbatim.
    if (status === 429) {
      return buildUnsupportedSnapshot('claude', 'Claude 额度端点限流（429），稍后重试');
    }
    return null;
  }

  const payload = asRecord(body);
  if (!payload) return null;

  const parseWindow = (raw: unknown): OauthQuotaWindowSnapshot | null => {
    const window = asRecord(raw);
    if (!window) return null;
    const utilization = asFiniteNumber(window.utilization);
    if (utilization === undefined) return null;
    const used = clampPercent(utilization);
    const resetAt = asIsoDateTime(window.resets_at);
    return {
      supported: true,
      used,
      limit: 100,
      remaining: clampPercent(100 - used),
      ...(resetAt ? { resetAt } : {}),
    };
  };

  const fiveHour = parseWindow(payload.five_hour);
  const sevenDay = parseWindow(payload.seven_day);
  if (!fiveHour && !sevenDay) return null;

  const entries: OauthQuotaEntrySnapshot[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!key.startsWith('seven_day_') || key === 'seven_day') continue;
    const parsed = parseWindow(value);
    if (!parsed) continue;
    entries.push({
      key,
      label: `7d ${key.replace('seven_day_', '')}`,
      kind: 'window',
      used: parsed.used,
      limit: 100,
      remaining: parsed.remaining,
      ...(parsed.resetAt ? { resetAt: parsed.resetAt } : {}),
    });
  }

  const extraUsage = asRecord(payload.extra_usage);
  if (extraUsage) {
    const used = asFiniteNumber(extraUsage.used_credits);
    const limit = asFiniteNumber(extraUsage.monthly_limit);
    if (used !== undefined || limit !== undefined) {
      entries.push({
        key: 'extra_usage',
        label: '额外用量',
        kind: 'credits',
        used: used ?? null,
        limit: limit ?? null,
        remaining: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : null,
        unit: 'credits',
      });
    }
  }

  const planType = asTrimmedString(payload.plan) || asTrimmedString(payload.subscription_type);
  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    providerMessage: 'claude usage windows fetched from official oauth/usage endpoint',
    ...(planType ? { subscription: { planType } } : {}),
    windows: {
      fiveHour: fiveHour ?? buildUnsupportedWindow('Claude 未返回 5h 窗口'),
      sevenDay: sevenDay ?? buildUnsupportedWindow('Claude 未返回 7d 窗口'),
    },
    ...(entries.length ? { entries } : {}),
  };
}

/**
 * Gemini CLI: POST v1internal:retrieveUserQuota with { project } returns
 * per-model buckets carrying remainingFraction + resetTime.
 */
export async function probeGeminiCliQuota(input: {
  accessToken: string;
  projectId?: string;
  proxyUrl: string | null;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const accessToken = asTrimmedString(input.accessToken);
  const projectId = asTrimmedString(input.projectId);
  if (!accessToken) return null;
  if (!projectId) {
    return buildUnsupportedSnapshot('gemini-cli', 'Gemini CLI 缺少 projectId，无法查询额度');
  }

  const { ok, status, body } = await fetchJson({
    url: GEMINI_QUOTA_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ project: projectId }),
    },
    proxyUrl: input.proxyUrl,
  });
  if (!ok) {
    return buildUnsupportedSnapshot('gemini-cli', `Gemini CLI 额度查询失败（HTTP ${status}）`);
  }

  const payload = asRecord(body);
  const buckets = Array.isArray(payload?.buckets) ? payload.buckets as unknown[] : [];
  const entries: OauthQuotaEntrySnapshot[] = [];
  for (const raw of buckets) {
    const bucket = asRecord(raw);
    if (!bucket) continue;
    const modelId = asTrimmedString(bucket.modelId);
    const remainingFraction = asFiniteNumber(bucket.remainingFraction);
    if (!modelId || remainingFraction === undefined) continue;
    const total = 100;
    const remaining = clampPercent(total * remainingFraction);
    const resetAt = asIsoDateTime(bucket.resetTime);
    entries.push({
      key: modelId,
      label: modelId,
      kind: 'bucket',
      used: clampPercent(total - remaining),
      limit: total,
      remaining,
      remainingPercent: clampPercent(remainingFraction * 100),
      ...(resetAt ? { resetAt } : {}),
    });
  }
  if (!entries.length) {
    return buildUnsupportedSnapshot('gemini-cli', 'Gemini CLI 未返回可识别的额度桶');
  }

  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    providerMessage: 'gemini-cli per-model quota fetched from official retrieveUserQuota endpoint',
    windows: {
      fiveHour: buildUnsupportedWindow('Gemini CLI 不提供 5h 窗口，按模型桶返回'),
      sevenDay: buildUnsupportedWindow('Gemini CLI 不提供 7d 窗口，按模型桶返回'),
    },
    entries,
  };
}

/**
 * Antigravity: POST v1internal:fetchAvailableModels returns per-model
 * quotaInfo (remainingFraction + resetTime).
 */
export async function probeAntigravityQuota(input: {
  accessToken: string;
  proxyUrl: string | null;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const accessToken = asTrimmedString(input.accessToken);
  if (!accessToken) return null;

  const loadHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-request-source': 'local',
  };

  let projectId: string | undefined;
  let planType: string | undefined;
  const assist = await fetchJson({
    url: ANTIGRAVITY_LOAD_PROJECT_URL,
    init: {
      method: 'POST',
      headers: loadHeaders,
      body: JSON.stringify({ mode: 1 }),
    },
    proxyUrl: input.proxyUrl,
  });
  if (assist.ok) {
    const assistBody = asRecord(assist.body);
    projectId = asTrimmedString(assistBody?.cloudaicompanionProject);
    const tier = asRecord(assistBody?.currentTier);
    planType = asTrimmedString(tier?.name);
  }

  const { ok, status, body } = await fetchJson({
    url: ANTIGRAVITY_QUOTA_URL,
    init: {
      method: 'POST',
      headers: {
        ...loadHeaders,
        'X-Client-Name': 'antigravity',
        'X-Client-Version': ANTIGRAVITY_CLIENT_VERSION,
      },
      body: JSON.stringify(projectId ? { project: projectId } : {}),
    },
    proxyUrl: input.proxyUrl,
  });
  if (status === 401) {
    return buildUnsupportedSnapshot('antigravity', 'Antigravity 额度端点认证已过期，聊天仍可用');
  }
  if (status === 403) {
    return buildUnsupportedSnapshot('antigravity', 'Antigravity 额度端点拒绝访问，聊天仍可用');
  }
  if (!ok) {
    return buildUnsupportedSnapshot('antigravity', `Antigravity 额度查询失败（HTTP ${status}）`);
  }

  const payload = asRecord(body);
  const models = asRecord(payload?.models);
  if (!models) return null;

  const entries: OauthQuotaEntrySnapshot[] = [];
  for (const [modelKey, raw] of Object.entries(models)) {
    const info = asRecord(raw);
    if (!info) continue;
    const quotaInfo = asRecord(info.quotaInfo);
    if (!quotaInfo) continue;
    if (info.isInternal === true) continue;
    if (!ANTIGRAVITY_HEADLINE_MODELS.includes(modelKey)) continue;
    const remainingFraction = asFiniteNumber(quotaInfo.remainingFraction);
    if (remainingFraction === undefined) continue;
    const total = 100;
    const remaining = clampPercent(total * remainingFraction);
    const resetAt = asIsoDateTime(quotaInfo.resetTime);
    entries.push({
      key: modelKey,
      label: asTrimmedString(info.displayName) || modelKey,
      kind: 'bucket',
      used: clampPercent(total - remaining),
      limit: total,
      remaining,
      remainingPercent: clampPercent(remainingFraction * 100),
      ...(resetAt ? { resetAt } : {}),
    });
  }
  if (!entries.length) {
    return buildUnsupportedSnapshot('antigravity', 'Antigravity 未返回可识别的额度桶');
  }

  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    providerMessage: 'antigravity per-model quota fetched from official fetchAvailableModels endpoint',
    ...(planType ? { subscription: { planType } } : {}),
    windows: {
      fiveHour: buildUnsupportedWindow('Antigravity 不提供 5h 窗口，按模型桶返回'),
      sevenDay: buildUnsupportedWindow('Antigravity 不提供 7d 窗口，按模型桶返回'),
    },
    entries,
  };
}

/**
 * GitHub Copilot: GET /copilot_internal/user returns quota_snapshots on paid
 * plans and monthly_quotas/limited_user_quotas on limited plans.
 * Requires the GitHub OAuth token (not the short-lived Copilot token).
 */
export async function probeGithubCopilotQuota(input: {
  accessToken: string;
  proxyUrl: string | null;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const accessToken = asTrimmedString(input.accessToken);
  if (!accessToken) return null;

  const { ok, status, body } = await fetchJson({
    url: GITHUB_COPILOT_USER_URL,
    init: {
      method: 'GET',
      headers: {
        Authorization: `token ${accessToken}`,
        Accept: 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': GITHUB_USER_AGENT,
        'Editor-Version': 'vscode/1.100.0',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
      },
    },
    proxyUrl: input.proxyUrl,
  });
  if (!ok) {
    return buildUnsupportedSnapshot('github', `GitHub Copilot 额度查询失败（HTTP ${status}）`);
  }

  const payload = asRecord(body);
  if (!payload) return null;

  const entries: OauthQuotaEntrySnapshot[] = [];
  const pushSnapshot = (key: string, label: string, raw: unknown, resetAt?: string) => {
    const snapshot = asRecord(raw);
    if (!snapshot) return;
    const entitlement = asFiniteNumber(snapshot.entitlement);
    const remaining = asFiniteNumber(snapshot.remaining);
    if (entitlement === undefined && remaining === undefined) return;
    const limit = entitlement ?? null;
    const used = limit != null && remaining != null ? clampPercent(limit - remaining) : null;
    entries.push({
      key,
      label,
      kind: 'bucket',
      used,
      limit,
      remaining: remaining ?? null,
      remainingPercent: limit != null && limit > 0 && remaining != null
        ? clampPercent((remaining / limit) * 100)
        : null,
      unlimited: snapshot.unlimited === true,
      ...(resetAt ? { resetAt } : {}),
    });
  };

  const quotaSnapshots = asRecord(payload.quota_snapshots);
  const resetAt = asIsoDateTime(payload.quota_reset_date);
  if (quotaSnapshots) {
    pushSnapshot('chat', 'Chat', quotaSnapshots.chat, resetAt);
    pushSnapshot('completions', 'Completions', quotaSnapshots.completions, resetAt);
    pushSnapshot(
      'premium_interactions',
      'Premium requests',
      quotaSnapshots.premium_interactions,
      resetAt,
    );
  } else {
    const monthly = asRecord(payload.monthly_quotas) || {};
    const limited = asRecord(payload.limited_user_quotas) || {};
    const limitedResetAt = asIsoDateTime(payload.limited_user_reset_date);
    for (const key of ['chat', 'completions'] as const) {
      const total = asFiniteNumber(monthly[key]);
      const used = asFiniteNumber(limited[key]);
      if (total === undefined && used === undefined) continue;
      const limit = total ?? null;
      const usedValue = used ?? null;
      entries.push({
        key,
        label: key === 'chat' ? 'Chat' : 'Completions',
        kind: 'bucket',
        used: usedValue,
        limit,
        remaining: limit != null && usedValue != null ? Math.max(0, limit - usedValue) : null,
        remainingPercent: limit != null && limit > 0 && usedValue != null
          ? clampPercent(((limit - usedValue) / limit) * 100)
          : null,
        ...(limitedResetAt ? { resetAt: limitedResetAt } : {}),
      });
    }
  }

  if (!entries.length) {
    return buildUnsupportedSnapshot('github', 'GitHub Copilot 未返回可识别的额度数据');
  }

  const planType = asTrimmedString(payload.copilot_plan) || asTrimmedString(payload.access_type_sku);
  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    providerMessage: 'github copilot quota fetched from official copilot_internal/user endpoint',
    ...(planType ? { subscription: { planType } } : {}),
    windows: {
      fiveHour: buildUnsupportedWindow('GitHub Copilot 不提供 5h 窗口，按月额度返回'),
      sevenDay: buildUnsupportedWindow('GitHub Copilot 不提供 7d 窗口，按月额度返回'),
    },
    entries,
  };
}

/**
 * Qoder: GET api/v2/quota/usage returns userQuota / orgResourcePackage
 * credit pools plus a single absolute expiresAt.
 */
export async function probeQoderQuota(input: {
  accessToken: string;
  proxyUrl: string | null;
  syncedAt: string;
}): Promise<OauthQuotaSnapshot | null> {
  const accessToken = asTrimmedString(input.accessToken);
  if (!accessToken) return null;

  const { ok, status, body } = await fetchJson({
    url: QODER_QUOTA_URL,
    init: {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    },
    proxyUrl: input.proxyUrl,
  });
  if (!ok) {
    return buildUnsupportedSnapshot('qoder', `Qoder 额度查询失败（HTTP ${status}）`);
  }

  const payload = asRecord(body);
  if (!payload) return null;
  const resetAt = asIsoDateTime(payload.expiresAt);

  const entries: OauthQuotaEntrySnapshot[] = [];
  const pushPool = (key: string, label: string, raw: unknown) => {
    const pool = asRecord(raw);
    if (!pool) return;
    const total = asFiniteNumber(pool.total);
    const used = asFiniteNumber(pool.used);
    const remaining = asFiniteNumber(pool.remaining);
    if (total === undefined && used === undefined && remaining === undefined) return;
    entries.push({
      key,
      label,
      kind: 'credits',
      used: used ?? null,
      limit: total ?? null,
      remaining: remaining ?? null,
      unit: asTrimmedString(pool.unit) || 'credits',
      ...(resetAt ? { resetAt } : {}),
    });
  };
  pushPool('user', '用户额度', payload.userQuota);
  pushPool('organization', '组织额度', payload.orgResourcePackage);

  if (!entries.length) {
    return buildUnsupportedSnapshot('qoder', 'Qoder 未返回可识别的额度数据');
  }

  return {
    status: 'supported',
    source: 'official',
    lastSyncAt: input.syncedAt,
    providerMessage: 'qoder quota fetched from official quota/usage endpoint',
    windows: {
      fiveHour: buildUnsupportedWindow('Qoder 不提供 5h 窗口，按积分池返回'),
      sevenDay: buildUnsupportedWindow('Qoder 不提供 7d 窗口，按积分池返回'),
    },
    entries,
  };
}

/** Providers with a dedicated official quota probe implemented above. */
export const PROVIDER_QUOTA_PROBES = new Set([
  'claude',
  'gemini-cli',
  'antigravity',
  'github',
  'qoder',
]);
