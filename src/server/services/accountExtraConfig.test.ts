import { describe, expect, it } from 'vitest';
import {
  buildStoredSub2ApiSubscriptionSummary,
  fallbackBalanceEvidence,
  getBalanceEvidenceFromExtraConfig,
  reduceSiteBalanceAvailability,
  setBalanceEvidenceInExtraConfig,
  getCredentialModeFromExtraConfig,
  hasOauthProvider,
  getPlatformUserIdFromExtraConfig,
  getProxyUrlFromExtraConfig,
  getUseSystemProxyFromExtraConfig,
  resolveProxyUrlFromExtraConfig,
  getSub2ApiAuthFromExtraConfig,
  getSub2ApiSubscriptionFromExtraConfig,
  getManualBalanceUsdFromExtraConfig,
  setManualBalanceUsdInExtraConfig,
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  normalizeCredentialMode,
  resolvePlatformUserId,
  requiresManagedAccountTokens,
  supportsDirectAccountRoutingConnection,
} from './accountExtraConfig.js';
import { config } from '../config.js';

describe('accountExtraConfig', () => {
  it('reads platformUserId from extra config when present', () => {
    expect(getPlatformUserIdFromExtraConfig(JSON.stringify({ platformUserId: 11494 }))).toBe(11494);
    expect(getPlatformUserIdFromExtraConfig(JSON.stringify({ platformUserId: '7659' }))).toBe(7659);
    expect(getPlatformUserIdFromExtraConfig({ platformUserId: 2233 })).toBe(2233);
  });

  it('guesses platformUserId from username suffix digits', () => {
    expect(guessPlatformUserIdFromUsername('linuxdo_7659')).toBe(7659);
    expect(guessPlatformUserIdFromUsername('user11494')).toBe(11494);
    expect(guessPlatformUserIdFromUsername('abc')).toBeUndefined();
    expect(guessPlatformUserIdFromUsername('id_12')).toBeUndefined();
  });

  it('prefers configured user id over guessed user id', () => {
    expect(resolvePlatformUserId(JSON.stringify({ platformUserId: 5001 }), 'linuxdo_7659')).toBe(5001);
  });

  it('merges platformUserId into existing config without dropping keys', () => {
    const merged = mergeAccountExtraConfig(
      JSON.stringify({
        foo: 'bar',
        autoRelogin: { username: 'demo', passwordCipher: 'cipher' },
      }),
      { platformUserId: 7659 },
    );

    expect(merged).toBeTruthy();
    const parsed = JSON.parse(merged!);
    expect(parsed.foo).toBe('bar');
    expect(parsed.autoRelogin?.username).toBe('demo');
    expect(parsed.platformUserId).toBe(7659);
  });

  it('merges object extra config without dropping existing keys', () => {
    const merged = mergeAccountExtraConfig(
      {
        foo: 'bar',
        credentialMode: 'session',
        autoRelogin: { username: 'demo', passwordCipher: 'cipher' },
      },
      { platformUserId: 9001 },
    );

    expect(JSON.parse(merged)).toEqual(expect.objectContaining({
      foo: 'bar',
      credentialMode: 'session',
      platformUserId: 9001,
      autoRelogin: expect.objectContaining({
        username: 'demo',
        passwordCipher: 'cipher',
      }),
    }));
  });

  it('parses credential mode from extra config', () => {
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'apikey' }))).toBe('apikey');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'session' }))).toBe('session');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'AUTO' }))).toBe('auto');
    expect(getCredentialModeFromExtraConfig(JSON.stringify({ credentialMode: 'unknown' }))).toBeUndefined();
  });

  it('normalizes credential mode input', () => {
    expect(normalizeCredentialMode(' apikey ')).toBe('apikey');
    expect(normalizeCredentialMode('session')).toBe('session');
    expect(normalizeCredentialMode('AUTO')).toBe('auto');
    expect(normalizeCredentialMode('abc')).toBeUndefined();
  });

  it('parses managed sub2api refresh token config from extra config', () => {
    expect(getSub2ApiAuthFromExtraConfig(JSON.stringify({
      sub2apiAuth: { refreshToken: 'refresh-1', tokenExpiresAt: 1760000000000 },
    }))).toEqual({
      refreshToken: 'refresh-1',
      tokenExpiresAt: 1760000000000,
    });
    expect(getSub2ApiAuthFromExtraConfig(JSON.stringify({
      sub2apiAuth: { refreshToken: '  ' },
    }))).toBeNull();
  });

  it('reads proxyUrl from extra config', () => {
    expect(getProxyUrlFromExtraConfig(JSON.stringify({ proxyUrl: 'http://127.0.0.1:7890' }))).toBe('http://127.0.0.1:7890');
    expect(getProxyUrlFromExtraConfig(JSON.stringify({ proxyUrl: '  socks5://proxy.local:1080  ' }))).toBe('socks5://proxy.local:1080');
  });

  it('returns null for missing or empty proxyUrl', () => {
    expect(getProxyUrlFromExtraConfig(JSON.stringify({}))).toBeNull();
    expect(getProxyUrlFromExtraConfig(JSON.stringify({ proxyUrl: '' }))).toBeNull();
    expect(getProxyUrlFromExtraConfig(JSON.stringify({ proxyUrl: '   ' }))).toBeNull();
    expect(getProxyUrlFromExtraConfig(null)).toBeNull();
    expect(getProxyUrlFromExtraConfig(undefined)).toBeNull();
    expect(getProxyUrlFromExtraConfig('invalid-json')).toBeNull();
  });

  it('reads useSystemProxy from extra config', () => {
    expect(getUseSystemProxyFromExtraConfig(JSON.stringify({ useSystemProxy: true }))).toBe(true);
    expect(getUseSystemProxyFromExtraConfig(JSON.stringify({ useSystemProxy: false }))).toBe(false);
    expect(getUseSystemProxyFromExtraConfig(JSON.stringify({}))).toBe(false);
  });

  it('resolves account proxy url from custom override before system proxy', () => {
    const previousSystemProxyUrl = config.systemProxyUrl;
    try {
      config.systemProxyUrl = 'http://127.0.0.1:7890';
      expect(resolveProxyUrlFromExtraConfig(JSON.stringify({
        proxyUrl: 'http://account-proxy:8080',
        useSystemProxy: true,
      }))).toBe('http://account-proxy:8080');
      expect(resolveProxyUrlFromExtraConfig(JSON.stringify({
        useSystemProxy: true,
      }))).toBe('http://127.0.0.1:7890');
      expect(resolveProxyUrlFromExtraConfig(JSON.stringify({
        useSystemProxy: false,
      }))).toBeNull();
    } finally {
      config.systemProxyUrl = previousSystemProxyUrl;
    }
  });

  it('treats auto-mode api token connections as direct-account routable', () => {
    expect(supportsDirectAccountRoutingConnection({
      accessToken: '',
      apiToken: 'sk-demo',
      extraConfig: null,
    })).toBe(true);
    expect(requiresManagedAccountTokens({
      accessToken: '',
      apiToken: 'sk-demo',
      extraConfig: null,
    })).toBe(false);
  });

  it('treats oauth and session connections as non-managed-token direct routes only when intended', () => {
    expect(supportsDirectAccountRoutingConnection({
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider: 'codex' } }),
    })).toBe(true);
    expect(requiresManagedAccountTokens({
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({ credentialMode: 'session', oauth: { provider: 'codex' } }),
    })).toBe(false);
    expect(supportsDirectAccountRoutingConnection({
      accessToken: 'session-token',
      apiToken: 'sk-default',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toBe(false);
    expect(requiresManagedAccountTokens({
      accessToken: 'session-token',
      apiToken: 'sk-default',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    })).toBe(true);
  });

  it('recognizes structured oauth provider columns even when extraConfig omits oauth.provider', () => {
    const structuredOauthAccount = {
      oauthProvider: 'codex',
      accessToken: 'oauth-access-token',
      apiToken: null,
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          email: 'oauth-user@example.com',
        },
      }),
    };

    expect(hasOauthProvider(structuredOauthAccount)).toBe(true);
    expect(supportsDirectAccountRoutingConnection(structuredOauthAccount)).toBe(true);
    expect(requiresManagedAccountTokens(structuredOauthAccount)).toBe(false);
  });

  it('parses stored sub2api subscription summary from extra config', () => {
    const extraConfig = mergeAccountExtraConfig(null, {
      sub2apiSubscription: buildStoredSub2ApiSubscriptionSummary({
        activeCount: 1,
        totalUsedUsd: 3.5,
        subscriptions: [
          {
            id: 7,
            groupName: 'Pro',
            expiresAt: '2026-04-01T00:00:00.000Z',
            monthlyUsedUsd: 3.5,
            monthlyLimitUsd: 20,
          },
        ],
      }, 1760000000000),
    });

    expect(getSub2ApiSubscriptionFromExtraConfig(extraConfig)).toEqual({
      activeCount: 1,
      totalUsedUsd: 3.5,
      subscriptions: [
        {
          id: 7,
          groupName: 'Pro',
          expiresAt: '2026-04-01T00:00:00.000Z',
          monthlyUsedUsd: 3.5,
          monthlyLimitUsd: 20,
        },
      ],
      updatedAt: 1760000000000,
    });
  });
});

