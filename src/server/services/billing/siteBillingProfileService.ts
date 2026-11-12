/**
 * 站点计费参数探测与持久化（S6 / T8.4）。
 *
 * 探测来源全部来自取证（A3，2026-11-08 VPS 实测 siteC）：
 *   `/api/status` → `price`（首选）、`stripe_unit_price`、`usd_exchange_rate`；
 *   `quota_per_unit` 直接给出额度标尺（siteC = 500000），优先于平台默认表。
 *
 * 诚实性约定（R7 / 决策"失败即留空，不写默认值"）：
 *   - 探测不到汇率就留 null，**绝不回退 7.2 之类的猜测值**；
 *   - 用户手动覆盖（manual）永远优先于自动探测（auto）；
 *   - 展示层读到 null 必须说"汇率未知"，不得显示换算后的数字。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { clearSnapshotCache, readSnapshotCache } from '../snapshotCacheService.js';

export interface SiteBillingProfileRow {
  siteId: number;
  quotaPerUnit: number | null;
  cnyPerUsd: number | null;
  quotaSource: 'auto' | 'manual' | null;
  rateSource: 'auto' | 'manual' | null;
  capturedAt: string | null;
}

/** 候选汇率字段，按取证确认的优先级排列（hub 顺序 + 本站点实测补充）。 */
const RATE_FIELD_CANDIDATES = ['price', 'stripe_unit_price', 'PaymentUSDRate', 'usd_exchange_rate'] as const;

function toFinitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 从 /api/status 的 data 里提取汇率与标尺。
 * 纯函数，便于单测直接喂真实响应片段。
 */
export function extractStatusBillingInfo(data: Record<string, unknown> | null | undefined): {
  cnyPerUsd: number | null;
  rateFieldName: string | null;
  quotaPerUnit: number | null;
} {
  let cnyPerUsd: number | null = null;
  let rateFieldName: string | null = null;
  for (const field of RATE_FIELD_CANDIDATES) {
    const v = toFinitePositive(data?.[field]);
    if (v !== null) {
      cnyPerUsd = v;
      rateFieldName = field;
      break;
    }
  }

  // quota_per_unit 合法范围钳制：正常只有 500k / 1M，异常值宁可不存
  const rawQuota = toFinitePositive(data?.quota_per_unit);
  const quotaPerUnit = rawQuota !== null && rawQuota >= 1_000 && rawQuota <= 100_000_000 ? rawQuota : null;

  return { cnyPerUsd, rateFieldName, quotaPerUnit };
}

