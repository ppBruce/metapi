import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatLocalDate } from '../../services/localTimeService.js';

type DbModule = typeof import('../../db/index.js');

describe('GET /api/sites metapi peer daily income', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-peer-site-income-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register((await import('./sites.js')).sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('shows the upstream daily income without a local checkin, excluding stale snapshots', async () => {
    const day = formatLocalDate(new Date());
    const site = await db.insert(schema.sites).values({
      name: 'upstream-metapi', url: 'https://metapi.example.com', platform: 'metapi',
    }).returning().get();
    for (const [username, incomeDay, income] of [
      ['current', day, 12.5],
      ['stale', '2000-01-01', 999],
    ] as const) {
      await db.insert(schema.accounts).values({
        siteId: site.id,
        username,
        accessToken: `token-${username}`,
        status: 'active',
        extraConfig: JSON.stringify({ todayIncomeSnapshot: {
          day: incomeDay, baseline: income, latest: income,
        } }),
      }).run();
    }
    const response = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(response.statusCode).toBe(200);
    const rows = response.json() as Array<{ id: number; todayReward: number }>;
    expect(rows.find((row) => row.id === site.id)?.todayReward).toBe(12.5);
  });
});