/**
 * F8 第 1 期：余额可得性证据。
 *
 * 这块的价值全在"脏数据怎么处理"上 —— 证据决定界面显不显示 `—`，
 * 猜错等于谎报，所以每个用例都在钉住"宁可退回 unknown 也不猜"。
 */
describe('balance evidence', () => {
  it('写入后能原样读回，capturedAt 缺省取当前时刻', () => {
    const now = Date.now();
    const next = setBalanceEvidenceInExtraConfig(null, { status: 'known', source: 'session' });
    const evidence = getBalanceEvidenceFromExtraConfig(next);
    expect(evidence?.status).toBe('known');
    expect(evidence?.source).toBe('session');
    expect(evidence?.reason).toBeNull();
    expect(evidence?.capturedAt).toBeGreaterThanOrEqual(now - 1000);
  });

  it('保留 extra_config 里的其他字段', () => {
    const base = JSON.stringify({ platformUserId: 42, other: 'keep-me' });
    const next = setBalanceEvidenceInExtraConfig(base, {
      status: 'unavailable',
      reason: 'all-sources-failed',
      source: 'session',
      capturedAt: 1760000000000,
    });
    const parsed = JSON.parse(next);
    expect(parsed.platformUserId).toBe(42);
    expect(parsed.other).toBe('keep-me');
    expect(parsed.balanceEvidence).toEqual({
      status: 'unavailable',
      reason: 'all-sources-failed',
      source: 'session',
      capturedAt: 1760000000000,
    });
  });

  it('ISO 时间串也能归一成毫秒', () => {
    const next = setBalanceEvidenceInExtraConfig(null, {
      status: 'known',
      capturedAt: '2026-11-13T00:00:00.000Z',
    });
    expect(getBalanceEvidenceFromExtraConfig(next)?.capturedAt).toBe(Date.parse('2026-11-13T00:00:00.000Z'));
  });

  it('非法 status / 不在白名单的 reason 一律降级，不写进库', () => {
    const base = JSON.stringify({ keep: 1 });
    const next = setBalanceEvidenceInExtraConfig(base, {
      status: 'bogus' as any,
      reason: 'not-a-real-reason' as any,
    });
    expect(JSON.parse(next)).toEqual({ keep: 1 });
    expect(getBalanceEvidenceFromExtraConfig(next)).toBeNull();
  });

  it('库里是脏数据时读取返回 null，迫使调用方走推断链', () => {
    expect(getBalanceEvidenceFromExtraConfig(JSON.stringify({ balanceEvidence: 'oops' }))).toBeNull();
    expect(getBalanceEvidenceFromExtraConfig(JSON.stringify({ balanceEvidence: { status: 'whatever' } }))).toBeNull();
    // 合法的 known 才算数
    expect(
      getBalanceEvidenceFromExtraConfig(JSON.stringify({ balanceEvidence: { status: 'known', capturedAt: 1 } }))?.status,
    ).toBe('known');
  });

  it('站点级归并：任一连接读到过就算 known', () => {
    expect(reduceSiteBalanceAvailability([
      { status: 'unavailable', reason: 'all-sources-failed', source: 'session', capturedAt: 1 },
      { status: 'known', reason: null, source: 'session', capturedAt: 2 },
    ])).toBe('known');
  });

  it('站点级归并：全都没读到时区分"该重试"与"没这个概念"', () => {
    // unavailable 比 not-applicable 更需要人关注，优先级更高
    expect(reduceSiteBalanceAvailability([
      { status: 'not-applicable', reason: 'unlimited-quota', source: 'apikey-telemetry', capturedAt: 1 },
      { status: 'unavailable', reason: 'endpoint-unauthorized', source: 'session', capturedAt: 2 },
    ])).toBe('unavailable');
    expect(reduceSiteBalanceAvailability([
      { status: 'not-applicable', reason: 'unlimited-quota', source: 'apikey-telemetry', capturedAt: 1 },
    ])).toBe('not-applicable');
  });

  it('站点级归并：没有连接或证据缺失时是 unknown（不冒充任何结论）', () => {
    expect(reduceSiteBalanceAvailability([])).toBe('unknown');
    expect(reduceSiteBalanceAvailability([null, undefined])).toBe('unknown');
    // 脏证据同样不参与判定
    expect(reduceSiteBalanceAvailability([{ status: 'nope' } as any])).toBe('unknown');
  });

  it('fallback 与"读不到"的含义不同：它是无结论，不是不可用', () => {
    expect(fallbackBalanceEvidence()).toEqual({
      status: 'unknown',
      reason: 'no-capable-source',
      source: null,
      capturedAt: null,
    });
  });
});

