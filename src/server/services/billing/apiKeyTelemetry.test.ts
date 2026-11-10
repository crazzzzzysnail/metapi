import { describe, expect, it, vi } from 'vitest';
import {
  adoptByPriority,
  queryApiKeyTelemetry,
} from './apiKeyTelemetryService.js';
import {
  parseNewApiTokenUsage,
  parseOpenAiBillingUsage,
  parseSub2ApiUsage,
} from './apiKeyTelemetryParsers.js';
import { toFiniteNonNegative, toFinitePositive } from './balanceSources.js';

/**
 * S5d API-key 余额遥测（T7.7）。
 *
 * 载荷形态取自 2026-11-08 对真实上游 siteC 的实测响应
 * （字段名与类型一致，数值为脱敏后的同量级替身）。
 * 核心要守住的不是"算得出来"，而是**不该给数字时绝不给**。
 */

const QUOTA_PER_UNIT = 500_000;

/**
 * 数值解析的最底层判据。
 * `Number('') === 0`、`Number(null) === 0` —— 若不做前置缺省判定，
 * "上游没给字段"会塌成"给了 0"，余额显示成 $0.00 并误触预警。
 * 这组断言是那条修复的唯一守卫（曾出现变异后测试仍全绿的情况）。
 */
describe('parseFinite 语义（缺省 ≠ 0）', () => {
  it('null / undefined / 空串 / 纯空白一律视为缺省', () => {
    expect(toFiniteNonNegative(undefined)).toBeUndefined();
    expect(toFiniteNonNegative(null)).toBeUndefined();
    expect(toFiniteNonNegative('')).toBeUndefined();
    expect(toFiniteNonNegative('   ')).toBeUndefined();
    expect(toFinitePositive('')).toBeUndefined();
    expect(toFinitePositive(null)).toBeUndefined();
  });

  it('真正的 0 必须保留（已用尽与不知道是两件事）', () => {
    expect(toFiniteNonNegative(0)).toBe(0);
    expect(toFiniteNonNegative('0')).toBe(0);
    // 但 0 不是"正数"
    expect(toFinitePositive(0)).toBeUndefined();
  });

  it('正常数值与数字字符串都可用', () => {
    expect(toFiniteNonNegative(42)).toBe(42);
    expect(toFiniteNonNegative('7.3')).toBe(7.3);
    expect(toFinitePositive(1e6)).toBe(1e6);
  });

  it('负数与非数值拒绝', () => {
    expect(toFiniteNonNegative(-5)).toBeUndefined();
    expect(toFiniteNonNegative('abc')).toBeUndefined();
    expect(toFiniteNonNegative({})).toBeUndefined();
    expect(toFiniteNonNegative(Number.NaN)).toBeUndefined();
  });
});

describe('parseNewApiTokenUsage', () => {
  it('有限额度：按站点标尺换算成美元', () => {
    const result = parseNewApiTokenUsage({
      data: {
        object: 'token_usage',
        unlimited_quota: false,
        total_granted: 25_000_000,
        total_used: 5_000_000,
        total_available: 20_000_000,
        expires_at: -1,
      },
    }, QUOTA_PER_UNIT);

    expect(result.balanceUsd).toBe(40);
    expect(result.totalUsedUsd).toBe(10);
    expect(result.totalGrantedUsd).toBe(50);
    expect(result.evidence.source).toBe('apikey-token-usage');
    // 额度换算涉及除法与上游取整 → approximate，不冒充精确价
    expect(result.evidence.precision).toBe('approximate');
  });

  it('unlimited_quota=true 时不得产出金额（实测会算出负余额）', () => {
    // 这是真实观测到的形态：granted 只有 1 位数、available 极大
    const result = parseNewApiTokenUsage({
      data: {
        unlimited_quota: true,
        total_granted: 0,
        total_used: 15_463_194,
        total_available: 15_463_194,
        name: 'API',
        object: 'token_usage',
      },
    }, QUOTA_PER_UNIT);

    expect(result.unlimitedQuota).toBe(true);
    // 关键三条断言
    expect(result.balanceUsd).toBeUndefined();
    expect(result.totalGrantedUsd).toBeUndefined();
    expect(result.evidence.reason).toBe('unlimited-quota');
    // 已用量仍可信，保留它
    expect(typeof result.totalUsedUsd).toBe('number');
  });

  it('total_granted 为负也视为无限（hub 侧同判据）', () => {
    const result = parseNewApiTokenUsage({
      data: { total_granted: -1, total_used: 100, total_available: 0 },
    }, QUOTA_PER_UNIT);
    expect(result.unlimitedQuota).toBe(true);
    expect(result.balanceUsd).toBeUndefined();
  });

  it('payload 畸形返回 unknown，而不是 0', () => {
    const result = parseNewApiTokenUsage({ data: {} }, QUOTA_PER_UNIT);
    expect(result.evidence.precision).toBe('unknown');
    expect(result.evidence.reason).toBe('malformed-payload');
    expect(result.balanceUsd).toBeUndefined();
  });

  it('expires_at 秒级时间戳归一为毫秒', () => {
    const result = parseNewApiTokenUsage({
      data: { unlimited_quota: false, total_granted: 100, total_used: 0, total_available: 100, expires_at: 1_800_000_000 },
    }, QUOTA_PER_UNIT);
    expect(result.expiresAtMs).toBe(1_800_000_000_000);
  });

  it('标尺非法时不换算（拒绝用猜测标尺出数）', () => {
    const result = parseNewApiTokenUsage({
      data: { unlimited_quota: false, total_granted: 1e6, total_used: 0, total_available: 1e6 },
    }, 0);
    expect(result.balanceUsd).toBeUndefined();
  });
});

