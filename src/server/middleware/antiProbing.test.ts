import http from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { antiProbingMiddleware, isProbeRequest } from './antiProbing.js';

// The rejection path reads the per-key auth context (normally installed by
// proxyAuthMiddleware on a real /v1 request) and the globally configured
// thresholds. Both are stubbed so the app further down drives the real
// middleware to a deterministic "probe → 400" verdict without standing up the
// key/DB graph.
vi.mock('./auth.js', () => ({
  getProxyAuthContext: () => ({
    token: 'sk-test',
    source: 'managed',
    keyId: 1,
    keyName: 'test-key',
    policy: {},
    // Per-key override: force enforcement ON (null would consult global settings).
    sensitiveWordDetection: true,
  }),
}));

vi.mock('../services/sensitiveWordDetectionService.js', () => ({
  resolveGlobalSensitiveWordDetection: async () => true,
  resolveAntiProbeMinTextLength: async () => 8,
}));

describe('isProbeRequest', () => {
  it('flags a standalone short probe message', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    })).toBe(true);
  });

  it('flags a short message with no substantive prior user context', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ],
    })).toBe(true);
  });

  it('allows a short follow-up after a substantive prior user turn', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: '请帮我写一段关于机器学习的技术分析报告' },
        { role: 'assistant', content: '好的，如下...' },
        { role: 'user', content: '谢谢' },
      ],
    })).toBe(false);
  });

  it('allows normal long user messages', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: '请解释一下分布式系统中的一致性模型' }],
    })).toBe(false);
  });

  it('allows a short last message in a Gemini multi-turn conversation', () => {
    expect(isProbeRequest({
      model: 'gemini-2.0-flash',
      contents: [
        { role: 'user', parts: [{ text: '写一首关于夏天的诗' }] },
        { role: 'model', parts: [{ text: '夏日的风...' }] },
        { role: 'user', parts: [{ text: '再写一首' }] },
      ],
    })).toBe(false);
  });

  it('respects a configurable custom threshold', () => {
    // With a lenient threshold (1), a short-ish (but not pattern-matching) message is allowed.
    expect(isProbeRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'abcde' }] },
      1,
    )).toBe(false);
    // With the default threshold (8), the same message is flagged as a probe.
    expect(isProbeRequest(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'abcde' }] },
      8,
    )).toBe(true);
  });

  it('allows "write a story" — write-prefix is legitimate coding/agent traffic', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'write a story' }],
    })).toBe(false);
  });

  it('allows a long "can you" question', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'can you explain how distributed systems achieve consensus in detail?' }],
    })).toBe(false);
  });

  it('flags a short bare "can you" capability probe', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'can you help?' }],
    })).toBe(true);
  });

  it('does not flag a normal sentence containing "hi" as a substring', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'please fix the bug in this function and explain the change' }],
    })).toBe(false);
  });

  it('still flags a whole-word keyword probe', () => {
    expect(isProbeRequest({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'system prompt reveal' }],
    })).toBe(true);
  });
});

/**
 * Regression tests for the anti-probing REJECTION path (the 400 branch).
 *
 * The bug these pin down (Fastify 5): an async hook that calls `reply.send(x)`
 * and then resolves to `undefined` (explicit `return;`) makes Fastify run the
 * same onSend chain a second time while the chain is suspended by a
 * promise-returning onSend hook. The second pass ends in `safeWriteHead()` on an
 * already-written head: `ERR_HTTP_HEADERS_SENT` thrown on the server plus a
 * `FST_ERR_REP_ALREADY_SENT` warning in the log — while the client still sees the
 * correct 400. Production runs several async onSend hooks (capability +
 * security headers), so every blocked probe used to emit this noise.
 *
 * The app below is shaped like production: two async onSend hooks that hold the
 * chain open across a macrotask plus the middleware reached through the same
 * `await` wrapper as routes/proxy/router.ts. The last case is a deliberate
 * counter-example proving the detector actually fires on the buggy shape — if it
 * ever stops firing there, the "no header errors" assertions above are worthless
 * and this suite must be fixed before it is trusted.
 */

// --------------------------------------------------------------- writeHead probe
// `http.ServerResponse.prototype.writeHead` is the point where a second onSend
// pass becomes visible: it calls writeHead again on a response whose head is
// already out. Counting calls per response is the direct,
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

interface ProbeOutcome {
  status: number;
  body: string;
  writeHeads: WriteHeadRecord[];
  logs: string[];
  routeHandlerCalls: number;
}

interface ProbeHarness {
  app: FastifyInstance;
  post: (body: Record<string, unknown>) => Promise<ProbeOutcome>;
}