describe('manual balance', () => {
  it('读写往返：数字与数字字符串都能读出，保留其他字段', () => {
    const initial = JSON.stringify({ proxyUrl: 'http://127.0.0.1:7890' });
    const next = setManualBalanceUsdInExtraConfig(initial, 12.5);
    expect(getManualBalanceUsdFromExtraConfig(next)).toBe(12.5);
    expect(JSON.parse(next).proxyUrl).toBe('http://127.0.0.1:7890');

    const zero = setManualBalanceUsdInExtraConfig('{}', 0);
    expect(getManualBalanceUsdFromExtraConfig(zero)).toBe(0);
  });

  it('清除后回到 null；负数与脏值不被当成手动值', () => {
    const set = setManualBalanceUsdInExtraConfig('{}', 3);
    const cleared = setManualBalanceUsdInExtraConfig(set, null);
    expect('manualBalanceUsd' in JSON.parse(cleared)).toBe(false);
    expect(getManualBalanceUsdFromExtraConfig(cleared)).toBe(null);

    expect(getManualBalanceUsdFromExtraConfig(JSON.stringify({ manualBalanceUsd: -1 }))).toBe(null);
    expect(getManualBalanceUsdFromExtraConfig(JSON.stringify({ manualBalanceUsd: 'abc' }))).toBe(null);
    // 早期写入的是字符串形态，必须仍能读出（备份恢复的老数据走这条）
    expect(getManualBalanceUsdFromExtraConfig(JSON.stringify({ manualBalanceUsd: '3.5' }))).toBe(3.5);
    expect(getManualBalanceUsdFromExtraConfig(JSON.stringify({ manualBalanceUsd: null }))).toBe(null);
    // 写负数属于调用方错误，保持原样且不落脏值
    expect(getManualBalanceUsdFromExtraConfig(setManualBalanceUsdInExtraConfig('{}', -2))).toBe(null);
  });
});
