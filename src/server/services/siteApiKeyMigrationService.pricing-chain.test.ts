import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type MigrationModule = typeof import('./siteApiKeyMigrationService.js');
type PricingModule = typeof import('./modelPricingService.js');

/**
 * D10'：站点级 apiKey 迁移后，定价链路仍然可用。
 *
 * 原方案提出「把 sites.apiKey 加进定价令牌候选」，经核查这是无效改动：
 * 启动时 `migrateSiteApiKeysToAccounts()` 会把站点密钥下推成 apikey 账户，
 * 并调用 `clearSiteApiKey` 把 `sites.api_key` 置空（src/server/index.ts:190）。
 * 因此生产环境里该字段恒为空，读它不会多拿到任何令牌。
 *
 * 本测试不锁定这个结论，而是把它变成可执行约束：
 *   ① 迁移确实清空了 sites.api_key；
 *   ② 迁移产物（apikey 账户的 apiToken）能被 buildTokenCandidates 取到；
 *   ③ buildTokenCandidates 从不引用站点级密钥 —— 防止有人重新加回去。
 */
describe('siteApiKeyMigration → 定价令牌候选链路', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let migrateSiteApiKeysToAccounts: MigrationModule['migrateSiteApiKeysToAccounts'];
  let buildTokenCandidates: PricingModule['buildTokenCandidates'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-d10-pricing-chain-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const migrationModule = await import('./siteApiKeyMigrationService.js');
    const pricingModule = await import('./modelPricingService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    migrateSiteApiKeysToAccounts = migrationModule.migrateSiteApiKeysToAccounts;
    buildTokenCandidates = pricingModule.buildTokenCandidates;
  });

  beforeEach(async () => {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    delete process.env.DATA_DIR;
  });

  it('站点密钥迁移后进入 apikey 账户并可被定价候选取到', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'legacy-pricing-site',
      url: 'https://legacy-pricing.example.com',
      platform: 'new-api',
      apiKey: 'sk-legacy-for-pricing',
    }).returning().get();

    const summary = await migrateSiteApiKeysToAccounts();

    expect(summary.migrated).toBe(1);
    expect(summary.clearedSites).toBe(1);

    // ① 站点字段确已清空
    const persistedSite = await db.select().from(schema.sites)
      .where(eq(schema.sites.id, site.id)).get();
    expect(persistedSite?.apiKey).toBe(null);

    // ② 迁移出的账户持有该密钥，且没有 session 令牌
    const migratedAccount = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.siteId, site.id)).get();
    expect(migratedAccount?.apiToken).toBe('sk-legacy-for-pricing');
    expect(migratedAccount?.accessToken).toBe('');

    // ③ 定价链路能拿到它
    const candidates = buildTokenCandidates({
      account: {
        accessToken: migratedAccount?.accessToken,
        apiToken: migratedAccount?.apiToken,
      },
    });
    expect(candidates).toEqual(['sk-legacy-for-pricing']);
  });

  it('session 优先于 apikey，空值与纯空白一律剔除', () => {
    expect(buildTokenCandidates({
      account: { accessToken: 'session-token', apiToken: 'sk-api-token' },
    })).toEqual(['session-token', 'sk-api-token']);

    expect(buildTokenCandidates({
      account: { accessToken: '   ', apiToken: 'sk-api-token' },
    })).toEqual(['sk-api-token']);

    expect(buildTokenCandidates({
      account: { accessToken: null, apiToken: undefined },
    })).toEqual([]);
  });

  it('相同令牌只保留一份（去重防止重复请求）', () => {
    expect(buildTokenCandidates({
      account: { accessToken: 'same-token', apiToken: 'same-token' },
    })).toEqual(['same-token']);
  });
});
