import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resetBoundedPlatformDispatcherMock = vi.fn((..._args: unknown[]) => true);

vi.mock('./platforms/platformHttpDispatcher.js', () => ({
  resetBoundedPlatformDispatcher: (...args: unknown[]) => resetBoundedPlatformDispatcherMock(...args),
}));

import {
  __resetPlatformHttpSelfHealForTests,
  attemptPlatformHttpSelfHeal,
  getPlatformHttpSelfHealState,
  notePlatformHttpHealthy,
} from './platformHttpSelfHeal.js';

describe('platform HTTP self-heal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T02:00:00.000Z'));
    __resetPlatformHttpSelfHealForTests();
    resetBoundedPlatformDispatcherMock.mockClear();
    resetBoundedPlatformDispatcherMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds immediately on the first connect-class failure', () => {
    expect(attemptPlatformHttpSelfHeal('model refresh timed out')).toEqual({ attempt: 1 });
    expect(resetBoundedPlatformDispatcherMock).toHaveBeenCalledTimes(1);
    expect(getPlatformHttpSelfHealState()).toEqual({ attempts: 1, lastAttemptAtMs: Date.now() });
  });

  it('backs successive rebuilds off inside one failure episode', () => {
    expect(attemptPlatformHttpSelfHeal('a')).toEqual({ attempt: 1 });
    expect(attemptPlatformHttpSelfHeal('b')).toBeNull();

    vi.advanceTimersByTime(15 * 60_000);
    expect(attemptPlatformHttpSelfHeal('c')).toEqual({ attempt: 2 });
    expect(attemptPlatformHttpSelfHeal('d')).toBeNull();

    vi.advanceTimersByTime(15 * 60_000);
    expect(attemptPlatformHttpSelfHeal('e')).toEqual({ attempt: 3 });

    vi.advanceTimersByTime(30 * 60_000 - 1);
    expect(attemptPlatformHttpSelfHeal('f')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(attemptPlatformHttpSelfHeal('g')).toEqual({ attempt: 4 });

    vi.advanceTimersByTime(60 * 60_000 - 1);
    expect(attemptPlatformHttpSelfHeal('h')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(attemptPlatformHttpSelfHeal('i')).toEqual({ attempt: 5 });
  });

  it('ends the episode after a healthy pass', () => {
    expect(attemptPlatformHttpSelfHeal('a')).toEqual({ attempt: 1 });
    notePlatformHttpHealthy();
    expect(getPlatformHttpSelfHealState()).toEqual({ attempts: 0, lastAttemptAtMs: 0 });
    expect(attemptPlatformHttpSelfHeal('b')).toEqual({ attempt: 1 });
  });

  it('reports nothing when the dispatcher cannot be rebuilt', () => {
    resetBoundedPlatformDispatcherMock.mockReturnValueOnce(false);
    expect(attemptPlatformHttpSelfHeal('a')).toBeNull();
    expect(getPlatformHttpSelfHealState()).toEqual({ attempts: 0, lastAttemptAtMs: 0 });
  });
});
