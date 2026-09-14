import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSiteContextCapabilityCacheForTests,
  deleteSiteContextEntry,
  ensureSiteContextCapabilityLoaded,
  listSiteContextEntriesForSite,
  lookupSiteContextLimitForNames,
  lookupSiteContextObservedMaxPrompt,
  normalizeContextModelKey,
  observeContextOverflowFailure,
  observeSuccessfulPromptUsage,
  setManualSiteContextLimit,
} from './siteContextCapabilityService.js';

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<Record<string, unknown>>,
}));

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ left, right }),
  and: (...args: unknown[]) => args,
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        all: async () => state.rows.slice(),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({
          run: async () => {
            state.upserts.push(values);
            const idx = state.rows.findIndex(
              (row) => row.siteId === values.siteId && row.modelName === values.modelName,
            );
            const next = { id: idx >= 0 ? state.rows[idx]!.id : state.rows.length + 1, ...values };
            if (idx >= 0) state.rows[idx] = next;
            else state.rows.push(next);
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        run: async () => {},
      }),
    }),
  },
  schema: {
    siteModelContext: { siteId: 'site_id', modelName: 'model_name' },
  },
}));

function seedRow(input: {
  siteId: number;
  modelName: string;
  contextLimit?: number | null;
  source?: string;
  observedMaxPrompt?: number | null;
}) {
  state.rows.push({
    id: state.rows.length + 1,
    siteId: input.siteId,
    modelName: input.modelName,
    modelNameRaw: input.modelName,
    contextLimit: input.contextLimit ?? null,
    source: input.source ?? 'error',
    observedMaxPrompt: input.observedMaxPrompt ?? null,
    note: null,
    createdAt: null,
    updatedAt: null,
  });
}

beforeEach(() => {
  __resetSiteContextCapabilityCacheForTests();
  state.rows.length = 0;
  state.upserts.length = 0;
});

describe('normalizeContextModelKey', () => {
  it('lowercases and canonicalizes provider prefixes and free labels', () => {
    expect(normalizeContextModelKey('  Z-AI/GLM-5.2  ')).toBe('glm-5.2');
    expect(normalizeContextModelKey('deepseek-v4-flash:free')).toBe('deepseek-v4-flash');
    expect(normalizeContextModelKey('')).toBe('');
    expect(normalizeContextModelKey(null)).toBe('');
  });
});

describe('lookup / min selection', () => {
  it('returns the minimum known limit across candidate names', async () => {
    seedRow({ siteId: 7, modelName: 'model-c1', contextLimit: 100_000 });
    seedRow({ siteId: 7, modelName: 'model-c2', contextLimit: 64_000 });
    await ensureSiteContextCapabilityLoaded();

    const hit = lookupSiteContextLimitForNames(7, ['model-c1', 'model-c2', 'unknown-name']);
    expect(hit).toEqual({ limit: 64_000, matchedName: 'model-c2', source: 'error', observedMaxPrompt: null });
  });

  it('returns null when nothing is known', async () => {
    seedRow({ siteId: 8, modelName: 'model-x', contextLimit: null, source: 'usage' });
    await ensureSiteContextCapabilityLoaded();
    expect(lookupSiteContextLimitForNames(8, ['model-x'])).toBeNull();
    expect(lookupSiteContextLimitForNames(999, ['model-x'])).toBeNull();
  });

  it('reports the observed lower bound even when no cap is known', async () => {
    seedRow({ siteId: 8, modelName: 'model-x', contextLimit: null, source: 'usage', observedMaxPrompt: 52_000 });
    seedRow({ siteId: 8, modelName: 'model-y', contextLimit: 64_000, source: 'error', observedMaxPrompt: 30_000 });
    await ensureSiteContextCapabilityLoaded();

    // usage-only row still yields its proven lower bound
    expect(lookupSiteContextObservedMaxPrompt(8, ['model-x'])).toBe(52_000);
    // nothing observed for this name
    expect(lookupSiteContextObservedMaxPrompt(8, ['unknown'])).toBeNull();
    // largest observed across the candidate names wins
    expect(lookupSiteContextObservedMaxPrompt(8, ['model-y', 'model-x'])).toBe(52_000);
    // unknown site
    expect(lookupSiteContextObservedMaxPrompt(999, ['model-x'])).toBeNull();
  });
});

