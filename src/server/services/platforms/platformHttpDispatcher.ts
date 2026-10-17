import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import type { Dispatcher } from 'undici';

export const platformHttpDispatcherTimeouts = {
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 30_000,
  connections: 64,
} as const;

// Grace before a superseded dispatcher is force-destroyed during a self-heal
// rebuild: requests riding healthy sockets get a chance to finish, while
// wedged sockets (which never complete) are killed once the grace expires.
const SUPERSEDED_DISPATCHER_GRACE_MS = 30_000;

let installed: Dispatcher | null = null;

function createBoundedPlatformDispatcherAgent(): Dispatcher {
  return new Agent({
    keepAliveTimeout: platformHttpDispatcherTimeouts.keepAliveTimeout,
    keepAliveMaxTimeout: platformHttpDispatcherTimeouts.keepAliveMaxTimeout,
    connections: platformHttpDispatcherTimeouts.connections,
    pipelining: 1,
  });
}

/** Idempotent: installs a bounded keep-alive agent for platform HTTP traffic. */
export function installBoundedPlatformDispatcher(): Dispatcher {
  if (installed) return installed;
  installed = createBoundedPlatformDispatcherAgent();
  setGlobalDispatcher(installed);
  return installed;
}

export function getInstalledPlatformDispatcher(): Dispatcher | null {
  return installed;
}

/**
 * Self-heal: swap in a fresh agent so wedged connection state (half-open
 * sockets, requests queued behind them forever) is discarded without a
 * process restart. 2026-10-05: every call to the upstream site timed out for
 * four days and only a manual restart cleared it — nothing rebuilt the pool.
 * The superseded agent is closed gracefully, then force-destroyed so its
 * stuck sockets cannot linger. Returns false when nothing is installed.
 */
export function resetBoundedPlatformDispatcher(reason: string): boolean {
  if (!installed) return false;
  const superseded = installed;
  installed = createBoundedPlatformDispatcherAgent();
  setGlobalDispatcher(installed);
  console.warn(`[platform-http] rebuilt the outbound connection pool: ${reason}`);
  void disposeSupersededDispatcher(superseded);
  return true;
}

async function disposeSupersededDispatcher(superseded: Dispatcher): Promise<void> {
  const grace = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SUPERSEDED_DISPATCHER_GRACE_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([superseded.close().catch(() => {}), grace]);
  } catch {
    // close() failures are irrelevant here; destroy() below is the hammer.
  }
  await superseded.destroy().catch(() => {});
}

/** Test hook: restore the dispatcher that was active before this helper. */
export function __resetPlatformHttpDispatcherForTests(previous: Dispatcher = getGlobalDispatcher()): void {
  installed = null;
  setGlobalDispatcher(previous);
}
