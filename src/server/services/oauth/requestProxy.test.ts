import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../../config.js';
import { setProxyPoolCache } from '../proxyPoolStore.js';

type DbModule = typeof import('../../db/index.js');

const originalSystemProxyUrl = config.systemProxyUrl;

describe('oauth request proxy resolution', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-oauth-request-proxy-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    config.systemProxyUrl = '';
    // 池缓存直接注入：本测试只关心解析链，不重复覆盖池 CRUD
    setProxyPoolCache([
      { id: 11, url: 'http://pool-a.example:7000', isDefault: false },
      { id: 12, url: 'http://pool-default.example:8000', isDefault: true },
    ]);
  });

  afterAll(() => {
    config.systemProxyUrl = originalSystemProxyUrl;
    setProxyPoolCache([]);
    delete process.env.DATA_DIR;
  });

  async function createSite(values: Partial<{
    proxyUrl: string | null;
    proxyId: number | null;
    useSystemProxy: boolean;
  }> = {}): Promise<number> {
    const result = await db.insert(schema.sites).values({
      name: `site-${Math.random().toString(36).slice(2, 8)}`,
      url: `https://${Math.random().toString(36).slice(2, 8)}.example.com`,
      platform: 'codex',
      ...values,
    }).run();
    return Number(result.lastInsertRowid);
  }

  it('prefers the account custom url over pool and site settings', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite({ proxyUrl: 'http://site-custom.example:9000' });

    expect(await resolveOauthAccountProxyUrl({
      siteId,
      extraConfig: JSON.stringify({
        proxyUrl: 'http://account-custom.example:7890',
        proxyId: 11,
        useSystemProxy: true,
      }),
    })).toBe('http://account-custom.example:7890');
  });

  it('resolves an account pool reference through the cache', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite({ proxyUrl: 'http://site-custom.example:9000' });

    expect(await resolveOauthAccountProxyUrl({
      siteId,
      extraConfig: JSON.stringify({ proxyId: 11 }),
    })).toBe('http://pool-a.example:7000');
  });

  it('uses the pool default only when the account checks the system cell', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite();

    expect(await resolveOauthAccountProxyUrl({
      siteId,
      extraConfig: JSON.stringify({ useSystemProxy: true }),
    })).toBe('http://pool-default.example:8000');
    // 未勾选：账号层整层为空，落到站点层（此站点无配置 → null）
    expect(await resolveOauthAccountProxyUrl({
      siteId,
      extraConfig: JSON.stringify({ useSystemProxy: false }),
    })).toBeNull();
  });

  it('falls back to the whole site layer when the account cells are empty', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite({ proxyId: 11 });

    expect(await resolveOauthAccountProxyUrl({ siteId, extraConfig: null })).toBe('http://pool-a.example:7000');
  });

  it('resolves a checked site system cell to the pool default', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite({ useSystemProxy: true });

    expect(await resolveOauthAccountProxyUrl({ siteId })).toBe('http://pool-default.example:8000');
  });

  it('returns null for a missing site or an unusable site id', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');

    expect(await resolveOauthAccountProxyUrl({ siteId: null })).toBeNull();
    expect(await resolveOauthAccountProxyUrl({ siteId: 0 })).toBeNull();
    expect(await resolveOauthAccountProxyUrl({ siteId: 999999 })).toBeNull();
  });

  it('ignores an unknown account pool id instead of falling back to direct-with-value', async () => {
    const { resolveOauthAccountProxyUrl } = await import('./requestProxy.js');
    const siteId = await createSite({ proxyUrl: 'http://site-custom.example:9000' });

    // 池里查不到 id 视为该格空，继续走站点层，不能返回空串之类的“半个值”
    expect(await resolveOauthAccountProxyUrl({
      siteId,
      extraConfig: JSON.stringify({ proxyId: 999999 }),
    })).toBe('http://site-custom.example:9000');
  });
});
