/**
 * Debug-trace detail render helpers for the proxy logs page. Extracted from
 * ProxyLogs.tsx (which was ~3k lines) — pure move, zero behavior change.
 * These are display-only: the copy handler is injected so the module stays
 * free of page state. Types are declared locally to avoid a circular import
 * with ProxyLogs.tsx.
 */
import { DetailDisclosureCard, debugCodeBlockStyle, detailInfoGridStyle, detailInfoItemStyle, detailInfoLabelStyle, detailInfoValueStyle } from './proxyLogsUi.js';
import { parseStoredDebugPreview, stringifyStoredDebugValue } from './proxyLogsHelpers.js';
import type { ProxyDebugTraceDetail } from '../../api.js';

export type ProxyDebugTraceAttempt = ProxyDebugTraceDetail['attempts'][number];

export type ProxyDebugTraceListItemLike = {
  id: number;
  finalStatus?: string | null;
};

export function renderTraceStatusBadge(trace: ProxyDebugTraceListItemLike) {
  const failed = trace.finalStatus === 'failed';
  // Plain coloured text, matching the usage-log status column: no chip, dot or
  // background — the whole column is one repeated value pair, so a filled badge
  // only adds noise and breaks the row baseline.
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: failed ? 600 : 500,
        color: failed ? 'var(--color-danger)' : 'var(--color-success)',
      }}
    >
      {failed ? '失败' : '成功'}
    </span>
  );
}

export function renderStoredDebugDetails(
  title: string,
  value: unknown,
  options: { defaultOpen?: boolean; copyLabel?: string },
  onCopy: (label: string, value: unknown) => void,
) {
  const normalized = parseStoredDebugPreview(value);
  const copyLabel = options?.copyLabel || title;

  return (
    <DetailDisclosureCard title={title} defaultOpen={options?.defaultOpen}>
      <div style={{ padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              border: '1px solid var(--color-border)',
              padding: '6px 12px',
            }}
            aria-label={`复制${copyLabel}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onCopy(copyLabel, value);
            }}
          >
            复制当前保存内容
          </button>
        </div>
        {normalized.note ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {normalized.note}
          </div>
        ) : null}
        <pre style={debugCodeBlockStyle}>{normalized.displayText}</pre>
      </div>
    </DetailDisclosureCard>
  );
}

/**
 * One attempt inside a debug trace: the target URL / executor / recovery and
 * downgrade flags as a labelled grid, plus the full serialized exchange (request
 * and response headers, bodies, raw error, memory write) in a code block.
 *
 * Extracted from ProxyLogs.tsx, which called it as a plain map() callback even
 * though it renders JSX.
 */
export function ProxyDebugAttemptDetail({ attempt }: { attempt: ProxyDebugTraceAttempt }) {
  const serializedAttempt = [
    `targetUrl: ${attempt.targetUrl}`,
    `runtimeExecutor: ${attempt.runtimeExecutor || '-'}`,
    `recoverApplied: ${attempt.recoverApplied ? 'true' : 'false'}`,
    `downgradeDecision: ${attempt.downgradeDecision ? 'true' : 'false'}`,
    `downgradeReason: ${attempt.downgradeReason || '-'}`,
    '',
    'requestHeaders:',
    stringifyStoredDebugValue(attempt.requestHeadersJson) || '-',
    '',
    'requestBody:',
    stringifyStoredDebugValue(attempt.requestBodyJson) || '-',
    '',
    'responseHeaders:',
    stringifyStoredDebugValue(attempt.responseHeadersJson) || '-',
    '',
    'responseBody:',
    stringifyStoredDebugValue(attempt.responseBodyJson) || '-',
    '',
    'rawErrorText:',
    attempt.rawErrorText || '-',
    '',
    'memoryWrite:',
    stringifyStoredDebugValue(attempt.memoryWriteJson) || '-',
  ].join('\n');

  return (
    <DetailDisclosureCard
      key={attempt.id}
      title={`#${attempt.attemptIndex + 1} · ${attempt.endpoint} · ${attempt.responseStatus ?? '-'} · ${attempt.requestPath}`}
    >
      <div style={{ padding: 12, display: 'grid', gap: 12 }}>
        <div style={detailInfoGridStyle}>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>目标地址</div>
            <div
              style={{
                ...detailInfoValueStyle,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
              }}
            >
              {attempt.targetUrl || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>执行器</div>
            <div style={detailInfoValueStyle}>
              {attempt.runtimeExecutor || '-'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>恢复逻辑</div>
            <div style={detailInfoValueStyle}>
              {attempt.recoverApplied ? '已应用' : '未应用'}
            </div>
          </div>
          <div style={detailInfoItemStyle}>
            <div style={detailInfoLabelStyle}>降级决策</div>
            <div style={detailInfoValueStyle}>
              {attempt.downgradeDecision ? '已触发' : '未触发'}
            </div>
          </div>
        </div>
        {attempt.downgradeReason ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            降级原因：{attempt.downgradeReason}
          </div>
        ) : null}
        <pre style={debugCodeBlockStyle}>{serializedAttempt}</pre>
      </div>
    </DetailDisclosureCard>
  );
}
