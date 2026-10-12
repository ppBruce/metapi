import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, getGlobalDispatcher } from 'undici';
import {
  __resetPlatformHttpDispatcherForTests,
  getInstalledPlatformDispatcher,
  installBoundedPlatformDispatcher,
  platformHttpDispatcherTimeouts,
  resetBoundedPlatformDispatcher,
} from './platformHttpDispatcher.js';

describe('platform HTTP dispatcher', () => {
  const previous = getGlobalDispatcher();

  afterEach(() => __resetPlatformHttpDispatcherForTests(previous));

  it('bounds keep-alive lifetime without imposing a response header/body deadline', () => {
    expect(platformHttpDispatcherTimeouts.keepAliveTimeout).toBeLessThanOrEqual(30_000);
    expect(platformHttpDispatcherTimeouts.keepAliveMaxTimeout)
      .toBeGreaterThanOrEqual(platformHttpDispatcherTimeouts.keepAliveTimeout);
  });

  it('installs one bounded agent globally and stays idempotent', () => {
    const first = installBoundedPlatformDispatcher();
    const second = installBoundedPlatformDispatcher();
    expect(first).toBe(second);
    expect(first).toBeInstanceOf(Agent);
    expect(getGlobalDispatcher()).toBe(first);
    expect(getInstalledPlatformDispatcher()).toBe(first);
  });

  it('rebuilds the pool on demand and supersedes the previous agent', async () => {
    const first = installBoundedPlatformDispatcher();
    const closeSpy = vi.spyOn(first as Agent, 'close');
    const destroySpy = vi.spyOn(first as Agent, 'destroy');

    expect(resetBoundedPlatformDispatcher('unit test: rebuild')).toBe(true);
    const second = getInstalledPlatformDispatcher();
    expect(second).not.toBe(first);
    expect(second).toBeInstanceOf(Agent);
    expect(getGlobalDispatcher()).toBe(second);
    // After a rebuild the install helper hands back the fresh agent.
    expect(installBoundedPlatformDispatcher()).toBe(second);

    // The superseded agent is closed and then force-destroyed so its stuck
    // sockets cannot linger.
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
    await vi.waitFor(() => expect(destroySpy).toHaveBeenCalled());
  });

  it('reports nothing to rebuild when no dispatcher is installed', () => {
    __resetPlatformHttpDispatcherForTests(previous);
    expect(resetBoundedPlatformDispatcher('nothing installed')).toBe(false);
  });
});
