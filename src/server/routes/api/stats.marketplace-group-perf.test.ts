import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * S5-1 / S2.5-5 端到端接线测：模型广场 pricingSources 的**分组级**公示快照。
 *
 * 这条链的判据落点（都在本文件里逐一钉住）：
 * 1. `groupPerf` 的键与该行 `groupPricing` 的计价分组**逐字符一致**（判据 3 的分组名同源，
 *    由 stats.ts 按 Object.keys(groupPricing) 产出，这里直接对拍两处的键序列）。
 * 2. 每个键取到**自己那一档**的分组值，绝不串档、绝不回退站级/模型级值（S4-1 铁律）。
 * 3. 从未预热该 (site,model) → `groupPerf` 为空表（不是 null、不是夹一排空态）。
 * 4. 未热 + 能力 public/auth → 触发一次单飞后台补拉；能力 none/未探测 → **绝不补拉**
 *    （否则等于给 404 无源的站白打上游）。
 * 5. 渲染路径零上游等待：补拉只登记任务，本次响应仍是空表（判据 5）。
 *
 * 缓存注入走 perfMetricsCache 的 store*（与 tokens.channel-presentation 同法）：
 * 这是进程内单例，故每例前必须 __resetPerfMetricsCacheForTests + 清响应缓存，
 * 否则 90s 的响应档会把上一例的快照带给下一例，伪装成"缓存生效"。
 */

const fetchModelPricingCatalogMock = vi.fn();
const startBackgroundTaskMock = vi.fn(() => ({ task: { id: 'bg-perf-1' }, reused: false }));

vi.mock('../../services/modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/modelPricingService.js')>('../../services/modelPricingService.js');
  return {
    ...actual,
    fetchModelPricingCatalog: (...args: unknown[]) => fetchModelPricingCatalogMock(...args),
  };
});

// 后台任务只拦 startBackgroundTask：补拉的**内容**（取数/退避/写缓存）属 perfMetricsCache
// 与 warmService 的单测范围，这里要钉的是"该不该发起、以什么 dedupeKey 发起"。
// 不拦 runner 的话，测试会真的去打 example 域名 → 网络 flaky + 噪音日志。
vi.mock('../../services/backgroundTaskService.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/backgroundTaskService.js')>('../../services/backgroundTaskService.js');
  return {
    ...actual,
    startBackgroundTask: (...args: unknown[]) => startBackgroundTaskMock(...args),
  };
});

type DbModule = typeof import('../../db/index.js');
type PerfCacheModule = typeof import('../../services/perfMetricsCache.js');