describe('observeContextOverflowFailure', () => {
  it('lowers a known limit and never raises it', async () => {
    seedRow({ siteId: 3, modelName: 'model-d', contextLimit: 128_000 });
    await ensureSiteContextCapabilityLoaded();

    const raised = await observeContextOverflowFailure({
      siteId: 3,
      modelName: 'model-d',
      status: 400,
      errorText: "This model's maximum context length is 200000 tokens.",
    });
    expect(raised).toBe(200_000);
    expect(lookupSiteContextLimitForNames(3, ['model-d'])).toEqual({ limit: 128_000, matchedName: 'model-d', source: 'error', observedMaxPrompt: null });

    const lowered = await observeContextOverflowFailure({
      siteId: 3,
      modelName: 'model-d',
      status: 400,
      errorText: 'maximum context length is 96000 tokens',
    });
    expect(lowered).toBe(96_000);
    expect(lookupSiteContextLimitForNames(3, ['model-d'])).toEqual({ limit: 96_000, matchedName: 'model-d', source: 'error', observedMaxPrompt: null });
  });

  it('learns a limit for an unknown model (first overflow)', async () => {
    await ensureSiteContextCapabilityLoaded();
    const learned = await observeContextOverflowFailure({
      siteId: 9,
      modelName: 'model-new',
      status: 400,
      errorText: 'max_model_len 32768 exceeded',
    });
    expect(learned).toBe(32_768);
    expect(lookupSiteContextLimitForNames(9, ['model-new'])).toEqual({ limit: 32_768, matchedName: 'model-new', source: 'error', observedMaxPrompt: null });
  });

  it('ignores non-overflow errors and unparseable overflows', async () => {
    await ensureSiteContextCapabilityLoaded();
    const notOverflow = await observeContextOverflowFailure({
      siteId: 9,
      modelName: 'model-x',
      status: 401,
      errorText: 'invalid api key',
    });
    expect(notOverflow).toBeNull();

    const noLimit = await observeContextOverflowFailure({
      siteId: 9,
      modelName: 'model-x',
      status: 400,
      errorText: 'prompt is too long',
    });
    expect(noLimit).toBeNull();
    expect(lookupSiteContextLimitForNames(9, ['model-x'])).toBeNull();
  });

  it('never overwrites a manual pin', async () => {
    seedRow({ siteId: 4, modelName: 'model-e', contextLimit: 100_000, source: 'manual' });
    await ensureSiteContextCapabilityLoaded();

    await observeContextOverflowFailure({
      siteId: 4,
      modelName: 'model-e',
      status: 400,
      errorText: 'maximum context length is 50000 tokens',
    });
    expect(lookupSiteContextLimitForNames(4, ['model-e'])).toEqual({ limit: 100_000, matchedName: 'model-e', source: 'manual', observedMaxPrompt: null });
    expect(state.upserts.length).toBe(0);
  });
});

describe('observeSuccessfulPromptUsage', () => {
  it('raises the observed lower bound only', async () => {
    seedRow({ siteId: 5, modelName: 'model-f', observedMaxPrompt: 5000, source: 'usage' });
    await ensureSiteContextCapabilityLoaded();

    await observeSuccessfulPromptUsage({ siteId: 5, modelName: 'model-f', promptTokens: 3000 });
    expect(state.upserts.length).toBe(0);

    await observeSuccessfulPromptUsage({ siteId: 5, modelName: 'model-f', promptTokens: 9000 });
    const entry = listSiteContextEntriesForSite(5).find((row) => row.modelName === 'model-f');
    expect(entry?.observedMaxPrompt).toBe(9000);
    expect(entry?.contextLimit).toBeNull();
  });

  it('creates a usage-only row when the model is unseen', async () => {
    await ensureSiteContextCapabilityLoaded();
    await observeSuccessfulPromptUsage({ siteId: 6, modelName: 'model-g', promptTokens: 123 });
    const entry = listSiteContextEntriesForSite(6).find((row) => row.modelName === 'model-g');
    expect(entry?.observedMaxPrompt).toBe(123);
    expect(entry?.source).toBe('usage');
  });
});

describe('manual pin and delete', () => {
  it('sets, reads back, and deletes a manual pin', async () => {
    await ensureSiteContextCapabilityLoaded();
    const ok = await setManualSiteContextLimit({ siteId: 6, modelName: 'model-h', contextLimit: 65_536 });
    expect(ok).toBe(true);
    expect(lookupSiteContextLimitForNames(6, ['model-h'])).toEqual({ limit: 65_536, matchedName: 'model-h', source: 'manual', observedMaxPrompt: null });

    const removed = await deleteSiteContextEntry(6, 'model-h');
    expect(removed).toBe(true);
    expect(lookupSiteContextLimitForNames(6, ['model-h'])).toBeNull();
  });
});
