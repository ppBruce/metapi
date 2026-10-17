import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

type DbModule = typeof import('./index.js');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uniqueKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe('sqlite transaction isolation', () => {
  let dbModule: DbModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-db-tx-'));
    process.env.DB_TYPE = 'sqlite';
    await import('./migrate.js');
    dbModule = await import('./index.js');
  });

  it('serializes overlapping transactions instead of failing the second begin', async () => {
    const { db, schema } = dbModule;
    const order: string[] = [];
    const first = db.transaction(async (tx: any) => {
      order.push('a:start');
      await tx.insert(schema.settings).values({ key: uniqueKey('tx-a'), value: '1' });
      await sleep(40);
      order.push('a:end');
      return 'a';
    });
    await sleep(5);
    const second = db.transaction(async (tx: any) => {
      order.push('b:start');
      await tx.insert(schema.settings).values({ key: uniqueKey('tx-b'), value: '2' });
      order.push('b:end');
      return 'b';
    });

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('defers statements from other requests until an open transaction settles (no swallow on rollback)', async () => {
    const { db, schema } = dbModule;
    const keptKey = uniqueKey('outside');
    let markTransactionReady!: () => void;
    let releaseTransaction!: () => void;
    const transactionReady = new Promise<void>((resolve) => { markTransactionReady = resolve; });
    const holdTransaction = new Promise<void>((resolve) => { releaseTransaction = resolve; });
    const txPromise = db.transaction(async (tx: any) => {
      await tx.insert(schema.settings).values({ key: uniqueKey('rollback'), value: 'x' });
      markTransactionReady();
      await holdTransaction;
      throw new Error('force rollback');
    });

    // Begin the competing request only after the transaction body has written
    // successfully and is definitely holding the SQLite transaction window.
    await transactionReady;
    let settled = false;
    const outside = Promise.resolve(
      db.insert(schema.settings).values({ key: keptKey, value: 'kept' }),
    ).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseTransaction();
    await expect(txPromise).rejects.toThrow('force rollback');
    await outside;
    expect(settled).toBe(true);

    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, keptKey))
      .all();
    expect(rows.length).toBe(1);
  });

  it('does not let a waiting statement slip into the next queued transaction', async () => {
    const { db, schema } = dbModule;
    const externalKey = uniqueKey('external-between-transactions');
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const holdSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const first = db.transaction(async (tx: any) => {
      await tx.insert(schema.settings).values({ key: uniqueKey('first-tx'), value: 'first' });
      firstStarted();
      await holdFirst;
      throw new Error('rollback first');
    });
    await firstReady;
    let externalSettled = false;
    const external = Promise.resolve(db.insert(schema.settings).values({ key: externalKey, value: 'external' }))
      .then(() => { externalSettled = true; });
    const second = db.transaction(async (tx: any) => {
      await tx.insert(schema.settings).values({ key: uniqueKey('second-tx'), value: 'second' });
      secondStarted();
      await holdSecond;
      throw new Error('rollback second');
    });
    releaseFirst();
    await expect(first).rejects.toThrow('rollback first');
    await secondReady;
    await new Promise((resolve) => setImmediate(resolve));
    expect(externalSettled).toBe(false);
    releaseSecond();
    await expect(second).rejects.toThrow('rollback second');
    await external;
    const rows = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, externalKey)).all();
    expect(rows).toHaveLength(1);
  });

  it('supports nested transactions through savepoints without deadlocking', async () => {
    const { db, schema } = dbModule;
    const outerKey = uniqueKey('outer');
    const innerKey = uniqueKey('inner');
    const result = await db.transaction(async (tx: any) => {
      await tx.insert(schema.settings).values({ key: outerKey, value: 'o' });
      const inner = await tx.transaction(async (tx2: any) => {
        await tx2.insert(schema.settings).values({ key: innerKey, value: 'i' });
        return 'inner-ok';
      });
      return `outer:${inner}`;
    });
    expect(result).toBe('outer:inner-ok');

    const outerRows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, outerKey))
      .all();
    const innerRows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, innerKey))
      .all();
    expect(outerRows.length).toBe(1);
    expect(innerRows.length).toBe(1);
  });

  it('releases the queue after a failed transaction so later work proceeds', async () => {
    const { db, schema } = dbModule;
    await expect(
      db.transaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const key = uniqueKey('post-failure');
    await db.insert(schema.settings).values({ key, value: 'ok' });
    const rows = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, key))
      .all();
    expect(rows.length).toBe(1);
  });
});
