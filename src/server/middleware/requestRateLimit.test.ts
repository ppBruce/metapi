import http from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  __getRateLimitSeenKeyStatsForTests,
  createRateLimitGuard,
  resetRequestRateLimitStore,
} from './requestRateLimit.js';

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

function fakeRequest(ip: string) {
  return { ip, headers: {} } as never;
}

function fakeReply() {
  const state = { statusCode: 0 };
  const reply = {
    code(code: number) {
      state.statusCode = code;
      return reply;
    },
    header() {
      return reply;
    },
    send() {
      return reply;
    },
  };
  return { reply: reply as never, state };
}

describe('createRateLimitGuard seen-key tracking', () => {
  it('keeps per-bucket seen-key tracking bounded under many unique client IPs', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-test',
      // Generous budget: this test exercises key bookkeeping, not 429s.
      max: 1_000_000,
      windowMs: 60_000,
    });

    for (let i = 0; i < 700; i += 1) {
      const { reply } = fakeReply();
      await guard(fakeRequest(`10.${Math.floor(i / 256) % 256}.${i % 256}.7`), reply);
    }

    const stats = __getRateLimitSeenKeyStatsForTests();
    const bucketStats = stats.find((entry) => entry.bucket === 'bounded-tracking-test');
    expect(bucketStats).toBeDefined();
    expect(bucketStats!.seenKeys).toBeLessThanOrEqual(512);
    resetRequestRateLimitStore();
  });

  it('still enforces the per-window budget across unique IPs', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-budget',
      max: 2,
      windowMs: 60_000,
    });

    let rejected = 0;
    for (let i = 0; i < 5; i += 1) {
      const { reply, state } = fakeReply();
      await guard(fakeRequest('10.9.9.9'), reply);
      if (state.statusCode === 429) rejected += 1;
    }
    expect(rejected).toBe(3);
    resetRequestRateLimitStore();
  });

  it('reset clears limiter state so a fresh budget is available afterwards', async () => {
    resetRequestRateLimitStore();
    const guard = createRateLimitGuard({
      bucket: 'bounded-tracking-reset',
      max: 1,
      windowMs: 60_000,
    });

    const { reply: firstReply, state: firstState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), firstReply);
    expect(firstState.statusCode).toBe(0);

    const { reply: secondReply, state: secondState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), secondReply);
    expect(secondState.statusCode).toBe(429);

    resetRequestRateLimitStore();

    const { reply: thirdReply, state: thirdState } = fakeReply();
    await guard(fakeRequest('10.8.8.8'), thirdReply);
    expect(thirdState.statusCode).toBe(0);
  });
});

/**
 * Regression tests for the 429 path, driven through a real Fastify app because
 * the defect lives in the framework lifecycle, not in the guard's own return
 * value.
 *
 * The bug these pin down (Fastify 5): a preHandler hook that calls
 * `reply.send(...)` and then resolves to `undefined` makes Fastify run the same
 * onSend chain a second time while the chain is suspended by a
 * promise-returning onSend hook. The second pass ends in `safeWriteHead()` on an
 * already-written head: `ERR_HTTP_HEADERS_SENT` thrown on the server plus a
 * `FST_ERR_REP_ALREADY_SENT` warning in the log — while the client still sees the
 * correct 429. Production registers these guards as `{ preHandler: [guard] }`
 * and runs several async onSend hooks, so every throttled request used to emit
 * this noise.
 *
 * The second case is a deliberate counter-example proving the detector fires on
 * the buggy shape; if it ever stops firing there, the assertions above are
 * worthless.
 */

interface RateLimitOutcome {
  status: number;
  body: string;
  retryAfter: string | null;
  writeHeads: WriteHeadRecord[];
  logs: string[];
  routeHandlerCalls: number;
}

interface RateLimitHarness {
  app: FastifyInstance;
  get: () => Promise<RateLimitOutcome>;
}

