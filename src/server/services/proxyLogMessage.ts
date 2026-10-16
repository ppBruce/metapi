import {
  parseProxyLogMetadata,
  type ParsedProxyLogMetadata,
  type ProxyLogUsageSource,
} from '../../shared/proxyLogMeta.js';
import { isEmptyContentFailureText } from './siteFailureClassification.js';

type ComposeProxyLogMessageArgs = {
  clientKind?: string | null;
  sessionId?: string | null;
  traceHint?: string | null;
  traceId?: string | null;
  downstreamPath?: string | null;
  upstreamPath?: string | null;
  usageSource?: ProxyLogUsageSource;
  errorCode?: string | null;
  errorMessage?: string | null;
  /**
   * Upstream HTTP status observed for this attempt. Only rendered as a
   * `[status:]` token when the message body says nothing on its own.
   */
  upstreamStatus?: number | null;
  /**
   * Site / relay display name this attempt ran on. Only rendered as a
   * `[site:]` token when the message body says nothing on its own.
   */
  siteLabel?: string | null;
};

export type ParsedProxyLogMessageMeta = ParsedProxyLogMetadata;

export function parseProxyLogMessageMeta(rawMessage: string): ParsedProxyLogMessageMeta {
  return parseProxyLogMetadata(rawMessage);
}

/**
 * Whether a failure body carries nothing an operator can act on: no text at
 * all, a bare relay fallback (`unknown error` — what a relay says when it has
 * no detail of its own), or an empty-content verdict. Such rows are
 * indistinguishable from each other in the log list, so they are the only ones
 * that get `[site:]` / `[status:]` locator tokens.
 *
 * Empty-content detection reuses the shared failure vocabulary in
 * siteFailureClassification.ts so the log locator and the retry / routing-health
 * classifiers keep the same definition of that failure.
 */
export function isUninformativeProxyLogBody(messageText?: string | null): boolean {
  const normalized = typeof messageText === 'string' ? messageText.trim() : '';
  if (!normalized) return true;
  if (/^unknown\s+error$/i.test(normalized)) return true;
  return isEmptyContentFailureText(normalized);
}

/** Keeps a site name inside the `[token:value]` grammar (no brackets, no newlines). */
function normalizeSiteLabel(siteLabel?: string | null): string | null {
  if (typeof siteLabel !== 'string') return null;
  const normalized = siteLabel.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

/** Only a positive, finite HTTP status is worth recording; 0 / null mean "no upstream reply". */
function normalizeUpstreamStatus(upstreamStatus?: number | null): number | null {
  if (typeof upstreamStatus !== 'number' || !Number.isFinite(upstreamStatus)) return null;
  const status = Math.trunc(upstreamStatus);
  return status > 0 ? status : null;
}

/**
 * Locator arguments for a proxy log row, derived from the row status: only a
 * FAILED attempt carries them (a success row must not grow `[site:]` /
 * `[status:]` tokens on its empty error body). Unknown site/status stays null,
 * so a locator is never half-true. Spread the result into
 * composeProxyLogMessage.
 */
export function proxyLogFailureLocator(args: {
  status?: string | null;
  siteName?: string | null;
  upstreamStatus?: number | null;
}): { siteLabel: string | null; upstreamStatus: number | null } {
  if (args.status !== 'failed') return { siteLabel: null, upstreamStatus: null };
  return {
    siteLabel: normalizeSiteLabel(args.siteName),
    upstreamStatus: normalizeUpstreamStatus(args.upstreamStatus),
  };
}

export function composeProxyLogMessage({
  clientKind,
  sessionId,
  traceHint,
  traceId,
  downstreamPath,
  upstreamPath,
  usageSource,
  errorCode,
  errorMessage,
  upstreamStatus,
  siteLabel,
}: ComposeProxyLogMessageArgs): string | null {
  const rawMessage = typeof errorMessage === 'string' ? errorMessage.trim() : '';
  const parsed = parseProxyLogMessageMeta(rawMessage);
  const finalClientKind = (clientKind || parsed.clientKind || '').trim();
  const finalSessionId = (sessionId || traceHint || parsed.sessionId || '').trim();
  const finalTraceId = (traceId || parsed.traceId || '').trim();
  const finalDownstreamPath = (downstreamPath || parsed.downstreamPath || '').trim();
  const finalUpstreamPath = (upstreamPath || parsed.upstreamPath || '').trim();
  const finalUsageSource = (usageSource || parsed.usageSource || '').trim();
  const finalErrorCode = (errorCode || parsed.errorCode || '').trim();
  const finalMessageText = parsed.messageText.trim();
  const locatorSiteLabel = normalizeSiteLabel(siteLabel);
  const locatorUpstreamStatus = normalizeUpstreamStatus(upstreamStatus);

  const prefixParts: string[] = [];
  if (finalClientKind) prefixParts.push(`[client:${finalClientKind}]`);
  if (finalSessionId) prefixParts.push(`[session:${finalSessionId}]`);
  if (finalTraceId) prefixParts.push(`[trace:${finalTraceId}]`);
  if (finalDownstreamPath) prefixParts.push(`[downstream:${finalDownstreamPath}]`);
  if (finalUpstreamPath) prefixParts.push(`[upstream:${finalUpstreamPath}]`);
  if (finalUsageSource) prefixParts.push(`[usage:${finalUsageSource}]`);
  if (finalErrorCode) prefixParts.push(`[code:${finalErrorCode}]`);

  // Locator tokens: appended after the identifying prefixes and before the body,
  // and ONLY when the body carries no information of its own. The row then says
  // which site answered and with what status without a DB join (the columns
  // already hold them, the text did not). A message that explains itself — an
  // upstream `{"error": ...}` body, a classification verdict — is returned
  // byte-identical: this must not rewrite useful errors.
  if (
    (locatorSiteLabel !== null || locatorUpstreamStatus !== null)
    && isUninformativeProxyLogBody(finalMessageText)
  ) {
    if (locatorSiteLabel !== null) prefixParts.push(`[site:${locatorSiteLabel}]`);
    if (locatorUpstreamStatus !== null) prefixParts.push(`[status:${locatorUpstreamStatus}]`);
  }

  if (prefixParts.length === 0 && !finalMessageText) return null;
  if (finalMessageText) return `${prefixParts.join(' ')} ${finalMessageText}`.trim();
  return prefixParts.join(' ');
}
