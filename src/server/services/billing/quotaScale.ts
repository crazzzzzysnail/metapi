/**
 * 额度标尺（quota scale）单一权威来源。
 *
 * 各上游平台把金额折算成整数「额度」时使用的除数并不一致：
 * new-api / one-api / one-hub / done-hub / sub2api 系用 500_000 额度 = 1 USD，
 * veloera 用 1_000_000 额度 = 1 USD。
 *
 * 历史上这些字面量散落在各平台适配器、余额服务、统计 SQL 里，导致同一份数据
 * 在不同链路上被换算两次或漏换算（例如 one-api/veloera 的 balance 双扣、
 * resolveModelSpend 对 veloera 恒定高估 2 倍）。本模块把标尺收敛为一张表，
 * 并要求业务代码只通过这里的函数做换算。
 */

/** 单个平台的额度标尺：1 USD 对应多少额度单位。 */
export type QuotaScale = number;

/**
 * 平台 → 额度标尺默认值。
 * key 统一使用小写平台名，与 sites.platform 的取值口径一致。
 */
export const PLATFORM_QUOTA_DEFAULTS: Record<string, QuotaScale> = {
  'new-api': 500_000,
  newapi: 500_000,
  'one-api': 500_000,
  oneapi: 500_000,
  'one-hub': 500_000,
  onehub: 500_000,
  'done-hub': 500_000,
  donehub: 500_000,
  sub2api: 500_000,
  veloera: 1_000_000,
};

/** 未识别平台沿用 new-api 系口径，避免误判为 0 造成除零。 */
const FALLBACK_QUOTA_SCALE = 500_000;

/**
 * 取某个平台的额度标尺。
 * 大小写不敏感；未知平台回落到 500_000（new-api 系默认口径）。
 */
export function getQuotaScale(platform?: string | null): QuotaScale {
  const key = (platform || '').trim().toLowerCase();
  return PLATFORM_QUOTA_DEFAULTS[key] ?? FALLBACK_QUOTA_SCALE;
}

/** 额度单位 → USD。非有限值按 0 处理。 */
export function quotaToUsd(quota: number | null | undefined, platform?: string | null): number {
  const value = Number(quota);
  if (!Number.isFinite(value)) return 0;
  return value / getQuotaScale(platform);
}

/** USD → 额度单位。负值归零，结果取整（额度是整数域）。 */
export function usdToQuota(usd: number | null | undefined, platform?: string | null): number {
  const value = Number(usd);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * getQuotaScale(platform));
}

/** 总 token 数 → USD 的粗粒度兜底换算（只在拿不到任何价格证据时使用）。 */
export function tokensToUsd(tokens: number | null | undefined, platform?: string | null): number {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value / getQuotaScale(platform);
}

/**
 * 模型倍率 → 每百万 token 单价（USD）。
 *
 * 推导：New API 系按 `总 token × model_ratio × group_ratio` 扣额度，
 * 且 500_000 额度 = 1 USD。故 1M token 在 ratio=1 时扣 1_000_000 额度 = 2 USD。
 * 换算式统一写成 `ratio × 1e6 / 标尺`：
 *   - new-api 系（标尺 500_000）→ `ratio × 2`
 *   - veloera（标尺 1_000_000）→ `ratio × 1`
 * 这是标尺唯一允许以代数形式参与的地方，源码中不得再出现裸乘数 `* 2`。
 */
export function ratioToUsdPerMillion(
  ratio: number | null | undefined,
  platform?: string | null,
): number {
  const value = Number(ratio);
  if (!Number.isFinite(value) || value < 0) return 0;
  return value * (1_000_000 / getQuotaScale(platform));
}
/**
 * 生成统计 SQL 里的额度→USD 除数。
 * Drizzle 的 sql 模板会把数值参数化成占位符，因此调用方需写成 `... / ${usdDivisorSql()}`。
 */
export function usdDivisorSql(platform?: string | null): number {
  return getQuotaScale(platform);
}
