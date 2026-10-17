/**
 * Regression tests for the chat surface's "already sent, then resolve to
 * undefined" family — the 502 upstream-failure path reported by the cascading
 * peer.
 *
 * The bug these pin down (Fastify 5): an async handler that calls
 * `reply.send(x)` — directly or through `sendReplyIfWritable` — and then
 * resolves to `undefined` (explicit `return;`) makes Fastify run the same
 * onSend chain a second time whenever the chain is suspended by a
 * promise-returning onSend hook. The second pass ends in `safeWriteHead()` on a
 * head that is already written: an `ERR_HTTP_HEADERS_SENT` throw plus a
 * `FST_ERR_REP_ALREADY_SENT` warning in the log — while the client still sees
 * the correct 502 JSON. Production runs several async onSend hooks (capability
 * headers + security headers), so every terminal branch used to emit this noise.
 *
 * The apps below are shaped like production: two async onSend hooks (the
 * ingredient that keeps the chain in flight past the handler's `.then`
 * continuation). The last describe block is a deliberate counter-example
 * proving the detector actually fires on the buggy shape — if it ever stops
 * firing there, the "no header errors" assertions are worthless and this suite
 * must be fixed before it is trusted.
 */
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config.js';
import { sendReplyIfWritable } from '../../proxy-core/replySafety.js';
import { resetUpstreamEndpointRuntimeState } from '../../services/upstreamEndpointRuntimeMemory.js';

const fetchMock = vi.fn();
const selectChannelMock = vi.fn();
const selectNextChannelMock = vi.fn();
const recordSuccessMock = vi.fn();
const recordFailureMock = vi.fn();
const refreshModelsAndRebuildRoutesMock = vi.fn();
const reportProxyAllFailedMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const resetTokenExpiredSightingsMock = vi.fn();
const estimateProxyCostMock = vi.fn(async (_arg?: any) => 0);
const buildProxyBillingDetailsMock = vi.fn(async (_arg?: any) => null);
const fetchModelPricingCatalogMock = vi.fn(async (_arg?: any): Promise<any> => null);
const resolveProxyUsageWithSelfLogFallbackMock = vi.fn(async ({ usage }: any) => ({
  ...usage,
  estimatedCostFromQuota: 0,
  recoveredFromSelfLog: false,
}));
const dbInsertMock = vi.fn((_arg?: any) => ({
  values: () => ({
    run: () => undefined,
  }),
}));

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: (...args: unknown[]) => fetchMock(...args),
  };
});

vi.mock('../../services/tokenRouter.js', () => ({
  tokenRouter: {
    selectChannel: (...args: unknown[]) => selectChannelMock(...args),
    selectNextChannel: (...args: unknown[]) => selectNextChannelMock(...args),
    selectPreferredChannel: async () => null,
    recordSuccess: (...args: unknown[]) => recordSuccessMock(...args),
    recordFailure: (...args: unknown[]) => recordFailureMock(...args),
  },
}));

vi.mock('../../services/modelService.js', () => ({
  refreshModelsAndRebuildRoutes: (...args: unknown[]) => refreshModelsAndRebuildRoutesMock(...args),
}));

vi.mock('../../services/alertService.js', () => ({
  reportProxyAllFailed: (...args: unknown[]) => reportProxyAllFailedMock(...args),
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
  resetTokenExpiredSightings: (...args: unknown[]) => resetTokenExpiredSightingsMock(...args),
}));

vi.mock('../../services/alertRules.js', () => ({
  isTokenExpiredError: () => false,
}));

vi.mock('../../services/modelPricingService.js', () => ({
  estimateProxyCost: (arg: any) => estimateProxyCostMock(arg),
  buildProxyBillingDetails: (arg: any) => buildProxyBillingDetailsMock(arg),
  fetchModelPricingCatalog: (arg: any) => fetchModelPricingCatalogMock(arg),
}));

vi.mock('../../services/proxyRetryPolicy.js', () => ({
  resolveFailoverBackoffMs: () => 0,
  sleepMs: async () => undefined,
  shouldGraceRetryInPlaceOnce: () => false,
  shouldInPlaceRetryEmptyContentOnce: () => false,
  canRetryInPlaceForRecoveringFailure: () => false,
  isRecoveringTransientFailure: () => false,
  shouldRetryProxyRequest: () => false,
  shouldAbortSameSiteEndpointFallback: () => false,
  RETRYABLE_TIMEOUT_PATTERNS: [/(request timed out|connection timed out|read timeout|\btimed out\b)/i],
}));

