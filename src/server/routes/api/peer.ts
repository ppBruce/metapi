import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { secretsEqual } from '../../middleware/auth.js';
import { getDashboardSummarySnapshot } from '../../services/dashboardSnapshotService.js';
import { getOrCreateCascadeDownstreamKey } from '../../services/cascadeCredentialService.js';

/**
 * Peer overview: read-only site-level metrics for cascaded MetAPI instances.
 *
 * This is the metapi-platform counterpart of new-api's per-user panel: the
 * credential is the ADMIN token, so a peer that presents it gets the same
 * numbers the local dashboard shows (total balance across active site
 * accounts, today's spend, today's checkin reward). Anything else — a
 * downstream `sk-` key, a wrong token, no token — is rejected with a bare
 * 401 that carries no MetAPI-specific marker, so the endpoint is
 * indistinguishable from any other admin API and cannot be probed without
 * holding the admin credential.
 *
 * Every branch RETURNS the reply. An async handler that sends and then resolves
 * to undefined makes Fastify run the onSend chain a second time while an async
 * onSend hook is still pending (we have three: the two capability headers plus
 * the security headers), because `reply.sent` stays false until the body is
 * written — the second pass then hits ERR_HTTP_HEADERS_SENT on the written head.
 * Returning the reply keeps the handler promise pending until the flush.
 */

const PEER_PROTOCOL_VERSION = 1;

function roundMicro(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function extractBearerToken(request: { headers: Record<string, unknown> }): string | null {
  const auth = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  return auth.replace(/^Bearer\s+/i, '').trim() || null;
}

export async function peerRoutes(app: FastifyInstance) {
  app.get('/api/v1/peer/overview', async (request, reply) => {
    const token = extractBearerToken(request) || '';
    // Constant-time compare; a wrong/missing token is a featureless 401.
    if (!token || !secretsEqual(token, config.authToken)) {
      return reply.code(401).send({ error: 'Invalid token' });
    }

    const summary = await getDashboardSummarySnapshot();
    const payload = summary.payload;
    return reply.send({
      protocolVersion: PEER_PROTOCOL_VERSION,
      site: {
        totalBalance: roundMicro(payload.totalBalance),
        totalUsed: roundMicro(payload.totalUsed),
        activeAccounts: payload.activeAccounts,
        totalAccounts: payload.totalAccounts,
      },
      today: {
        spend: roundMicro(payload.todaySpend),
        reward: roundMicro(payload.todayReward),
        checkin: payload.todayCheckin,
      },
      updatedAt: new Date().toISOString(),
    });
  });

  // Cascade key handoff: a trusted peer holding the admin token can pull the
  // downstream sk- key to route traffic with, instead of asking the operator
  // to create one by hand. Reuse-first on the upstream side, idempotent on
  // repeated calls.
  app.post('/api/v1/peer/cascade-key', async (request, reply) => {
    const token = extractBearerToken(request) || '';
    if (!token || !secretsEqual(token, config.authToken)) {
      return reply.code(401).send({ error: 'Invalid token' });
    }
    try {
      const key = await getOrCreateCascadeDownstreamKey();
      return reply.send({ key, name: 'cascade' });
    } catch (error) {
      request.log.error({ err: error }, 'cascade key issuance failed');
      return reply.code(500).send({ error: 'failed to issue cascade key' });
    }
  });
}
