import { describe, expect, it } from 'vitest';
import { balanceUnavailableHint, isBalanceNeverRead, isUnlimitedQuota } from './balanceAvailability.js';

/**
 * 余额可得性判据的单测（F8）。
 *
 * 两条判据的优先级不是随手排的，每条都有现场依据（见 helpers/balanceAvailability.ts 注释）：
 * 成功时间戳压过一切 → 服务端证据 → 都没有就按"没读到"。
 * 这里把顺序与边界钉死，避免以后"顺手把证据提到最前面"而悄悄改变判据。
 */

describe('isBalanceNeverRead', () => {
  it('有成功时间戳就一定算读到过（哪怕证据说上次失败）', () => {
    expect(isBalanceNeverRead({
      lastBalanceRefresh: '2026-11-12T08:00:00.000Z',
      balanceEvidence: { status: 'unavailable', reason: 'all-sources-failed' },
    })).toBe(false);
  });

  it('证据 known 算读到过', () => {
    expect(isBalanceNeverRead({ lastBalanceRefresh: null, balanceEvidence: { status: 'known' } })).toBe(false);
  });

  it('证据 unavailable / not-applicable 都算没读到', () => {
    expect(isBalanceNeverRead({ balanceEvidence: { status: 'unavailable' } })).toBe(true);
    expect(isBalanceNeverRead({ balanceEvidence: { status: 'not-applicable', reason: 'unlimited-quota' } })).toBe(true);
  });

  it('什么都没有时按没读到处理（非零金额仍会照常显示）', () => {
    expect(isBalanceNeverRead({})).toBe(true);
    expect(isBalanceNeverRead(null)).toBe(true);
    expect(isBalanceNeverRead(undefined)).toBe(true);
    // 空字符串时间戳与 null 等价（老数据里出现过 ""）
    expect(isBalanceNeverRead({ lastBalanceRefresh: '' })).toBe(true);
  });

  it('runtimeHealth 不参与判据：凭证过期不等于余额读到了', () => {
    // 用 as any 传旧字段，钉死"多传的字段不影响结论"
    expect(isBalanceNeverRead({ runtimeHealth: { state: 'unhealthy', source: 'auth' } } as never)).toBe(true);
    expect(isBalanceNeverRead({ runtimeHealth: { state: 'healthy', source: 'balance' } } as never)).toBe(true);
  });
});

describe('balanceUnavailableHint', () => {
  it('按原因码给出具体说明', () => {
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'not-applicable', reason: 'unlimited-quota' } }))
      .toBe('无限配额，不受额度约束');
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'not-applicable', reason: 'no-capable-source' } }))
      .toBe('该站点不提供余额接口');
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'unavailable', reason: 'endpoint-unauthorized' } }))
      .toBe('鉴权失败，未能读取余额');
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'unavailable', reason: 'endpoint-unreachable' } }))
      .toBe('上游不可达，未能读取余额');
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'unavailable', reason: 'malformed-payload' } }))
      .toBe('上游返回的数据无法解析');
  });

  it('未知原因码回落通用文案，不猜具体故障', () => {
    expect(balanceUnavailableHint({ balanceEvidence: { status: 'unavailable', reason: 'sentinel-limit' } }))
      .toBe('尚未读取到余额');
    expect(balanceUnavailableHint({})).toBe('尚未读取到余额');
  });
});

describe('isUnlimitedQuota', () => {
  it('只认 not-applicable + unlimited-quota', () => {
    expect(isUnlimitedQuota({ balanceEvidence: { status: 'not-applicable', reason: 'unlimited-quota' } })).toBe(true);
    expect(isUnlimitedQuota({ balanceEvidence: { status: 'not-applicable', reason: 'no-capable-source' } })).toBe(false);
    expect(isUnlimitedQuota({ balanceEvidence: { status: 'known' } })).toBe(false);
    expect(isUnlimitedQuota(null)).toBe(false);
  });
});
