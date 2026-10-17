import { parseProxyLogMetadata, type ParsedProxyLogMetadata } from '../../../shared/proxyLogMeta.js';

type ProxyLogPathMeta = {
  clientFamily: string | null;
  sessionId: string | null;
  traceId: string | null;
  downstreamPath: string | null;
  upstreamPath: string | null;
  usageSource: ParsedProxyLogMetadata['usageSource'];
  /** `[site:]` — the site that answered a failed attempt. */
  siteLabel: string | null;
  /** `[status:]` — the upstream status of a failed attempt, as recorded. */
  upstreamStatus: string | null;
  errorMessage: string;
};

export function parseProxyLogPathMeta(message?: string): ProxyLogPathMeta {
  const raw = typeof message === 'string' ? message.trim() : '';
  const parsed = parseProxyLogMetadata(raw);

  return {
    clientFamily: parsed.clientKind,
    sessionId: parsed.sessionId,
    traceId: parsed.traceId,
    downstreamPath: parsed.downstreamPath,
    upstreamPath: parsed.upstreamPath,
    usageSource: parsed.usageSource,
    siteLabel: parsed.siteLabel,
    upstreamStatus: parsed.upstreamStatus,
    errorMessage: parsed.messageText,
  };
}
