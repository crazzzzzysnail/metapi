/**
 * 跨站金额的逐站换算与排除（S6 / T8.7、T8.8）。
 *
 * R7 决议：**逐站换算，汇率未知的站点排除并提示数量**。
 * 本模块只做"求和 + 分类"这一件事，三个汇总点（仪表盘快照、站点统计快照、
 * 站点列表）共用同一实现，避免各自写一套导致同屏数字对不上。
 *
 * 口径约定（用户确认的"双轨"）：
 *   - `usdTotal` 永远保留原始美元合计，**不因货币开关改变**；
 *   - `cnyTotal` 只累计汇率已知的站点；
 *   - `excludedSiteCount` 是被排除的站点数，前端必须显示出来——
 *     静默少算是把错误藏进"看起来正常"的数字里，比报错更糟。
 */

import { getQuotaScale } from './quotaScale.js';

export interface SiteUsdAmount {
  siteId: number;
  platform?: string | null;
  /** 该站点的美元金额（余额或花费，语义由调用方决定）。 */
  usd: number;
  /** 站点汇率档案里的 cny_per_usd；null/非法 = 未知。 */
  cnyPerUsd: number | null;
}

export interface CurrencySplitSummary {
  /** 全部站点的美元合计（含汇率未知站点，因为 USD 不需要汇率）。 */
  usdTotal: number;
  /** 仅汇率已知站点换算后的人民币合计。 */
  cnyTotal: number;
  /** 计入 CNY 合计的站点数。 */
  includedSiteCount: number;
  /** 因汇率未知被排除出 CNY 合计的站点数。 */
  excludedSiteCount: number;
  /** 被排除站点的名称/ID，供 UI 给出可操作的提示。 */
  excludedSites: Array<{ siteId: number; reason: 'rate-unknown' | 'rate-invalid' }>;
}

const MICRO = 1_000_000;

function roundMicro(value: number): number {
  return Math.round(value * MICRO) / MICRO;
}

/**
 * 逐站换算并分类。不做任何默认汇率兜底 —— 汇率缺失就是排除，不是猜。
 */
export function summarizeByCurrency(items: SiteUsdAmount[]): CurrencySplitSummary {
  let usdTotal = 0;
  let cnyTotal = 0;
  let includedSiteCount = 0;
  const excludedSites: CurrencySplitSummary['excludedSites'] = [];

  for (const item of items) {
    const usd = Number.isFinite(item.usd) ? item.usd : 0;
    // USD 合计始终纳入：换算不涉及汇率，缺汇率不影响美元准确性
    usdTotal += usd;

    const rate = Number(item.cnyPerUsd);
    if (!Number.isFinite(rate) || rate <= 0) {
      excludedSites.push({
        siteId: item.siteId,
        reason: item.cnyPerUsd === null || item.cnyPerUsd === undefined ? 'rate-unknown' : 'rate-invalid',
      });
      continue;
    }

    cnyTotal += usd * rate;
    includedSiteCount += 1;
  }

  return {
    usdTotal: roundMicro(usdTotal),
    cnyTotal: roundMicro(cnyTotal),
    includedSiteCount,
    excludedSiteCount: excludedSites.length,
    excludedSites,
  };
}

/**
 * 单站点金额换算（用于行内展示，不做合计）。
 * 返回 null 表示汇率未知，调用方必须显式标注而不是显示美元数加 ¥。
 */
export function convertSiteUsdToCny(
  usd: number,
  cnyPerUsd: number | null,
): number | null {
  const amount = Number(usd);
  const rate = Number(cnyPerUsd);
  if (!Number.isFinite(amount)) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return roundMicro(amount * rate);
}

/**
 * 取某站点的有效额度标尺：档案里的 quota_per_unit 优先，其次平台默认表。
 * （A9 的正解：标尺来自数据而不是硬编码分支。）
 */
export function resolveEffectiveQuotaScale(
  profileQuotaPerUnit: number | null | undefined,
  platform?: string | null,
): number {
  const explicit = Number(profileQuotaPerUnit);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return getQuotaScale(platform);
}
