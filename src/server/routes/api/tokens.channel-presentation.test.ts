import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// 真函数（非工厂 mock）：billing/* 不经 modelPricingService 的 mock，故这里拿到的是
// 展示与实扣共用的同一实现，用于"同函数同结果"直证断言。
import { resolveBillingGroup } from '../../services/billing/billingGroupResolution.js';
// 预热缓存是模块级单例：S4-1 用例直接往里灌详情，故每例前必须清空（防跨例污染）。
import { storePerfDetail, __resetPerfMetricsCacheForTests } from '../../services/perfMetricsCache.js';

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
    __resetPerfMetricsCacheForTests();

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

  it('S1 边界：无令牌分组 + 平台不支持目录 + 目录冷 → unavailable，绝不凭空造价（移交 S2）', async () => {
    // coarena 冷启动真实形态：platform=openai（错标，不在 PRICING_CATALOG_PLATFORMS）+ 无令牌分组 + 缓存未热。
    // 期望：走 refreshBlockReason 分支 → unavailable『当前连接不支持计费目录』，
    //   而不是旧的『当前令牌分组未知』，更不是给无凭据/不支持的平台凭空编一个价。
    // 这条是判据 1 负控制的另一半：证明 S1-2 移除 bail 后，仍严守"不支持就不出价"。
    // 目录热后（marketplace 先拉过）它才出价——该正路径已由真库实测覆盖，冷启动归宿交 S2 能力探测。
    const seeded = await seedChannel({
      route: { modelPattern: 'cold-openai-model' },
      channel: { tokenId: null, sourceModel: 'cold-openai-model' },
      token: { enabled: false, isDefault: true },
      site: { platform: 'openai' },
    });
    getCachedModelPricingCatalogMock.mockReturnValue(null);

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({
      status: 'unavailable',
      message: '当前连接不支持计费目录',
    });
    expect(body[0].billing.message).not.toBe('当前令牌分组未知');
    expect(body[0].billing.pricing).toBeNull();
    expect(refreshModelPricingCatalogMock).not.toHaveBeenCalled();
  });

  it('treats sub2api as pricing-unsupported (T2.5)', async () => {
    // sub2api 只有订阅摘要与余额，没有任何取价端点。
    // 它此前被错列为支持定价目录，导致 UI 显示"可查目录"而结果恒为空。
    const seeded = await seedChannel({
      route: { modelPattern: 'sub2api-model' },
      channel: { sourceModel: 'sub2api-model' },
      site: { platform: 'sub2api' },
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

  it('S1-2：未知令牌分组不再提前 bail，改为触发目录刷新（与模型广场同路径）', async () => {
    // 旧行为：!groupName 直接 bail "当前令牌分组未知"，连目录都不查 —— apikey 类整类的显示缺陷。
    // 新行为：无分组等价于实扣 groupHint=null，继续走目录；缓存未命中则 refreshing，命中后按声明首档出。
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
      status: 'refreshing',
      modelName: 'unknown-group-model',
    });
    expect(body[0].billing.refreshTaskId).toEqual(expect.any(String));
    expect(refreshModelPricingCatalogMock).toHaveBeenCalledTimes(1);
  });

  it('S1-3 例1（coarena 形）：apikey 无令牌分组、模型只挂 default → 展示 default，且与实扣同函数同结果', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'coarena-shape-model' },
      channel: { tokenId: null, sourceModel: 'coarena-shape-model' },
      token: { enabled: false, isDefault: true },
    });
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [
        {
          modelName: 'coarena-shape-model',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['default'],
          groupPricing: {
            default: { quotaType: 0, inputPerMillion: 0.5, outputPerMillion: 1 },
          },
        },
      ],
      groupRatio: { default: 0.01 },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({
      status: 'ready',
      groupName: 'default',
      modelName: 'coarena-shape-model',
    });
    expect(body[0].billing.pricing).toMatchObject({ inputPerMillion: 0.5 });
    // 同函数同结果直证：展示档 == 实扣 resolveBillingGroup(空 hint) 档，逐字一致。
    expect(resolveBillingGroup({ enableGroups: ['default'] }, { default: 0.01 }, null)?.groupName).toBe('default');
    expect(body[0].billing.groupName).toBe(
      resolveBillingGroup({ enableGroups: ['default'] }, { default: 0.01 }, null)?.groupName,
    );
  });

  it('S1-3 例2（siteC 形，钉死被推翻的错法）：enable_groups=[组甲,default] 且 default×2 → 展示组甲价，绝不显示 default', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'sitec-shape-model' },
      channel: { tokenId: null, sourceModel: 'sitec-shape-model' },
      token: { enabled: false, isDefault: true },
    });
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [
        {
          modelName: 'sitec-shape-model',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: ['组甲', 'default'],
          groupPricing: {
            组甲: { quotaType: 0, inputPerMillion: 1.2, outputPerMillion: 2.4 },
            default: { quotaType: 0, inputPerMillion: 9.9, outputPerMillion: 9.9 },
          },
        },
      ],
      // default 倍率 ×2 是被推翻方案会误用的档；正确取声明首档 组甲。
      groupRatio: { 组甲: 1, default: 2 },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({ status: 'ready', groupName: '组甲' });
    expect(body[0].billing.pricing).toMatchObject({ inputPerMillion: 1.2 });
    // 绝不显示 default×2 的价。
    expect(body[0].billing.pricing?.inputPerMillion).not.toBe(9.9);
    // 同函数同结果直证。
    expect(resolveBillingGroup({ enableGroups: ['组甲', 'default'] }, { 组甲: 1, default: 2 }, null)?.groupName).toBe('组甲');
  });

  it('S1-3 例3：enableGroups 为空 → 如实保持未知分组（与实扣 line 978 同语义，绝不注入 default）', async () => {
    const seeded = await seedChannel({
      route: { modelPattern: 'no-declared-group-model' },
      channel: { tokenId: null, sourceModel: 'no-declared-group-model' },
      token: { enabled: false, isDefault: true },
    });
    getCachedModelPricingCatalogMock.mockReturnValue({
      models: [
        {
          modelName: 'no-declared-group-model',
          quotaType: 0,
          modelDescription: null,
          tags: [],
          supportedEndpointTypes: [],
          ownerBy: null,
          enableGroups: [],
          groupPricing: {},
        },
      ],
      groupRatio: { default: 1 },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/routes/${seeded.route.id}/channels`,
    });
    const body = response.json() as any[];
    expect(body[0].billing).toMatchObject({ status: 'unavailable', groupName: null });
    // 即便目录里存在 default 倍率，也绝不拿它兜底。
    expect(resolveBillingGroup({ enableGroups: [] }, { default: 1 }, null)).toBeNull();
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

  it('S4-1：ready 行附 perfGroup，按计价分组同名取 groups[] 条目（含双窗+ttft）', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'perf-group-model' }, channel: { sourceModel: 'perf-group-model' } });
    mockCatalog('perf-group-model', 'vip');
    // 预热缓存里放该 (site,model) 的详情：groups[] 同时有 vip 与别的档，钉"取同名那条"。
    const siteId = seeded.site.id;
    const now = Date.now();
    storePerfDetail(siteId, 'perf-group-model', 24, {
      groups: [
        { group: 'vip', avg_tps: 77, avg_ttft_ms: 1297, avg_latency_ms: 4426, success_rate: 99.1 },
        { group: 'other', avg_tps: 5, avg_ttft_ms: 900, avg_latency_ms: 9999, success_rate: 12 },
      ],
    }, now);
    storePerfDetail(siteId, 'perf-group-model', 1, {
      groups: [{ group: 'vip', avg_tps: 80, avg_ttft_ms: 1200, avg_latency_ms: 4200, success_rate: 100 }],
    }, now);

    const response = await app.inject({ method: 'GET', url: `/api/routes/${seeded.route.id}/channels` });
    const body = response.json() as any[];
    const perf = body[0].billing.perfGroup;
    expect(body[0].billing.groupName).toBe('vip');
    expect(perf).toBeTruthy();
    expect(perf.state).toBe('value');
    expect(perf.groupName).toBe('vip');
    expect(perf.tps.value).toBe(77);
    expect(perf.success24.value).toBe(99.1);
    expect(perf.success1h.value).toBe(100);
    expect(perf.ttft.value).toBe(1297);
    // 绝不取到 other 档的值（分组名一致性优先）。
    expect(perf.success24.value).not.toBe(12);
    expect(perf.latency.value).not.toBe(9999);
  });

  it('S4-1：groups[] 无同名档 → perfGroup 落空态，绝不回退站级/别的分组值', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'perf-miss-model' }, channel: { sourceModel: 'perf-miss-model' } });
    mockCatalog('perf-miss-model', 'vip');
    storePerfDetail(seeded.site.id, 'perf-miss-model', 24, {
      groups: [{ group: 'gold', avg_tps: 42, avg_latency_ms: 100, success_rate: 88 }],
    }, Date.now());
    storePerfDetail(seeded.site.id, 'perf-miss-model', 1, {
      groups: [{ group: 'gold', avg_tps: 42, avg_latency_ms: 100, success_rate: 88 }],
    }, Date.now());

    const response = await app.inject({ method: 'GET', url: `/api/routes/${seeded.route.id}/channels` });
    const body = response.json() as any[];
    const perf = body[0].billing.perfGroup;
    expect(body[0].billing.status).toBe('ready');
    expect(perf).toBeTruthy();
    // 计价档是 vip，groups[] 里只有 gold → 四态空值、不是拿 gold 的值冒充。
    expect(perf.tps.present).toBe(false);
    expect(perf.tps.value).toBeNull();
    expect(perf.success24.value).toBeNull();
  });

  it('S4-1：详情完全未预热 → perfGroup=null（整组不渲染，不给无数据行挂空 chip）', async () => {
    const seeded = await seedChannel({ route: { modelPattern: 'perf-none-model' }, channel: { sourceModel: 'perf-none-model' } });
    mockCatalog('perf-none-model', 'vip');
    // 不调 storePerfDetail：模拟该 (site,model) 从未被预热。

    const response = await app.inject({ method: 'GET', url: `/api/routes/${seeded.route.id}/channels` });
    const body = response.json() as any[];
    // 从未预热 = 无公示数据，null 而非"上游未公示"空 chip（后者专属"过期断供"，判据 5）。
    expect(body[0].billing.perfGroup).toBeNull();
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
