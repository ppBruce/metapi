import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';

import { ProxyDebugTraceDetailPanel } from './proxyLogTraceDetail.js';

/**
 * The debug-trace detail panel used to be a render function nested inside
 * ProxyLogs.tsx, where it could not be tested without mounting the whole page.
 * These cases pin the four load states and the populated panel, which is what the
 * extraction made reachable.
 */

function collectText(node: ReactTestInstance): string {
  return (node.children || [])
    .map((child) => (typeof child === 'string' ? child : collectText(child)))
    .join('');
}

function renderPanel(props: Parameters<typeof ProxyDebugTraceDetailPanel>[0]) {
  let renderer: ReturnType<typeof create> | null = null;
  act(() => {
    renderer = create(<ProxyDebugTraceDetailPanel {...props} />);
  });
  return renderer!;
}

const noop = vi.fn();

function detailData(overrides: Record<string, unknown> = {}) {
  return {
    trace: {
      downstreamPath: '/v1/chat/completions',
      sessionId: 'sess-1',
      requestedModel: 'gpt-5.2',
      finalUpstreamPath: '/v1/messages',
      endpointCandidatesJson: null,
      requestHeadersJson: null,
      requestBodyJson: null,
      finalResponseBodyJson: null,
    },
    attempts: [],
    ...overrides,
  } as never;
}

describe('ProxyDebugTraceDetailPanel', () => {
  it('prompts for a trace when nothing is selected', () => {
    const renderer = renderPanel({
      selectedDebugTraceId: null,
      detail: undefined,
      onCopyStoredDebugValue: noop,
    });
    expect(collectText(renderer.root)).toContain('暂无追踪详情。请选择一条最近追踪后再查看。');
  });

  it('shows a loading state while the detail is in flight', () => {
    const renderer = renderPanel({
      selectedDebugTraceId: 7,
      detail: { loading: true },
      onCopyStoredDebugValue: noop,
    });
    expect(collectText(renderer.root)).toContain('加载追踪详情中...');
  });

  it('surfaces a load error verbatim', () => {
    const renderer = renderPanel({
      selectedDebugTraceId: 7,
      detail: { loading: false, error: '请求超时' },
      onCopyStoredDebugValue: noop,
    });
    expect(collectText(renderer.root)).toContain('请求超时');
  });

  it('handles a response with no detail payload', () => {
    const renderer = renderPanel({
      selectedDebugTraceId: 7,
      detail: { loading: false },
      onCopyStoredDebugValue: noop,
    });
    expect(collectText(renderer.root)).toContain('暂无追踪详情。');
  });

  it('renders the trace summary', () => {
    const renderer = renderPanel({
      selectedDebugTraceId: 7,
      detail: { loading: false, data: detailData() },
      onCopyStoredDebugValue: noop,
    });
    const text = collectText(renderer.root);
    expect(text).toContain('/v1/chat/completions');
    expect(text).toContain('sess-1');
    expect(text).toContain('gpt-5.2');
    expect(text).toContain('/v1/messages');
  });
});