async function fetchSiteStatus(
  baseUrl: string,
  requestInit: (url: string, init?: UndiciRequestInit) => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const payload = await requestInit(`${baseUrl}/api/status`) as any;
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
    return data && typeof data === 'object' ? data as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * 读取某站点的计费档案；没有行时返回全 null（= 未知），不伪造。
 */
export async function getSiteBillingProfile(siteId: number): Promise<SiteBillingProfileRow> {
  const row = await db.select().from(schema.siteBillingProfiles)
    .where(eq(schema.siteBillingProfiles.siteId, siteId)).get();
  return {
    siteId,
    quotaPerUnit: row?.quotaPerUnit ?? null,
    cnyPerUsd: row?.cnyPerUsd ?? null,
    quotaSource: (row?.quotaSource as 'auto' | 'manual' | null) ?? null,
    rateSource: (row?.rateSource as 'auto' | 'manual' | null) ?? null,
    capturedAt: row?.capturedAt ?? null,
  };
}

/**
 * 自动探测并合并写库。规则：
 *   - manual 来源的值不被 auto 覆盖；
 *   - 探测失败的字段保持原状（包括保持 null），不会写入猜测值。
 */
export async function probeAndPersistSiteBillingProfile(
  site: { id: number; url: string },
  requestJson: (url: string, init?: UndiciRequestInit) => Promise<unknown>,
): Promise<SiteBillingProfileRow> {
  const normalizedBase = (site.url || '').replace(/\/+$/, '');
  const statusData = await fetchSiteStatus(normalizedBase, requestJson);
  const extracted = extractStatusBillingInfo(statusData);

  const existing = await db.select().from(schema.siteBillingProfiles)
    .where(eq(schema.siteBillingProfiles.siteId, site.id)).get();

  const next: typeof schema.siteBillingProfiles.$inferInsert = { siteId: site.id };

  if (extracted.cnyPerUsd !== null && existing?.rateSource !== 'manual') {
    next.cnyPerUsd = extracted.cnyPerUsd;
    next.rateSource = 'auto';
  }
  if (extracted.quotaPerUnit !== null && existing?.quotaSource !== 'manual') {
    next.quotaPerUnit = extracted.quotaPerUnit;
    next.quotaSource = 'auto';
  }
  // 至少探到过一项才刷新时间戳；全失败不动已有 capturedAt
  if (next.cnyPerUsd !== undefined || next.quotaPerUnit !== undefined) {
    next.capturedAt = new Date().toISOString();
  }

  if (Object.keys(next).length > 1) {
    await db.insert(schema.siteBillingProfiles)
      .values(next as any)
      .onConflictDoUpdate({ target: schema.siteBillingProfiles.siteId, set: next as any })
      .run();
  }

  // 汇率/标尺一变，全站金额显示就得重算：让轻量端点的缓存立刻作废，
  // 否则用户填完要等最多 60 秒才看到变化，会被当成"设置没生效"。
  invalidateSiteCurrencyRatesCache();

  return getSiteBillingProfile(site.id);
}

/** 用户手动维护入口（站点编辑弹窗用）。传 null 表示清除覆盖、回到未知。 */
export async function setManualBillingOverrides(input: {
  siteId: number;
  cnyPerUsd?: number | null;
  quotaPerUnit?: number | null;
}): Promise<SiteBillingProfileRow> {
  const patch: Record<string, unknown> = { siteId: input.siteId };

  if (input.cnyPerUsd !== undefined) {
    const v = input.cnyPerUsd === null ? null : toFinitePositive(input.cnyPerUsd);
    patch.cnyPerUsd = v;
    patch.rateSource = v === null ? null : 'manual';
  }
  if (input.quotaPerUnit !== undefined) {
    const v = input.quotaPerUnit === null ? null : toFinitePositive(input.quotaPerUnit);
    patch.quotaPerUnit = v;
    patch.quotaSource = v === null ? null : 'manual';
  }

  await db.insert(schema.siteBillingProfiles)
    .values(patch as any)
    .onConflictDoUpdate({ target: schema.siteBillingProfiles.siteId, set: patch as any })
    .run();

  // 同上：手动覆盖也要让汇率缓存作废。
  invalidateSiteCurrencyRatesCache();

  return getSiteBillingProfile(input.siteId);
}

/**
 * 全站汇率档案的轻量读取（B1）。
 *
 * 为什么单独开一个入口而不是让前端搭 `/api/sites` 的便车：
 *   显示币种换算只需要 `{siteId, cnyPerUsd}` 两个数，而站点表里带着
 *   url / api_key / extra_config / custom_headers 等大字段。为了让金额
 *   带上 ¥ 符号去拉全量站点行，在 MySQL 部署下是不必要的 IO 与传输。
 *
 * ⚠️ F3 修正：**以活跃站点为基准输出**，没有档案行的站点给 null。
 *   原先只返回 site_billing_profiles 里已有的行 —— 实测 8 个活跃站只有 4 行档案，
 *   另外 4 个（OAuth 类）压根不在表里。那样前端无法区分"这站没设汇率"和
 *   "这站不存在"，也就算不出"有多少站被排除出人民币合计"。
 *
 * 语义与 getSiteBillingProfile 一致：null = 未知，绝不填默认汇率。
 */
export interface SiteCurrencyRate {
  siteId: number;
  /** 1 USD ≈ N CNY；null 表示该站点汇率未知，调用方须排除出合计并提示。 */
  cnyPerUsd: number | null;
}

export async function listSiteCurrencyRates(): Promise<SiteCurrencyRate[]> {
  const [profileRows, activeSites] = await Promise.all([
    db.select({
      siteId: schema.siteBillingProfiles.siteId,
      cnyPerUsd: schema.siteBillingProfiles.cnyPerUsd,
    }).from(schema.siteBillingProfiles).all(),
    // 只统计活跃站点：禁用站不参与任何金额合计，把它们算进"未设汇率"会虚增提示数量
    db.select({ id: schema.sites.id }).from(schema.sites)
      .where(eq(schema.sites.status, 'active')).all(),
  ]);

  const rateBySiteId = new Map<number, number | null>();
  for (const row of profileRows) {
    const rate = Number(row.cnyPerUsd);
    rateBySiteId.set(
      Number(row.siteId),
      Number.isFinite(rate) && rate > 0 ? rate : null,
    );
  }

  return (activeSites ?? [])
    .map((site) => ({ siteId: Number(site.id) }))
    .filter((item) => Number.isFinite(item.siteId) && item.siteId > 0)
    .map((item) => ({ siteId: item.siteId, cnyPerUsd: rateBySiteId.get(item.siteId) ?? null }))
    .sort((left, right) => left.siteId - right.siteId);
}

/**
 * 带缓存的汇率档案读取（B1）。
 *
 * 必须挂缓存的原因：这个端点是全站金额显示的前置依赖，页面加载即触发。
 * 不缓存的话，"为了避免拉全量站点数据"就退化成每次加载多打一次 MySQL 往返 ——
 * 远程库的成本几乎全在 RTT 上，那样反而比搭 getSites 便车更慢。
 *
 * TTL 取 60s：汇率是人工/探测维护的低频数据，分钟级陈旧完全可接受；
 * 而用户在站点编辑里保存汇率时会显式失效（见 invalidateCurrencyRateCache），
 * 所以"改完立刻可见"这条体验不受 TTL 影响。
 */
const CURRENCY_RATES_TTL_MS = 60_000;

export async function getSiteCurrencyRatesSnapshot(options?: {
  forceRefresh?: boolean;
}) {
  return readSnapshotCache<SiteCurrencyRate[]>({
    namespace: 'site-currency-rates',
    key: 'default',
    ttlMs: CURRENCY_RATES_TTL_MS,
    forceRefresh: options?.forceRefresh,
    loader: listSiteCurrencyRates,
  });
}

/**
 * 让汇率缓存立即失效。
 * 调用时机：站点保存了手动汇率、或自动探测写回了新值。
 * 不做这件事的话，用户填完汇率要等最多 60 秒才能看到价格变化，
 * 会被当成"设置没生效"。
 */
export function invalidateSiteCurrencyRatesCache(): void {
  clearSnapshotCache('site-currency-rates');
}
