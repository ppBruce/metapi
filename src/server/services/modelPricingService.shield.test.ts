import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import { registerShieldCooldown, resetShieldCooldownsForTests } from './platforms/newApiShield.js';

describe('pricing management backoff', () => {
  let server: ReturnType<typeof createServer>;
  let url: string;
  let calls = 0;
  beforeEach(async () => {
    calls = 0;
    resetShieldCooldownsForTests();
    server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(403, { 'Content-Type': 'text/html' });
      response.end('<html><title>403 Forbidden</title><p>Denied by http_ratelimit</p></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetShieldCooldownsForTests();
  });
  it('does not bypass management rate-limit backoff via plain pricing fetch', async () => {
    registerShieldCooldown(url);
    const result = await fetchModelPricingCatalog({
      site: { id: 881001, url, platform: 'new-api' },
      account: { id: 881001, accessToken: 'session=offline-test', apiToken: 'offline-api-key' },
      modelName: 'offline-model',
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });
});
