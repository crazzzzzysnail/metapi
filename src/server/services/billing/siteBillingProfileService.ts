/**
 * 站点计费参数探测与持久化（S6 / T8.4）。
 *
 * 探测来源：上游 `/api/status` 的 **充值价** 与额度标尺。
 *
 * ⚠️ 语义订正（2026-11-22，上游源码确证）：
 *   `cnyPerUsd` 存的不是"官方汇率"，而是 **充值价**——每 1 美元额度实际支付的人民币。
 *   依据（QuantumNous/new-api）：
 *     controller/topup.go getTopUpQuota: quota = amount × QuotaPerUnit（amount 即美元额度）
 *     controller/topup.go getPayMoney : payMoney = amount × Price
 *   两式相除，amount 抵消 ⇒ 实付人民币 / 美元额度 = Price。与 amount 用什么单位无关。
 *   实测印证：某站 `/api/user/amount {"amount":1}` 返回应付 `1.00`，其 `price` 恰为 1。
 *
 *   因此 `price` **不能**当作"官方 USD→CNY 汇率"使用：它是站主定的售卖价
 *   （默认 7.3 与官方汇率同值，一旦打折或改价即分裂：实测见过 1、0.005）。
 *   官方汇率是另一个字段 `usd_exchange_rate`（仅用于"按官方汇率折合"的参考展示），
 *   **不进本候选表**——混进来会让"实付价"和"官方价"在同一口径里相加，正是失准来源。
 *
 * 诚实性约定（R7 / 决策"失败即留空，不写默认值"）：
 *   - 探测不到充值价就留 null，**绝不回退 7.2 之类的猜测值**；
 *   - 后台静默探测不覆盖手动值（manual）；用户显式点探测时例外，以上游为准；
 *   - 展示层读到 null 必须说"充值价未知"，不得显示换算后的数字。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { upsertRow } from '../../db/dialectUpsert.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { clearSnapshotCache, readSnapshotCache } from '../snapshotCacheService.js';

export interface SiteBillingProfileRow {
  siteId: number;
  quotaPerUnit: number | null;
  cnyPerUsd: number | null;
  /** 上游展示口径：USD / CNY / CUSTOM / TOKENS；null = 未探测。 */
  quotaDisplayType: string | null;
  /** CUSTOM 模式下站主填的符号（自由文本）；null = 未提供。 */
  customCurrencySymbol: string | null;
  /** CUSTOM 模式下每 1 USD 等于多少自定义单位；null = 未知。 */
  customCurrencyExchangeRate: number | null;
  /** 展示口径来源：auto 探测 / manual 手填 / null 未知。 */
  displaySource: 'auto' | 'manual' | null;
  quotaSource: 'auto' | 'manual' | null;
  rateSource: 'auto' | 'manual' | null;
  capturedAt: string | null;
}

/** 归一展示口径：只认四种声明值（大小写不敏感），其它一律 null。 */
function normalizeDisplayType(value: unknown): string | null {
  const key = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return QUOTA_DISPLAY_TYPES.has(key) ? key : null;
}

/**
 * 归一自定义货币符号：空白/不可显示串按"未提供"存 null，绝不伪造一个默认符号。
 *
 * 判据 3（2026-11-23）：站主可能只填空格或零宽字符（实测某站
 * custom_currency_symbol 就是单个 0x20）—— 这类值不能正常显示，一律归 null，
 * 显示层退化成裸数字、提示用户手动补充，而不是把空白当符号画出来。
 * 只判"能不能显示"，不猜符号内容。
 * ⚠️ 正则里必须用 \uXXXX 转义显式列出零宽/空白码点（普通 trim 去不掉
 * U+200B/U+3000/U+FEFF 这类），源码内禁止出现字面不可见字符。
 */
function normalizeCurrencySymbol(value: unknown): string | null {
  const raw = typeof value === 'string' ? value : '';
  const text = raw
    .replace(/[\s\u00A0\u1680\u2000-\u200F\u202F\u205F\u2060\u3000\uFEFF]/g, '')
    .trim();
  return text ? text : null;
}

