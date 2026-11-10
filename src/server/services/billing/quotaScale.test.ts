/**
 * quotaScale 单元测试。
 * 覆盖标尺表、双向换算、倍率→USD/1M，以及未识别平台的回落口径。
 */
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_QUOTA_DEFAULTS,
  getQuotaScale,
  quotaToUsd,
  ratioToUsdPerMillion,
  tokensToUsd,
  usdDivisorSql,
  usdToQuota,
} from './quotaScale.js';

describe('quotaScale 标尺表', () => {
  it('new-api 系用 500_000，veloera 用 1_000_000', () => {
    expect(getQuotaScale('new-api')).toBe(500_000);
    expect(getQuotaScale('one-api')).toBe(500_000);
    expect(getQuotaScale('one-hub')).toBe(500_000);
    expect(getQuotaScale('done-hub')).toBe(500_000);
    expect(getQuotaScale('sub2api')).toBe(500_000);
    expect(getQuotaScale('veloera')).toBe(1_000_000);
  });

  it('平台名大小写与空白不敏感', () => {
    expect(getQuotaScale('VELOERA')).toBe(1_000_000);
    expect(getQuotaScale('  New-API ')).toBe(500_000);
  });

  it('未知与空平台回落到 new-api 口径（不得为 0，避免除零）', () => {
    expect(getQuotaScale('anyrouter')).toBe(500_000);
    expect(getQuotaScale(null)).toBe(500_000);
    expect(getQuotaScale(undefined)).toBe(500_000);
    expect(getQuotaScale('')).toBe(500_000);
    for (const scale of Object.values(PLATFORM_QUOTA_DEFAULTS)) {
      expect(scale).toBeGreaterThan(0);
    }
  });
});

describe('quotaScale 额度与 USD 双向换算', () => {
  it('额度 → USD 按平台标尺', () => {
    expect(quotaToUsd(500_000, 'new-api')).toBe(1);
    expect(quotaToUsd(1_000_000, 'veloera')).toBe(1);
    expect(quotaToUsd(250_000, 'one-api')).toBe(0.5);
  });

  it('USD → 额度取整且负值归零', () => {
    expect(usdToQuota(1, 'new-api')).toBe(500_000);
    expect(usdToQuota(2, 'veloera')).toBe(2_000_000);
    expect(usdToQuota(-5, 'new-api')).toBe(0);
  });

  it('非有限输入一律按 0 处理', () => {
    expect(quotaToUsd(Number.NaN, 'new-api')).toBe(0);
    expect(quotaToUsd(null, 'new-api')).toBe(0);
    expect(quotaToUsd(undefined, 'new-api')).toBe(0);
    expect(usdToQuota(Number.POSITIVE_INFINITY, 'new-api')).toBe(0);
    expect(tokensToUsd(Number.NaN, 'veloera')).toBe(0);
  });

  it('token → USD 与额度 → USD 共用同一标尺', () => {
    expect(tokensToUsd(500_000, 'new-api')).toBe(1);
    expect(tokensToUsd(500_000, 'veloera')).toBe(0.5);
  });
});

describe('quotaScale 倍率换算', () => {
  it('new-api 系：1 倍率 = 2 USD / 1M token', () => {
    expect(ratioToUsdPerMillion(1, 'new-api')).toBe(2);
    expect(ratioToUsdPerMillion(7.5, 'new-api')).toBe(15);
    expect(ratioToUsdPerMillion(150, 'new-api')).toBe(300);
  });

  it('0 倍率保留为 0，不被伪造成正价', () => {
    expect(ratioToUsdPerMillion(0, 'new-api')).toBe(0);
    expect(ratioToUsdPerMillion(0, 'veloera')).toBe(0);
  });

  it('veloera 标尺下 1 倍率 = 1 USD / 1M token', () => {
    expect(ratioToUsdPerMillion(1, 'veloera')).toBe(1);
  });

  it('换算结果与历史 `ratio * 2` 写法在 new-api 系完全等价', () => {
    // 止血包不得改变既有价格数值，只改「谁拥有这个数字」。
    for (const ratio of [0, 0.5, 1, 7.5, 37.5, 150]) {
      expect(ratioToUsdPerMillion(ratio, 'new-api')).toBeCloseTo(ratio * 2, 10);
    }
  });

  it('负倍率与非法值归零', () => {
    expect(ratioToUsdPerMillion(-1, 'new-api')).toBe(0);
    expect(ratioToUsdPerMillion(Number.NaN, 'new-api')).toBe(0);
    expect(ratioToUsdPerMillion(null, 'new-api')).toBe(0);
  });
});

describe('quotaScale SQL 生成', () => {
  it('usdDivisorSql 返回正数标尺，供 Drizzle 参数化占位', () => {
    expect(usdDivisorSql('new-api')).toBe(500_000);
    expect(usdDivisorSql()).toBe(500_000);
  });
});
