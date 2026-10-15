import type { FastifyInstance, FastifyRequest } from 'fastify';

type ContentTypeAwareFastify = FastifyInstance & {
  __metapiEmptyBodyContentTypeParserRegistered?: boolean;
};

/**
 * Tolerate a stamped media type on a request that carries no body.
 *
 * A body-less POST leaves the browser without a `Content-Type`, and the next hop
 * adds one: Cloudflare's edge sends `application/octet-stream` (reproduced with a
 * quick tunnel — the identical request is 200 on localhost and 415 through the
 * tunnel). Fastify rejects any unregistered media type *before* the handler runs,
 * so every action endpoint that takes no body silently stopped working behind a
 * tunnel: the usage-log SSE stream behind the auto-refresh button, the model-check
 * POST, the update-center check, the tunnel enable/disable calls.
 *
 * The rule is deliberately narrow: an EMPTY body is accepted whatever the declared
 * type, while a non-empty body in an unparsed type keeps its 415 — an unknown
 * payload must never turn into a silent no-op.
 */
export function ensureEmptyBodyContentTypeParser(app: FastifyInstance): void {
  const target = app as ContentTypeAwareFastify;
  if (target.__metapiEmptyBodyContentTypeParserRegistered) return;

  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 1024 }, (request, body, done) => {
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    const error = new Error(unsupportedMediaTypeMessage(request)) as Error & {
      statusCode?: number;
      code?: string;
    };
    error.statusCode = 415;
    error.code = 'FST_ERR_CTP_INVALID_MEDIA_TYPE';
    done(error);
  });

  target.__metapiEmptyBodyContentTypeParserRegistered = true;
}

function unsupportedMediaTypeMessage(request: FastifyRequest): string {
  const declared = request.headers['content-type'];
  return typeof declared === 'string' && declared.length > 0
    ? `Unsupported Media Type: ${declared.split(';')[0]?.trim()}`
    : 'Unsupported Media Type';
}