describe('parseOpenAiBillingUsage', () => {
  it('哨兵上限（≥1e6）不得当成可用余额 —— 实测三个 limit 字段全是这个量级', () => {
    const result = parseOpenAiBillingUsage(
      {
        object: 'billing_subscription',
        hard_limit_usd: 1_000_000_000,
        soft_limit_usd: 1_000_000_000,
        system_hard_limit_usd: 1_000_000_000,
        has_payment_method: false,
      },
      { object: 'billing_usage', total_usage: 123_400 },
    );

    // 若不过滤，这里会显示"还剩十亿美元"
    expect(result.balanceUsd).toBeUndefined();
    expect(result.evidence.reason).toBe('sentinel-limit');
    // total_usage 是美分：123400 → $1234.00
    expect(result.totalUsedUsd).toBe(1234);
  });

  it('真实有限额度才计算 balance = hard_limit - used', () => {
    const result = parseOpenAiBillingUsage(
      { hard_limit_usd: 100 },
      { total_usage: 2_500 },   // 25 美元
    );
    expect(result.balanceUsd).toBe(75);
    expect(result.totalGrantedUsd).toBe(100);
    expect(result.totalUsedUsd).toBe(25);
  });

  it('sub.balance 直给美元时优先采用并标 exact', () => {
    const result = parseOpenAiBillingUsage({ balance: 42 }, {});
    expect(result.balanceUsd).toBe(42);
    expect(result.evidence.precision).toBe('exact');
  });

  it('used_usd 作为 total_usage 的替代字段', () => {
    const result = parseOpenAiBillingUsage({ hard_limit_usd: 50 }, { used_usd: 10 });
    expect(result.totalUsedUsd).toBe(10);
    expect(result.balanceUsd).toBe(40);
  });

  it('两端点都无有效字段 → unknown', () => {
    const result = parseOpenAiBillingUsage({}, {});
    expect(result.evidence.precision).toBe('unknown');
  });
});

describe('parseSub2ApiUsage', () => {
  it('只认明确美元语义的字段', () => {
    const result = parseSub2ApiUsage({ balance_usd: 10, used_usd: 2 });
    expect(result.balanceUsd).toBe(10);
    expect(result.totalUsedUsd).toBe(2);
  });

  it('量纲不明的裸 balance 一律不采信（避免把额度当美元）', () => {
    const result = parseSub2ApiUsage({ balance: 5_000_000 });
    expect(result.balanceUsd).toBeUndefined();
    expect(result.evidence.precision).toBe('unknown');
  });
});

