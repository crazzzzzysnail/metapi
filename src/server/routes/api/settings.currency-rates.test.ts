import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * F8：汇率端点的 unknownCount。
 *
 * 缓存不用管：readSnapshotCache 在 VITEST 下恒为 bypass（snapshotCacheService.ts:69），
 * 每个用例都会真的跑一次 loader，读到的是本次种下的数据。
 */

type DbModule = typeof import('../../db/index.js');

describe('GET /api/settings/currency-rates 的 unknownCount', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-currency-rates-unknown-'));
    process.env.DATA_DIR = dataDir;
    delete process.env.DB_URL;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./settings.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.settingsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteBillingProfiles).run();
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });

  async function seedSite(name: string, status: 'active' | 'disabled', rate: number | null) {
    const site = await db.insert(schema.sites).values({
      name,
      url: `https://${name}.example`,
      platform: 'new-api',
      status,
    }).returning().get();
    if (rate !== null) {
      await db.insert(schema.siteBillingProfiles)
        .values({ siteId: site.id, cnyPerUsd: rate, rateSource: 'manual' })
        .run();
    }
    return site;
  }

  it('活跃站里汇率未知的数量如实回传', async () => {
    await seedSite('siteA', 'active', 7.2);
    await seedSite('siteB', 'active', null);
    await seedSite('siteC', 'active', null);

    const res = await app.inject({ method: 'GET', url: '/api/settings/currency-rates' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rates).toHaveLength(3);
    expect(body.unknownCount).toBe(2);
  });

  it('禁用站点不参与 unknownCount（否则提示数量虚增）', async () => {
    await seedSite('siteA', 'active', 7.2);
    await seedSite('siteB', 'active', null);
    // 禁用站即使缺汇率也不算"未计入"：它压根不在任何金额合计里
    await seedSite('siteD', 'disabled', null);

    const body = (await app.inject({ method: 'GET', url: '/api/settings/currency-rates' })).json();
    expect(body.rates).toHaveLength(2);
    expect(body.unknownCount).toBe(1);
  });

  it('非法汇率值同样计为未知，而不是当成有效值', async () => {
    await seedSite('siteA', 'active', 0);

    const body = (await app.inject({ method: 'GET', url: '/api/settings/currency-rates' })).json();
    expect(body.rates[0].cnyPerUsd).toBe(null);
    expect(body.unknownCount).toBe(1);
  });

  it('与前端同源：无活跃站时 counts 归零而不是 null', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/settings/currency-rates' })).json();
    expect(body.rates).toEqual([]);
    expect(body.unknownCount).toBe(0);
  });
});
