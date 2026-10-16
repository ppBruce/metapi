export function parseProxyLogMetadata(rawMessage) {
  const text = typeof rawMessage === 'string' ? rawMessage : '';
  const clientMatch = text.match(/\[client:([^\]]+)\]/i);
  const sessionMatch = text.match(/\[session:([^\]]+)\]/i);
  const traceMatch = text.match(/\[trace:([^\]]+)\]/i);
  const downstreamMatch = text.match(/\[downstream:([^\]]+)\]/i);
  const upstreamMatch = text.match(/\[upstream:([^\]]+)\]/i);
  const usageMatch = text.match(/\[usage:([^\]]+)\]/i);
  const codeMatch = text.match(/\[code:([^\]]+)\]/i);
  const siteMatch = text.match(/\[site:([^\]]+)\]/i);
  const statusMatch = text.match(/\[status:([^\]]+)\]/i);
  const messageText = text.replace(
    /^\s*(?:\[(?:client|session|trace|downstream|upstream|usage|code|site|status):[^\]]+\]\s*)+/i,
    '',
  ).trim();

  return {
    clientKind: clientMatch?.[1]?.trim() || null,
    sessionId: sessionMatch?.[1]?.trim() || null,
    traceId: traceMatch?.[1]?.trim() || null,
    downstreamPath: downstreamMatch?.[1]?.trim() || null,
    upstreamPath: upstreamMatch?.[1]?.trim() || null,
    usageSource: usageMatch?.[1]?.trim() || null,
    errorCode: codeMatch?.[1]?.trim() || null,
    siteLabel: siteMatch?.[1]?.trim() || null,
    upstreamStatus: statusMatch?.[1]?.trim() || null,
    messageText,
  };
}