vi.mock('../../services/proxyUsageFallbackService.js', () => ({
  resolveProxyUsageWithSelfLogFallback: (arg: any) => resolveProxyUsageWithSelfLogFallbackMock(arg),
}));

vi.mock('../../db/index.js', () => ({
  runtimeDbDialect: 'sqlite',
  hasProxyLogRequestTraceIdColumn: async () => true,
  db: {
    insert: (arg: any) => dbInsertMock(arg),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            all: async () => [],
          }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          run: async () => undefined,
        }),
      }),
    }),
  },
  hasProxyLogBillingDetailsColumn: async () => false,
  hasProxyLogClientColumns: async () => false,
  hasProxyLogDownstreamApiKeyIdColumn: async () => false,
  hasProxyLogStreamTimingColumns: async () => false,
  schema: {
    proxyLogs: {},
    siteApiEndpoints: {
      id: {},
      siteId: {},
      sortOrder: {},
    },
  },
}));

// --------------------------------------------------------------- writeHead probe
// `http.ServerResponse.prototype.writeHead` is the point where the double
// onSend pass becomes visible: the second pass calls it again on a response
// whose head is already out. Counting calls per response is the direct,
// framework-independent observation of "the chain ran twice".
interface WriteHeadRecord {
  response: http.ServerResponse;
  statusCode: number;
  headersAlreadySent: boolean;
}

type WriteHeadProbe = (
  this: http.ServerResponse,
  statusCode: number,
  ...rest: unknown[]
) => http.ServerResponse;

const writeHeadRecords: WriteHeadRecord[] = [];
const originalWriteHead = http.ServerResponse.prototype.writeHead;

function probeWriteHead(
  this: http.ServerResponse,
  statusCode: number,
  ...rest: unknown[]
): http.ServerResponse {
  writeHeadRecords.push({ response: this, statusCode, headersAlreadySent: this.headersSent });
  return Reflect.apply(originalWriteHead, this, [statusCode, ...rest]) as http.ServerResponse;
}

const HEADER_ERROR_MARKERS = ['ERR_HTTP_HEADERS_SENT', 'FST_ERR_REP_ALREADY_SENT'] as const;

function errorMarkersIn(logs: readonly string[]): string[] {
  const text = logs.join('\n');
  return HEADER_ERROR_MARKERS.filter((marker) => text.includes(marker));
}

interface RequestOutcome {
  status: number;
  body: string;
  contentType: string | null;
  writeHeads: WriteHeadRecord[];
  logs: string[];
}

interface TestApp {
  app: FastifyInstance;
  logs: string[];
}

/**
 * Production-shaped app: the real chat route plus the two promise-returning
 * onSend hooks that keep the chain parked while the handler promise settles.
 */
async function startProductionShapedApp(): Promise<TestApp> {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      // 'trace' captures every level, so nothing can hide below the stream's threshold.
      level: 'trace',
      stream: { write: (line: string) => logs.push(line) },
    },
  });
  // The hooks await a macrotask on purpose: the bug only exists while the
  // onSend chain is still in flight when the handler promise settles (a
  // one-microtask hook usually loses that race in a test, while in production
  // the chain — compress + the capability/security hooks — is still parked).
  // Holding the chain open is the precondition of the defect, not a
  // convenience: with it, the pre-fix shapes below fail this suite.
  const holdChainOpen = async <T>(payload: T): Promise<T> => {
    await new Promise((resolve) => setImmediate(resolve));
    return payload;
  };
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-test-onsend-1', '1');
    return holdChainOpen(payload);
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-test-onsend-2', '1');
    return holdChainOpen(payload);
  });
  const { chatProxyRoute } = await import('./chat.js');
  await app.register(chatProxyRoute);
  const { responsesProxyRoute } = await import('./responses.js');
  await app.register(responsesProxyRoute);
  return { app, logs };
}