describe('GET /api/models/marketplace 分组级公示快照（S5-1）', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let storePerfSummary: PerfCacheModule['storePerfSummary'];
  let storePerfDetail: PerfCacheModule['storePerfDetail'];
  let resetPerfCache: PerfCacheModule['__resetPerfMetricsCacheForTests'];
  let resetMarketplaceCache: () => void;
  let dataDir = '';

  const MODEL = 'sample-model-len';
  const NOW = Date.now();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-marketplace-group-perf-'));
    process.env.DATA_DIR = dataDir;

    vi.resetModules();
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const perfCacheModule = await import('../../services/perfMetricsCache.js');
    const routesModule = await import('./stats.js');
    db = dbModule.db;
    schema = dbModule.schema;
    storePerfSummary = perfCacheModule.storePerfSummary;
    storePerfDetail = perfCacheModule.storePerfDetail;
    resetPerfCache = perfCacheModule.__resetPerfMetricsCacheForTests;
    resetMarketplaceCache = routesModule.resetModelsMarketplaceCacheForTests;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    fetchModelPricingCatalogMock.mockReset();
    startBackgroundTaskMock.mockClear();
    resetPerfCache();
    resetMarketplaceCache();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  /** 造一个 active 站 + active 账号 + 账号级可用模型，返回 siteId。 */
  async function seedSite(opts: { capability: 'public' | 'auth' | 'none' | null }) {
    const site = await db.insert(schema.sites).values({
      name: 'site-perf',
      url: 'https://site-perf.example.com',
      platform: 'new-api',
      status: 'active',
      perfMetricsCapability: opts.capability,
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alice',
      accessToken: 'session-token',
      status: 'active',
    }).returning().get();

    await db.insert(schema.modelAvailability).values({
      accountId: account.id,
      modelName: MODEL,
      available: true,
    }).run();

    return { siteId: site.id, accountId: account.id };
  }

  /** 目录里给两个计价分组（含中文组名，验证逐字符同源不止对 ASCII 成立）。 */
  function mockCatalogWithTwoGroups() {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [{
        modelName: MODEL,
        quotaType: 0,
        modelDescription: null,
        tags: [],
        supportedEndpointTypes: [],
        ownerBy: null,
        enableGroups: ['grp-codex', '组甲'],
        groupPricing: {
          'grp-codex': { quotaType: 0, inputPerMillion: 0.3, outputPerMillion: 1.5 },
          '组甲': { quotaType: 0, inputPerMillion: 0.6, outputPerMillion: 2.25 },
        },
      }],
      groupRatio: { 'grp-codex': 1, '组甲': 2 },
      autoGroups: [],
    });
  }

  async function getMarketplace() {
    const response = await app.inject({
      method: 'GET',
      url: `/api/models/marketplace?includePricing=1`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      models: Array<{
        name: string;
        pricingSources: Array<{
          siteId: number;
          groupPricing: Record<string, unknown>;
          perf?: { state: string; success24?: { value: number | null } } | null;
          groupPerf?: Record<string, { state: string; groupName?: string; success24?: { value: number | null }; success1h?: { value: number | null } } | null>;
        }>;
      }>;
    };
    const model = body.models.find((item) => item.name === MODEL);
    expect(model).toBeDefined();
    return model?.pricingSources[0];
  }

  it('每个计价分组徽章取到自己那一档：键与 groupPricing 逐字符一致，24h/1h 各取各窗', async () => {
    const { siteId } = await seedSite({ capability: 'public' });
    mockCatalogWithTwoGroups();
    storePerfDetail(siteId, MODEL, 24, {
      groups: [
        { group: 'grp-codex', avg_ttft_ms: 1200, avg_latency_ms: 4426, avg_tps: 77, success_rate: 99.1 },
        { group: '组甲', avg_ttft_ms: 900, avg_latency_ms: 5100, avg_tps: 40, success_rate: 88.5 },
      ],
    }, NOW - 60_000);
    storePerfDetail(siteId, MODEL, 1, {
      groups: [
        { group: 'grp-codex', avg_ttft_ms: 1100, avg_latency_ms: 4300, avg_tps: 80, success_rate: 100 },
        { group: '组甲', avg_ttft_ms: 800, avg_latency_ms: 5000, avg_tps: 42, success_rate: 94.44 },
      ],
    }, NOW - 60_000);

    const source = await getMarketplace();
    const perf = source?.groupPerf ?? {};
    // 键序列与计价分组完全一致（逐字符同源）。
    expect(Object.keys(perf).sort()).toEqual(Object.keys(source!.groupPricing).sort());
    expect(perf['grp-codex']?.success24?.value).toBe(99.1);
    expect(perf['grp-codex']?.success1h?.value).toBe(100);
    // 串档=最坏的错法：中文组名必须拿自己的数，不是第一档的数。
    expect(perf['组甲']?.success24?.value).toBe(88.5);
    expect(perf['组甲']?.success1h?.value).toBe(94.44);
    expect(perf['组甲']?.groupName).toBe('组甲');
    expect(perf['grp-codex']?.state).toBe('value');
  });

  it('计价分组在公示 groups[] 里挑不到 → 该键给 noWindowTraffic 空态，绝不错拿别的分组', async () => {
    const { siteId } = await seedSite({ capability: 'public' });
    mockCatalogWithTwoGroups();
    storePerfDetail(siteId, MODEL, 24, {
      groups: [{ group: 'grp-codex', avg_tps: 77, success_rate: 99.1 }],
    }, NOW - 60_000);

    const source = await getMarketplace();
    const perf = source?.groupPerf ?? {};
    expect(Object.keys(perf).sort()).toEqual(Object.keys(source!.groupPricing).sort());
    expect(perf['组甲']?.state).toBe('noWindowTraffic');
    expect(perf['组甲']?.success24?.value).toBeNull();
  });

  it('从未预热该 (site,model) → groupPerf 空表；能力 public 时触发单飞补拉（本次响应不等上游）', async () => {
    const { siteId } = await seedSite({ capability: 'public' });
    mockCatalogWithTwoGroups();
    // 只有站级 summary，没有该模型详情缓存 → 分组级无数据源。
    storePerfSummary(siteId, 24, [{ model_name: MODEL, avg_tps: 77, avg_latency_ms: 4426, success_rate: 99 }], true, NOW - 60_000);

    const source = await getMarketplace();
    expect(source?.groupPerf).toEqual({});
    // 模型级快照仍可用（来自 summary），说明两处数据源分列、互不冒充。
    expect(source?.perf?.state).toBe('value');

    const calls = startBackgroundTaskMock.mock.calls.map((c) => (c[0] as { dedupeKey?: string; type?: string }));
    const warmCall = calls.find((c) => c.dedupeKey === `perf-warm:${siteId}:${MODEL.toLowerCase()}`);
    expect(warmCall).toBeDefined();
    expect(warmCall?.type).toBe('perf-metrics-warm');
  });

  it('能力 none（404 无源站）→ 空表但**绝不**补拉', async () => {
    await seedSite({ capability: 'none' });
    mockCatalogWithTwoGroups();

    const source = await getMarketplace();
    expect(source?.groupPerf).toEqual({});
    expect(startBackgroundTaskMock).not.toHaveBeenCalled();
  });

  it('能力未探测(null) → 不补拉，也不给徽章挂空态', async () => {
    await seedSite({ capability: null });
    mockCatalogWithTwoGroups();

    const source = await getMarketplace();
    expect(source?.groupPerf).toEqual({});
    expect(startBackgroundTaskMock).not.toHaveBeenCalled();
  });

  it('详情缓存全过期 >24h → 每键 notPublished（诚实断供，与"从未热"可区分）', async () => {
    const { siteId } = await seedSite({ capability: 'auth' });
    mockCatalogWithTwoGroups();
    const dead = NOW - 25 * 60 * 60_000;
    storePerfDetail(siteId, MODEL, 24, { groups: [{ group: 'grp-codex', success_rate: 99 }] }, dead);
    storePerfDetail(siteId, MODEL, 1, { groups: [{ group: 'grp-codex', success_rate: 99 }] }, dead);

    const source = await getMarketplace();
    const perf = source?.groupPerf ?? {};
    expect(perf['grp-codex']?.state).toBe('notPublished');
    expect(perf['grp-codex']?.success24?.value).toBeNull();
    // 过期≠未热：补拉门控只看"缓存位存不存在"，过期位的重拉归 5min sweep（shouldWarmTask
    // 已含 force=false 的过期判定），渲染路径这里绝不重复发请求。
    expect(startBackgroundTaskMock).not.toHaveBeenCalled();
  });
});
