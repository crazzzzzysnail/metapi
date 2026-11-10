/**
 * API-key 余额遥测编排（S5d / T7.5、T7.6）。
 *
 * ## 为什么必须存在
 *
 * `balanceService.ts` 原先对 apikey 型连接**直接早退**（reason: proxy_only），
 * 于是"只有 API key、没有账号密码"的通道永远刷不出余额，
 * 即便上游明明提供 `/api/usage/token/`。本模块把这条路径改为多源编排。
 *
 * ## 优先级（R14）
 *   session 优先 —— 它反映账号钱包，与站点列表/预警的既有口径一致；
 *   API-key 遥测其次 —— 它是**令牌配额**，语义不同，不能覆盖 session 结果；
 *   两源并存时都保留在 `sources` 里供排查，但**数值不合并、不平均、不取大**（冲突不合并）。
 *
 * ## 安全约束
 * 密钥只用于向该站点自身发起读取请求：不落日志、不进错误信息、不回显。
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import type { BalanceInfo } from '../platforms/base.js';
import { getQuotaScale } from './quotaScale.js';
import {
  getSiteBillingProfile,
  type SiteBillingProfileRow,
} from './siteBillingProfileService.js';
import {
  parseNewApiTokenUsage,
  parseOpenAiBillingUsage,
  parseSub2ApiUsage,
} from './apiKeyTelemetryParsers.js';
import {
  unknownBalanceObservation,
  type BalanceEvidence,
  type BalanceObservation,
  type BalanceSource,
} from './balanceSources.js';

const NEW_API_FAMILY_PLATFORMS = new Set(['new-api', 'one-api', 'veloera', 'anyrouter', 'one-hub', 'done-hub']);

/** 一次刷新拿到的全部观测，按来源保留（不合并）。 */
export interface TelemetryOutcome {
  /** 最终采用的观测（session 优先规则下选出）。 */
  adopted: BalanceObservation | null;
  /** 所有尝试过的来源结果，供 UI tooltip 与程序日志排查。 */
  observations: BalanceObservation[];
  /** 没有任何可用来源时为 true —— 调用方应保持原值而不是写 0。 */
  allFailed: boolean;
}

/**
 * 从库里取出该账号可用于遥测的 API key。
 *
 * 注意：key 存在于两处且语义不同 ——
 *   - `accounts.api_token`：账号级 key（旧数据可能为空）；
 *   - `account_tokens.token`：令牌行里的 key（实测 siteC 的 key 就在这里）。
 * 只看前者会误判"这个通道没有 key"，这正是 S5d 要修的点。
 */
async function collectCandidateApiKeys(accountId: number): Promise<string[]> {
  const keys: string[] = [];

  const account = await db.select({ apiToken: schema.accounts.apiToken })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  const accountLevel = String(account?.apiToken || '').trim();
  if (accountLevel) keys.push(accountLevel);

  // 令牌行：只取启用且已就绪的，避免用失效 key 反复打上游
  const tokenRows = await db.select({
    token: schema.accountTokens.token,
    enabled: schema.accountTokens.enabled,
    valueStatus: schema.accountTokens.valueStatus,
  })
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  for (const row of tokenRows) {
    const token = String(row?.token || '').trim();
    if (!token) continue;
    if (row.enabled === false) continue;
    if (row.valueStatus && row.valueStatus !== 'ready') continue;
    if (!keys.includes(token)) keys.push(token);
  }

  return keys;
}

type FetchJson = (url: string, init?: Record<string, unknown>) => Promise<unknown>;

async function tryFetch(
  fetchJson: FetchJson,
  url: string,
  apiKey: string,
): Promise<{ ok: true; payload: unknown } | { ok: false; kind: 'unauthorized' | 'unreachable' }> {
  try {
    const payload = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    return { ok: true, payload };
  } catch (error) {
    const message = String((error as Error)?.message || '');
    // 401/403 与网络失败要区分：前者说明 key 无定价/遥测权限，后者可能是站点此端点不存在
    return { ok: false, kind: /(401|403|unauthorized|invalid token)/i.test(message) ? 'unauthorized' : 'unreachable' };
  }
}

/**
 * 对单个 key 依次尝试各遥测端点。
 * 任一端点成功即返回；全部失败则给出聚合原因。
 */