async function post(
  app: FastifyInstance,
  logs: string[],
  url: string,
  payload: Record<string, unknown>,
): Promise<RequestOutcome> {
  const writeHeadStart = writeHeadRecords.length;
  const logStart = logs.length;
  const response = await app.inject({ method: 'POST', url, payload });
  const body = response.body;
  // A stray second onSend pass reports its failure right after the response
  // reaches the client; let the loop drain before snapshotting the log slice.
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    status: response.statusCode,
    body,
    contentType: response.headers['content-type'] ?? null,
    writeHeads: writeHeadRecords.slice(writeHeadStart),
    logs: logs.slice(logStart),
  };
}

/** Every upstream fails with 502 regardless of endpoint/protocol candidate. */
function failEveryUpstreamWith502(): void {
  fetchMock.mockImplementation(async () => new Response('bad gateway', { status: 502 }));
}

beforeAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead = probeWriteHead;
});

afterAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead =
    originalWriteHead as unknown as WriteHeadProbe;
});

beforeEach(() => {
  writeHeadRecords.length = 0;
  fetchMock.mockReset();
  selectChannelMock.mockReset();
  selectNextChannelMock.mockReset();
  recordSuccessMock.mockReset();
  recordFailureMock.mockReset();
  refreshModelsAndRebuildRoutesMock.mockReset();
  reportProxyAllFailedMock.mockReset();
  reportTokenExpiredMock.mockReset();
  resetTokenExpiredSightingsMock.mockReset();
  estimateProxyCostMock.mockClear();
  buildProxyBillingDetailsMock.mockClear();
  fetchModelPricingCatalogMock.mockReset();
  resolveProxyUsageWithSelfLogFallbackMock.mockClear();
  dbInsertMock.mockClear();
  resetUpstreamEndpointRuntimeState();

  selectChannelMock.mockReturnValue({
    channel: { id: 11, routeId: 22 },
    site: { name: 'demo-site', url: 'https://upstream.example.com' },
    account: { id: 33, username: 'demo-user' },
    tokenName: 'default',
    tokenValue: 'sk-demo',
    actualModel: 'upstream-gpt',
  });
  selectNextChannelMock.mockReturnValue(null);
  fetchModelPricingCatalogMock.mockResolvedValue(null);
  (config as any).codexHeaderDefaults = {
    userAgent: '',
    betaFeatures: '',
  };
  (config as any).payloadRules = {
    default: [],
    defaultRaw: [],
    override: [],
    overrideRaw: [],
    filter: [],
  };
  (config as any).disableCrossProtocolFallback = false;
  (config as any).openAiServiceTierRules = undefined;
  // One attempt only: the first upstream failure is terminal, which is the
  // branch that used to send through `sendReplyIfWritable` and then resolve to
  // undefined (the reported 502 shape).
  (config as any).proxyMaxChannelAttempts = 1;
  config.proxyEmptyContentFailEnabled = false;
  config.proxyErrorKeywords = [];
});

