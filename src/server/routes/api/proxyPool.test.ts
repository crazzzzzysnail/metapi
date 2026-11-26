import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { normalizeSiteProxyUrl } from '../../services/proxyUrlNormalize.js';

type DbModule = typeof import('../../db/index.js');

// 探测函数换成可断言的假实现：路由会真发网络请求，测试不应依赖外网
vi.mock('../../services/proxyConnectivityTest.js', () => ({
  testProxyConnectivity: vi.fn(async (proxyUrl: string) => ({
    reachable: true,
    ok: true,
    statusCode: 204,
    latencyMs: 12,
    probeUrl: 'https://www.gstatic.com/generate_204',
    finalUrl: proxyUrl,
  })),
}));

describe('proxy pool routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  // 带凭据的假地址。入站会先过 normalizeSiteProxyUrl（花括号等字符可能被百分号编码），
  // 因此所有期望都从同一常量运行时派生，绝不硬编码第二处字面量。
  const CRED_RAW = 'http://userA:{{PASSWORD_u4wqexlk}}@127.0.0.1:7890';
  const CRED_STORED = normalizeSiteProxyUrl(CRED_RAW);
  const CRED_SECRET = CRED_RAW.slice(CRED_RAW.indexOf('userA:') + 6, CRED_RAW.indexOf('@'));

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-pool-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./proxyPool.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.proxyPoolRoutes);
    await app.ready();
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.proxyPool).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.events).run();
    const { resetProxyPoolCacheForTests } = await import('../../services/proxyPoolService.js');
    resetProxyPoolCacheForTests();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('lists pool entries with redacted urls', async () => {
    const created = await app.inject({
      method: 'POST',
      payload: { name: '池甲', url: CRED_RAW },
      url: '/api/proxy-pool',
    });
    expect(created.statusCode).toBe(200);

    const listed = await app.inject({ method: 'GET', url: '/api/proxy-pool' });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: '池甲',
      url: 'http://***@127.0.0.1:7890',
      hasCredentials: true,
      isDefault: true,
    });
    // 凭据片段不得出现在列表响应里
    expect(listed.body).not.toContain(CRED_SECRET);
  });

  it('rejects invalid urls and masked write-backs', async () => {
    const invalid = await app.inject({
      method: 'POST',
      payload: { name: '坏代理', url: 'ftp://127.0.0.1:21' },
      url: '/api/proxy-pool',
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { message?: string }).message).toContain('代理地址无效');

    const masked = await app.inject({
      method: 'POST',
      payload: { name: '掩码', url: 'http://***@127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    expect(masked.statusCode).toBe(400);
    expect((masked.json() as { message?: string }).message).toContain('脱敏占位');
  });

  it('rejects non-object and blank-name payloads at the contract boundary', async () => {
    const arrayBody = await app.inject({ method: 'POST', payload: [], url: '/api/proxy-pool' });
    expect(arrayBody.statusCode).toBe(400);
    expect((arrayBody.json() as { message?: string }).message).toContain('object');

    const blankName = await app.inject({
      method: 'POST',
      payload: { name: '   ', url: 'http://127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    expect(blankName.statusCode).toBe(400);
    expect((blankName.json() as { message?: string }).message).toContain('name');
  });

  it('renames without accepting a url rewrite through the regular update', async () => {
    const created = await app.inject({
      method: 'POST',
      payload: { name: '池甲', url: 'http://127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    const item = (created.json() as { item: { id: number } }).item;

    const renamed = await app.inject({
      method: 'PUT',
      payload: { name: '池甲改名', url: 'http://127.0.0.1:9999' },
      url: `/api/proxy-pool/${item.id}`,
    });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { item: { url: string } }).item.url).toBe('http://127.0.0.1:7890');
  });

  it('switches the default entry via the dedicated route', async () => {
    const first = await app.inject({
      method: 'POST',
      payload: { name: '池甲', url: 'http://127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    const second = await app.inject({
      method: 'POST',
      payload: { name: '池乙', url: 'socks5://127.0.0.1:1080' },
      url: '/api/proxy-pool',
    });
    const secondId = (second.json() as { item: { id: number } }).item.id;

    const switched = await app.inject({ method: 'PUT', url: `/api/proxy-pool/${secondId}/default` });
    expect(switched.statusCode).toBe(200);
    expect((switched.json() as { item: { isDefault: boolean } }).item.isDefault).toBe(true);

    const settings = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'system_proxy_url')).all();
    expect(JSON.parse(String(settings[0]?.value))).toBe('socks5://127.0.0.1:1080');
  });

  it('reports the reference impact before a url change or delete', async () => {
    const created = await app.inject({
      method: 'POST',
      payload: { name: '池甲', url: 'http://127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    const item = (created.json() as { item: { id: number } }).item;

    const site = await db.insert(schema.sites).values({
      name: '示例站点',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      proxyId: item.id,
    }).run();
    const siteId = Number(site.lastInsertRowid);
    await db.insert(schema.accounts).values({
      siteId,
      username: '账号甲',
      accessToken: 'dummy-token-1',
      extraConfig: JSON.stringify({ proxyId: item.id }),
    }).run();

    const usage = await app.inject({ method: 'GET', url: `/api/proxy-pool/${item.id}/usage` });
    expect(usage.statusCode).toBe(200);
    expect(usage.json()).toEqual({ siteCount: 1, accountCount: 1 });
  });

  it('reveals the raw url and records an audit event', async () => {
    const created = await app.inject({
      method: 'POST',
      payload: { name: '带凭据', url: CRED_RAW },
      url: '/api/proxy-pool',
    });
    const item = (created.json() as { item: { id: number } }).item;

    const revealed = await app.inject({ method: 'POST', url: `/api/proxy-pool/${item.id}/reveal` });
    expect(revealed.statusCode).toBe(200);
    expect((revealed.json() as { url: string }).url).toBe(CRED_STORED);

    const events = await db.select().from(schema.events).all();
    expect(events.some((row) => String(row.message || '').includes(`#${item.id}`))).toBe(true);
  });

  it('tests a pool entry with its stored raw url', async () => {
    const { testProxyConnectivity } = await import('../../services/proxyConnectivityTest.js');
    const created = await app.inject({
      method: 'POST',
      payload: { name: '带凭据', url: CRED_RAW },
      url: '/api/proxy-pool',
    });
    const item = (created.json() as { item: { id: number } }).item;

    const result = await app.inject({ method: 'POST', url: `/api/proxy-pool/${item.id}/test` });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ success: true, statusCode: 204, latencyMs: 12 });
    // 探测必须用存储原文（归一化后形态），不能拿脱敏值去连
    expect(testProxyConnectivity).toHaveBeenCalledWith(CRED_STORED);
  });

  it('returns 404 for unknown ids on per-entry routes', async () => {
    for (const url of ['/api/proxy-pool/999/usage', '/api/proxy-pool/999/reveal']) {
      const response = await app.inject({ method: url.endsWith('reveal') ? 'POST' : 'GET', url });
      expect(response.statusCode).toBe(404);
    }
    const badId = await app.inject({ method: 'PUT', payload: { name: 'x' }, url: '/api/proxy-pool/abc' });
    expect(badId.statusCode).toBe(400);
  });

  it('deletes an entry and reports no remaining default', async () => {
    const created = await app.inject({
      method: 'POST',
      payload: { name: '池甲', url: 'http://127.0.0.1:7890' },
      url: '/api/proxy-pool',
    });
    const item = (created.json() as { item: { id: number } }).item;

    const deleted = await app.inject({ method: 'DELETE', url: `/api/proxy-pool/${item.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true, defaultId: null });

    const listed = await app.inject({ method: 'GET', url: '/api/proxy-pool' });
    expect((listed.json() as { items: unknown[] }).items).toEqual([]);
  });
});
