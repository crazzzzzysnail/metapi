import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogClientColumns,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
} from '../db/index.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

/**
 * 列表接口的两个开关刻意分开：
 *   - includeBillingDetails → 响应里带**完整** billing_details（详情接口用）；
 *   - includeBillingSummary → 只把该列 **SELECT 出来**，由路由层解析成轻量摘要，
 *     原文不进响应体（列表页默认显示「分组/计费」两行用）。
 * 两者都要求该列存在；缺列时下面的降级重试会撤掉对应开关。
 */
function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeBillingSummary?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  const needsBillingColumn = options?.includeBillingDetails === true
    || options?.includeBillingSummary === true;
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(needsBillingColumn ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeBillingSummary: boolean;
  includeClientFields: boolean;
  includeStreamTimingFields: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeBillingSummary?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
}) {
  // 摘要与完整明细共用同一列存在性判断：缺列时两者一起退让，不会出现"查了列却给不出值"。
  const hasBillingColumn = await hasProxyLogBillingDetailsColumn();
  const includeBillingDetails = options?.includeBillingDetails === true && hasBillingColumn;
  const includeBillingSummary = options?.includeBillingSummary === true && hasBillingColumn;
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();

  return {
    includeBillingDetails,
    includeBillingSummary,
    includeClientFields,
    includeStreamTimingFields,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeBillingSummary,
      includeClientFields,
      includeStreamTimingFields,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: { includeBillingDetails?: boolean; includeBillingSummary?: boolean; includeClientFields?: boolean; includeStreamTimingFields?: boolean },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      // 缺 billing_details 列时，完整明细与轻量摘要**一起**退让 ——
      // 只撤一个会让下面的条件永远成立，从而在这里死循环重试。
      if ((selection.includeBillingDetails || selection.includeBillingSummary) && isMissingBillingDetailsColumnError(error)) {
        selection = {
          includeBillingDetails: false,
          includeBillingSummary: false,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: false,
            includeBillingSummary: false,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeBillingSummary: selection.includeBillingSummary,
          includeClientFields: false,
          includeStreamTimingFields: selection.includeStreamTimingFields,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeBillingSummary: selection.includeBillingSummary,
            includeClientFields: false,
            includeStreamTimingFields: selection.includeStreamTimingFields,
          }),
        };
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = {
          includeBillingDetails: selection.includeBillingDetails,
          includeBillingSummary: selection.includeBillingSummary,
          includeClientFields: selection.includeClientFields,
          includeStreamTimingFields: false,
          fields: buildProxyLogSelectFields({
            includeBillingDetails: selection.includeBillingDetails,
            includeBillingSummary: selection.includeBillingSummary,
            includeClientFields: selection.includeClientFields,
            includeStreamTimingFields: false,
          }),
        };
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * 列表页用的轻量计费摘要。
 *
 * 为什么不直接把整段 billing_details 下发给列表：
 *   一条记录的 billing_details 含 usage / pricing / breakdown 三个对象共十几个字段，
 *   列表一页几十行全部带上会明显放大响应体；而界面只需要分组名、倍率、档位与单价。
 *   明细仍然走单条详情接口，展开时才取 —— 两个口径各取所需，不是同一份数据的两次搬运。
 */
export interface ProxyLogBillingSummary {
  groupName: string | null;
  groupRatio: number | null;
  tierName: string | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
}

function toFiniteOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 从 billing_details（对象或 JSON 文本）抽出列表要显示的几个标量。缺字段一律 null，不补 0。 */
export function extractProxyLogBillingSummary(value: unknown): ProxyLogBillingSummary | null {
  const detail = parseProxyLogBillingDetails(value);
  if (!detail) return null;

  const pricing = (detail.pricing || {}) as Record<string, unknown>;
  const breakdown = (detail.breakdown || {}) as Record<string, unknown>;
  const summary: ProxyLogBillingSummary = {
    groupName: typeof pricing.groupName === 'string' && pricing.groupName.trim()
      ? pricing.groupName.trim()
      : null,
    groupRatio: toFiniteOrNull(pricing.groupRatio),
    tierName: typeof pricing.tierName === 'string' && pricing.tierName.trim()
      ? pricing.tierName.trim()
      : null,
    inputPerMillion: toFiniteOrNull(breakdown.inputPerMillion),
    outputPerMillion: toFiniteOrNull(breakdown.outputPerMillion),
  };

  // 全空说明这条记录压根没有可用计费信息（旧数据或未记账），返回 null 让前端显示占位。
  const hasAnything = summary.groupName !== null
    || summary.groupRatio !== null
    || summary.tierName !== null
    || summary.inputPerMillion !== null
    || summary.outputPerMillion !== null;
  return hasAnything ? summary : null;
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested: input.modelRequested ?? null,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    // N2 同层第二处：这里也必须原样传 null。
    // 上一轮改的是 sharedSurface，若此处仍 `?? 0`，缺价照样会以"免费"落库。
    estimatedCost: input.estimatedCost ?? null,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    createdAt: input.createdAt ?? null,
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();

  let allowBillingDetails = includeBillingDetails;
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      throw error;
    }
  }
}