/**
 * 候选 **充值价** 字段（按语义明确度排序）。
 *
 * - `price`            new-api 售卖价：实付人民币 / 美元额度（首选，源码确证）
 * - `PaymentUSDRate`   done-hub 支付汇率：语义同为"每美元额度付多少人民币"
 * - `stripe_unit_price` Stripe 单价：同为按额度计的支付价，但币种取决于 Stripe 账户配置，排后
 *
 * 刻意**不含** `usd_exchange_rate`：那是官方汇率，不是站主实收价。
 */
const TOPUP_PRICE_FIELDS = ['price', 'PaymentUSDRate', 'stripe_unit_price'] as const;

function toFinitePositive(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 上游展示口径的合法取值；其它值一律按未知处理。 */
const QUOTA_DISPLAY_TYPES = new Set(['USD', 'CNY', 'CUSTOM', 'TOKENS']);

/**
 * 从 /api/status 的 data 里提取 **充值价**、额度标尺与 **上游展示口径**。
 * 纯函数，便于单测直接喂真实响应片段。
 */
export function extractStatusBillingInfo(data: Record<string, unknown> | null | undefined): {
  cnyPerUsd: number | null;
  rateFieldName: string | null;
  quotaPerUnit: number | null;
  quotaDisplayType: string | null;
  customCurrencySymbol: string | null;
  customCurrencyExchangeRate: number | null;
} {
  let cnyPerUsd: number | null = null;
  let rateFieldName: string | null = null;
  for (const field of TOPUP_PRICE_FIELDS) {
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

  // 上游展示口径：归一逻辑与手动覆盖共用同一个出口（normalizeDisplayType / normalizeCurrencySymbol），
  // 否则"手填能存进去的值"和"探测认下来的值"会是两套判据，迟早对不上。
  const quotaDisplayType = normalizeDisplayType(data?.quota_display_type);
  const customCurrencySymbol = normalizeCurrencySymbol(data?.custom_currency_symbol);
  const customCurrencyExchangeRate = toFinitePositive(data?.custom_currency_exchange_rate);

  return {
    cnyPerUsd,
    rateFieldName,
    quotaPerUnit,
    quotaDisplayType,
    customCurrencySymbol,
    customCurrencyExchangeRate,
  };
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
    quotaDisplayType: row?.quotaDisplayType ?? null,
    customCurrencySymbol: row?.customCurrencySymbol ?? null,
    customCurrencyExchangeRate: row?.customCurrencyExchangeRate ?? null,
    displaySource: (row?.displaySource as 'auto' | 'manual' | null) ?? null,
    quotaSource: (row?.quotaSource as 'auto' | 'manual' | null) ?? null,
    rateSource: (row?.rateSource as 'auto' | 'manual' | null) ?? null,
    capturedAt: row?.capturedAt ?? null,
  };
}

export interface ProbeSiteBillingProfileOptions {
  /**
   * 显式探测（用户点「探测上游充值价」/「重新探测」）允许用上游值覆盖手动维护值。
   *
   * 两种调用的意图不同，必须分开：
   *   - 站点保存后的**后台静默**探测：不能让上游悄悄改掉用户手填的充值价，
   *     否则表现为"我刚保存的值自己变了"，故 overrideManual 缺省 false；
   *   - 用户**显式点探测**按钮：意图就是"以上游为准"，此时仍拒写就会
   *     出现"点了探测，数字纹丝不动、来源还标着手动"的假死现象。
   */
  overrideManual?: boolean;
}

/**
 * 自动探测并合并写库。规则：
 *   - 默认 manual 来源的值不被 auto 覆盖；显式探测（overrideManual）例外；
 *   - 探测失败的字段保持原状（包括保持 null），不会写入猜测值。
 */
export async function probeAndPersistSiteBillingProfile(
  site: { id: number; url: string },
  requestJson: (url: string, init?: UndiciRequestInit) => Promise<unknown>,
  options: ProbeSiteBillingProfileOptions = {},
): Promise<SiteBillingProfileRow> {
  const normalizedBase = (site.url || '').replace(/\/+$/, '');
  const statusData = await fetchSiteStatus(normalizedBase, requestJson);
  const extracted = extractStatusBillingInfo(statusData);

  const existing = await db.select().from(schema.siteBillingProfiles)
    .where(eq(schema.siteBillingProfiles.siteId, site.id)).get();

  const next: typeof schema.siteBillingProfiles.$inferInsert = { siteId: site.id };
  // 显式探测时用户就是要以上游为准：手动值也允许被覆盖，并如实改回 auto。
  const canOverrideManual = options.overrideManual === true;

  if (extracted.cnyPerUsd !== null && (canOverrideManual || existing?.rateSource !== 'manual')) {
    next.cnyPerUsd = extracted.cnyPerUsd;
    next.rateSource = 'auto';
  }
  if (extracted.quotaPerUnit !== null && (canOverrideManual || existing?.quotaSource !== 'manual')) {
    next.quotaPerUnit = extracted.quotaPerUnit;
    next.quotaSource = 'auto';
  }
  // 展示口径与充值价同构：静默探测不覆盖手填（display_source='manual'），显式探测才覆盖并回标 auto。
  // 判据必须存在的原因：部分上游把 /api/status 挡在 WAF 后（实测某站匿名请求 403），
  // 探测永远拿不到口径，用户只能手填；若静默探测能覆盖手填，填了也会被冲掉。
  //
  // 三个字段是一个整体：口径为 USD/CNY/TOKENS 时上游并没有自定义符号与倍率，
  // 这时必须把旧的符号/倍率**清空**，否则改了口径却留着上一个口径的 10 倍，标注就错。
  if (extracted.quotaDisplayType !== null && (canOverrideManual || existing?.displaySource !== 'manual')) {
    next.quotaDisplayType = extracted.quotaDisplayType;
    next.customCurrencySymbol = extracted.customCurrencySymbol;
    next.customCurrencyExchangeRate = extracted.customCurrencyExchangeRate;
    next.displaySource = 'auto';
  }
  // 至少探到过一项才刷新时间戳；全失败不动已有 capturedAt
  if (
    next.cnyPerUsd !== undefined
    || next.quotaPerUnit !== undefined
    || next.quotaDisplayType !== undefined
  ) {
    next.capturedAt = new Date().toISOString();
  }

  if (Object.keys(next).length > 1) {
    // 走方言感知的 upsert。原先直接写 `.onConflictDoUpdate(...)`，在
    // DB_TYPE=mysql 下是 `onConflictDoUpdate is not a function` → HTTP 500。
    // `next` 只含本次真正探到的列，缺省 set 即整份覆盖这些列，与原语义逐字一致；
    // site_id 在三种方言下都是主键，写回自己无害。
    await upsertRow({
      table: schema.siteBillingProfiles,
      values: next as Record<string, unknown>,
      conflictTarget: schema.siteBillingProfiles.siteId,
    });
  }

  // 充值价/标尺一变，全站金额显示就得重算：让轻量端点的缓存立刻作废，
  // 否则用户填完要等最多 60 秒才看到变化，会被当成"设置没生效"。
  invalidateSiteCurrencyRatesCache();

  return getSiteBillingProfile(site.id);
}

/** 用户手动维护入口（站点编辑弹窗用）。传 null 表示清除覆盖、回到未知。 */
export async function setManualBillingOverrides(input: {
  siteId: number;
  cnyPerUsd?: number | null;
  quotaPerUnit?: number | null;
  /**
   * 上游展示口径三件套。传 `quotaDisplayType` 即视为"用户来定口径"：
   *   - null/空 → 清除覆盖、回到未知（display_source=null），三个字段一起清；
   *   - USD/CNY/TOKENS → 这三个口径下上游没有自定义符号与倍率，符号/倍率一律清空，
   *     否则改了口径却留着上一个口径的 10 倍，界面标注就错；
   *   - CUSTOM → 采用用户给的符号（空白按未提供）与倍率（>0 才存）。
   */
  quotaDisplayType?: string | null;
  customCurrencySymbol?: string | null;
  customCurrencyExchangeRate?: number | null;
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
  if (input.quotaDisplayType !== undefined) {
    const displayType = normalizeDisplayType(input.quotaDisplayType);
    patch.quotaDisplayType = displayType;
    if (displayType === 'CUSTOM') {
      patch.customCurrencySymbol = normalizeCurrencySymbol(input.customCurrencySymbol);
      patch.customCurrencyExchangeRate = input.customCurrencyExchangeRate === null
        || input.customCurrencyExchangeRate === undefined
        ? null
        : toFinitePositive(input.customCurrencyExchangeRate);
    } else {
      // 非 CUSTOM（含"清除回未知"）：符号与倍率一并清掉，不给上一个口径留残留值。
      patch.customCurrencySymbol = null;
      patch.customCurrencyExchangeRate = null;
    }
    patch.displaySource = displayType === null ? null : 'manual';
  }

  // 同上：手动覆盖也要走方言感知 upsert。这里 patch 会显式带 null（= 清除覆盖），
  // 整份覆盖正是想要的语义，故不传 set，让缺省逻辑原样写回。
  await upsertRow({
    table: schema.siteBillingProfiles,
    values: patch,
    conflictTarget: schema.siteBillingProfiles.siteId,
  });

  // 同上：手动覆盖也要让充值价缓存作废。
  invalidateSiteCurrencyRatesCache();

  return getSiteBillingProfile(input.siteId);
}

/**
 * 全站充值价档案的轻量读取（B1）。
 *
 * 为什么单独开一个入口而不是让前端搭 `/api/sites` 的便车：
 *   显示币种换算只需要 `{siteId, cnyPerUsd}` 两个数，而站点表里带着
 *   url / api_key / extra_config / custom_headers 等大字段。为了让金额
 *   带上 ¥ 符号去拉全量站点行，在 MySQL 部署下是不必要的 IO 与传输。
 *
 * ⚠️ F3 修正：**以活跃站点为基准输出**，没有档案行的站点给 null。
 *   原先只返回 site_billing_profiles 里已有的行 —— 实测 8 个活跃站只有 4 行档案，
 *   另外 4 个（OAuth 类）压根不在表里。那样前端无法区分"这站没设充值价"和
 *   "这站不存在"，也就算不出"有多少站被排除出人民币合计"。
 *
 * 语义与 getSiteBillingProfile 一致：null = 未知，绝不填默认充值价。
 */
export interface SiteCurrencyRate {
  siteId: number;
  /** 充值价：每 1 美元额度实付人民币；null 表示该站点充值价未知，调用方须排除出合计并提示。 */
  cnyPerUsd: number | null;
  /**
   * 上游展示口径（S6）。只用于把 USD 金额换算成"上游页面会显示的数字"，
   * 让用户拿两边一对就知道是不是同一笔钱；不参与任何计费或合计。
   */
  quotaDisplayType: string | null;
  customCurrencySymbol: string | null;
  customCurrencyExchangeRate: number | null;
}

export async function listSiteCurrencyRates(): Promise<SiteCurrencyRate[]> {
  const [profileRows, activeSites] = await Promise.all([
    db.select({
      siteId: schema.siteBillingProfiles.siteId,
      cnyPerUsd: schema.siteBillingProfiles.cnyPerUsd,
      quotaDisplayType: schema.siteBillingProfiles.quotaDisplayType,
      customCurrencySymbol: schema.siteBillingProfiles.customCurrencySymbol,
      customCurrencyExchangeRate: schema.siteBillingProfiles.customCurrencyExchangeRate,
    }).from(schema.siteBillingProfiles).all(),
    // 只统计活跃站点：禁用站不参与任何金额合计，把它们算进"未设充值价"会虚增提示数量
    db.select({ id: schema.sites.id }).from(schema.sites)
      .where(eq(schema.sites.status, 'active')).all(),
  ]);

  const profileBySiteId = new Map<number, {
    cnyPerUsd: number | null;
    quotaDisplayType: string | null;
    customCurrencySymbol: string | null;
    customCurrencyExchangeRate: number | null;
  }>();
  for (const row of profileRows) {
    const rate = Number(row.cnyPerUsd);
    const customRate = Number(row.customCurrencyExchangeRate);
    profileBySiteId.set(Number(row.siteId), {
      cnyPerUsd: Number.isFinite(rate) && rate > 0 ? rate : null,
      quotaDisplayType: row.quotaDisplayType ?? null,
      customCurrencySymbol: row.customCurrencySymbol ?? null,
      customCurrencyExchangeRate: Number.isFinite(customRate) && customRate > 0 ? customRate : null,
    });
  }

  return (activeSites ?? [])
    .map((site) => ({ siteId: Number(site.id) }))
    .filter((item) => Number.isFinite(item.siteId) && item.siteId > 0)
    .map((item) => {
      const profile = profileBySiteId.get(item.siteId);
      return {
        siteId: item.siteId,
        cnyPerUsd: profile?.cnyPerUsd ?? null,
        quotaDisplayType: profile?.quotaDisplayType ?? null,
        customCurrencySymbol: profile?.customCurrencySymbol ?? null,
        customCurrencyExchangeRate: profile?.customCurrencyExchangeRate ?? null,
      };
    })
    .sort((left, right) => left.siteId - right.siteId);
}

/**
 * 带缓存的充值价档案读取（B1）。
 *
 * 必须挂缓存的原因：这个端点是全站金额显示的前置依赖，页面加载即触发。
 * 不缓存的话，"为了避免拉全量站点数据"就退化成每次加载多打一次 MySQL 往返 ——
 * 远程库的成本几乎全在 RTT 上，那样反而比搭 getSites 便车更慢。
 *
 * TTL 取 60s：充值价是人工/探测维护的低频数据，分钟级陈旧完全可接受；
 * 而用户在站点编辑里保存充值价时会显式失效（见 invalidateCurrencyRateCache），
 * 所以"改完立刻可见"这条体验不受 TTL 影响。
 */
const CURRENCY_RATES_TTL_MS = 60_000;

export async function getSiteCurrencyRatesSnapshot(options?: {
  forceRefresh?: boolean;
}) {
  const snapshot = await readSnapshotCache<SiteCurrencyRate[]>({
    namespace: 'site-currency-rates',
    key: 'default',
    ttlMs: CURRENCY_RATES_TTL_MS,
    forceRefresh: options?.forceRefresh,
    loader: listSiteCurrencyRates,
  });
  // F8：把「有多少活跃站充值价未知」在服务端算好一起返回。
  // 这不是冗余字段 —— 前端 CurrencyContext 也数一遍（unknownRateSiteCount），
  // 两处必须同源同值，否则仪表盘的「已排除 N 个」与顶栏提示会各说一套。
  // 判据同样只取活跃站：listSiteCurrencyRates 已按 status='active' 过滤，
  // 禁用站不参与任何金额合计，不该虚增提示数量。
  const rates = snapshot.payload ?? [];
  let unknownCount = 0;
  for (const rate of rates) {
    if (rate.cnyPerUsd == null) unknownCount += 1;
  }
  return { ...snapshot, unknownCount };
}

/**
 * 让充值价缓存立即失效。
 * 调用时机：站点保存了手动充值价、或自动探测写回了新值。
 * 不做这件事的话，用户填完充值价要等最多 60 秒才能看到价格变化，
 * 会被当成"设置没生效"。
 */
export function invalidateSiteCurrencyRatesCache(): void {
  clearSnapshotCache('site-currency-rates');
}
