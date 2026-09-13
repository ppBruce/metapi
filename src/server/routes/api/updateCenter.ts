import { FastifyInstance } from 'fastify';

import {
  getUpdateCenterStatus,
  refreshUpdateCenterStatusCache,
} from '../../services/updateCenterStatusService.js';
import {
  getOtaStatusPayload,
  getOtaSupport,
  isOtaRunning,
  startOtaApply,
  startOtaRollback,
} from '../../services/updateCenterOtaService.js';
import { normalizeStableVersion } from '../../shared/updateCenterReminder.js';

export async function updateCenterRoutes(app: FastifyInstance) {
  app.get('/api/update-center/status', async () => {
    return await getUpdateCenterStatus();
  });

  app.post('/api/update-center/check', async () => {
    return (await refreshUpdateCenterStatusCache()).status;
  });

  app.get('/api/update-center/ota', async () => {
    return getOtaStatusPayload();
  });

  app.post('/api/update-center/apply', async (request, reply) => {
    const body = (request.body || {}) as { version?: unknown };
    const version = normalizeStableVersion(typeof body.version === 'string' ? body.version : '');
    if (!version) {
      return reply.code(400).send({ success: false, message: '无效的版本号' });
    }

    const support = getOtaSupport();
    if (!support.supported) {
      return reply.code(400).send({ success: false, message: support.reason || '当前部署不支持在线更新' });
    }
    if (isOtaRunning()) {
      return reply.code(409).send({ success: false, message: '已有在线更新任务进行中' });
    }

    void startOtaApply(version).catch(() => {
      // 失败详情已经记录在 OTA state 中，由状态接口对外呈现
    });
    return { success: true, state: getOtaStatusPayload().state };
  });

  app.post('/api/update-center/rollback', async (_request, reply) => {
    if (isOtaRunning()) {
      return reply.code(409).send({ success: false, message: '已有在线更新任务进行中' });
    }
    try {
      const result = await startOtaRollback();
      return { success: true, toVersion: result.toVersion };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ success: false, message });
    }
  });
}
