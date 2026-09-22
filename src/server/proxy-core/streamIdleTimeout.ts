/**
 * Inter-chunk idle deadline for an in-flight upstream stream.
 *
 * The first-byte watchdog (`fetchWithObservedFirstByte`) is disarmed as soon as
 * the first chunk arrives, so an upstream that emits one chunk and then goes
 * silent used to hold the request open until the downstream client gave up:
 * live traces show streams stalling 212s / 314s that only ended when the client
 * cancelled. Re-arm the deadline on every chunk instead, so a stalled body
 * fails on its own and the channel is recorded as a timeout.
 *
 * This guards a stream that has already started, so it cannot fail over — the
 * SSE response is committed downstream. Its job is to end the hang with an
 * honest failure instead of waiting for the client's patience to run out.
 */

export type GuardedStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
};

export function buildStreamIdleTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `stream idle timeout (${seconds}s)`;
}

/**
 * Race one body read against the idle deadline.
 *
 * `timeoutMs <= 0` (explicit opt-out) reads unguarded, matching how a zero
 * first-byte timeout disables that watchdog end-to-end.
 */
export async function readWithIdleTimeout<T>(
  read: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  if (!(timeoutMs > 0)) return read();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Settle as a timeout BEFORE tearing the peer down. Cancelling a body
      // that has a pending read resolves that read as a clean EOF, and that
      // resolution would otherwise reach this promise first and report a
      // truncated stream as a normal end (no failure recorded, client sees a
      // silent stop).
      reject(new Error(buildStreamIdleTimeoutMessage(timeoutMs)));
      try {
        onTimeout?.();
      } catch {
        // ignore: the deadline is the failure being reported
      }
    }, timeoutMs);

    read().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Wrap an upstream body reader so every chunk read is deadline-guarded.
 *
 * Generic over the underlying read result so a caller that types `value` as
 * required keeps that contract (the gemini reader does); the guard never
 * reshapes what the peer returned.
 *
 * On idle timeout the upstream body is cancelled (a silent peer must not keep
 * its socket for the life of the process) and the read rejects with
 * {@link buildStreamIdleTimeoutMessage}, which the failure taxonomy classifies
 * as a retryable timeout.
 */
export function createIdleGuardedStreamReader<R extends { done: boolean; value?: Uint8Array }>(input: {
  reader: {
    read(): Promise<R>;
    cancel(reason?: unknown): Promise<unknown>;
    releaseLock(): void;
  };
  timeoutMs: number;
  onChunk?: (value: Uint8Array) => void;
}): {
  read(): Promise<R>;
  cancel(reason?: unknown): Promise<unknown>;
  releaseLock(): void;
} {
  const { reader, timeoutMs, onChunk } = input;
  return {
    async read() {
      const result = await readWithIdleTimeout(
        () => reader.read(),
        timeoutMs,
        () => {
          void Promise.resolve(reader.cancel('stream idle timeout')).catch(() => {});
        },
      );
      if (result.value) onChunk?.(result.value);
      return result;
    },
    async cancel(reason?: unknown) {
      return reader.cancel(reason);
    },
    releaseLock() {
      reader.releaseLock();
    },
  };
}
