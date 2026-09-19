import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const deleteApiTokenMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    deleteApiToken: (...args: unknown[]) => deleteApiTokenMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('account token deletion follows what the site can prove', { timeout: 20_000 }, () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let seedId = 0;

  const seedToken = async (overrides: { token?: string; valueStatus?: string } = {}) => {
    seedId += 1;
    const site = await db.insert(schema.sites).values({
      name: `site-${seedId}`,
      url: `https://site-${seedId}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${seedId}`,
      accessToken: `acc-token-${seedId}`,
      status: 'active',
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: `token-${seedId}`,
      token: overrides.token ?? `sk-live-token-${seedId}`,
      valueStatus: overrides.valueStatus ?? 'ready',
      isDefault: false,
    }).returning().get();

    return { site, account, token };
  };

  const readToken = async (tokenId: number) => db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.id, tokenId))
    .get();

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-token-delete-'));
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register((await import('./accountTokens.js')).accountTokensRoutes);
  });

  beforeEach(async () => {
    deleteApiTokenMock.mockReset();
    seedId = 0;
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('keeps the local row when the site never confirmed the deletion', async () => {
    const { token } = await seedToken();
    // Unreachable site, or a masked/paginated token list: the adapter cannot
    // tell "already gone" from "still there", so nothing is deleted.
    deleteApiTokenMock.mockResolvedValue('unconfirmed');

    const response = await app.inject({ method: 'DELETE', url: `/api/account-tokens/${token.id}` });

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('站点未确认该令牌是否已删除');
    expect(body.requiresForce).toBeUndefined();
    expect(await readToken(token.id)).toBeDefined();
  });

  it('deletes the local row when the site proves the token is already gone', async () => {
    const { token } = await seedToken();
    // The site's token list was fully enumerated and this key is not in it, so
    // the local row cannot be orphaned by removing it.
    deleteApiTokenMock.mockResolvedValue('verified-absent');

    const response = await app.inject({ method: 'DELETE', url: `/api/account-tokens/${token.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(await readToken(token.id)).toBeUndefined();
  });

  it('deletes the local row when the site revoked the token', async () => {
    const { token } = await seedToken();
    deleteApiTokenMock.mockResolvedValue('deleted');

    const response = await app.inject({ method: 'DELETE', url: `/api/account-tokens/${token.id}` });

    expect(response.statusCode).toBe(200);
    expect(deleteApiTokenMock).toHaveBeenCalledTimes(1);
    expect(await readToken(token.id)).toBeUndefined();
  });

  it('fails closed when an adapter answers with anything but a confirmed outcome', async () => {
    const { token } = await seedToken();
    // Defensive: a truthy legacy value (or a future adapter returning a bare
    // boolean) must never be read as permission to delete.
    deleteApiTokenMock.mockResolvedValue(true as unknown as string);

    const response = await app.inject({ method: 'DELETE', url: `/api/account-tokens/${token.id}` });

    expect(response.statusCode).toBe(502);
    expect(await readToken(token.id)).toBeDefined();
  });

  it('deletes a masked placeholder locally without asking the site', async () => {
    const { token } = await seedToken({ token: 'sk-……masked……', valueStatus: 'masked_pending' });

    const response = await app.inject({ method: 'DELETE', url: `/api/account-tokens/${token.id}` });

    expect(response.statusCode).toBe(200);
    expect(deleteApiTokenMock).not.toHaveBeenCalled();
    expect(await readToken(token.id)).toBeUndefined();
  });
});
