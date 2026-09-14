/**
 * Per-site × model effective context capability.
 *
 * Same model can have different context windows per upstream site (a relay
 * may cap/reduce a model below its nominal window). This service learns each
 * site's real limit from:
 *   - 'error'  — an upstream context-overflow error that quotes the window
 *                (authoritative; the value is only ever lowered);
 *   - 'usage'  — successful traffic observing prompt_tokens (lower bound);
 *   - 'manual' — user-pinned value (wins over every automatic source).
 *
 * Matching is canonical-name based (see canonicalizeModelName) with the raw
 * spelling kept for display. An in-memory index mirrors the table so the
 * router can look limits up synchronously inside hot selection paths.
 *
 * NOTE: context-overflow failures must NOT be counted as site failures by
 * the caller — a too-large request is our information gap, not the site's
 * health problem.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { canonicalizeModelName } from '../shared/modelCanonicalization.js';
import { detectContextOverflow } from '../shared/upstreamContextSignals.js';

export type SiteModelContextSource = 'error' | 'usage' | 'manual';

export type SiteModelContextEntry = {
  siteId: number;
  /** Canonical match key (lowercase). */
  modelName: string;
  /** Last observed raw spelling. */
  modelNameRaw: string | null;
  /** Known effective context limit; null = unknown (usage-only evidence). */
  contextLimit: number | null;
  source: SiteModelContextSource;
  /** Largest prompt this site has successfully processed for the model. */
  observedMaxPrompt: number | null;
  updatedAt: string | null;
};

const cache = new Map<string, SiteModelContextEntry>();
let cacheLoaded = false;
let loadPromise: Promise<void> | null = null;
/** Serializes read-modify-write upserts (single writer at a time). */
let writeQueue: Promise<void> = Promise.resolve();

function entryKey(siteId: number, modelKey: string): string {
  return `${Math.trunc(siteId)}|${modelKey}`;
}

/** Canonical match key for a model spelling; '' when unusable. */
export function normalizeContextModelKey(modelName: string | null | undefined): string {
  const raw = String(modelName || '').trim().toLowerCase();
  if (!raw) return '';
  return canonicalizeModelName(raw) || raw;
}

function toEntry(row: typeof schema.siteModelContext.$inferSelect): SiteModelContextEntry {
  return {
    siteId: Number(row.siteId),
    modelName: String(row.modelName),
    modelNameRaw: row.modelNameRaw ?? null,
    contextLimit: typeof row.contextLimit === 'number' ? row.contextLimit : null,
    source: (row.source === 'manual' || row.source === 'usage') ? row.source : 'error',
    observedMaxPrompt: typeof row.observedMaxPrompt === 'number' ? row.observedMaxPrompt : null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function ensureSiteContextCapabilityLoaded(): Promise<void> {
  if (cacheLoaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const rows = await db.select().from(schema.siteModelContext).all();
        cache.clear();
        for (const row of rows) {
          cache.set(entryKey(row.siteId, row.modelName), toEntry(row));
        }
        cacheLoaded = true;
      } finally {
        loadPromise = null;
      }
    })();
  }
  await loadPromise;
}

export function __resetSiteContextCapabilityCacheForTests(): void {
  cache.clear();
  cacheLoaded = false;
  loadPromise = null;
}

/** Sync lookup for ONE spelling. Prefers the canonical key, then raw-lower. */
export function lookupSiteContextEntry(
  siteId: number | null | undefined,
  modelName: string | null | undefined,
): SiteModelContextEntry | null {
  if (siteId == null || !Number.isFinite(siteId) || siteId <= 0) return null;
  const key = normalizeContextModelKey(modelName);
  if (!key) return null;
  const direct = cache.get(entryKey(siteId, key));
  if (direct) return direct;
  const rawLower = String(modelName || '').trim().toLowerCase();
  if (rawLower && rawLower !== key) {
    return cache.get(entryKey(siteId, rawLower)) ?? null;
  }
  return null;
}

/**
 * Known context limit across candidate spellings for one site: the MINIMUM of
 * every known limit (conservative — if any alias is known tighter, that wins).
 * Returns null when nothing is known (unknown ≠ insufficient).
 */
export function lookupSiteContextLimitForNames(
  siteId: number | null | undefined,
  modelNames: Array<string | null | undefined>,
): {
  limit: number;
  matchedName: string;
  source: SiteModelContextSource;
  observedMaxPrompt: number | null;
} | null {
  let best: {
    limit: number;
    matchedName: string;
    source: SiteModelContextSource;
    observedMaxPrompt: number | null;
  } | null = null;
  const seen = new Set<string>();
  for (const name of modelNames) {
    const key = normalizeContextModelKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = cache.get(entryKey(Number(siteId), key));
    if (!entry || entry.contextLimit == null || entry.contextLimit <= 0) continue;
    if (!best || entry.contextLimit < best.limit) {
      best = {
        limit: entry.contextLimit,
        matchedName: name ? String(name) : key,
        source: entry.source,
        observedMaxPrompt: entry.observedMaxPrompt ?? null,
      };
    }
  }
  return best;
}

export function listSiteContextEntries(): SiteModelContextEntry[] {
  return [...cache.values()];
}

export function listSiteContextEntriesForSite(siteId: number): SiteModelContextEntry[] {
  const normalized = Math.trunc(Number(siteId) || 0);
  if (normalized <= 0) return [];
  return [...cache.values()].filter((entry) => entry.siteId === normalized);
}

type UpsertPatch = {
  modelNameRaw?: string | null;
  contextLimit?: number | null;
  source?: SiteModelContextSource;
  observedMaxPrompt?: number | null;
  note?: string | null;
};

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const run = writeQueue.then(task, task);
  // Keep the queue alive even when an individual write fails.
  writeQueue = run.catch(() => undefined);
  return run;
}

