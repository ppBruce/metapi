import type { PreparedProviderRequest, PrepareProviderRequestInput, ProviderAction, ProviderProfile } from './types.js';
import { resolveAntigravityProviderAction } from './antigravityRuntime.js';
import { asTrimmedString } from '../../shared/trimString.js';
import { antigravityUserAgent } from '../../shared/antigravityVersion.js';

function resolvePath(action: ProviderAction): string {
  if (action === 'countTokens') return '/v1internal:countTokens';
  if (action === 'streamGenerateContent') return '/v1internal:streamGenerateContent?alt=sse';
  return '/v1internal:generateContent';
}

/**
 * Antigravity exposes thinking tiers as client-facing aliases, while its
 * runtime endpoint accepts the base Gemini model id. Keep the alias in the
 * route/request context and translate only the upstream envelope field.
 */
export function resolveAntigravityUpstreamModelName(modelName: string): string {
  const normalized = asTrimmedString(modelName);
  const tieredFlash = normalized.match(/^(gemini-[0-9]+(?:\.[0-9]+)?-flash)-(high|medium|low|extra-low|tiered)$/i);
  if (!tieredFlash) return normalized;
  // AG's newer high-thinking aliases are backed by the dynamic `tiered`
  // entities (for example gemini-3.8-flash-tiered), while older low/medium
  // names are accepted as their base model IDs.
  return tieredFlash[2].toLowerCase() === 'high'
    ? `${tieredFlash[1]}-tiered`
    : tieredFlash[1];
}

export const antigravityProviderProfile: ProviderProfile = {
  id: 'antigravity',
  prepareRequest(input: PrepareProviderRequestInput): PreparedProviderRequest {
    const action = resolveAntigravityProviderAction(input.action, input.stream, input.modelName);
    const projectId = asTrimmedString(input.oauthProjectId);
    const upstreamModelName = resolveAntigravityUpstreamModelName(input.modelName);
    return {
      path: resolvePath(action),
      headers: {
        Authorization: input.baseHeaders.Authorization,
        'Content-Type': 'application/json',
        Accept: action === 'streamGenerateContent' ? 'text/event-stream' : 'application/json',
        'User-Agent': antigravityUserAgent(),
      },
      body: {
        project: projectId,
        model: upstreamModelName,
        request: input.body,
      },
      runtime: {
        executor: 'antigravity',
        modelName: upstreamModelName,
        stream: input.stream,
        oauthProjectId: projectId,
        action,
      },
    };
  },
};
