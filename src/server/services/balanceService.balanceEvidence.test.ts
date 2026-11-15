import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBalanceEvidenceFromExtraConfig } from './accountExtraConfig.js';

/**
 * F8：余额可得性证据的写入分支（`refreshBalance`）。
 *
 * 这里只钉"证据写没写、写成什么、有没有顺手把余额写坏"，
 * 不重复 autoRelogin 那份测试里的换 token 流程。
 *
 * 两条负控制是重点：
 * 1) unavailable 分支**不得**往 balance 里写 0 —— 库里的 0 是 schema 默认值，
 *    写 0 就等于把"没读到"伪造成"余额为零"，正是 F8 要消灭的东西。
 * 2) 证据必须先于 setAccountRuntimeHealth 落库。两者都是"读行→改 extra_config→写回"，
 *    反序会被未 await 的健康写入覆盖（用 journal 断言先后）。
 */

const adapterMock = {
  getBalance: vi.fn(),
  login: vi.fn(),
};

const selectAllMock = vi.fn();
const selectGetMock = vi.fn();
const updateSetMock = vi.fn();
const setAccountRuntimeHealthMock = vi.fn();
const extractRuntimeHealthMock = vi.fn();
const telemetryMock = vi.fn();
const undiciFetchMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const decryptPasswordMock = vi.fn();

/** 写入顺序日志：'db' = 证据/余额落库，'health' = 运行时健康状态。 */
let writeJournal: string[] = [];