describe('chat surface upstream-502 terminal branch', () => {
  it('writes the head once and logs no header errors when every upstream answers 502', async () => {
    const harness = await startProductionShapedApp();
    failEveryUpstreamWith502();

    try {
      const outcome = await post(harness.app, harness.logs, '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      });

      // The client keeps getting the real 502 JSON — that is exactly why this
      // bug is easy to miss.
      expect(outcome.status).toBe(502);
      expect(outcome.contentType).toContain('application/json');
      expect(JSON.parse(outcome.body)).toMatchObject({
        error: { type: 'upstream_error' },
      });

      // ...but the response must have been written exactly once.
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 502, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });

  it('writes the head once on the streaming request path too', async () => {
    const harness = await startProductionShapedApp();
    failEveryUpstreamWith502();

    try {
      const outcome = await post(harness.app, harness.logs, '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(outcome.status).toBe(502);
      expect(JSON.parse(outcome.body)).toMatchObject({
        error: { type: 'upstream_error' },
      });
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 502, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
  it('writes the head once on the /v1/responses upstream-502 path too', async () => {
    const harness = await startProductionShapedApp();
    failEveryUpstreamWith502();

    try {
      const outcome = await post(harness.app, harness.logs, '/v1/responses', {
        model: 'gpt-4o-mini',
        input: 'hi',
      });

      expect(outcome.status).toBe(502);
      expect(JSON.parse(outcome.body)).toMatchObject({
        error: { type: 'upstream_error' },
      });
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 502, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
  it('writes the head once when a stream fails before any byte reaches the client', async () => {
    // Drives the `continueAttemptOrTerminate` consumers: the terminal failure
    // is decided inside the helper (which returns 'terminal', never the reply),
    // so the caller is the function that must resolve with the reply.
    const harness = await startProductionShapedApp();
    config.proxyEmptyContentFailEnabled = true;
    const encoder = new TextEncoder();
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    fetchMock.mockImplementation(async () => new Response(upstreamBody, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    }));

    try {
      const outcome = await post(harness.app, harness.logs, '/v1/chat/completions', {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(outcome.status).toBe(502);
      expect(outcome.contentType).toContain('application/json');
      expect(JSON.parse(outcome.body)).toMatchObject({
        error: { type: 'upstream_error' },
      });
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 502, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
    } finally {
      await harness.app.close();
    }
  });
});

describe('chat surface regression detector (counter-example)', () => {
  it('the send-then-resolve-undefined shapes do trip ERR_HTTP_HEADERS_SENT + FST_ERR_REP_ALREADY_SENT', async () => {
    // Same app shape, but the handlers keep the pre-fix form:
    // `send(...)` followed by resolving to undefined. If this stops producing
    // the two markers, the detector above has lost its power and the
    // regression test must not be trusted until this counter-example is fixed.
    const logs: string[] = [];
    const app = Fastify({
      logger: {
        level: 'trace',
        stream: { write: (line: string) => logs.push(line) },
      },
    });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-test-onsend-1', '1');
      return payload;
    });
    app.addHook('onSend', async (_request, reply, payload) => {
      reply.header('x-test-onsend-2', '1');
      return payload;
    });
    // 1) plain reply.send + bare return.
    app.get('/buggy-send', async (_request, reply) => {
      reply.code(502).send({ error: { message: 'boom', type: 'upstream_error' } });
      return;
    });
    // 2) the pre-fix surface shape: sendReplyIfWritable + bare return.
    app.get('/buggy-if-writable', async (_request, reply) => {
      sendReplyIfWritable(reply, 502, { error: { message: 'boom', type: 'upstream_error' } });
      return;
    });
    // 3) the fixed shape: the helper is followed by returning the reply.
    app.get('/fixed-if-writable', async (_request, reply) => {
      sendReplyIfWritable(reply, 502, { error: { message: 'boom', type: 'upstream_error' } });
      return reply;
    });

    const outcomes = new Map<string, RequestOutcome>();
    try {
      for (const url of ['/buggy-send', '/buggy-if-writable', '/fixed-if-writable']) {
        const writeHeadStart = writeHeadRecords.length;
        const logStart = logs.length;
        const response = await app.inject({ method: 'GET', url });
        await new Promise((resolve) => setTimeout(resolve, 150));
        outcomes.set(url, {
          status: response.statusCode,
          body: response.body,
          contentType: response.headers['content-type'] ?? null,
          writeHeads: writeHeadRecords.slice(writeHeadStart),
          logs: logs.slice(logStart),
        });
      }
    } finally {
      await app.close();
    }

    for (const url of ['/buggy-send', '/buggy-if-writable']) {
      const buggy = outcomes.get(url)!;
      // The client still saw the correct 502 — the noise is server-side only.
      expect(buggy.status).toBe(502);
      expect(JSON.parse(buggy.body)).toMatchObject({ error: { message: 'boom' } });
      expect(errorMarkersIn(buggy.logs)).toEqual([
        'ERR_HTTP_HEADERS_SENT',
        'FST_ERR_REP_ALREADY_SENT',
      ]);
      expect(buggy.writeHeads.length).toBeGreaterThanOrEqual(2);
      expect(buggy.writeHeads.some((call) => call.headersAlreadySent)).toBe(true);
    }

    const fixed = outcomes.get('/fixed-if-writable')!;
    expect(fixed.status).toBe(502);
    expect(JSON.parse(fixed.body)).toMatchObject({ error: { message: 'boom' } });
    expect(errorMarkersIn(fixed.logs)).toEqual([]);
    expect(fixed.writeHeads).toHaveLength(1);
    expect(fixed.writeHeads[0]).toMatchObject({ statusCode: 502, headersAlreadySent: false });
  });
});
