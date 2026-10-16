export type ProxyLogUsageSource = 'upstream' | 'self-log' | 'unknown' | null;

export type ParsedProxyLogMetadata = {
  clientKind: string | null;
  sessionId: string | null;
  traceId: string | null;
  downstreamPath: string | null;
  upstreamPath: string | null;
  usageSource: ProxyLogUsageSource;
  errorCode: string | null;
  /**
   * Site / relay display name that answered the attempt, from a `[site:]`
   * locator token. Null on rows recorded before the token existed.
   */
  siteLabel: string | null;
  /**
   * Upstream HTTP status of the attempt, from a `[status:]` locator token.
   * Kept as the raw string so an explicit `status:0` (no upstream reply) is
   * not silently lost by a numeric coercion.
   */
  upstreamStatus: string | null;
  messageText: string;
};

export declare function parseProxyLogMetadata(rawMessage: string): ParsedProxyLogMetadata;
