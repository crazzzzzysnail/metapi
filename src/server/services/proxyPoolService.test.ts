import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { clearProxyPoolCache, proxyPoolDefaultUrl } from './proxyPoolStore.js';
import { resolveHolderProxyUrl } from './proxyResolution.js';
import type * as ProxyPoolServiceModule from './proxyPoolService.js';

type DbModule = typeof import('../db/index.js');

const originalSystemProxyUrl = config.systemProxyUrl;

describe('proxyPoolService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: typeof ProxyPoolServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-proxy-pool-'));
    process.env.DATA_DIR = dataDir;
    // 服务层静态 import 会拉起 db/index.js 并在加载时就建连，必须在 DATA_DIR 就位后再动态导入
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./proxyPoolService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.proxyPool).run();
    await db.delete(schema.settings).run();
    clearProxyPoolCache();
    config.systemProxyUrl = '';
  });

  afterAll(() => {
    config.systemProxyUrl = originalSystemProxyUrl;
    delete process.env.DATA_DIR;
  });

  async function readSystemProxySetting(): Promise<unknown> {
    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, 'system_proxy_url'))
      .get();
    if (!row) return null;
    try {
      return JSON.parse(String(row.value));
    } catch {
      return row.value;
    }
  }

  it('makes the first entry the default and mirrors it into settings', async () => {
    const created = await service.createProxyPool({ name: '池甲', url: ' http://127.0.0.1:7890/ ' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.data).toMatchObject({ name: '池甲', url: 'http://127.0.0.1:7890', isDefault: true });
    expect(await readSystemProxySetting()).toBe('http://127.0.0.1:7890');
    expect(proxyPoolDefaultUrl()).toBe('http://127.0.0.1:7890');
    expect(config.systemProxyUrl).toBe('http://127.0.0.1:7890');
  });

  it('does not promote later entries and only switches the default explicitly', async () => {
    const first = await service.createProxyPool({ name: '池甲', url: 'http://127.0.0.1:7890' });
    const second = await service.createProxyPool({ name: '池乙', url: 'socks5://127.0.0.1:1080' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.data.isDefault).toBe(false);
    expect(await readSystemProxySetting()).toBe('http://127.0.0.1:7890');

    const switched = await service.setDefaultProxyPool(second.data.id);
    expect(switched.ok).toBe(true);
    expect(proxyPoolDefaultUrl()).toBe('socks5://127.0.0.1:1080');
    expect(await readSystemProxySetting()).toBe('socks5://127.0.0.1:1080');

    const rows = await service.listProxyPool();
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([second.data.id]);
  });

  it('refreshes the mirror when the default entry url changes', async () => {
    const created = await service.createProxyPool({ name: '池甲', url: 'http://127.0.0.1:7890' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await service.updateProxyPoolUrl(created.data.id, 'http://127.0.0.1:7891');
    expect(updated.ok).toBe(true);
    expect(await readSystemProxySetting()).toBe('http://127.0.0.1:7891');
    expect(proxyPoolDefaultUrl()).toBe('http://127.0.0.1:7891');
  });

  it('rejects unsupported urls and masked values', async () => {
    const invalid = await service.createProxyPool({ name: '坏代理', url: 'ftp://127.0.0.1:21' });
    expect(invalid).toMatchObject({ ok: false, status: 400 });

    const masked = await service.createProxyPool({ name: '掩码', url: 'http://***@127.0.0.1:7890' });
    expect(masked).toMatchObject({ ok: false, status: 400 });
    expect(await service.listProxyPool()).toEqual([]);
  });

  it('redacts credentials in list views and keeps the raw url in the cache', async () => {
    // 假密码用无花括号形态：new URL() 重序列化不会改动它，缓存里的原文可直接比对
    const rawUrl = 'http://userA:dummypass-9x2k@127.0.0.1:7890';
    const created = await service.createProxyPool({ name: '带凭据', url: rawUrl });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [row] = await service.listProxyPool();
    expect(row?.url).toBe('http://***@127.0.0.1:7890');
    expect(row?.hasCredentials).toBe(true);
    expect(proxyPoolDefaultUrl()).toBe(rawUrl);
  });

  it('clears references on delete and does not auto-promote another entry', async () => {
    const first = await service.createProxyPool({ name: '池甲', url: 'http://127.0.0.1:7890' });
    const second = await service.createProxyPool({ name: '池乙', url: 'http://127.0.0.1:7891' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const site = await db.insert(schema.sites).values({
      name: '示例站点',
      url: 'https://site-a.example.com',
      platform: 'new-api',
      proxyId: first.data.id,
    }).run();
    const siteId = Number(site.lastInsertRowid);
    await db.insert(schema.accounts).values({
      siteId,
      username: '账号甲',
      accessToken: '{{SECRET_kz34wq2m}}',
      extraConfig: JSON.stringify({ proxyId: first.data.id }),
    }).run();

    expect(await service.countProxyPoolUsage(first.data.id)).toEqual({ siteCount: 1, accountCount: 1 });

    const deleted = await service.deleteProxyPool(first.data.id);
    expect(deleted).toMatchObject({ ok: true, data: { defaultId: null } });

    const siteRow = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    expect(siteRow?.proxyId).toBeNull();
    const accountRow = await db.select().from(schema.accounts).where(eq(schema.accounts.siteId, siteId)).get();
    expect(accountRow?.extraConfig).not.toContain('proxyId');
    // 删默认条目清空镜像，其余条目保持非默认
    expect(await readSystemProxySetting()).toBe('');
    expect(proxyPoolDefaultUrl()).toBeNull();
    expect(await service.proxyPoolIdExists(second.data.id)).toBe(true);
  });

  it('maps legacy system proxy writes onto pool entries', async () => {
    // 空池 → 建默认
    expect((await service.applyLegacySystemProxyUrl('http://127.0.0.1:7890')).ok).toBe(true);
    let rows = await service.listProxyPool();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '默认代理', url: 'http://127.0.0.1:7890', isDefault: true });

    // 有默认 → 改默认条目地址
    expect((await service.applyLegacySystemProxyUrl('http://127.0.0.1:7891')).ok).toBe(true);
    rows = await service.listProxyPool();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('http://127.0.0.1:7891');

    // 空值 → 清默认，不删条目
    expect((await service.applyLegacySystemProxyUrl('')).ok).toBe(true);
    rows = await service.listProxyPool();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isDefault).toBe(false);
    expect(await readSystemProxySetting()).toBe('');

    // 再写同 URL → 恢复该条为默认
    expect((await service.applyLegacySystemProxyUrl('http://127.0.0.1:7891')).ok).toBe(true);
    rows = await service.listProxyPool();
    expect(rows[0]?.isDefault).toBe(true);
  });

  it('seeds a default from the runtime setting only when the pool is empty', async () => {
    config.systemProxyUrl = 'http://127.0.0.1:7890';
    await service.ensureProxyPoolSeeded();

    let rows = await service.listProxyPool();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: '默认代理', isDefault: true });
    expect(proxyPoolDefaultUrl()).toBe('http://127.0.0.1:7890');

    // 已有池时不再新增，也不抢占默认
    config.systemProxyUrl = 'http://127.0.0.1:9999';
    await service.ensureProxyPoolSeeded();
    rows = await service.listProxyPool();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('http://127.0.0.1:7890');
  });

  it('repairs duplicate defaults by keeping the smallest id', async () => {
    const first = await service.createProxyPool({ name: '池甲', url: 'http://127.0.0.1:7890' });
    const second = await service.createProxyPool({ name: '池乙', url: 'http://127.0.0.1:7891' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // 人为制造第二条默认（脏数据）
    await db.update(schema.proxyPool).set({ isDefault: true }).where(eq(schema.proxyPool.id, second.data.id)).run();
    await service.ensureProxyPoolSeeded();

    const rows = await service.listProxyPool();
    expect(rows.filter((row) => row.isDefault).map((row) => row.id)).toEqual([first.data.id]);
  });

  it('feeds the resolution chain so a pool reference resolves to its url', async () => {
    const created = await service.createProxyPool({ name: '池甲', url: 'http://127.0.0.1:7890' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(resolveHolderProxyUrl({ proxyId: created.data.id })).toBe('http://127.0.0.1:7890');
    expect(resolveHolderProxyUrl({ useSystemProxy: true })).toBe('http://127.0.0.1:7890');
  });
});
