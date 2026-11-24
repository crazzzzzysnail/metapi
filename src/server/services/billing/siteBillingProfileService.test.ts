import { describe, expect, it } from 'vitest';
import { extractStatusBillingInfo } from './siteBillingProfileService.js';

/**
 * /api/status 计费信息提取（T8.4 / A3 取证回归）。
 *
 * ⚠️ 语义订正（2026-11-22，上游源码确证）：
 *   这里提取的是 **充值价**（实付人民币 / 1 美元额度），不是官方汇率。
 *   new-api 源码：getTopUpQuota: quota = amount × QuotaPerUnit；
 *                 getPayMoney : payMoney = amount × Price
 *   ⇒ 实付人民币 / 美元额度 = Price。默认 7.3 与官方汇率同值，
 *   但站主可独立改（实测见过 1、0.005），改后两者分裂。
 *   `usd_exchange_rate` 是官方汇率、不是实付价，**刻意不在候选表**。
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
    // price 是站主定的实付价；stripe=8 是另一个支付通道的价，干扰项，绝不能被采用
    expect(result.cnyPerUsd).toBe(7.3);
    expect(result.rateFieldName).toBe('price');
    expect(result.quotaPerUnit).toBe(500000);
  });

  it('折扣站：price=1 就取 1，绝不被同响应里的官方汇率 7.3 覆盖', () => {
    // siteF 实测形态：站主把充值价定为 1（约官方价 1/7），官方汇率字段仍是 7.3
    const result = extractStatusBillingInfo({
      price: 1,
      stripe_unit_price: 8,
      usd_exchange_rate: 7.3,
      quota_per_unit: 500000,
    });
    expect(result.cnyPerUsd).toBe(1);
    expect(result.rateFieldName).toBe('price');
  });

  it('price 缺失时退到 PaymentUSDRate（done-hub 支付汇率），再退 stripe', () => {
    expect(extractStatusBillingInfo({ PaymentUSDRate: 6.9 }).cnyPerUsd).toBe(6.9);
    expect(extractStatusBillingInfo({ stripe_unit_price: 8 }).cnyPerUsd).toBe(8);
    // 两者同时存在时，语义更明确的 PaymentUSDRate 优先
    expect(
      extractStatusBillingInfo({ PaymentUSDRate: 6.9, stripe_unit_price: 8 }).rateFieldName,
    ).toBe('PaymentUSDRate');
  });

  it('只有官方汇率 usd_exchange_rate 时返回 null —— 它不是实付价，不得冒充（R7）', () => {
    // 这是本轮修复的核心：旧实现把官方汇率当实付价，导致人民币金额系统性偏大
    const result = extractStatusBillingInfo({ usd_exchange_rate: 7.3 });
    expect(result.cnyPerUsd).toBeNull();
    expect(result.rateFieldName).toBeNull();
  });

  it('上游展示口径归一：type 只认四种、symbol 空白为未提供、rate 仅正数', () => {
    // 这三列直接决定界面「上游 X」标注对不对，归一判据与手动覆盖共用同一套出口。
    const custom = extractStatusBillingInfo({
      quota_display_type: 'custom', // 小写也要认
      custom_currency_symbol: '\u3000', // （全角空格） = 未提供，不是符号
      custom_currency_exchange_rate: 10,
    });
    expect(custom.quotaDisplayType).toBe('CUSTOM');
    expect(custom.customCurrencySymbol).toBeNull();
    expect(custom.customCurrencyExchangeRate).toBe(10);
    // 非法口径值不得当成「看起来能用」的字符串入库
    expect(extractStatusBillingInfo({ quota_display_type: 'EURO' }).quotaDisplayType).toBeNull();
    // 0 / 负数倍率视为未知（不伪造一个可用倍率）
    expect(extractStatusBillingInfo({ custom_currency_exchange_rate: 0 }).customCurrencyExchangeRate).toBeNull();
  });

  it('符号只含零宽/方向标记/BOM/各类空白：判为未提供（测试内只用 \\u 转义，不写字面不可见字符）', () => {
    // 实测上游可能把符号填成单个空格或零宽字符 —— 这类"不能正常显示"的符号必须归 null，
    // 显示层才会退化成裸数字并提示手动补充，而不是画出一个看不见的"符号"。
    // 普通 String.trim() 去不掉 U+200B/U+3000/U+FEFF，所以必须显式列码点。
    // 源码级 \uXXXX 转义：文件内只有可见 ASCII，运行时即为该不可见字符本身。
    const blanks = ['\u0020', '\u3000', '\u200B', '\uFEFF', '\u2060', '\u00A0', '\u2000', '\u200F'];
    for (const blank of blanks) {
      expect(extractStatusBillingInfo({
        quota_display_type: 'CUSTOM', custom_currency_exchange_rate: 10, custom_currency_symbol: blank,
      }).customCurrencySymbol).toBeNull();
    }
    // 真符号（含 emoji、普通词）不得被误伤
    expect(extractStatusBillingInfo({ custom_currency_symbol: '能量' }).customCurrencySymbol).toBe('能量');
    expect(extractStatusBillingInfo({ custom_currency_symbol: '🍊' }).customCurrencySymbol).toBe('🍊');
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
