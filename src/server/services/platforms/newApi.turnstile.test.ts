import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// 只 mock getTurnstileSolverSettings，保持 isTurnstileRequiredMessage 和
// solveTurnstileToken 真实（后者会向下面的 mock solver 发 HTTP 请求）
// ---------------------------------------------------------------------------
vi.mock('../turnstileSolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../turnstileSolver.js')>();
  return {
    ...actual,
    getTurnstileSolverSettings: vi.fn(async () => null),
  };
});

import { NewApiAdapter } from './newApi.js';
import { getTurnstileSolverSettings } from '../turnstileSolver.js';

const SITEKEY = '0x4AAAAAA-stub-sitekey';
const SOLVED_TOKEN = 'stub-turnstile-token';

function json(res: ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('NewApiAdapter — Turnstile checkin', () => {
  let siteServer: ReturnType<typeof createServer>;
  let solverServer: ReturnType<typeof createServer>;
  let siteBase: string;
  let solverBase: string;
  let siteRequests: string[] = [];
  let solverRequests: Array<{ url: string; body: string; headers: IncomingMessage['headers'] }> = [];
  let solverDown = false;

  beforeEach(async () => {
    siteRequests = [];
    solverRequests = [];
    solverDown = false;
    vi.mocked(getTurnstileSolverSettings).mockResolvedValue(null);

    // —— 上游站点 mock ——
    siteServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        siteRequests.push(req.url || '');
        const url = req.url || '';
        if (url.startsWith('/api/status')) {
          json(res, {
            success: true,
            data: { system_name: 'stub-site', turnstile_site_key: SITEKEY, turnstile_check: true, checkin_enabled: true },
          });
          return;
        }
        if (url.startsWith('/api/user/checkin')) {
          const u = new URL(url, 'http://stub.local');
          const ts = u.searchParams.get('turnstile');
          if (!ts) {
            json(res, { success: false, message: 'Turnstile token 为空' });
            return;
          }
          json(res, { success: true, message: '签到成功', data: { reward: 2000000 } });
          return;
        }
        json(res, { success: false, message: 'not found' }, 404);
      });
    });

    // —— 求解器 mock ——
    solverServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        solverRequests.push({ url: req.url || '', body: Buffer.concat(chunks).toString('utf8'), headers: req.headers });
        if (!solverDown && req.url === '/solve') {
          json(res, { token: SOLVED_TOKEN, elapsed: 1.2, user_agent: 'stub-solver' });
          return;
        }
        json(res, { error: 'solver down' }, 500);
      });
    });

    await new Promise<void>((resolve) => siteServer.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => solverServer.listen(0, '127.0.0.1', () => resolve()));
    siteBase = `http://127.0.0.1:${(siteServer.address() as AddressInfo).port}`;
    solverBase = `http://127.0.0.1:${(solverServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    siteServer.closeAllConnections();
    solverServer.closeAllConnections();
    await new Promise<void>((resolve) => siteServer.close(() => resolve()));
    await new Promise<void>((resolve) => solverServer.close(() => resolve()));
  });

  // -----------------------------------------------------------------------
  // 测试 1：有求解器 → 自动求解 + 带 token 重试 → 签到成功
  // -----------------------------------------------------------------------
  it('solves the Turnstile gate, then replays checkin with the token', async () => {
    vi.mocked(getTurnstileSolverSettings).mockResolvedValue({
      enabled: true,
      baseUrl: solverBase,
      apiKey: 'sk-test-key',
      timeoutSeconds: 15,
    });

    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(siteBase, 'turnstile-bearer', 203453);

    expect(result.success).toBe(true);
    expect(result.reward).toBe('2000000');

    // 重放请求中是否含 turnstile 参数
    const replayed = siteRequests.filter((u) => u.includes('turnstile='));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toContain(`turnstile=${SOLVED_TOKEN}`);

    // 求解器接收到了正确的 sitekey
    const solveReq = solverRequests.find((r) => r.url === '/solve');
    expect(solveReq).toBeTruthy();
    expect(solveReq!.headers['x-api-key']).toBe('sk-test-key');
    const payload = JSON.parse(solveReq!.body);
    expect(payload.sitekey).toBe(SITEKEY);
    expect(payload.url).toContain('/sign-in');
  });

  // -----------------------------------------------------------------------
  // 测试 2：无求解器配置 → 原样返回 Turnstile token 为空
  // -----------------------------------------------------------------------
  it('keeps the original failure when no solver is configured', async () => {
    vi.mocked(getTurnstileSolverSettings).mockResolvedValue(null);
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(siteBase, 'turnstile-bearer', 203453);

    expect(result.success).toBe(false);
    expect(String(result.message)).toMatch(/turnstile/i);
    expect(solverRequests).toHaveLength(0);
    expect(siteRequests.some((u) => u.includes('turnstile='))).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 测试 3：求解器配置了但挂了 → 优雅回落
  // -----------------------------------------------------------------------
  it('falls back to the original failure when the solver is down', async () => {
    solverDown = true;
    vi.mocked(getTurnstileSolverSettings).mockResolvedValue({
      enabled: true,
      baseUrl: solverBase,
      apiKey: 'sk-test-key',
      timeoutSeconds: 15,
    });

    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(siteBase, 'turnstile-bearer', 203453);

    expect(result.success).toBe(false);
    // 求解器被调用了但失败；没发出重放请求
    expect(solverRequests.length).toBeGreaterThan(0);
    expect(siteRequests.some((u) => u.includes('turnstile='))).toBe(false);
  }, 15000);
});