type GuardHook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * Production-shaped app: the guard is registered exactly like the routes do it
 * (`{ preHandler: [guard] }`), and two promise-returning onSend hooks hold the
 * response chain open across a macrotask while the hook promise settles. A
 * one-microtask chain usually loses that race in a test and would let the buggy
 * shape pass, so the suspension is a precondition here, not a convenience.
 */
async function startRateLimitHarness(hook: GuardHook): Promise<RateLimitHarness> {
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
  let routeHandlerCalls = 0;
  app.get('/api/rate-limited-read', { preHandler: [hook] }, async () => {
    routeHandlerCalls += 1;
    return { ok: true };
  });

  return {
    app,
    async get(): Promise<RateLimitOutcome> {
      const writeHeadStart = writeHeadRecords.length;
      const logStart = logs.length;
      const response = await app.inject({ method: 'GET', url: '/api/rate-limited-read' });
      // A stray second onSend pass reports its failure right after the response
      // reaches the client; let the loop drain before snapshotting the log slice.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        status: response.statusCode,
        body: response.body,
        retryAfter: (response.headers['retry-after'] as string | undefined) ?? null,
        writeHeads: writeHeadRecords.slice(writeHeadStart),
        logs: logs.slice(logStart),
        routeHandlerCalls,
      };
    },
  };
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
  resetRequestRateLimitStore();
});

describe('createRateLimitGuard 429 path (preHandler hook)', () => {
  it('writes the 429 head once and logs no header errors when the budget is exhausted', async () => {
    const guard = createRateLimitGuard({
      bucket: 'prehandler-429-headers',
      max: 1,
      windowMs: 60_000,
    });
    const harness = await startRateLimitHarness(guard);

    try {
      const allowed = await harness.get();
      expect(allowed.status).toBe(200);
      expect(allowed.writeHeads).toHaveLength(1);
      expect(errorMarkersIn(allowed.logs)).toEqual([]);

      const rejected = await harness.get();

      // The client keeps getting the real 429 with its retry hint.
      expect(rejected.status).toBe(429);
      // The header is derived from the remaining window; only its presence and
      // shape are stable enough to assert (a 60s window can report 59 late in a
      // slow tick).
      expect(rejected.retryAfter).toMatch(/^\d+$/);
      expect(Number(rejected.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(rejected.retryAfter)).toBeLessThanOrEqual(60);
      expect(JSON.parse(rejected.body)).toEqual({
        success: false,
        message: '请求过于频繁，请稍后再试',
      });

      // ...but the response must have been written exactly once.
      expect(rejected.writeHeads).toHaveLength(1);
      expect(rejected.writeHeads[0]).toMatchObject({ statusCode: 429, headersAlreadySent: false });
      expect(errorMarkersIn(rejected.logs)).toEqual([]);
      // Single pass: the rejection resolves the hook chain only after the
      // response flushed, so the route handler never runs a second time.
      expect(rejected.routeHandlerCalls).toBe(1);
    } finally {
      await harness.app.close();
    }
  });
});

describe('createRateLimitGuard regression detector (counter-example)', () => {
  it('the send-then-resolve-undefined hook shape does trip ERR_HTTP_HEADERS_SENT + FST_ERR_REP_ALREADY_SENT', async () => {
    // Same app shape, but the hook keeps the pre-fix form: `send(...)` followed
    // by resolving to undefined. If this stops producing the two markers, the
    // detector above has lost its power and the regression test must not be
    // trusted until this counter-example is fixed.
    const preFixGuard: GuardHook = async (_request: FastifyRequest, reply: FastifyReply) => {
      reply
        .code(429)
        .header('retry-after', '1')
        .send({ success: false, message: '请求过于频繁，请稍后再试' });
      return;
    };
    const harness = await startRateLimitHarness(preFixGuard);

    try {
      const outcome = await harness.get();

      // The client still saw the correct 429 — the noise is server-side only.
      expect(outcome.status).toBe(429);
      expect(JSON.parse(outcome.body)).toEqual({
        success: false,
        message: '请求过于频繁，请稍后再试',
      });
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
