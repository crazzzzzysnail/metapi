import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getCachedModelPricingCatalogMock = vi.fn();
const refreshModelPricingCatalogMock = vi.fn();

vi.mock('../../services/modelPricingService.js', () => ({
  getCachedModelPricingCatalog: (...args: unknown[]) => getCachedModelPricingCatalogMock(...args),
  refreshModelPricingCatalog: (...args: unknown[]) => refreshModelPricingCatalogMock(...args),
}));

type DbModule = typeof import('../../db/index.js');
type BackgroundTaskModule = typeof import('../../services/backgroundTaskService.js');

describe('GET /api/routes/:id/channels presentation metadata', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let resetBackgroundTasks: BackgroundTaskModule['__resetBackgroundTasksForTests'];
  let waitForBackgroundTaskCompletion: BackgroundTaskModule['waitForBackgroundTaskCompletion'];
  let dataDir = '';
  let seedId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-route-channel-presentation-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./tokens.js');
    const backgroundTaskModule = await import('../../services/backgroundTaskService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    resetBackgroundTasks = backgroundTaskModule.__resetBackgroundTasksForTests;
    waitForBackgroundTaskCompletion = backgroundTaskModule.waitForBackgroundTaskCompletion;

    app = Fastify();
    await app.register(routesModule.tokensRoutes);
  });

  beforeEach(async () => {
    getCachedModelPricingCatalogMock.mockReset();
    refreshModelPricingCatalogMock.mockReset();
    refreshModelPricingCatalogMock.mockResolvedValue(null);
    resetBackgroundTasks();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.routeGroupSources).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    seedId = 0;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  async function seedChannel(overrides: {
    channel?: Partial<typeof schema.routeChannels.$inferInsert>;
    token?: Partial<typeof schema.accountTokens.$inferInsert>;
    site?: Partial<typeof schema.sites.$inferInsert>;
    account?: Partial<typeof schema.accounts.$inferInsert>;
    route?: Partial<typeof schema.tokenRoutes.$inferInsert>;
  } = {}) {
    seedId += 1;
    const site = await db.insert(schema.sites).values({
      name: `site-${seedId}`,
      url: `https://site-${seedId}.example.com`,
      platform: 'new-api',
      status: 'active',
      globalWeight: 2.5,
      ...overrides.site,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${seedId}`,
      accessToken: `access-token-${seedId}`,
      apiToken: `api-token-${seedId}`,
      balance: 12.34,
      status: 'active',
      ...overrides.account,
    }).returning().get();

    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'vip-token',
      token: `sk-token-${seedId}`,
      tokenGroup: 'vip',
      enabled: true,
      isDefault: true,
      ...overrides.token,
    }).returning().get();

    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: `gpt-5-mini-${seedId}`,
      enabled: true,
      ...overrides.route,
    }).returning().get();

    const channel = await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      tokenId: token.id,
      sourceModel: route.modelPattern,
      priority: 0,
      weight: 10,
      enabled: true,
      successCount: 9,
      failCount: 0,
      ...overrides.channel,
    }).returning().get();

    return { site, account, token, route, channel };
  }

  function mockCatalog(modelName: string, groupName = 'vip') {
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [
        {
          modelName,
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: [groupName],
          groupPricing: {
            [groupName]: {
              quotaType: 0,
              inputPerMillion: 1.2,
              outputPerMillion: 2.4,
            },
          },
        },
      ],
      groupRatio: { [groupName]: 1 },
    });
  }

  it('returns site weight, balance, token group, billing and healthy status', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'gpt-5-mini' }, channel: { sourceModel: 'gpt-5-mini' } });
    mockCatalog('gpt-5-mini');

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].site.globalWeight).toBe(2.5);
    expect(body[0].account.balance).toBe(12.34);
    expect(body[0].token.tokenGroup).toBe('vip');
    expect(body[0].effectiveToken.groupName).toBe('vip');
    expect(body[0].billing).toMatchObject({
      status: 'ready',
      groupName: 'vip',
      modelName: 'gpt-5-mini',
      pricing: {
        quotaType: 0,
        inputPerMillion: 1.2,
        outputPerMillion: 2.4,
      },
    });
    expect(body[0].health).toMatchObject({
      status: 'healthy',
      label: '健康',
    });
  });

  it('falls back to the default token group when a channel follows the account default token', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'gpt-5-mini' },
      channel: { tokenId: null, sourceModel: 'gpt-5-mini' },
      token: { name: 'default', tokenGroup: null },
    });
    mockCatalog('gpt-5-mini', 'default');

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body[0].token).toBeNull();
    expect(body[0].effectiveToken.groupName).toBe('default');
    expect(body[0].billing).toMatchObject({
      status: 'ready',
      groupName: 'default',
    });
  });

  it('returns refreshing billing when pricing cache is missing', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'gpt-5-mini' }, channel: { sourceModel: 'gpt-5-mini' } });
    getCachedModelPricingCatalogMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body[0].billing.status).toBe('refreshing');
    expect(body[0].billing.refreshTaskId).toEqual(expect.any(String));
    await waitForBackgroundTaskCompletion(body[0].billing.refreshTaskId, 5);
    expect(refreshModelPricingCatalogMock).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.events).all()).toHaveLength(0);
  });

  it('does not refresh pricing for unsupported native platforms', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'gpt-5-mini' },
      channel: { sourceModel: 'gpt-5-mini' },
      site: { platform: 'openai' },
    });
    getCachedModelPricingCatalogMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({
      status: 'unavailable',
      message: '当前连接不支持计费目录',
    });
    expect(body[0].billing.refreshTaskId).toBeUndefined();
    expect(refreshModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('does not refresh pricing for disabled or source-unavailable channels', async () => {
    const disabled = await seedChannel({
      route: { modelPattern: 'disabled-refresh-model' },
      channel: { sourceModel: 'disabled-refresh-model', enabled: false },
    });
    const unavailable = await seedChannel({
      route: { modelPattern: 'unavailable-refresh-model' },
      channel: { sourceModel: 'unavailable-refresh-model', sourceUnavailable: true },
    });
    getCachedModelPricingCatalogMock.mockReturnValue(null);

    const rows = await Promise.all([disabled, unavailable].map(async (seeded) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/routes/${seeded.route.id}/channels`,
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as any[])[0];
    }));

    expect(rows.map((row) => row.billing.status)).toEqual(['unavailable', 'unavailable']);
    expect(rows.map((row) => row.billing.refreshTaskId)).toEqual([undefined, undefined]);
    expect(refreshModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('does not refresh pricing when the effective token group is unknown', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'unknown-group-model' },
      channel: { tokenId: null, sourceModel: 'unknown-group-model' },
      token: { enabled: false, isDefault: true },
    });
    getCachedModelPricingCatalogMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({
      status: 'unavailable',
      message: '当前令牌分组未知',
    });
    expect(body[0].billing.refreshTaskId).toBeUndefined();
    expect(refreshModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('returns unavailable billing when the pricing catalog has no matching model', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'gpt-5-mini' }, channel: { sourceModel: 'gpt-5-mini' } });
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [],
      groupRatio: {},
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({
      status: 'unavailable',
      message: '上游计费目录未提供该模型',
    });
  });

  it('returns cooling, unavailable, disabled and degraded health states', async () => {
    const cooling = await seedChannel({
      route: { modelPattern: 'cooling-model' },
      channel: {
        sourceModel: 'cooling-model',
        cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    const unavailable = await seedChannel({
      route: { modelPattern: 'unavailable-model' },
      channel: { sourceModel: 'unavailable-model', sourceUnavailable: true },
    });
    const disabled = await seedChannel({
      route: { modelPattern: 'disabled-model' },
      channel: { sourceModel: 'disabled-model', enabled: false },
    });
    const degraded = await seedChannel({
      route: { modelPattern: 'degraded-model' },
      channel: {
        sourceModel: 'degraded-model',
        successCount: 1,
        failCount: 4,
      },
    });
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [],
      groupRatio: {},
    });

    const rows = await Promise.all([cooling, unavailable, disabled, degraded].map(async (seeded) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/routes/${seeded.route.id}/channels`,
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as any[])[0];
    }));

    expect(rows.map((row) => row.health.status)).toEqual([
      'cooling',
      'unavailable',
      'disabled',
      'degraded',
    ]);
  });

  it('uses the source model when an explicit group route exposes source channels', async () => {
    const source = await seedChannel({
      route: { modelPattern: 'source-model' },
      channel: { sourceModel: null },
    });
    const groupRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'public-group-model',
      displayName: 'public-group-model',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeGroupSources).values({
      groupRouteId: groupRoute.id,
      sourceRouteId: source.route.id,
    }).run();
    mockCatalog('source-model');

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${groupRoute.id}/channels`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].sourceModel).toBe('source-model');
    expect(body[0].billing).toMatchObject({
      status: 'ready',
      modelName: 'source-model',
    });
  });
});
