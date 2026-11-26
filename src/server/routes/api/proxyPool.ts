import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import {
  parseProxyPoolCreatePayload,
  parseProxyPoolUpdatePayload,
  parseProxyPoolUrlPayload,
} from '../../contracts/proxyPoolRoutePayloads.js';
import {
  countProxyPoolUsage,
  createProxyPool,
  deleteProxyPool,
  getProxyPoolRawUrl,
  listProxyPool,
  renameProxyPool,
  setDefaultProxyPool,
  updateProxyPoolUrl,
} from '../../services/proxyPoolService.js';
import { testProxyConnectivity } from '../../services/proxyConnectivityTest.js';

/** 路由层只做解析/鉴权边界内的编排；业务与落库归 proxyPoolService。 */
export async function proxyPoolRoutes(app: FastifyInstance) {
  function parseId(raw: string): number | null {
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  app.get('/api/proxy-pool', async () => {
    return { items: await listProxyPool() };
  });

  app.post<{ Body: unknown }>('/api/proxy-pool', async (request, reply) => {
    const parsed = parseProxyPoolCreatePayload(request.body);
    if (!parsed.success) return reply.code(400).send({ message: parsed.error });
    const result = await createProxyPool({ name: parsed.data.name, url: parsed.data.url });
    if (!result.ok) return reply.code(result.status).send({ message: result.error });
    return { item: result.data };
  });

  // 常规更新只接受备注名；地址变更走独立端点（防把脱敏值当新地址回写）
  app.put<{ Params: { id: string }; Body: unknown }>('/api/proxy-pool/:id', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const parsed = parseProxyPoolUpdatePayload(request.body);
    if (!parsed.success) return reply.code(400).send({ message: parsed.error });
    const result = await renameProxyPool(id, parsed.data.name);
    if (!result.ok) return reply.code(result.status).send({ message: result.error });
    return { item: result.data };
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/proxy-pool/:id/url', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const parsed = parseProxyPoolUrlPayload(request.body);
    if (!parsed.success) return reply.code(400).send({ message: parsed.error });
    const result = await updateProxyPoolUrl(id, parsed.data.url);
    if (!result.ok) return reply.code(result.status).send({ message: result.error });
    return { item: result.data };
  });

  app.put<{ Params: { id: string } }>('/api/proxy-pool/:id/default', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const result = await setDefaultProxyPool(id);
    if (!result.ok) return reply.code(result.status).send({ message: result.error });
    return { success: true, item: result.data };
  });

  app.get<{ Params: { id: string } }>('/api/proxy-pool/:id/usage', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const raw = await getProxyPoolRawUrl(id);
    if (raw === null) return reply.code(404).send({ message: 'Proxy not found.' });
    return await countProxyPoolUsage(id);
  });

  // 显式揭示原文：仅管理员令牌可达（全局鉴权钩子），并留一条事件便于审计
  app.post<{ Params: { id: string } }>('/api/proxy-pool/:id/reveal', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const raw = await getProxyPoolRawUrl(id);
    if (raw === null) return reply.code(404).send({ message: 'Proxy not found.' });
    try {
      await db.insert(schema.events).values({
        type: 'status',
        title: '查看代理地址原文',
        message: `代理池条目 #${id} 的完整地址被查看`,
        level: 'info',
        relatedId: id,
        relatedType: 'settings',
        createdAt: formatUtcSqlDateTime(new Date()),
      }).run();
    } catch {
      // 审计写入失败不阻断揭示（与既有事件写入的容错口径一致）
    }
    return { url: raw };
  });

  app.post<{ Params: { id: string } }>('/api/proxy-pool/:id/test', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const raw = await getProxyPoolRawUrl(id);
    if (raw === null) return reply.code(404).send({ message: 'Proxy not found.' });
    try {
      const result = await testProxyConnectivity(raw);
      return { success: true, ...result };
    } catch (error: any) {
      return reply.code(502).send({ success: false, message: error?.message || '代理测试失败' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/proxy-pool/:id', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ message: 'Invalid proxy id.' });
    const result = await deleteProxyPool(id);
    if (!result.ok) return reply.code(result.status).send({ message: result.error });
    return { success: true, defaultId: result.data.defaultId };
  });
}
