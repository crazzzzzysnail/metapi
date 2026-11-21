import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../../db/index.js');

/**
 * perf-metrics 能力列的值域守卫 + API 读写测（S2-2/S2-4）。
 * 端点与 balance 能力同处（POST /api/sites/:id/balance-capability），复用其失效逻辑。
 */
describe('sites perf-metrics capability endpoint', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-perf-capability-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.DB_URL;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function createSite() {
    return db.insert(schema.sites).values({
      name: 'siteA',
      url: 'https://siteA.example',
      platform: 'new-api',
    }).returning().get();
  }

  it('四态取值都能落库并在响应回显', async () => {
    const site = await createSite();
    for (const value of ['public', 'auth', 'cred_invalid', 'none'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sites/${site.id}/balance-capability`,
        payload: { perfMetricsCapability: value },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().site.perfMetricsCapability).toBe(value);
      const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
      expect(stored?.perfMetricsCapability).toBe(value);
    }
  });

  it('null / 空串清空为未探测（区别于 none=确认无端点）', async () => {
    const site = await createSite();
    await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: 'public' },
    });
    const cleared = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: null },
    });
    expect(cleared.json().site.perfMetricsCapability).toBe(null);
    const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(stored?.perfMetricsCapability ?? null).toBe(null);
  });

  it('GET /api/sites 行上透出该列（S2-4：供筛站）', async () => {
    const site = await createSite();
    await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: 'auth' },
    });
    const list = await app.inject({ method: 'GET', url: '/api/sites' });
    const row = list.json().find((item: any) => item.id === site.id);
    expect(row.perfMetricsCapability).toBe('auth');
  });

  it('auto 别名与非法值一律 400 且不写库', async () => {
    const site = await createSite();
    // perf 没有 balance 那套 auto 语义。
    const badAlias = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: 'auto' },
    });
    expect(badAlias.statusCode).toBe(400);

    const badValue = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: 'perhaps' },
    });
    expect(badValue.statusCode).toBe(400);

    const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(stored?.perfMetricsCapability ?? null).toBe(null);
  });

  it('只传 perfMetricsCapability 不误碰 balance 字段（窄更新）', async () => {
    const site = await createSite();
    await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { balanceCapability: 'none' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { perfMetricsCapability: 'public' },
    });
    expect(res.json().site.perfMetricsCapability).toBe('public');
    // balance 仍是上一步设的 none，没被这次更新冲掉。
    const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(stored?.balanceCapability).toBe('none');
  });
});
