import { describe, expect, it } from 'vitest';
import { extractStatusBillingInfo } from './siteBillingProfileService.js';

/**
 * /api/status 计费信息提取（T8.4 / A3 取证回归）。
 * fixture 形态取自 2026-11-08 VPS 对 siteC 的实测响应。
 */

describe('extractStatusBillingInfo', () => {
  it('siteC 实测形态：price 优先于 stripe_unit_price', () => {
    const result = extractStatusBillingInfo({
      price: 7.3,
      stripe_unit_price: 8,
      usd_exchange_rate: 7.3,
      quota_per_unit: 500000,
      display_in_currency: true,
    });
    // 两个候选同为 7.3，但首选命中即止；stripe=8 是干扰项，绝不能被采用
    expect(result.cnyPerUsd).toBe(7.3);
    expect(result.rateFieldName).toBe('price');
    expect(result.quotaPerUnit).toBe(500000);
  });

  it('price 缺失时依次退到 stripe、PaymentUSDRate、usd_exchange_rate', () => {
    expect(extractStatusBillingInfo({ stripe_unit_price: 8 }).cnyPerUsd).toBe(8);
    expect(extractStatusBillingInfo({ PaymentUSDRate: '6.9' }).cnyPerUsd).toBe(6.9);
    expect(extractStatusBillingInfo({ usd_exchange_rate: 7 }).cnyPerUsd).toBe(7);
  });

  it('全缺失返回 null —— 绝不回退猜测汇率（R7）', () => {
    const result = extractStatusBillingInfo({ system_name: 'x' });
    expect(result.cnyPerUsd).toBeNull();
    expect(result.quotaPerUnit).toBeNull();
    expect(extractStatusBillingInfo(null).cnyPerUsd).toBeNull();
    expect(extractStatusBillingInfo(undefined).cnyPerUsd).toBeNull();
  });

  it('零与负值视为无效（不是"免费汇率"）', () => {
    expect(extractStatusBillingInfo({ price: 0 }).cnyPerUsd).toBeNull();
    expect(extractStatusBillingInfo({ price: -7 }).cnyPerUsd).toBeNull();
    expect(extractStatusBillingInfo({ quota_per_unit: 0 }).quotaPerUnit).toBeNull();
  });

  it('异常标尺不入库：合法区间外的 quota_per_unit 视为不可信', () => {
    expect(extractStatusBillingInfo({ quota_per_unit: 7 }).quotaPerUnit).toBeNull();
    expect(extractStatusBillingInfo({ quota_per_unit: 1e12 }).quotaPerUnit).toBeNull();
    expect(extractStatusBillingInfo({ quota_per_unit: 1_000_000 }).quotaPerUnit).toBe(1_000_000);
  });

  it('数字字符串可用（上游偶发字符串序列化）', () => {
    expect(extractStatusBillingInfo({ price: '7.3' }).cnyPerUsd).toBe(7.3);
    expect(extractStatusBillingInfo({ quota_per_unit: '500000' }).quotaPerUnit).toBe(500000);
  });
});
