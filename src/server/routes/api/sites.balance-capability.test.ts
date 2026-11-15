import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { setBalanceEvidenceInExtraConfig } from '../../services/accountExtraConfig.js';

type DbModule = typeof import('../../db/index.js');

describe('sites balance capability endpoint', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-balance-capability-'));
    process.env.DATA_DIR = dataDir;
    // 别的用例可能设过 DB_URL，它的优先级更高，必须清掉才不会连到真实库
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

  it('切换不计入总余额，并在 /api/sites 行上回传该标记', async () => {
    const site = await createSite();

    const res = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { excludeFromTotalBalance: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().site.excludeFromTotalBalance).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/sites' });
    const row = list.json().find((item: any) => item.id === site.id);
    expect(row.excludeFromTotalBalance).toBe(true);

    const back = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { excludeFromTotalBalance: false },
    });
    expect(back.json().site.excludeFromTotalBalance).toBe(false);

    const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(!!stored?.excludeFromTotalBalance).toBe(false);
  });

  it('balanceCapability 只接受 auto/none，auto 落库为 null', async () => {
    const site = await createSite();

    const none = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { balanceCapability: 'none' },
    });
    expect(none.statusCode).toBe(200);
    expect(none.json().site.balanceCapability).toBe('none');

    const auto = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { balanceCapability: 'auto' },
    });
    expect(auto.json().site.balanceCapability).toBe(null);
  });

  it('标记为无需余额数据后，站点行的可得性直接判 not-applicable', async () => {
    const site = await createSite();
    // 先造一条"读到过"的连接：时间戳存在时旧逻辑会判 known
    await db.insert(schema.accounts).values({
      siteId: site.id,
      name: 'grp-codex',
      apiKey: 'sk-test-DUMMY',
      accessToken: 'session-sample',
      lastBalanceRefresh: new Date().toISOString(),
    }).run();

    const before = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(before.json().find((item: any) => item.id === site.id).balanceAvailability).toBe('known');

    await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { balanceCapability: 'none' },
    });

    // 用户显式声明"这站没有余额接口"时结论最硬：不再看连接证据
    const after = await app.inject({ method: 'GET', url: '/api/sites' });
    const row = after.json().find((item: any) => item.id === site.id);
    expect(row.balanceAvailability).toBe('not-applicable');
    expect(row.balanceAvailabilityReason).toBe(null);
  });

  it('无限配额连接让站点行给出 balanceUnlimitedQuota，供前端画 ∞', async () => {
    const site = await createSite();
    // 读不到数字 + 证据是"无限配额" → 界面上应是 ∞，不是破折号
    await db.insert(schema.accounts).values({
      siteId: site.id,
      name: 'grp-codex',
      apiKey: 'sk-test-DUMMY',
      accessToken: 'session-sample',
      extraConfig: setBalanceEvidenceInExtraConfig(null, {
        status: 'not-applicable',
        reason: 'unlimited-quota',
        source: 'apikey-token-usage',
      }),
    }).run();

    const row = (await app.inject({ method: 'GET', url: '/api/sites' }))
      .json().find((item: any) => item.id === site.id);
    expect(row.balanceAvailability).toBe('not-applicable');
    expect(row.balanceUnlimitedQuota).toBe(true);
  });

  it('读到过余额时不再标记无限配额（∞ 不能盖掉真实数字）', async () => {
    const site = await createSite();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      name: 'grp-codex',
      apiKey: 'sk-test-DUMMY',
      accessToken: 'session-sample',
      balance: 8,
      lastBalanceRefresh: new Date().toISOString(),
      extraConfig: setBalanceEvidenceInExtraConfig(null, {
        status: 'not-applicable',
        reason: 'unlimited-quota',
      }),
    }).run();

    const row = (await app.inject({ method: 'GET', url: '/api/sites' }))
      .json().find((item: any) => item.id === site.id);
    expect(row.balanceAvailability).toBe('known');
    expect(row.balanceUnlimitedQuota).toBe(false);
  });

  it('非法入参一律 400，且不写库', async () => {
    const site = await createSite();

    const badFlag = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { excludeFromTotalBalance: 'yes' },
    });
    expect(badFlag.statusCode).toBe(400);

    const badCapability = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: { balanceCapability: 'perhaps' },
    });
    expect(badCapability.statusCode).toBe(400);

    const empty = await app.inject({
      method: 'POST',
      url: `/api/sites/${site.id}/balance-capability`,
      payload: {},
    });
    expect(empty.statusCode).toBe(400);

    const missing = await app.inject({
      method: 'POST',
      url: '/api/sites/999999/balance-capability',
      payload: { excludeFromTotalBalance: true },
    });
    expect(missing.statusCode).toBe(404);

    const stored = await db.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
    expect(!!stored?.excludeFromTotalBalance).toBe(false);
    expect(stored?.balanceCapability ?? null).toBe(null);
  });
});