vi.mock('../db/index.js', () => {
  const selectChain = {
    all: () => selectAllMock(),
    get: () => selectGetMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  return {
    db: {
      select: () => selectChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          writeJournal.push('db');
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
      insert: () => ({ values: () => ({ run: () => ({}) }) }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', status: 'status', extraConfig: 'extraConfig' },
      sites: { id: 'id', url: 'url', proxyUrl: 'proxyUrl', useSystemProxy: 'useSystemProxy', customHeaders: 'customHeaders' },
      settings: { key: 'key', value: 'value' },
      events: {},
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./billing/apiKeyTelemetryService.js', () => ({
  orchestrateApiKeyTelemetry: (...args: unknown[]) => telemetryMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => {
    writeJournal.push('health');
    return setAccountRuntimeHealthMock(...args);
  },
  extractRuntimeHealth: (...args: unknown[]) => extractRuntimeHealthMock(...args),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

/** 最近一次写进 extra_config 的证据（按写入顺序从后往前找）。 */
function lastWrittenEvidence() {
  for (let i = updateSetMock.mock.calls.length - 1; i >= 0; i -= 1) {
    const patch = updateSetMock.mock.calls[i][0];
    if (patch && typeof patch.extraConfig === 'string') {
      const evidence = getBalanceEvidenceFromExtraConfig(patch.extraConfig);
      if (evidence) return evidence;
    }
  }
  return null;
}

/** 是否有人往 balance 列写过东西（负控制用）。 */
function balanceWasWritten(): boolean {
  return updateSetMock.mock.calls.some((call) => call[0] && Object.prototype.hasOwnProperty.call(call[0], 'balance'));
}

function baseAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    username: 'acct-a',
    accessToken: 'session-token',
    status: 'active',
    balance: 0,
    balanceUsed: 0,
    quota: 0,
    extraConfig: null,
    ...overrides,
  };
}

function baseSite(overrides: Record<string, unknown> = {}) {
  return {
    id: 3,
    name: 'siteA',
    url: 'https://siteA.example',
    platform: 'new-api',
    status: 'active',
    ...overrides,
  };
}

function arrange(account: Record<string, unknown>, site: Record<string, unknown>) {
  selectAllMock.mockReturnValue([{ accounts: account, sites: site }]);
  selectGetMock.mockReturnValue({ extraConfig: account.extraConfig ?? null });
}

describe('refreshBalance 的余额证据', () => {
  beforeEach(() => {
    writeJournal = [];
    adapterMock.getBalance.mockReset();
    adapterMock.login.mockReset();
    selectAllMock.mockReset();
    selectGetMock.mockReset();
    updateSetMock.mockReset();
    setAccountRuntimeHealthMock.mockReset();
    extractRuntimeHealthMock.mockReset();
    telemetryMock.mockReset();
    undiciFetchMock.mockReset();
    reportTokenExpiredMock.mockReset();
    decryptPasswordMock.mockReset();

    extractRuntimeHealthMock.mockReturnValue(null);
    undiciFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
  });

  it('手动余额优先：写 known/manual 证据与余额，且不请求上游', async () => {
    arrange(
      baseAccount({ extraConfig: JSON.stringify({ manualBalanceUsd: 12.5 }), balance: 0 }),
      baseSite(),
    );

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ source: 'manual', balance: 12.5 });
    expect(adapterMock.getBalance).not.toHaveBeenCalled();
    expect(telemetryMock).not.toHaveBeenCalled();

    const evidence = lastWrittenEvidence();
    expect(evidence).toMatchObject({ status: 'known', source: 'manual' });
    expect(typeof evidence?.capturedAt).toBe('number');

    const balancePatch = updateSetMock.mock.calls
      .map((call) => call[0])
      .find((patch) => patch && Object.prototype.hasOwnProperty.call(patch, 'balance'));
    expect(balancePatch).toMatchObject({ balance: 12.5 });
    expect(typeof balancePatch?.lastBalanceRefresh).toBe('string');
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(1, expect.objectContaining({ state: 'healthy', reason: '使用手动余额' }));
  });

  it('站点标记「无需余额数据」：写 not-applicable 且完全不碰 balance 列', async () => {
    arrange(baseAccount(), baseSite({ balanceCapability: 'none' }));

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ skipped: true, reason: 'balance_not_applicable' });
    expect(adapterMock.getBalance).not.toHaveBeenCalled();
    expect(lastWrittenEvidence()).toMatchObject({
      status: 'not-applicable',
      reason: 'no-capable-source',
      source: 'site-capability',
    });
    // 负控制：不得写 balance（无论 0 还是旧值）
    expect(balanceWasWritten()).toBe(false);
  });

  it('apikey 无限配额：写 not-applicable/unlimited-quota，且不写 balance:0', async () => {
    arrange(baseAccount({ accessToken: null }), baseSite({ platform: 'new-api' }));
    telemetryMock.mockResolvedValue({
      adopted: { unlimitedQuota: true, totalUsedUsd: 1546 },
    });

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ skipped: true, source: 'unlimited-quota' });
    expect(lastWrittenEvidence()).toMatchObject({
      status: 'not-applicable',
      reason: 'unlimited-quota',
      source: 'apikey-telemetry',
    });
    expect(balanceWasWritten()).toBe(false);
  });

  it('apikey 遥测全失败：写 unavailable/all-sources-failed，且不写 balance:0', async () => {
    arrange(baseAccount({ accessToken: null }), baseSite());
    telemetryMock.mockResolvedValue(null);

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ skipped: true, reason: 'proxy_only' });
    expect(lastWrittenEvidence()).toMatchObject({
      status: 'unavailable',
      reason: 'all-sources-failed',
      source: 'apikey-telemetry',
    });
    expect(balanceWasWritten()).toBe(false);
  });

  it('apikey 有遥测但无金额：写 unavailable/malformed-payload', async () => {
    arrange(baseAccount({ accessToken: null }), baseSite());
    telemetryMock.mockResolvedValue({ adopted: { totalUsedUsd: 3 } });

    const { refreshBalance } = await import('./balanceService.js');
    await refreshBalance(1);

    expect(lastWrittenEvidence()).toMatchObject({
      status: 'unavailable',
      reason: 'malformed-payload',
      source: 'apikey-telemetry',
    });
    expect(balanceWasWritten()).toBe(false);
  });

  it('apikey 拿到余额：写 balance + known/apikey-telemetry', async () => {
    arrange(baseAccount({ accessToken: null }), baseSite());
    telemetryMock.mockResolvedValue({
      adopted: { balanceUsd: 7.25, totalUsedUsd: 1.5, totalGrantedUsd: 10 },
    });

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ source: 'apikey-telemetry', balance: 7.25 });
    const balancePatch = updateSetMock.mock.calls
      .map((call) => call[0])
      .find((patch) => patch && Object.prototype.hasOwnProperty.call(patch, 'balance'));
    expect(balancePatch).toMatchObject({ balance: 7.25, balanceUsed: 1.5, quota: 10 });
    expect(typeof balancePatch?.lastBalanceRefresh).toBe('string');
    expect(lastWrittenEvidence()).toMatchObject({ status: 'known', source: 'apikey-telemetry' });
  });

  it('session 鉴权失败：写 unavailable/endpoint-unauthorized，且先证据后健康', async () => {
    arrange(baseAccount(), baseSite());
    adapterMock.getBalance.mockRejectedValueOnce(new Error('HTTP 401: access token required'));

    const { refreshBalance } = await import('./balanceService.js');
    await expect(refreshBalance(1)).rejects.toThrow('access token');

    expect(lastWrittenEvidence()).toMatchObject({
      status: 'unavailable',
      reason: 'endpoint-unauthorized',
      source: 'session',
    });
    expect(balanceWasWritten()).toBe(false);
    // 顺序硬约束：证据落库必须发生在健康状态写入之前
    expect(writeJournal.indexOf('db')).toBeGreaterThanOrEqual(0);
    expect(writeJournal.indexOf('db')).toBeLessThan(writeJournal.indexOf('health'));
  });

  it('session 上游无余额接口：写 not-applicable 且不写 balance', async () => {
    arrange(baseAccount(), baseSite());
    adapterMock.getBalance.mockResolvedValueOnce({ unsupported: true, unsupportedReason: 'no balance api' });

    const { refreshBalance } = await import('./balanceService.js');
    const result = await refreshBalance(1);

    expect(result).toMatchObject({ skipped: true, reason: 'balance_unsupported' });
    expect(lastWrittenEvidence()).toMatchObject({
      status: 'not-applicable',
      reason: 'no-capable-source',
      source: 'session',
    });
    expect(balanceWasWritten()).toBe(false);
  });

  it('session 成功：证据并入余额那次写入，写 known/session', async () => {
    arrange(baseAccount(), baseSite());
    adapterMock.getBalance.mockResolvedValueOnce({ balance: 9.5, used: 0.5, quota: 10 });

    const { refreshBalance } = await import('./balanceService.js');
    await refreshBalance(1);

    const balancePatch = updateSetMock.mock.calls
      .map((call) => call[0])
      .find((patch) => patch && Object.prototype.hasOwnProperty.call(patch, 'balance'));
    expect(balancePatch).toMatchObject({ balance: 9.5, balanceUsed: 0.5, quota: 10 });
    // 成功路径不额外读写一次库：证据就在这一次 update 里
    expect(getBalanceEvidenceFromExtraConfig(balancePatch?.extraConfig as string)).toMatchObject({
      status: 'known',
      source: 'session',
    });
  });
});