describe('adoptByPriority（R14：session 优先，冲突不合并）', () => {
  const monetary = (source: string, balanceUsd: number) => ({
    balanceUsd,
    evidence: { source, precision: 'exact', capturedAt: 1 },
  }) as never;

  it('session 与 apikey 并存时采纳 session', () => {
    const adopted = adoptByPriority([
      monetary('apikey-token-usage', 40),
      monetary('session-user-self', 683),
    ]);
    expect(adopted?.balanceUsd).toBe(683);
    expect(adopted?.evidence.source).toBe('session-user-self');
  });

  it('不做任何数值合并（不平均、不取大、不相加）', () => {
    const adopted = adoptByPriority([
      monetary('session-user-self', 100),
      monetary('apikey-token-usage', 5),
    ]);
    expect(adopted?.balanceUsd).toBe(100);
  });

  it('session 没有金额信息时退到下一优先级', () => {
    const adopted = adoptByPriority([
      { evidence: { source: 'session-user-self', precision: 'unknown', reason: 'endpoint-unreachable', capturedAt: 1 } } as never,
      monetary('apikey-token-usage', 40),
    ]);
    expect(adopted?.balanceUsd).toBe(40);
  });

  it('全部无金额时仍返回优先级最高的一条（它的 reason 有诊断价值）', () => {
    const adopted = adoptByPriority([
      { evidence: { source: 'apikey-openai-billing', precision: 'unknown', reason: 'sentinel-limit', capturedAt: 1 } } as never,
      { evidence: { source: 'apikey-token-usage', precision: 'approximate', reason: 'unlimited-quota', capturedAt: 1 } } as never,
    ]);
    expect(adopted?.evidence.source).toBe('apikey-token-usage');
  });

  it('空输入返回 null', () => {
    expect(adoptByPriority([])).toBeNull();
  });
});

describe('queryApiKeyTelemetry 端点选择', () => {
  function makeFetchJson(responder: (url: string) => unknown) {
    return vi.fn(async (url: string) => responder(url));
  }

  it('new-api 家族同时尝试 token usage 与 OpenAI 兼容端点', async () => {
    const fetchJson = makeFetchJson((url) => {
      if (url.includes('/api/usage/token/')) {
        return { data: { unlimited_quota: false, total_granted: 1e6, total_used: 0, total_available: 1e6 } };
      }
      if (url.includes('/v1/dashboard/billing/subscription')) return { hard_limit_usd: 1e9 };
      if (url.includes('/v1/dashboard/billing/usage')) return { total_usage: 0 };
      throw new Error('unexpected url');
    });

    const results = await queryApiKeyTelemetry({
      baseUrl: 'https://gateway.example.com',
      platform: 'new-api',
      apiKey: 'sk-test-value-not-logged',
      quotaPerUnit: QUOTA_PER_UNIT,
      fetchJson,
    });

    const sources = results.map((r) => r.evidence.source);
    expect(sources).toContain('apikey-token-usage');
    expect(sources).toContain('apikey-openai-billing');
  });

  it('非 sub2api 平台不打 /v1/usage', async () => {
    const fetchJson = makeFetchJson(() => ({ data: { unlimited_quota: true, total_used: 0 } }));
    await queryApiKeyTelemetry({
      baseUrl: 'https://gateway.example.com',
      platform: 'new-api',
      apiKey: 'sk-x',
      quotaPerUnit: QUOTA_PER_UNIT,
      fetchJson,
    });
    const calledUrls = fetchJson.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.endsWith('/v1/usage'))).toBe(false);
  });

  it('密钥不出现在任何返回对象里（防泄漏到日志/UI）', async () => {
    const secret = 'sk-super-secret-do-not-log';
    const fetchJson = makeFetchJson(() => { throw new Error('HTTP 401'); });
    const results = await queryApiKeyTelemetry({
      baseUrl: 'https://gateway.example.com',
      platform: 'new-api',
      apiKey: secret,
      quotaPerUnit: QUOTA_PER_UNIT,
      fetchJson,
    });
    for (const observation of results) {
      expect(JSON.stringify(observation)).not.toContain(secret);
    }
  });

  it('401 归类为 endpoint-unauthorized，网络错误归类为 endpoint-unreachable', async () => {
    const unauthorized = await queryApiKeyTelemetry({
      baseUrl: 'https://gateway.example.com',
      platform: 'new-api',
      apiKey: 'k',
      quotaPerUnit: QUOTA_PER_UNIT,
      fetchJson: makeFetchJson(() => { throw new Error('HTTP 401'); }),
    });
    expect(unauthorized.every((o) => o.evidence.reason === 'endpoint-unauthorized')).toBe(true);

    const unreachable = await queryApiKeyTelemetry({
      baseUrl: 'https://gateway.example.com',
      platform: 'new-api',
      apiKey: 'k',
      quotaPerUnit: QUOTA_PER_UNIT,
      fetchJson: makeFetchJson(() => { throw new Error('ECONNREFUSED'); }),
    });
    expect(unreachable.every((o) => o.evidence.reason === 'endpoint-unreachable')).toBe(true);
  });
});
