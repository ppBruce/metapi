import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { decryptAccountPassword, encryptAccountPassword } from './accountCredentialService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export type SaveProxyVideoTaskInput = {
  publicId?: string;
  upstreamVideoId: string;
  siteUrl: string;
  tokenValue: string;
  requestedModel: string;
  actualModel: string;
  channelId: number | null;
  accountId: number | null;
  statusSnapshot?: unknown;
  upstreamResponseMeta?: unknown;
  lastUpstreamStatus?: number | null;
  lastPolledAt?: string | null;
};

export type ProxyVideoTaskRecord = {
  publicId: string;
  upstreamVideoId: string;
  siteUrl: string;
  tokenValue: string;
  requestedModel: string | null;
  actualModel: string | null;
  channelId: number | null;
  accountId: number | null;
  statusSnapshot: unknown | null;
  upstreamResponseMeta: unknown | null;
  lastUpstreamStatus: number | null;
  lastPolledAt: string | null;
};

function buildPublicVideoId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `vid_${timePart}_${randomPart}`;
}

export async function saveProxyVideoTask(input: SaveProxyVideoTaskInput): Promise<{
  publicId: string;
  upstreamVideoId: string;
}> {
  const publicId = input.publicId?.trim() || buildPublicVideoId();
  const now = formatUtcSqlDateTime(new Date());

  await db.insert(schema.proxyVideoTasks).values({
    publicId,
    upstreamVideoId: input.upstreamVideoId,
    siteUrl: input.siteUrl,
    tokenValue: encryptAccountPassword(input.tokenValue),
    requestedModel: input.requestedModel,
    actualModel: input.actualModel,
    channelId: input.channelId,
    accountId: input.accountId,
    statusSnapshot: input.statusSnapshot === undefined ? null : JSON.stringify(input.statusSnapshot),
    upstreamResponseMeta: input.upstreamResponseMeta === undefined ? null : JSON.stringify(input.upstreamResponseMeta),
    lastUpstreamStatus: input.lastUpstreamStatus ?? null,
    lastPolledAt: input.lastPolledAt ?? (input.lastUpstreamStatus == null ? null : now),
    createdAt: now,
    updatedAt: now,
  }).run();

  return {
    publicId,
    upstreamVideoId: input.upstreamVideoId,
  };
}

export async function getProxyVideoTaskByPublicId(publicId: string): Promise<ProxyVideoTaskRecord | null> {
  const row = await db.select().from(schema.proxyVideoTasks)
    .where(eq(schema.proxyVideoTasks.publicId, publicId))
    .get();
  if (!row) return null;
  return {
    publicId: row.publicId,
    upstreamVideoId: row.upstreamVideoId,
    siteUrl: row.siteUrl,
    tokenValue: readProxyVideoTaskToken(row.tokenValue),
    requestedModel: row.requestedModel,
    actualModel: row.actualModel,
    channelId: row.channelId,
    accountId: row.accountId,
    statusSnapshot: parseJsonColumn(row.statusSnapshot),
    upstreamResponseMeta: parseJsonColumn(row.upstreamResponseMeta),
    lastUpstreamStatus: row.lastUpstreamStatus,
    lastPolledAt: row.lastPolledAt,
  };
}

export async function resolveProxyVideoTaskSite(accountId: number | null): Promise<typeof schema.sites.$inferSelect | null> {
  if (!Number.isFinite(accountId) || !accountId || accountId <= 0) {
    return null;
  }
  const row = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  return row?.sites ?? null;
}

export async function deleteProxyVideoTaskByPublicId(publicId: string): Promise<void> {
  await db.delete(schema.proxyVideoTasks)
    .where(eq(schema.proxyVideoTasks.publicId, publicId))
    .run();
}

export async function refreshProxyVideoTaskSnapshot(
  publicId: string,
  input: {
    statusSnapshot?: unknown;
    upstreamResponseMeta?: unknown;
    lastUpstreamStatus?: number | null;
    lastPolledAt?: string | null;
  },
): Promise<void> {
  const now = formatUtcSqlDateTime(new Date());
  await db.update(schema.proxyVideoTasks)
    .set({
      statusSnapshot: input.statusSnapshot === undefined ? null : JSON.stringify(input.statusSnapshot),
      upstreamResponseMeta: input.upstreamResponseMeta === undefined ? null : JSON.stringify(input.upstreamResponseMeta),
      lastUpstreamStatus: input.lastUpstreamStatus ?? null,
      lastPolledAt: input.lastPolledAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.proxyVideoTasks.publicId, publicId))
    .run();
}

function parseJsonColumn(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Data-shape migration, not a one-time setting marker: restoring an older
// backup may reintroduce plaintext rows. Run on every startup, rewriting only
// rows that are still plaintext, without changing task IDs or timestamps.
export async function encryptLegacyProxyVideoTaskTokens(): Promise<number> {
  const rows = await db.select({
    id: schema.proxyVideoTasks.id,
    tokenValue: schema.proxyVideoTasks.tokenValue,
  }).from(schema.proxyVideoTasks).all();
  let migrated = 0;
  for (const row of rows) {
    if (/^v\d+:/.test(row.tokenValue)) continue;
    const encrypted = encryptAccountPassword(row.tokenValue);
    const result = await db.update(schema.proxyVideoTasks)
      .set({ tokenValue: encrypted })
      .where(and(
        eq(schema.proxyVideoTasks.id, row.id),
        eq(schema.proxyVideoTasks.tokenValue, row.tokenValue),
      ))
      .run();
    migrated += Number(result?.changes || 0);
  }
  return migrated;
}

function readProxyVideoTaskToken(value: string): string {
  // Legacy rows store plaintext. Any versioned envelope is treated as
  // ciphertext, even when malformed or from a newer version, so an unreadable
  // value cannot be forwarded to the upstream as an Authorization header.
  if (!/^v\d+:/.test(value)) return value;
  const plaintext = decryptAccountPassword(value);
  if (plaintext === null) throw new Error('Proxy video task token decryption failed');
  return plaintext;
}

/**
 * Retention purge: task rows hold an upstream credential (token_value) and
 * previously only ever left the table via an explicit
 * DELETE /v1/videos/:id or a factory reset — i.e. they grew without bound.
 * Drop rows whose last activity predates the cutoff (unlike the file store we
 * key on updated_at, since polling refreshes it; created_at covers rows that
 * never got one). Wired into the proxy-file retention interval.
 */
export async function purgeExpiredProxyVideoTasks(cutoffUtc: string): Promise<number> {
  const normalizedCutoff = cutoffUtc.trim();
  if (!normalizedCutoff) return 0;

  const result = await db.delete(schema.proxyVideoTasks)
    .where(or(
      lt(schema.proxyVideoTasks.updatedAt, normalizedCutoff),
      and(isNull(schema.proxyVideoTasks.updatedAt), lt(schema.proxyVideoTasks.createdAt, normalizedCutoff)),
    ))
    .run();

  return Number(result?.changes || 0);
}

export const __proxyVideoTaskStoreTestUtils = {
  parseJsonColumn,
};
