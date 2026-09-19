import { beforeEach, describe, expect, it } from 'vitest';
import {
  REASONING_EFFORT_CEILING_TTL_MS,
  __resetReasoningEffortCeilingsForTests,
  clampRequestBodyToSiteEffortCeiling,
  learnReasoningEffortCeilingFromFailure,
  recordReasoningEffortRejection,
  resolveReasoningEffortCeiling,
} from './siteReasoningEffortCapabilityService.js';

describe('site reasoning-effort ceiling', () => {
  beforeEach(() => {
    __resetReasoningEffortCeilingsForTests();
  });

  it('teaches the rung below the rejected value', () => {
    expect(recordReasoningEffortRejection({ siteId: 7, endpoint: 'messages', effort: 'max' }))
      .toBe('xhigh');
    expect(resolveReasoningEffortCeiling(7, 'messages')).toBe('xhigh');
  });

  it('keeps one site+protocol from leaking into another', () => {
    recordReasoningEffortRejection({ siteId: 7, endpoint: 'messages', effort: 'max' });

    expect(resolveReasoningEffortCeiling(7, 'chat')).toBeNull();
    expect(resolveReasoningEffortCeiling(8, 'messages')).toBeNull();
  });

  it('only ever tightens the ceiling', () => {
    recordReasoningEffortRejection({ siteId: 7, endpoint: 'messages', effort: 'max' });
    // A later, milder rejection must not hand capability back.
    recordReasoningEffortRejection({ siteId: 7, endpoint: 'messages', effort: 'max' });
    expect(resolveReasoningEffortCeiling(7, 'messages')).toBe('xhigh');

    // A harsher rejection does tighten it.
    recordReasoningEffortRejection({ siteId: 7, endpoint: 'messages', effort: 'xhigh' });
    expect(resolveReasoningEffortCeiling(7, 'messages')).toBe('high');
  });

  it('clamps a body that sits above the ceiling and leaves lower values alone', () => {
    recordReasoningEffortRejection({ siteId: 7, endpoint: 'chat', effort: 'xhigh' });

    const above: Record<string, unknown> = { model: 'gpt-5', reasoning_effort: 'max' };
    expect(clampRequestBodyToSiteEffortCeiling(above, 7, 'chat')).toBe('high');
    expect(above.reasoning_effort).toBe('high');

    const below: Record<string, unknown> = { model: 'gpt-5', reasoning_effort: 'medium' };
    expect(clampRequestBodyToSiteEffortCeiling(below, 7, 'chat')).toBeNull();
    expect(below.reasoning_effort).toBe('medium');
  });

  it('expires a learned ceiling so an upgraded upstream gets a fresh chance', () => {
    const learnedAtMs = 1_000_000;
    recordReasoningEffortRejection({
      siteId: 7, endpoint: 'messages', effort: 'max', nowMs: learnedAtMs,
    });

    expect(resolveReasoningEffortCeiling(7, 'messages', learnedAtMs + REASONING_EFFORT_CEILING_TTL_MS - 1))
      .toBe('xhigh');
    expect(resolveReasoningEffortCeiling(7, 'messages', learnedAtMs + REASONING_EFFORT_CEILING_TTL_MS))
      .toBeNull();
  });

  it('learns from a failed attempt only when the body carried an effort', () => {
    const withEffort: Record<string, unknown> = { reasoning: { effort: 'max' } };
    expect(learnReasoningEffortCeilingFromFailure({
      siteId: 9, endpoint: 'responses', errorText: 'level "max" not supported', body: withEffort,
    })).toBe('xhigh');

    const withoutEffort: Record<string, unknown> = { model: 'gpt-5' };
    expect(learnReasoningEffortCeilingFromFailure({
      siteId: 9, endpoint: 'responses', errorText: 'level "max" not supported', body: withoutEffort,
    })).toBeNull();
    expect(resolveReasoningEffortCeiling(9, 'responses')).toBe('xhigh');
  });

  it('reports a rejection of an unknown value as no change', () => {
    expect(recordReasoningEffortRejection({ siteId: 7, endpoint: 'chat', effort: 'turbo' })).toBeNull();
    expect(resolveReasoningEffortCeiling(7, 'chat')).toBeNull();
  });
});
