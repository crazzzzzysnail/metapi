import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { mergeAccountExtraConfig } from '../../services/accountExtraConfig.js';

const getApiTokensMock = vi.fn();
const getApiTokenMock = vi.fn();
const createApiTokenMock = vi.fn();
const getUserGroupsMock = vi.fn();
const deleteApiTokenMock = vi.fn();

type AccountTokenServiceModule = typeof import('../../services/accountTokenService.js');

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    createApiToken: (...args: unknown[]) => createApiTokenMock(...args),
    getUserGroups: (...args: unknown[]) => getUserGroupsMock(...args),
    deleteApiToken: (...args: unknown[]) => deleteApiTokenMock(...args),
  }),
}));

type DbModule = typeof import('../../db/index.js');

describe('account tokens sync routes with site status', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let maskToken: AccountTokenServiceModule['maskToken'];
  let normalizeTokenGroup: AccountTokenServiceModule['normalizeTokenGroup'];
  let dataDir = '';
  let previousDataDir: string | undefined;
  let seedId = 0;

  const nextSeed = () => {
    seedId += 1;
    return seedId;
  };

  const seedAccount = async (input: { siteStatus?: 'active' | 'disabled'; accountStatus?: string; accessToken?: string | null }) => {
    const id = nextSeed();
    const site = await db.insert(schema.sites).values({
      name: `site-${id}`,
      url: `https://site-${id}.example.com`,
      platform: 'new-api',
    }).returning().get();
    if (input.siteStatus === 'disabled') {
      await db.run(sql`update sites set status = 'disabled' where id = ${site.id}`);
    }

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `user-${id}`,
      accessToken: input.accessToken ?? `access-token-${id}`,
      status: input.accountStatus ?? 'active',
    }).returning().get();

    return { site, account };
  };

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-account-tokens-sync-'));
    vi.resetModules();
    process.env.DATA_DIR = dataDir;
    vi.resetModules();

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const accountTokenServiceModule = await import('../../services/accountTokenService.js');
    const routesModule = await import('./accountTokens.js');
    db = dbModule.db;
    schema = dbModule.schema;
    maskToken = accountTokenServiceModule.maskToken;
    normalizeTokenGroup = accountTokenServiceModule.normalizeTokenGroup;

    app = Fastify();
    await app.register(routesModule.accountTokensRoutes);
  });

  beforeEach(async () => {
    getApiTokensMock.mockReset();
    getApiTokenMock.mockReset();
    createApiTokenMock.mockReset();
    getUserGroupsMock.mockReset();
    deleteApiTokenMock.mockReset();
    seedId = 0;

    await db.delete(schema.accountTokens).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns skipped for single-account sync when site is disabled', async () => {
    const { account } = await seedAccount({ siteStatus: 'disabled' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: false,
      status: 'skipped',
      reason: 'site_disabled',
    });
    expect(getApiTokensMock).not.toHaveBeenCalled();
    expect(getApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns skipped when upstream has no api tokens', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: false,
      status: 'skipped',
      reason: 'no_upstream_tokens',
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows.length).toBe(0);
  });

  it('stores masked upstream token values as masked_pending placeholders', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: 'sk-abc***xyz', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      reason: 'upstream_masked_tokens',
      maskedPending: 1,
      pendingTokenIds: [expect.any(Number)],
      total: 1,
      created: 1,
      updated: 0,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: 'sk-abc***xyz',
      source: 'sync',
      enabled: false,
      isDefault: false,
    });
    expect((tokenRows[0] as any).valueStatus).toBe('masked_pending');

    const owner = await db.select()
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(owner?.apiToken ?? null).toBeNull();

    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject([
      expect.objectContaining({
        id: tokenRows[0].id,
        valueStatus: 'masked_pending',
      }),
    ]);
  });

  it('reuses an existing ready token when upstream only returns the matching masked token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: maskToken(fullToken), enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('removes matching masked_pending placeholders after reusing a ready token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    const maskedToken = maskToken(fullToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: maskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: maskedToken, enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('does not reuse a different ready token when another logical token shares the same masked value', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const firstFullToken = 'sk-real-token-1234';
    const secondFullToken = 'sk-real-zzzzz-1234';
    const sharedMaskedToken = maskToken(firstFullToken);

    expect(maskToken(secondFullToken)).toBe(sharedMaskedToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'first-token',
      token: firstFullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'second-token',
      token: sharedMaskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'second-token', key: sharedMaskedToken, enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 1,
      total: 2,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.find((row) => row.token === firstFullToken)).toMatchObject({
      name: 'first-token',
      token: firstFullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
    });
    const maskedRow = tokenRows.find((row) => row.name === 'second-token');
    expect(maskedRow).toMatchObject({
      token: sharedMaskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
    });
    expect((maskedRow as any)?.valueStatus).toBe('masked_pending');
  });

  it('keeps fully ambiguous short masks as masked_pending instead of reusing a ready token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-abcd';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'short-token',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'short-token', key: maskToken(fullToken), enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      reason: 'upstream_masked_tokens',
      created: 1,
      updated: 0,
      maskedPending: 1,
      total: 2,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.find((row) => row.token === fullToken)).toBeDefined();
    const maskedRow = tokenRows.find((row) => row.token === 'sk-***');
    expect(maskedRow).toMatchObject({
      name: 'short-token',
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
    });
    expect((maskedRow as any)?.valueStatus).toBe('masked_pending');
  });

  it('rejects sync and token management for apikey connections', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: '' });
    await db.update(schema.accounts)
      .set({
        apiToken: 'sk-proxy-only',
        checkinEnabled: false,
        extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    const syncResponse = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });
    expect(syncResponse.statusCode).toBe(400);
    expect(syncResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持同步账号令牌',
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'should-fail',
      },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持创建账号令牌',
    });

    const groupsResponse = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/groups/${account.id}`,
    });
    expect(groupsResponse.statusCode).toBe(400);
    expect(groupsResponse.json()).toMatchObject({
      success: false,
      message: 'API Key 连接不支持拉取账号令牌分组',
    });
  });

  it('hides legacy mirrored tokens for apikey connections from list API', async () => {
    const { account } = await seedAccount({ siteStatus: 'active', accessToken: '' });
    await db.update(schema.accounts)
      .set({
        apiToken: 'sk-hidden-legacy',
        checkinEnabled: false,
        extraConfig: mergeAccountExtraConfig(null, { credentialMode: 'apikey' }),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-hidden-legacy',
      enabled: true,
      isDefault: true,
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/account-tokens',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('sync-all skips disabled-site accounts and syncs active-site accounts', async () => {
    const disabled = await seedAccount({ siteStatus: 'disabled' });
    const active = await seedAccount({ siteStatus: 'active' });

    getApiTokensMock.mockResolvedValue([
      { name: 'default', key: 'sk-synced-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/sync-all',
      payload: { wait: true },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as {
      success: boolean;
      summary: {
        total: number;
        synced: number;
        skipped: number;
        failed: number;
      };
      results: Array<{ accountId: number; status: string; reason?: string; synced?: boolean }>;
    };

    expect(body.success).toBe(true);
    expect(body.summary).toMatchObject({
      total: 2,
      synced: 1,
      skipped: 1,
      failed: 0,
    });

    const skipped = body.results.find((item) => item.accountId === disabled.account.id);
    const synced = body.results.find((item) => item.accountId === active.account.id);

    expect(skipped).toMatchObject({
      accountId: disabled.account.id,
      status: 'skipped',
      reason: 'site_disabled',
    });
    expect(synced).toMatchObject({
      accountId: active.account.id,
      status: 'synced',
      synced: true,
    });

    const syncedDefaultToken = await db.select()
      .from(schema.accountTokens)
      .where(and(eq(schema.accountTokens.accountId, active.account.id), eq(schema.accountTokens.isDefault, true)))
      .get();
    expect(syncedDefaultToken?.token).toBe('sk-synced-token');
  });

  it('rejects non-boolean wait when syncing all account tokens', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens/sync-all',
      payload: {
        wait: 'true',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid wait. Expected boolean.',
    });
  });

  it('returns the refreshed default state after creating the first manual token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'manual-default',
        token: 'sk-manual-default-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        name: 'manual-default',
        isDefault: true,
        enabled: true,
      }),
    });
  });

  it('creates token via upstream api and syncs into local store when manual token is omitted', async () => {
    const { account, site } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'created-from-upstream', key: 'sk-created-upstream-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'created-from-upstream',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      createdViaUpstream: true,
      synced: true,
      status: 'synced',
    });
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0][0]).toBe(site.url);
    expect(createApiTokenMock.mock.calls[0][1]).toBe(account.accessToken);

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();

    expect(tokenRows.length).toBe(1);
    expect(tokenRows[0].name).toBe('created-from-upstream');
    expect(tokenRows[0].token).toBe('sk-created-upstream-token');
    expect(tokenRows[0].source).toBe('sync');
  });

  it('passes token creation options to upstream adapter', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(true);
    getApiTokensMock.mockResolvedValue([
      { name: 'custom-token', key: 'sk-created-upstream-token', enabled: true },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'custom-token',
        group: 'vip',
        unlimitedQuota: false,
        remainQuota: 123456,
        expiredTime: 2_000_000_000,
        allowIps: '1.1.1.1,2.2.2.2',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(createApiTokenMock).toHaveBeenCalledTimes(1);
    expect(createApiTokenMock.mock.calls[0][3]).toMatchObject({
      name: 'custom-token',
      group: 'vip',
      unlimitedQuota: false,
      remainQuota: 123456,
      expiredTime: 2_000_000_000,
      allowIps: '1.1.1.1,2.2.2.2',
    });
  });

  it('rejects non-string token payload when creating manual account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        token: { value: 'bad-token' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('token');
  });

  it('rejects non-boolean unlimitedQuota payload when creating upstream account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'typed-token',
        unlimitedQuota: 'false',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('unlimitedQuota');
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns 400 when limited token misses remainQuota', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'bad-token',
        unlimitedQuota: false,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: '有限额度令牌必须填写 remainQuota',
    });
    expect(createApiTokenMock).not.toHaveBeenCalled();
  });

  it('returns 502 when upstream token creation fails', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    createApiTokenMock.mockResolvedValue(false);

    const response = await app.inject({
      method: 'POST',
      url: '/api/account-tokens',
      payload: {
        accountId: account.id,
        name: 'created-from-upstream',
      },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      success: false,
      message: '站点创建令牌失败',
    });
  });

  it('fetches account token groups from upstream', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    getUserGroupsMock.mockResolvedValue(['default', 'vip']);

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/groups/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      groups: ['default', 'vip'],
    });
    expect(getUserGroupsMock).toHaveBeenCalledTimes(1);
  });

  it('deletes upstream token before removing local token', async () => {
    const { account, site } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'upstream-token',
      token: 'sk-upstream-token',
      source: 'sync',
      enabled: true,
      isDefault: false,
    }).returning().get();
    deleteApiTokenMock.mockResolvedValue(true);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(deleteApiTokenMock).toHaveBeenCalledTimes(1);
    expect(deleteApiTokenMock.mock.calls[0][0]).toBe(site.url);
    expect(deleteApiTokenMock.mock.calls[0][1]).toBe(account.accessToken);
    expect(deleteApiTokenMock.mock.calls[0][2]).toBe('sk-upstream-token');

    const removed = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(removed).toBeUndefined();
  });

  it('keeps local token when upstream deletion fails', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'upstream-token',
      token: 'sk-upstream-token',
      source: 'sync',
      enabled: true,
      isDefault: false,
    }).returning().get();
    deleteApiTokenMock.mockResolvedValue(false);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      success: false,
      message: '站点删除令牌失败，本地未删除',
    });

    const existing = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(existing).toBeDefined();
  });

  it('rejects retrieving token value when stored token is masked', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: true,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'GET',
      url: `/api/account-tokens/${token.id}/value`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
    });
  });

  it('upgrades an existing masked_pending placeholder when upstream later returns the full token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: 'sk-abc***xyz',
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: 'sk-real-token-1234', enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      synced: true,
      status: 'synced',
      total: 1,
      created: 0,
      updated: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'masked-only',
      token: 'sk-real-token-1234',
      enabled: true,
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('does not allow setting a masked_pending placeholder as default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/${token.id}/default`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: expect.stringContaining('待补全令牌'),
    });
  });

  it('promotes a masked_pending placeholder to ready when a full token is saved', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}`,
      payload: {
        token: 'sk-real-token-updated',
        enabled: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        id: token.id,
        enabled: true,
        valueStatus: 'ready',
      }),
    });

    const latest = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .get();
    expect(latest).toMatchObject({
      token: 'sk-real-token-updated',
      enabled: true,
    });
    expect((latest as any)?.valueStatus).toBe('ready');
  });

  it('returns the refreshed default state after promoting an existing token to default', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default-token',
      token: 'sk-default-token',
      source: 'manual',
      enabled: true,
      isDefault: true,
    }).run();
    const secondary = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'secondary-token',
      token: 'sk-secondary-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${secondary.id}`,
      payload: {
        isDefault: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      token: expect.objectContaining({
        id: secondary.id,
        isDefault: true,
      }),
    });
  });

  it('rejects non-string name payload when updating account token', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'typed-token',
      token: 'sk-real-token',
      source: 'manual',
      enabled: true,
      isDefault: false,
    }).returning().get();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/account-tokens/${token.id}`,
      payload: {
        name: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('name');
  });

  it('deletes masked_pending placeholders locally without calling upstream delete', async () => {
    const { account } = await seedAccount({ siteStatus: 'active' });
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-token',
      token: 'sk-mask***tail',
      source: 'sync',
      enabled: false,
      isDefault: false,
      valueStatus: 'masked_pending' as any,
    }).returning().get();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/account-tokens/${token.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(deleteApiTokenMock).not.toHaveBeenCalled();
    const removed = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).get();
    expect(removed).toBeUndefined();
  });

  // ============================================================================
  // 以下为 docs/plans/2026-10-09-token-sync-authority-fix.md 第 6.2 节要求的新增用例。
  // 核心不变式：身份判据只有「值全等」与「掩码匹配」两种，name/tokenGroup 是命中后要写的字段，
  // 绝不再作为匹配前提；上游缺字段则该字段不可用，一律不写。
  // ============================================================================

  it('refreshes ready token name when upstream renames it', async () => {
    // 本次缺陷的主症状：已补全（ready）令牌在上游改名后永不刷新，反而多插一条待补全行。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'old-name',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'new-name', key: fullToken, enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 0,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'new-name',
      token: fullToken,
      tokenGroup: 'default',
    });
  });

  it('does not overwrite local group when upstream omits the group field', async () => {
    // 决策 2：上游没给 group 字段 = 该字段不可用 = 不写，禁止拿令牌名编造分组。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'masked-only',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'vip',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: maskToken(fullToken), enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'synced',
      created: 0,
      updated: 1,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    // 分组保持本地值，不被编造成令牌名。
    expect(tokenRows[0]).toMatchObject({ token: fullToken, tokenGroup: 'vip' });
  });

  it('keeps local name when upstream returns an empty name', async () => {
    // 决策 3 + 用户 2026-10-10 拍板：上游 name 为空时不覆盖本地 name；
    // 全新令牌且上游无 name 时**跳过**，既不建 default/token-N 回退名，也不插无名行。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'local-name',
      token: fullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: '', key: fullToken, enabled: true },
      { name: '   ', key: 'sk-brand-new-token', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'synced',
      created: 0,
      updated: 1,
      total: 1,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]!.name).toBe('local-name');
    expect(tokenRows.map((row) => row.name)).not.toContain('default');
    expect(tokenRows.map((row) => row.name)).not.toContain('token-1');
    expect(tokenRows.map((row) => row.token)).not.toContain('sk-brand-new-token');
  });

  it('does not accumulate placeholders across repeated syncs', async () => {
    // 反证计划 1.2 节：失配插入的 pending 行会被后续每轮自行更新走，ready 行永无机会命中。
    // 新规则下同值 pending 走「值全等 = 确定身份」复用，行数必须恒定（幂等）。
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'masked-only', key: 'sk-rea***1234', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const totals: number[] = [];
    const createds: number[] = [];
    for (let round = 0; round < 3; round++) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/account-tokens/sync/${account.id}`,
      });
      expect(response.statusCode).toBe(200);
      createds.push((response.json() as any).created);
      const tokenRows = await db.select()
        .from(schema.accountTokens)
        .where(eq(schema.accountTokens.accountId, account.id))
        .all();
      totals.push(tokenRows.length);
    }

    expect(totals).toEqual([1, 1, 1]);
    expect(createds).toEqual([1, 0, 0]);
  });

  it('keeps two masked tokens that share the same name', async () => {
    // 两条上游项 name 相同、脱敏值不同。旧实现会在 matchingPlaceholder（只看 name+group、完全不看值）
    // 上命中第一条，把它的 token 覆写成第二条的值 —— 第一条令牌的掩码信息就此丢失。
    // 新规则身份判据是值全等，两条各自成行。
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'same-name', key: 'sk-abc***xyz', enabled: true },
      { name: 'same-name', key: 'sk-def***uvw', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body).toMatchObject({ status: 'synced', created: 2, total: 2, maskedPending: 2 });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.map((row) => row.token).sort()).toEqual(['sk-abc***xyz', 'sk-def***uvw']);

    // maskedPending / pendingTokenIds 按行去重，两者必须一致且无重复 id。
    const pendingIds = body.pendingTokenIds as number[];
    expect(pendingIds).toHaveLength(2);
    expect(new Set(pendingIds).size).toBe(2);
    expect(body.maskedPending).toBe(pendingIds.length);
  });

  it('does not treat pending as orphan when upstream has no name', async () => {
    // 决策 10：上游无名称信息时不判孤儿、不删 pending，只复用。
    // 删除是整个实现里唯一减少数据行的路径，前提四条必须同时成立，不可放宽。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    const maskedToken = maskToken(fullToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'ready-key',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'ready-key',
      token: maskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    // 名称相同、分组相同，只差上游没给 name —— 孤儿判定必须不成立。
    getApiTokensMock.mockResolvedValue([
      { name: '', key: maskedToken, enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 1,
      total: 2,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(2);
    expect(tokenRows.find((row) => row.token === maskedToken)).toBeDefined();
    // 种子 source 刻意用 'manual'：若不判孤儿的分支误刷新了 ready 行，source 会被写成 'sync'，
    // 这条断言就能抓到「ready 行一行不动」。
    expect(tokenRows.find((row) => row.token === fullToken)).toMatchObject({
      name: 'ready-key',
      source: 'manual',
    });
  });

  it('reports undistinguishable group when two ready tokens share one mask', async () => {
    // 决策 4 + 决策 12 类型 A：ready 掩码命中多条、名称 tie-break 后仍 >1 → 不写任何 ready。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const firstFullToken = 'sk-real-token-1234';
    const secondFullToken = 'sk-real-zzzzz-1234';
    const sharedMask = maskToken(firstFullToken);
    expect(maskToken(secondFullToken)).toBe(sharedMask);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'first-token',
      token: firstFullToken,
      source: 'sync',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'second-token',
      token: secondFullToken,
      source: 'sync',
      enabled: true,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'unknown-name', key: sharedMask, enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body).toMatchObject({ status: 'synced', updated: 0, created: 1, maskedPending: 1 });

    expect(Array.isArray(body.undistinguishable)).toBe(true);
    expect(body.undistinguishable).toHaveLength(1);
    expect(body.undistinguishable[0]).toMatchObject({
      maskedValue: sharedMask,
      kind: 'ready-ambiguous',
      upstreamName: 'unknown-name',
    });
    expect(body.undistinguishable[0].candidateTokenIds).toHaveLength(2);

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(3);
    // 两条 ready 行的名称/分组都未被改写（不猜、不写到错误的令牌上）。
    expect(tokenRows.find((row) => row.token === firstFullToken)).toMatchObject({ name: 'first-token' });
    expect(tokenRows.find((row) => row.token === secondFullToken)).toMatchObject({ name: 'second-token' });
  });

  it('keeps duplicated same-value placeholders even when names all match', async () => {
    // 决策 8 的删除前提不可放宽：同值 pending **只有一条**时才允许判孤儿。
    // 两条同值 pending 即便名称/分组全一致也不删——它们彼此不可区分，
    // 「哪条是残留」没有证据，删两条就是拿猜测当证据（计划类型 B + 第 8 节遗留风险 3）。
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    const maskedToken = maskToken(fullToken);

    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'k',
      token: fullToken,
      source: 'manual',
      enabled: true,
      isDefault: true,
      tokenGroup: 'default',
      valueStatus: 'ready' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'k',
      token: maskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'k',
      token: maskedToken,
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'default',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'k', key: maskedToken, enabled: true, tokenGroup: 'default' },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    expect(body).toMatchObject({
      status: 'synced',
      created: 0,
      updated: 1,
      maskedPending: 1,
      total: 3,
    });
    // 只复用第一条，另两条保留；ready 行一行不动（种子 source 为 manual，被刷成 sync 即抓到）。
    expect(body.pendingTokenIds).toHaveLength(1);
    expect(body.undistinguishable.map((item: any) => item.kind)).toEqual(['pending-duplicate']);

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(3);
    expect(tokenRows.filter((row) => row.token === maskedToken)).toHaveLength(2);
    expect(tokenRows.find((row) => row.token === fullToken)).toMatchObject({ source: 'manual' });
  });

  it('reports undistinguishable group when two upstream items share one mask', async () => {
    // 决策 12 类型 C：上游同一轮返回两条脱敏同值项，系统层面无法区分，塌缩成 1 行但必须上报。
    const { account } = await seedAccount({ siteStatus: 'active' });
    getApiTokensMock.mockResolvedValue([
      { name: 'first-name', key: 'sk-rea***1234', enabled: true },
      { name: 'second-name', key: 'sk-rea***1234', enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as any;
    // 杜绝重复：第二轮不新增行，且 pendingTokenIds 不出现重复 id。
    expect(body).toMatchObject({ status: 'synced', total: 1, created: 1, maskedPending: 1 });
    expect(body.pendingTokenIds).toHaveLength(1);

    expect(body.undistinguishable).toHaveLength(1);
    expect(body.undistinguishable[0]).toMatchObject({
      maskedValue: 'sk-rea***1234',
      kind: 'upstream-collapse',
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
  });

  it('upgrades masked_pending to ready when upstream omits the group field', async () => {
    // 关键修正：上游没给 group 字段时，分组一律不参与身份判定。
    // 若在此处仍要求分组一致，本地有显式分组的 pending 行会判为不一致，
    // 进而落到 insert 新造一条同值 ready 行 —— 正是本方案要消灭的重复行。
    // （第 2 步的孤儿判定刻意仍要求分组一致：那里不一致的后果是「不删」，保守方向正确。）
    const { account } = await seedAccount({ siteStatus: 'active' });
    const fullToken = 'sk-real-token-1234';
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'my-key',
      token: maskToken(fullToken),
      source: 'sync',
      enabled: false,
      isDefault: false,
      tokenGroup: 'vip',
      valueStatus: 'masked_pending' as any,
    }).run();

    getApiTokensMock.mockResolvedValue([
      { name: 'my-key', key: fullToken, enabled: true },
    ]);
    getApiTokenMock.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: `/api/account-tokens/sync/${account.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'synced',
      total: 1,
      created: 0,
      updated: 1,
      maskedPending: 0,
    });

    const tokenRows = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, account.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]).toMatchObject({
      name: 'my-key',
      token: fullToken,
      enabled: true,
      // 上游没给分组，本地分组保持不动。
      tokenGroup: 'vip',
    });
    expect((tokenRows[0] as any).valueStatus).toBe('ready');
  });

  it('resolves token group as null instead of the token name', () => {
    // 决策 6：normalizeTokenGroup 的第二参数只用于识别 default / 默认 / token-N 这类
    // 可推断的命名，不再拿任意令牌名编造分组。
    expect(normalizeTokenGroup(null, 'my-key')).toBeNull();
    expect(normalizeTokenGroup(undefined, '生产令牌')).toBeNull();
    expect(normalizeTokenGroup('   ', 'my-key')).toBeNull();
    // 显式分组仍原样返回。
    expect(normalizeTokenGroup('vip', 'my-key')).toBe('vip');
    // 以下两条是既有行为，必须保持不变（tokens/stats 的既有用例依赖它们）。
    expect(normalizeTokenGroup(null, 'default')).toBe('default');
    expect(normalizeTokenGroup(null, 'token-1')).toBeNull();
    expect(normalizeTokenGroup(null, null)).toBeNull();
  });
});
