import { resetBoundedPlatformDispatcher } from './platforms/platformHttpDispatcher.js';

// Progressive cooldowns between automatic connection-pool rebuilds inside one
// failure episode. The first connect-class failure rebuilds immediately;
// later ones back off so a genuinely unreachable upstream cannot trigger a
// rebuild storm. A fully healthy refresh pass ends the episode.
const SELF_HEAL_COOLDOWN_STEPS_MS = [15 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000] as const;
const SELF_HEAL_COOLDOWN_MAX_MS = 60 * 60_000;

type PlatformHttpSelfHealState = {
  attempts: number;
  lastAttemptAtMs: number;
};

let state: PlatformHttpSelfHealState = { attempts: 0, lastAttemptAtMs: 0 };

function cooldownAfterAttempt(attempts: number): number {
  if (attempts <= 0) return 0;
  return SELF_HEAL_COOLDOWN_STEPS_MS[Math.min(attempts - 1, SELF_HEAL_COOLDOWN_STEPS_MS.length - 1)]
    ?? SELF_HEAL_COOLDOWN_MAX_MS;
}

/** A fully healthy refresh pass proves the upstream recovered: end the episode. */
export function notePlatformHttpHealthy(): void {
  state = { attempts: 0, lastAttemptAtMs: 0 };
}

/**
 * Rebuild the outbound platform connection pool after connect-class failures
 * (timeouts / aborted / fetch failed) during model discovery. 2026-10-05:
 * every call to one upstream timed out for four days and only a process
 * restart cleared it — rebuilding the pool is the in-process equivalent.
 * Returns the attempt number when a rebuild happened, null when rate-limited
 * or when there is nothing to rebuild.
 */
export function attemptPlatformHttpSelfHeal(reason: string): { attempt: number } | null {
  const nowMs = Date.now();
  if (state.attempts > 0 && nowMs - state.lastAttemptAtMs < cooldownAfterAttempt(state.attempts)) {
    return null;
  }
  if (!resetBoundedPlatformDispatcher(reason)) return null;
  state = { attempts: state.attempts + 1, lastAttemptAtMs: nowMs };
  console.warn(`[self-heal] rebuilt the outbound platform connection pool (attempt #${state.attempts}): ${reason}`);
  return { attempt: state.attempts };
}

export function getPlatformHttpSelfHealState(): PlatformHttpSelfHealState {
  return { ...state };
}

/** Test hook. */
export function __resetPlatformHttpSelfHealForTests(): void {
  state = { attempts: 0, lastAttemptAtMs: 0 };
}
