/**
 * Regression tests for the tunnel-admin rejection paths (POST /api/tunnel/enable
 * and its siblings) — the "already sent, then resolve to undefined" family,
 * reported by production logs on v1.8.9: a 403 rejection still emitted
 * ERR_HTTP_HEADERS_SENT + FST_ERR_REP_ALREADY_SENT because
 * `if (rejectTunnelAdminAction(...)) return;` resolves the async handler to
 * undefined after the helper sent the reply.
 *
 * Same double-onSend-chain mechanism as chat.upstream-failure-headers.test.ts:
 * two promise-returning onSend hooks hold the chain parked across macrotasks
 * (production registers capability + security header hooks), so the
 * wrap-thenable continuation still sees `!reply.sent` and re-enters the chain.
 * The final describe block is a deliberate counter-example proving the
 * detector fires on the buggy shape — without it, the clean-path assertions
 * above could pass vacuously.
 */
import http from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/cloudflareTunnelService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/cloudflareTunnelService.js')>(
    '../../services/cloudflareTunnelService.js',
  );
  return {
    ...actual,
    // Never let a test spawn or stop a real connector.
    startCloudflareTunnel: vi.fn(async () => ({ running: false, url: null })),
    stopCloudflareTunnel: vi.fn(async () => undefined),
    setTunnelDashboardAccess: vi.fn(async () => undefined),
  };
});

const { tunnelRoutes } = await import('./tunnel.js');

// --------------------------------------------------------------- writeHead probe
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
  writeHeads: WriteHeadRecord[];
  logs: string[];
}

async function request(
  app: FastifyInstance,
  logs: string[],
  url: string,
  headers: Record<string, string> = {},
  method: 'POST' | 'PUT' = 'POST',
): Promise<RequestOutcome> {
  const writeHeadStart = writeHeadRecords.length;
  const logStart = logs.length;
  const response = await app.inject({ method, url, headers });
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    status: response.statusCode,
    body: response.body,
    writeHeads: writeHeadRecords.slice(writeHeadStart),
    logs: logs.slice(logStart),
  };
}

async function startProductionShapedApp(): Promise<{ app: FastifyInstance; logs: string[] }> {
  const logs: string[] = [];
  const app = Fastify({
    logger: { level: 'trace', stream: { write: (line: string) => logs.push(line) } },
  });
  // Hold the onSend chain open across a macrotask on purpose: with only
  // microtask hooks the buggy shape loses the race in a test and the suite
  // would pass vacuously. Production has compress + capability/security hooks
  // still parked when the handler promise settles.
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
  await app.register(tunnelRoutes);
  return { app, logs };
}

const TUNNEL_HEADERS = { host: 'rq4gbtu.abc-tunnel.us', 'cf-ray': '8a1b2c3d-SJC' };

beforeAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead =
    probeWriteHead;
});

afterAll(() => {
  (http.ServerResponse.prototype as unknown as { writeHead: WriteHeadProbe }).writeHead =
    originalWriteHead as unknown as WriteHeadProbe;
});

beforeEach(() => {
  writeHeadRecords.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('tunnel admin rejection path writes the response exactly once', () => {
  const cases: Array<{ url: string; method: 'POST' | 'PUT' }> = [
    { url: '/api/tunnel/enable', method: 'POST' },
    { url: '/api/tunnel/disable', method: 'POST' },
    { url: '/api/tunnel/dashboard-access', method: 'PUT' },
  ];
  for (const { url, method } of cases) {
    it(`${method} ${url} from a tunnel origin`, async () => {
      const { app, logs } = await startProductionShapedApp();
      const outcome = await request(app, logs, url, TUNNEL_HEADERS, method);
      expect(outcome.status).toBe(403);
      expect(JSON.parse(outcome.body).error).toBe('Tunnel admin-only action denied');
      expect(outcome.writeHeads).toHaveLength(1);
      expect(outcome.writeHeads[0]).toMatchObject({ statusCode: 403, headersAlreadySent: false });
      expect(errorMarkersIn(outcome.logs)).toEqual([]);
    });
  }

  it('local console requests are not rejected (they reach the handler)', async () => {
    const { app, logs } = await startProductionShapedApp();
    const outcome = await request(app, logs, '/api/tunnel/enable', { host: '127.0.0.1:4000' });
    expect(outcome.status).toBe(200);
    expect(errorMarkersIn(outcome.logs)).toEqual([]);
  });
});

describe('counter-example: the buggy send-then-return-undefined shape still reproduces', () => {
  // If this block ever stops failing (i.e. produces a clean response), the
  // detector above has lost its discriminating power and the "no header
  // errors" assertions become worthless — fix the harness before trusting it.
  it('handler that sends and returns undefined re-enters the onSend chain', async () => {
    const logs: string[] = [];
    const app = Fastify({
      logger: { level: 'trace', stream: { write: (line: string) => logs.push(line) } },
    });
    const holdChainOpen = async <T>(payload: T): Promise<T> => {
      await new Promise((resolve) => setImmediate(resolve));
      return payload;
    };
    app.addHook('onSend', async (_request, _reply, payload) => holdChainOpen(payload));
    app.addHook('onSend', async (_request, _reply, payload) => holdChainOpen(payload));
    app.post('/buggy-shape', async (_request, reply) => {
      reply.code(403).send({ error: 'buggy' });
      return; // the old rejectTunnelAdminAction call-site shape
    });
    const outcome = await request(app, logs, '/buggy-shape');
    expect(outcome.status).toBe(403);
    expect(outcome.writeHeads).toHaveLength(2);
    expect(outcome.writeHeads[1].headersAlreadySent).toBe(true);
    expect(errorMarkersIn(outcome.logs)).toEqual([...HEADER_ERROR_MARKERS]);
  });
});
