import type { FastifyReply, FastifyRequest } from 'fastify';

export interface NotFoundHandlerDeps {
  /**
   * SPA shell policy from ./webSpaFallback.js. Injected so the branch split is
   * testable without the real web bundle on disk.
   */
  isSpaShellFallbackCandidate: (url: string) => boolean;
}

/**
 * SPA fallback / not-found handler for the static web bundle.
 *
 * Extracted from index.ts so the 404 branches can be exercised by a test that
 * reproduces the production reply shape (compress + the async onSend hooks).
 *
 * Every branch must RETURN the reply. An async handler that sends and then
 * resolves to undefined makes Fastify run the onSend chain twice whenever the
 * chain is suspended by an async hook (we have three: the two capability hooks
 * plus the security-header hook), because `reply.sent` is still false while the
 * chain is pending — the second pass then hits ERR_HTTP_HEADERS_SENT on the
 * already-written head. Returning the reply marks the response as handled and
 * keeps the chain single-pass: `reply` is itself a thenable that resolves only
 * once the response stream has ended, so the handler promise stays pending
 * until the flush instead of resolving early with undefined.
 */
export function createNotFoundHandler(deps: NotFoundHandlerDeps) {
  const { isSpaShellFallbackCandidate } = deps;

  return async function notFoundHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    if (request.url.startsWith('/api/') || request.url.startsWith('/v1/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Missing assets must 404 instead of receiving the SPA shell: a 200
    // text/html body at a .js/.css URL is rejected as a MIME mismatch and
    // hides the real cause (stale cached shell pointing at a deleted chunk).
    if (!isSpaShellFallbackCandidate(request.url)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    }
    return reply.sendFile('index.html');
  };
}
