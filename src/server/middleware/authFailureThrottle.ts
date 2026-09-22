import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

/**
 * Brute-force throttling for the admin token.
 *
 * The admin boundary is a single shared secret (`config.authToken`) checked by
 * `authMiddleware`, with no other credential to slow an attacker down. This adds
 * a per-IP failure budget on top of the constant-time compare.
 *
 * Two deliberate design choices:
 *
 * 1. **Only FAILURES are counted.** A valid token short-circuits before this
 *    module is consulted and clears the counter, so a legitimate admin can never
 *    be locked out by someone else's failed attempts. That matters because every
 *    client arriving through the tunnel reads as `127.0.0.1` (the connector runs
 *    locally and TRUST_PROXY defaults off) — a naive "block the IP" rule would
 *    let a stranger lock the operator out of their own console.
 * 2. **Blocking, not just rate limiting.** Exhausting the budget blocks the key
 *    for a full block window, so an attacker cannot resume guessing at the
 *    window boundary; they get `retry-after` instead.
 */

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 5 * 60_000;
const DEFAULT_BLOCK_MS = 5 * 60_000;

export type AuthThrottleOptions = {
  maxFailures?: number;
  windowMs?: number;
  blockMs?: number;
};

export type AuthThrottleVerdict = {
  blocked: boolean;
  retryAfterSec: number;
};

function secondsFromMs(ms: number, fallbackMs: number): number {
  const resolved = Number.isFinite(ms) && ms > 0 ? ms : fallbackMs;
  return Math.max(1, Math.ceil(resolved / 1000));
}

export function createAuthFailureThrottle(options: AuthThrottleOptions = {}) {
  const maxFailures = Math.max(1, Math.trunc(options.maxFailures ?? DEFAULT_MAX_FAILURES));
  const windowMs = Math.max(1000, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
  const blockMs = Math.max(1000, Math.trunc(options.blockMs ?? DEFAULT_BLOCK_MS));

  const limiter = new RateLimiterMemory({
    keyPrefix: 'admin-auth-failure',
    points: maxFailures,
    duration: Math.ceil(windowMs / 1000),
    blockDuration: Math.ceil(blockMs / 1000),
  });

  return {
    /** Count one rejected attempt; returns whether the caller is now blocked. */
    async recordFailure(key: string): Promise<AuthThrottleVerdict> {
      try {
        await limiter.consume(key);
        return { blocked: false, retryAfterSec: 0 };
      } catch (error) {
        if (error instanceof RateLimiterRes) {
          return { blocked: true, retryAfterSec: secondsFromMs(error.msBeforeNext, blockMs) };
        }
        throw error;
      }
    },
    /** A valid credential clears the key so the budget is per attacker, not per hour. */
    async clear(key: string): Promise<void> {
      await limiter.delete(key);
    },
    /** Read-only view, used by tests and diagnostics. */
    async peek(key: string): Promise<{ failures: number; blocked: boolean }> {
      const state = await limiter.get(key);
      if (!state) return { failures: 0, blocked: false };
      return {
        failures: Number(state.consumedPoints || 0),
        blocked: Number(state.consumedPoints || 0) >= maxFailures,
      };
    },
  };
}

/** Process-wide throttle used by `authMiddleware`. */
export const adminAuthThrottle = createAuthFailureThrottle();

export const adminAuthThrottleDefaults = {
  maxFailures: DEFAULT_MAX_FAILURES,
  windowMs: DEFAULT_WINDOW_MS,
  blockMs: DEFAULT_BLOCK_MS,
};
