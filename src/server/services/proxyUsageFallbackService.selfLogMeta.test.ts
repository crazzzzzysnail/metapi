import { describe, expect, it } from 'vitest';
import { parseSelfLogBillingMeta } from './proxyUsageFallbackService.js';

/**
 * D12 修复：self-log 计费元数据不得伪造倍率。
 *
 * 旧实现的三处方向性错误：
 *   ① `normalizePositiveRatio(x, 1)` —— 上游没给字段时填 1，把"不知道"变成"确定是 1×"；
 *   ② `hasMeaningfulData` 用 `ratio !== 1` 判定 —— 真实给的 1 被当成"没数据"，
 *      而伪造出来的 1 又因等于默认值而被判为"没数据"，两个方向都错；
 *   ③ 覆盖存在时完全跳过定价目录 —— 日志里的比率盖掉目录中的真实分组倍率
 *     （实测 siteA 各分组 ×0.15、siteB default ×2）。
 *
 * 本文件锁 ①②；③ 由 modelPricingService 的优先级测试覆盖。
 */

describe('缺失字段不再兜底成 1', () => {
  it('只有缓存量时：比率全部缺省，不出现 modelRatio: 1', () => {
    const meta = parseSelfLogBillingMeta({ cache_tokens: 5_000 });
    expect(meta).not.toBeNull();
    expect(meta!.cacheReadTokens).toBe(5_000);
    // 关键：这三个键根本不该存在
    expect('modelRatio' in meta!).toBe(false);
    expect('completionRatio' in meta!).toBe(false);
    expect('groupRatio' in meta!).toBe(false);
  });

  it('空对象没有任何信息 → null（而不是全 1 的假元数据）', () => {
    expect(parseSelfLogBillingMeta({})).toBeNull();
    expect(parseSelfLogBillingMeta('')).toBeNull();
    expect(parseSelfLogBillingMeta(null)).toBeNull();
    expect(parseSelfLogBillingMeta('not json')).toBeNull();
  });

  it('显式给出的 1 必须保留（倍率恰为 1 是合法真实值）', () => {
    const meta = parseSelfLogBillingMeta({ model_ratio: 1, completion_ratio: 1 });
    expect(meta).not.toBeNull();
    expect(meta!.modelRatio).toBe(1);
    expect(meta!.completionRatio).toBe(1);
  });

  it('0 是合法值且与"缺失"可区分', () => {
    const meta = parseSelfLogBillingMeta({ model_ratio: 0 });
    expect(meta).not.toBeNull();
    expect(meta!.modelRatio).toBe(0);
  });

  it('负数与非数值视为未提供', () => {
    expect(parseSelfLogBillingMeta({ model_ratio: -1 })).toBeNull();
    expect(parseSelfLogBillingMeta({ model_ratio: 'abc' })).toBeNull();
    // 但只要另有有效信息就仍返回 meta，且坏字段留空而非填 1
    const mixed = parseSelfLogBillingMeta({ model_ratio: -1, cache_tokens: 100 });
    expect(mixed).not.toBeNull();
    expect('modelRatio' in mixed!).toBe(false);
  });
});

describe('真实形态还原', () => {
  it('new-api self-log 常见形态：带完整比率', () => {
    const meta = parseSelfLogBillingMeta({
      model_ratio: 2.5,
      completion_ratio: 6,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
      group_ratio: 0.7,
      cache_tokens: 4_000,
      cache_creation_tokens: 1_000,
    });
    expect(meta).toMatchObject({
      modelRatio: 2.5,
      completionRatio: 6,
      cacheRatio: 0.1,
      cacheCreationRatio: 1.25,
      groupRatio: 0.7,
      cacheReadTokens: 4_000,
      cacheCreationTokens: 1_000,
      promptTokensIncludeCache: true,
    });
  });

  it('驼峰与下划线两种键名都吃', () => {
    const snake = parseSelfLogBillingMeta({ model_ratio: 3 });
    const camel = parseSelfLogBillingMeta({ modelRatio: 3 });
    expect(snake!.modelRatio).toBe(3);
    expect(camel!.modelRatio).toBe(3);
  });

  it('JSON 字符串输入同样解析', () => {
    const meta = parseSelfLogBillingMeta(JSON.stringify({ model_ratio: 2, cache_tokens: 9 }));
    expect(meta!.modelRatio).toBe(2);
    expect(meta!.cacheReadTokens).toBe(9);
  });
});
