import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatLocalDate,
  formatUtcSqlDateTime,
} from "../../services/localTimeService.js";
import { clearSnapshotCache } from "../../services/snapshotCacheService.js";

type DbModule = typeof import("../../db/index.js");

describe("accounts snapshot v2", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-accounts-snapshot-v2-"));
    process.env.DATA_DIR = dataDir;

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./accounts.js");
    const sitesModule = await import("./sites.js");
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
    await app.register(sitesModule.sitesRoutes);
  });

  beforeEach(async () => {
    clearSnapshotCache();
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterEach(() => {
    clearSnapshotCache();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns accounts and sites in one snapshot payload", async () => {
    const today = formatLocalDate(new Date());
    const site = await db
      .insert(schema.sites)
      .values({
        name: "snapshot-site",
        url: "https://snapshot-site.example.com",
        platform: "new-api",
      })
      .returning()
      .get();

    const account = await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: "snapshot-user",
        accessToken: "snapshot-token",
        status: "active",
        balance: 18.5,
        extraConfig: JSON.stringify({
          todayIncomeSnapshot: {
            day: today,
            baseline: 3.2,
            latest: 3.2,
            updatedAt: `${today}T08:00:00.000Z`,
          },
        }),
      })
      .returning()
      .get();

    await db
      .insert(schema.proxyLogs)
      .values({
        accountId: account.id,
        status: "success",
        estimatedCost: 1.25,
        createdAt: formatUtcSqlDateTime(new Date()),
      })
      .run();

    await db
      .insert(schema.checkinLogs)
      .values({
        accountId: account.id,
        status: "success",
        reward: "",
        message: "checkin success",
        createdAt: `${today} 09:00:00`,
      })
      .run();

    const response = await app.inject({
      method: "GET",
      url: "/api/accounts",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-accounts-snapshot-cache"]).toBeTruthy();
    const body = response.json() as {
      generatedAt: string;
      accounts: Array<{
        id: number;
        site: { id: number; name: string };
        todaySpend: number;
        todayReward: number;
      }>;
      sites: Array<{ id: number; name: string }>;
    };

    expect(Date.parse(body.generatedAt)).not.toBeNaN();
    expect(body.sites).toEqual([
      expect.objectContaining({ id: site.id, name: "snapshot-site" }),
    ]);
    expect(body.accounts).toEqual([
      expect.objectContaining({
        id: account.id,
        site: expect.objectContaining({ id: site.id, name: "snapshot-site" }),
        todaySpend: 1.25,
        todayReward: 3.2,
      }),
    ]);
  });

  it.each(["memory", "persisted"])(
    "returns current site choices while reusing the %s accounts snapshot",
    async (cacheSource) => {
      vi.stubEnv("VITEST", "");

      const initial = await app.inject({ method: "GET", url: "/api/accounts" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().sites).toEqual([]);

      const created = await app.inject({
        method: "POST",
        url: "/api/sites",
        payload: {
          name: "new-site",
          url: "https://new-site.example.com",
          platform: "new-api",
        },
      });
      expect(created.statusCode).toBe(200);
      const siteId = created.json().id;

      if (cacheSource === "persisted") clearSnapshotCache();

      const afterCreate = await app.inject({ method: "GET", url: "/api/accounts" });
      expect(afterCreate.headers["x-accounts-snapshot-cache"]).toBe("hit");
      expect(afterCreate.json().generatedAt).toBe(initial.json().generatedAt);
      expect(afterCreate.json().sites).toEqual([
        expect.objectContaining({ id: siteId, name: "new-site" }),
      ]);

      const updated = await app.inject({
        method: "PUT",
        url: `/api/sites/${siteId}`,
        payload: { name: "renamed-site", status: "disabled" },
      });
      expect(updated.statusCode).toBe(200);
      const afterUpdate = await app.inject({ method: "GET", url: "/api/accounts" });
      expect(afterUpdate.json().sites).toEqual([
        expect.objectContaining({ id: siteId, name: "renamed-site", status: "disabled" }),
      ]);

      const deleted = await app.inject({ method: "DELETE", url: `/api/sites/${siteId}` });
      expect(deleted.statusCode).toBe(200);
      const afterDelete = await app.inject({ method: "GET", url: "/api/accounts" });
      expect(afterDelete.headers["x-accounts-snapshot-cache"]).toBe("hit");
      expect(afterDelete.json().sites).toEqual([]);
    },
  );
});