export async function queryApiKeyTelemetry(input: {
  baseUrl: string;
  platform: string;
  apiKey: string;
  quotaPerUnit: number;
  fetchJson: FetchJson;
}): Promise<BalanceObservation[]> {
  const normalizedPlatform = (input.platform || '').trim().toLowerCase();
  const base = input.baseUrl.replace(/\/+$/, '');
  const observations: BalanceObservation[] = [];

  const endpoints: Array<{ label: string; run: () => Promise<BalanceObservation | null> }> = [];

  if (NEW_API_FAMILY_PLATFORMS.has(normalizedPlatform)) {
    endpoints.push({
      label: '/api/usage/token/',
      run: async () => {
        const result = await tryFetch(input.fetchJson, `${base}/api/usage/token/`, input.apiKey);
        if (!result.ok) {
          return unknownBalanceObservation(
            result.kind === 'unauthorized' ? 'endpoint-unauthorized' : 'endpoint-unreachable',
            'apikey-token-usage',
          );
        }
        return parseNewApiTokenUsage(result.payload, input.quotaPerUnit);
      },
    });
  }

  // OpenAI 兼容双端点：subscription 与 usage 都要拿到才有意义
  endpoints.push({
    label: '/v1/dashboard/billing/*',
    run: async () => {
      const [sub, usage] = await Promise.all([
        tryFetch(input.fetchJson, `${base}/v1/dashboard/billing/subscription`, input.apiKey),
        tryFetch(input.fetchJson, `${base}/v1/dashboard/billing/usage`, input.apiKey),
      ]);
      if (!sub.ok || !usage.ok) {
        // 判别联合：先看 sub，再看 usage，取第一个失败者的 kind
        const failedKind = !sub.ok ? sub.kind : (usage.ok ? null : usage.kind);
        return unknownBalanceObservation(
          failedKind === 'unauthorized' ? 'endpoint-unauthorized' : 'endpoint-unreachable',
          'apikey-openai-billing',
        );
      }
      return parseOpenAiBillingUsage(sub.payload, usage.payload);
    },
  });

  if (normalizedPlatform === 'sub2api') {
    endpoints.push({
      label: '/v1/usage',
      run: async () => {
        const result = await tryFetch(input.fetchJson, `${base}/v1/usage`, input.apiKey);
        if (!result.ok) {
          return unknownBalanceObservation(
            result.kind === 'unauthorized' ? 'endpoint-unauthorized' : 'endpoint-unreachable',
            'apikey-sub2api-usage',
          );
        }
        return parseSub2ApiUsage(result.payload);
      },
    });
  }

  for (const endpoint of endpoints) {
    const observation = await endpoint.run();
    if (observation) observations.push(observation);
  }

  return observations;
}

/**
 * 是否为可展示金额的观测。
 *
 * **必须有 balanceUsd**：仅有 totalUsedUsd 不构成"余额" ——
 * 无限配额场景下上游只给已消耗量，若把它当可采纳金额，
 * 调用方会退化成 `balance ?? 0` 从而伪造出 $0 余额（2026-11-08 端到端实测踩中）。
 */
function isMonetary(observation: BalanceObservation): boolean {
  return typeof observation.balanceUsd === 'number';
}

/**
 * session 优先的采纳规则（R14：多源并存但不合并数值）。
 *
 * 顺序：session → token-usage → openai-billing → sub2api。
 * 同优先级内取第一个带金额信息的观测；都没有金额时，
 * 仍采纳优先级最高的那条（它的 reason 有诊断价值）。
 */
export function adoptByPriority(observations: BalanceObservation[]): BalanceObservation | null {
  const order: BalanceSource[] = [
    'session-user-self',
    'apikey-token-usage',
    'apikey-openai-billing',
    'apikey-sub2api-usage',
    'manual',
    'unknown',
  ];

  const ranked = [...observations].sort((left, right) => (
    order.indexOf(left.evidence.source) - order.indexOf(right.evidence.source)
  ));

  return ranked.find(isMonetary) || ranked[0] || null;
}

/**
 * 完整编排：取候选 key → 逐 key 遥测 → session 结果优先采纳。
 *
 * `sessionBalance` 传入时代表 adapter.getBalance 已成功，
 * 此时**不覆盖**其数值，仅把 key 侧观测附在 sources 里供对照。
 */
export async function orchestrateApiKeyTelemetry(input: {
  site: { id: number; url: string; platform: string };
  accountId: number;
  sessionBalance?: BalanceInfo | null;
  fetchJson: FetchJson;
}): Promise<TelemetryOutcome> {
  const profile = await getSiteBillingProfile(input.site.id);
  const quotaPerUnit = toPositiveOrNull(profile.quotaPerUnit) ?? getQuotaScale(input.site.platform);

  const keys = await collectCandidateApiKeys(input.accountId);
  const observations: BalanceObservation[] = [];

  if (input.sessionBalance) {
    observations.push({
      ...(typeof input.sessionBalance.balance === 'number' ? { balanceUsd: input.sessionBalance.balance } : {}),
      ...(typeof input.sessionBalance.used === 'number' ? { totalUsedUsd: input.sessionBalance.used } : {}),
      ...(typeof input.sessionBalance.quota === 'number' ? { totalGrantedUsd: input.sessionBalance.quota } : {}),
      evidence: { source: 'session-user-self', precision: 'exact', capturedAt: Date.now() },
    });
  }

  for (const key of keys) {
    const results = await queryApiKeyTelemetry({
      baseUrl: input.site.url,
      platform: input.site.platform,
      apiKey: key,
      quotaPerUnit,
      fetchJson: input.fetchJson,
    });
    observations.push(...results);
    // 第一个 key 拿到金额就停：多个 key 打到同一站点没有额外信息量，只是浪费请求
    if (results.some(isMonetary)) break;
  }

  const adopted = adoptByPriority(observations);
  return {
    adopted,
    observations,
    allFailed: !observations.some(isMonetary),
  };
}

function toPositiveOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
