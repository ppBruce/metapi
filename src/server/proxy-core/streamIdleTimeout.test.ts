import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { describe, expect, it, vi } from 'vitest';

import { createProxyStreamLifecycle } from '../transformers/shared/protocolLifecycle.js';
import { fetchWithObservedFirstByte } from './firstByteTimeout.js';
import {
  buildStreamIdleTimeoutMessage,
  createIdleGuardedStreamReader,
  readWithIdleTimeout,
  type GuardedStreamReader,
} from './streamIdleTimeout.js';

const encoder = new TextEncoder();

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A reader that yields the given chunks, then optionally goes silent forever. */
function buildFakeReader(
  chunks: Uint8Array[],
  options: { hangAfterChunks?: boolean } = {},
): GuardedStreamReader & { cancel: ReturnType<typeof vi.fn>; releaseLock: ReturnType<typeof vi.fn> } {
  let index = 0;
  return {
    async read() {
      if (index < chunks.length) {
        const value = chunks[index];
        index += 1;
        return { done: false, value };
      }
      if (options.hangAfterChunks) return new Promise<never>(() => {});
      return { done: true };
    },
    cancel: vi.fn(async () => {}),
    releaseLock: vi.fn(() => {}),
  };
}

describe('buildStreamIdleTimeoutMessage', () => {
  it('renders the budget in whole seconds', () => {
    expect(buildStreamIdleTimeoutMessage(90_000)).toBe('stream idle timeout (90s)');
    expect(buildStreamIdleTimeoutMessage(45_500)).toBe('stream idle timeout (46s)');
  });

  it('never renders a zero-second budget', () => {
    expect(buildStreamIdleTimeoutMessage(30)).toBe('stream idle timeout (1s)');
  });
});

describe('readWithIdleTimeout', () => {
  it('returns the read result when the read settles inside the deadline', async () => {
    const result = await readWithIdleTimeout(
      async () => {
        await sleepFor(5);
        return 'chunk';
      },
      5_000,
    );

    expect(result).toBe('chunk');
  });

  it('rejects with the idle-timeout message when the read stays silent', async () => {
    await expect(readWithIdleTimeout(() => new Promise<never>(() => {}), 30))
      .rejects.toThrow('stream idle timeout (1s)');
  });

  it('runs the timeout hook before rejecting so the peer can be torn down', async () => {
    const onTimeout = vi.fn();

    await expect(readWithIdleTimeout(() => new Promise<never>(() => {}), 30, onTimeout))
      .rejects.toThrow('stream idle timeout');

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('reads unguarded when the budget is disabled', async () => {
    const read = vi.fn(async () => {
      await sleepFor(30);
      return 'slow but allowed';
    });

    await expect(readWithIdleTimeout(read, 0)).resolves.toBe('slow but allowed');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('propagates a read failure unchanged instead of reporting a timeout', async () => {
    await expect(readWithIdleTimeout(async () => {
      throw new Error('terminated');
    }, 5_000)).rejects.toThrow('terminated');
  });
});

describe('createIdleGuardedStreamReader', () => {
  it('delivers chunks, reports them to onChunk, and passes done through', async () => {
    const first = encoder.encode('data: one\n\n');
    const second = encoder.encode('data: two\n\n');
    const seen: string[] = [];
    const reader = createIdleGuardedStreamReader({
      reader: buildFakeReader([first, second]),
      timeoutMs: 5_000,
      onChunk: (value) => {
        seen.push(new TextDecoder().decode(value));
      },
    });

    expect(await reader.read()).toEqual({ done: false, value: first });
    expect(await reader.read()).toEqual({ done: false, value: second });
    expect(await reader.read()).toEqual({ done: true });
    expect(seen).toEqual(['data: one\n\n', 'data: two\n\n']);
  });

  it('fails a stream that goes silent and cancels the stalled upstream body', async () => {
    const base = buildFakeReader([encoder.encode('data: partial\n\n')], { hangAfterChunks: true });
    const reader = createIdleGuardedStreamReader({ reader: base, timeoutMs: 40 });

    expect((await reader.read()).done).toBe(false);
    await expect(reader.read()).rejects.toThrow('stream idle timeout');

    // The stalled peer must be torn down, not left holding a socket open.
    expect(base.cancel).toHaveBeenCalledWith('stream idle timeout');
  });

  it('reports the timeout even when cancelling the peer resolves the pending read', async () => {
    // undici resolves a pending body read as a clean EOF when that reader is
    // cancelled. Reporting that as EOF would mark a stalled stream successful,
    // so the deadline must win the race against its own teardown.
    let resolvePending: ((value: { done: boolean }) => void) | null = null;
    const base: GuardedStreamReader = {
      read: () => new Promise<{ done: boolean }>((resolve) => {
        resolvePending = resolve;
      }),
      cancel: vi.fn(async () => {
        resolvePending?.({ done: true });
      }),
      releaseLock: () => {},
    };
    const reader = createIdleGuardedStreamReader({ reader: base, timeoutMs: 40 });

    await expect(reader.read()).rejects.toThrow('stream idle timeout');
    expect(base.cancel).toHaveBeenCalledWith('stream idle timeout');
  });

  it('forwards cancel and releaseLock to the underlying reader', async () => {
    const base = buildFakeReader([]);
    const reader = createIdleGuardedStreamReader({ reader: base, timeoutMs: 5_000 });

    await reader.cancel('client disconnected');
    reader.releaseLock();

    expect(base.cancel).toHaveBeenCalledWith('client disconnected');
    expect(base.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('ends a real upstream socket that goes silent mid-stream instead of waiting for the client', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"chunk":1}\n\n');
      // Never writes again and never ends: the production stall shape.
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const port = (upstream.address() as AddressInfo).port;

    try {
      const response = await fetchWithObservedFirstByte(
        async () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          body: '{}',
        }),
        { firstByteTimeoutMs: 5_000 },
      );
      const reader = createIdleGuardedStreamReader({
        reader: response.body!.getReader(),
        // A budget well below the first-byte window proves the guard is armed
        // after the first chunk, which is exactly what the old code missed.
        timeoutMs: 60,
      });
      const lifecycle = createProxyStreamLifecycle<string>({
        reader,
        response: { end: () => {} },
        pullEvents: (buffer) => ({ events: [buffer], rest: '' }),
        handleEvent: () => {},
      });

      await expect(lifecycle.run()).rejects.toThrow('stream idle timeout');
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