async function upsertEntry(
  siteId: number,
  modelKey: string,
  applyPatch: (existing: SiteModelContextEntry | null) => UpsertPatch | null,
): Promise<void> {
  const normalizedSiteId = Math.trunc(siteId);
  if (!Number.isFinite(normalizedSiteId) || normalizedSiteId <= 0 || !modelKey) return;
  await enqueueWrite(async () => {
    const key = entryKey(normalizedSiteId, modelKey);
    const existing = cache.get(key) ?? null;
    const patch = applyPatch(existing);
    if (!patch) return;
    const now = new Date().toISOString();
    const nextContextLimit = patch.contextLimit !== undefined ? patch.contextLimit : (existing?.contextLimit ?? null);
    const nextRaw = patch.modelNameRaw !== undefined ? patch.modelNameRaw : (existing?.modelNameRaw ?? null);
    const nextSource = patch.source ?? existing?.source ?? 'error';
    const nextObserved = patch.observedMaxPrompt !== undefined ? patch.observedMaxPrompt : (existing?.observedMaxPrompt ?? null);
    try {
      await db.insert(schema.siteModelContext).values({
        siteId: normalizedSiteId,
        modelName: modelKey,
        modelNameRaw: nextRaw,
        contextLimit: nextContextLimit,
        source: nextSource,
        observedMaxPrompt: nextObserved,
        note: patch.note ?? null,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: [schema.siteModelContext.siteId, schema.siteModelContext.modelName],
        set: {
          modelNameRaw: nextRaw,
          contextLimit: nextContextLimit,
          source: nextSource,
          observedMaxPrompt: nextObserved,
          updatedAt: now,
        },
      }).run();
      cache.set(key, {
        siteId: normalizedSiteId,
        modelName: modelKey,
        modelNameRaw: nextRaw,
        contextLimit: nextContextLimit,
        source: nextSource,
        observedMaxPrompt: nextObserved,
        updatedAt: now,
      });
    } catch (error) {
      console.warn(
        `[site-context] failed to persist context entry ${modelKey}@site ${normalizedSiteId}`,
        error,
      );
    }
  });
}

/**
 * Runtime learning from an upstream failure. Returns the parsed context window
 * when the failure was a context overflow that quoted one, else null.
 */
export async function observeContextOverflowFailure(input: {
  siteId: number | null | undefined;
  modelName: string | null | undefined;
  status: number;
  errorText: string | null | undefined;
}): Promise<number | null> {
  const { overflow, limit } = detectContextOverflow(input.status, input.errorText);
  if (!overflow) return null;
  const siteId = Math.trunc(Number(input.siteId) || 0);
  const modelKey = normalizeContextModelKey(input.modelName);
  if (siteId <= 0 || !modelKey) return limit;
  if (limit == null) return null;
  await upsertEntry(siteId, modelKey, (existing) => {
    // Manual pins are authoritative — learning never overwrites them.
    if (existing && existing.source === 'manual') return null;
    const nextLimit = existing?.contextLimit != null ? Math.min(existing.contextLimit, limit) : limit;
    return {
      modelNameRaw: String(input.modelName || '') || null,
      contextLimit: nextLimit,
      source: 'error',
    };
  });
  return limit;
}

/** Lower-bound evidence from a successful request (never creates a limit). */
export async function observeSuccessfulPromptUsage(input: {
  siteId: number | null | undefined;
  modelName: string | null | undefined;
  promptTokens: number | null | undefined;
}): Promise<void> {
  const siteId = Math.trunc(Number(input.siteId) || 0);
  const modelKey = normalizeContextModelKey(input.modelName);
  const promptTokens = Math.trunc(Number(input.promptTokens) || 0);
  if (siteId <= 0 || !modelKey || promptTokens <= 0) return;
  await upsertEntry(siteId, modelKey, (existing) => {
    if (existing && existing.observedMaxPrompt != null && existing.observedMaxPrompt >= promptTokens) {
      return null; // nothing to record
    }
    return {
      modelNameRaw: String(input.modelName || '') || null,
      observedMaxPrompt: promptTokens,
      source: existing?.source ?? 'usage',
    };
  });
}

/** Manual pin (limit=null clears the pin back to learning). */
export async function setManualSiteContextLimit(input: {
  siteId: number;
  modelName: string;
  contextLimit: number | null;
  note?: string | null;
}): Promise<boolean> {
  const siteId = Math.trunc(Number(input.siteId) || 0);
  const modelKey = normalizeContextModelKey(input.modelName);
  if (siteId <= 0 || !modelKey) return false;
  await upsertEntry(siteId, modelKey, () => ({
    modelNameRaw: String(input.modelName || '') || null,
    contextLimit: input.contextLimit,
    source: 'manual',
    note: input.note ?? null,
  }));
  return true;
}

/** Remove an entry entirely (manual or learned). */
export async function deleteSiteContextEntry(siteId: number, modelName: string): Promise<boolean> {
  const normalizedSiteId = Math.trunc(Number(siteId) || 0);
  const modelKey = normalizeContextModelKey(modelName);
  if (normalizedSiteId <= 0 || !modelKey) return false;
  let removed = false;
  await enqueueWrite(async () => {
    const key = entryKey(normalizedSiteId, modelKey);
    if (!cache.has(key)) return;
    try {
      await db.delete(schema.siteModelContext)
        .where(and(
          eq(schema.siteModelContext.siteId, normalizedSiteId),
          eq(schema.siteModelContext.modelName, modelKey),
        ))
        .run();
    } catch (error) {
      console.warn('[site-context] failed to delete entry', error);
      return;
    }
    cache.delete(key);
    removed = true;
  });
  return removed;
}