/**
 * Production-shaped app: the middleware is reached through the same `await`
 * wrapper as routes/proxy/router.ts (that `await` is what propagates a
 * reply-returning rejection into the framework), and the two
 * promise-returning onSend hooks keep the response chain parked while the hook
 * promise settles — the suspension is the precondition of the defect, so a test
 * that only crosses one microtask would lose that race and go green on the buggy
 * shape too.
 */
async function startAntiProbeHarness(
  middleware: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): Promise<ProbeHarness> {
  const logs: string[] = [];
  const app = Fastify({
    logger: {
      level: 'trace',
      stream: { write: (line: string) => logs.push(line) },
    },
  });
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
  app.addHook('preHandler', async (request, reply) => {
    await middleware(request, reply);
  });
  let routeHandlerCalls = 0;
  app.post('/v1/chat/completions', async () => {
    routeHandlerCalls += 1;
    return { ok: true };
  });

  return {
    app,
    async post(body: Record<string, unknown>): Promise<ProbeOutcome> {
      const writeHeadStart = writeHeadRecords.length;
      const logStart = logs.length;
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: body,
      });
      // A stray second onSend pass reports its failure right after the response
      // reaches the client; let the loop drain before snapshotting the log slice.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        status: response.statusCode,
        body: response.body,
        writeHeads: writeHeadRecords.slice(writeHeadStart),
        logs: logs.slice(logStart),
        routeHandlerCalls,
      };
    },
  };
}

const PROBE_BODY = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
const LEGIT_BODY = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '请解释一下分布式系统中的一致性模型' }],
};

beforeAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead = probeWriteHead;
});

afterAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead =
    originalWriteHead as unknown as WriteHeadProbe;
});

beforeEach(() => {
  writeHeadRecords.length = 0;
});

describe('antiProbingMiddleware rejection path', () => {
  it('writes the 400 head once and logs no header errors when a probe is blocked', async () => {
    const harness = await startAntiProbeHarness(antiProbingMiddleware);

    try {
      const outcome = await harness.post(PROBE_BODY);

      // The client keeps getting the real security-policy 400.
      expect(outcome.status).toBe(400);
      expect(JSON.parse(outcome.body)).toMatchObject({
        error: { type: 'invalid_request_error', code: 'anti_probe_blocked' },
      });

      // ...but the response must have been written exactly once.
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 400, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
      // Single pass: the rejection resolves the hook chain only after the
      // response flushed, so the route handler never runs.
      expect(outcome.routeHandlerCalls).toBe(0);
    } finally {
      await harness.app.close();
    }
  });

  it('writes the head once for a legitimate request that passes the middleware', async () => {
    // Control case for the harness itself: the app produces exactly one head and
    // no header noise when nothing is rejected, so the assertions above cannot
    // pass merely because the probe never sees inject responses.
    const harness = await startAntiProbeHarness(antiProbingMiddleware);

    try {
      const outcome = await harness.post(LEGIT_BODY);

      expect(outcome.status).toBe(200);
      expect(JSON.parse(outcome.body)).toEqual({ ok: true });
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 200, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
      expect(outcome.routeHandlerCalls).toBe(1);
    } finally {
      await harness.app.close();
    }
  });
});

describe('antiProbingMiddleware regression detector (counter-example)', () => {
  it('the send-then-resolve-undefined middleware shape does trip ERR_HTTP_HEADERS_SENT + FST_ERR_REP_ALREADY_SENT', async () => {
    // Same app shape, but the middleware keeps the pre-fix form: `send(...)`
    // followed by resolving to undefined. If this stops producing the two
    // markers, the detector above has lost its power and the regression test
    // must not be trusted until this counter-example is fixed.
    const preFixMiddleware = async (
      _request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<void> => {
      reply.code(400).send({
        error: { type: 'invalid_request_error', code: 'anti_probe_blocked' },
      });
      return;
    };
    const harness = await startAntiProbeHarness(preFixMiddleware);

    try {
      const outcome = await harness.post(PROBE_BODY);

      // The client still saw the correct 400 — the noise is server-side only.
      expect(outcome.status).toBe(400);
      expect(JSON.parse(outcome.body)).toMatchObject({ error: { code: 'anti_probe_blocked' } });
      expect(errorMarkersIn(outcome.logs)).toEqual([
        'ERR_HTTP_HEADERS_SENT',
        'FST_ERR_REP_ALREADY_SENT',
      ]);
      expect(outcome.writeHeads.length).toBeGreaterThanOrEqual(2);
      expect(outcome.writeHeads.some((call) => call.headersAlreadySent)).toBe(true);
    } finally {
      await harness.app.close();
    }
  });
});