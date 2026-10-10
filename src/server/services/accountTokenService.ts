import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getInsertedRowId } from '../db/insertHelpers.js';
import { getCredentialModeFromExtraConfig } from './accountExtraConfig.js';

type UpstreamApiToken = {
  name?: string | null;
  key?: string | null;
  enabled?: boolean | null;
  tokenGroup?: string | null;
};

type AccountTokenRow = typeof schema.accountTokens.$inferSelect;

export const ACCOUNT_TOKEN_VALUE_STATUS_READY = 'ready' as const;
export const ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING = 'masked_pending' as const;
export type AccountTokenValueStatus =
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_READY
  | typeof ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;

export function normalizeTokenForDisplay(token?: string | null, platform?: string | null): string {
  if (!token) return '';
  const value = token.trim();
  if (!value) return '';
  if (platform !== undefined) {
    // Keep the parameter for route-level compatibility; display rule is now global.
  }
  if (!value.toLowerCase().startsWith('sk-')) {
    return `sk-${value}`;
  }
  return value;
}

export function maskToken(token?: string | null, platform?: string | null): string {
  const value = normalizeTokenForDisplay(token, platform);
  if (!value) return '';
  if (value.toLowerCase().startsWith('sk-')) {
    if (value.length <= 7) return 'sk-***';
    const visibleMiddle = value.slice(3, Math.min(6, value.length));
    if (value.length <= 12) return `sk-${visibleMiddle}***${value.slice(-2)}`;
    return `sk-${visibleMiddle}***${value.slice(-4)}`;
  }
  if (value.length <= 10) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function normalizeTokenName(name: string | null | undefined, fallbackIndex = 1): string {
  const trimmed = (name || '').trim();
  if (trimmed) return trimmed;
  return fallbackIndex === 1 ? 'default' : `token-${fallbackIndex}`;
}

function normalizeTokenValue(token: string | null | undefined): string | null {
  const trimmed = (token || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isMaskedTokenValue(token: string | null | undefined): boolean {
  const value = (token || '').trim();
  if (!value) return false;
  return value.includes('*') || value.includes('•');
}

function normalizeMaskedTokenForCompare(token: string | null | undefined): string {
  return normalizeTokenForDisplay(token).replace(/•/g, '*');
}

function matchesMaskedTokenValue(
  fullToken: string | null | undefined,
  maskedToken: string | null | undefined,
): boolean {
  const normalizedFull = normalizeTokenForDisplay(fullToken);
  const normalizedMasked = normalizeMaskedTokenForCompare(maskedToken);
  if (!normalizedFull || !normalizedMasked) return false;

  if (!isMaskedTokenValue(normalizedMasked)) {
    return normalizedFull === normalizedMasked;
  }

  const firstMaskIndex = normalizedMasked.search(/[\*]/);
  const lastMaskIndex = Math.max(
    normalizedMasked.lastIndexOf('*'),
    normalizedMasked.lastIndexOf('•'),
  );
  if (firstMaskIndex < 0 || lastMaskIndex < firstMaskIndex) {
    return normalizedFull === normalizedMasked;
  }

  const prefix = normalizedMasked.slice(0, firstMaskIndex);
  const suffix = normalizedMasked.slice(lastMaskIndex + 1);
  const visiblePrefix = prefix.replace(/^sk-/i, '');
  if (!visiblePrefix && !suffix) return false;
  if (normalizedFull.length < prefix.length + suffix.length) return false;
  if (prefix && !normalizedFull.startsWith(prefix)) return false;
  if (suffix && !normalizedFull.endsWith(suffix)) return false;
  return true;
}

function normalizeTokenValueStatus(value: string | null | undefined): AccountTokenValueStatus {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function resolveAccountTokenValueStatus(
  value: Pick<AccountTokenRow, 'token' | 'valueStatus'> | string | null | undefined,
): AccountTokenValueStatus {
  if (typeof value === 'string' || value == null) {
    return normalizeTokenValueStatus(value);
  }

  const explicit = normalizeTokenValueStatus(value.valueStatus);
  if (explicit === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
    return ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
  }
  return isMaskedTokenValue(value.token)
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
}

export function isReadyAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_READY
    && !isMaskedTokenValue(token.token);
}

export function isMaskedPendingAccountToken(token: Pick<AccountTokenRow, 'token' | 'valueStatus'> | null | undefined): boolean {
  if (!token) return false;
  return resolveAccountTokenValueStatus(token) === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING;
}

export function isUsableAccountToken(
  token: Pick<AccountTokenRow, 'enabled' | 'token' | 'valueStatus'> | null | undefined,
): boolean {
  if (!token) return false;
  return token.enabled === true && isReadyAccountToken(token);
}

export function normalizeTokenGroup(value: string | null | undefined, tokenName?: string | null): string | null {
  const explicit = (value || '').trim();
  if (explicit.length > 0) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  // 决策 6：上游/本地没给分组字段时返回 null（= 分组未知）。
  // 此前这里 return name，等于拿令牌名编造一个分组，是同步失配的根因之一：
  // 站点不返回 group 字段时，本地任何显式分组都必然与「令牌名」不等，同步永远命中不了 ready 行。
  // 已知下游影响（均已在计划 6.1 核查）：tokens.ts 分组计费转为「当前令牌分组未知」，
  // stats.ts 归入 groupCoverageUncertain，覆盖提示不会失效。
  return null;
}

function sameTokenGroup(
  leftGroup: string | null | undefined,
  leftName: string | null | undefined,
  rightGroup: string | null | undefined,
  rightName: string | null | undefined,
): boolean {
  return normalizeTokenGroup(leftGroup, leftName) === normalizeTokenGroup(rightGroup, rightName);
}

async function updateAccountApiToken(accountId: number, tokenValue: string | null) {
  await db.update(schema.accounts)
    .set({ apiToken: tokenValue || null, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return normalizeTokenValue(account.accessToken) === null;
}

export async function getPreferredAccountToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true)))
    .all();

  const usableTokens = tokens.filter(isUsableAccountToken);
  if (usableTokens.length === 0) return null;

  const preferred = usableTokens.find((t) => t.isDefault) || usableTokens[0];
  return preferred;
}

export async function ensureDefaultTokenForAccount(
  accountId: number,
  tokenValue: string,
  options?: { name?: string; source?: string; enabled?: boolean; tokenGroup?: string | null },
): Promise<number | null> {
  const normalizedToken = normalizeTokenValue(tokenValue);
  if (!normalizedToken) return null;
  if (isMaskedTokenValue(normalizedToken)) return null;
  const tokenGroup = normalizeTokenGroup(options?.tokenGroup, options?.name) || 'default';

  const now = new Date().toISOString();
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let target = tokens.find((t) => t.token === normalizedToken) || null;
  if (!target) {
    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: normalizeTokenName(options?.name, tokens.length + 1),
        token: normalizedToken,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || 'manual',
        enabled: options?.enabled ?? true,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    target = insertedId != null
      ? (await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, insertedId)).get()) ?? null
      : null;
    if (!target) return null;
  } else {
    await db.update(schema.accountTokens)
      .set({
        name: options?.name ? normalizeTokenName(options.name) : target.name,
        tokenGroup,
        valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
        source: options?.source || target.source || 'manual',
        enabled: options?.enabled ?? target.enabled,
        isDefault: true,
        updatedAt: now,
      })
      .where(eq(schema.accountTokens.id, target.id))
      .run();
  }

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(and(eq(schema.accountTokens.accountId, accountId), ne(schema.accountTokens.id, target.id)))
    .run();

  await updateAccountApiToken(accountId, normalizedToken);
  return target.id;
}

export async function setDefaultToken(tokenId: number): Promise<boolean> {
  const target = await db.select().from(schema.accountTokens).where(eq(schema.accountTokens.id, tokenId)).get();
  if (!target || !isUsableAccountToken(target)) return false;

  const now = new Date().toISOString();
  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, target.accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, tokenId))
    .run();

  await updateAccountApiToken(target.accountId, target.token);
  return true;
}

export async function repairDefaultToken(accountId: number) {
  const tokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  const enabled = tokens.filter(isUsableAccountToken);
  if (enabled.length === 0) {
    await updateAccountApiToken(accountId, null);
    return null;
  }

  const currentDefault = enabled.find((t) => t.isDefault) || enabled[0];
  const now = new Date().toISOString();

  await db.update(schema.accountTokens)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(schema.accountTokens.accountId, accountId))
    .run();

  await db.update(schema.accountTokens)
    .set({ isDefault: true, enabled: true, updatedAt: now })
    .where(eq(schema.accountTokens.id, currentDefault.id))
    .run();

  await updateAccountApiToken(accountId, currentDefault.token);
  return currentDefault;
}

export type TokenSyncUndistinguishableKind =
  | 'ready-ambiguous'
  | 'pending-duplicate'
  | 'upstream-collapse';

/**
 * 决策 12：系统无法区分时的上报项。
 * 脱敏后同值的令牌在信息层面不可区分（`sk-abcAAAxyz` 与 `sk-abcBBBxyz` 都脱敏成 `sk-abc***xyz`），
 * 修复只能保证它们互不污染，不能判定谁是谁，因此改为上报请用户人工查验。
 */
export type TokenSyncUndistinguishable = {
  /** 冲突的脱敏值（即本轮上游 key）。 */
  maskedValue: string;
  /** 涉及的本地行 id。 */
  candidateTokenIds: number[];
  /** 本轮上游项名称；上游没给名称时为 null。 */
  upstreamName: string | null;
  kind: TokenSyncUndistinguishableKind;
};

/**
 * 上游本轮可用元数据（决策 2/3）。
 * 「缺字段」与「读到空值」都视为该字段不可用，直接不返回该键，
 * 由调用方按「有值才写」落库；禁止用令牌名或 `token-N` 冒充上游真值。
 */
export type TokenSyncMeta = {
  name?: string;
  tokenGroup?: string;
};

/**
 * 决策 2/3 的唯一实现：从上游项提取可写字段。
 * 四个写分支（刷新 ready、判孤儿后刷新 ready、复用 pending、insert）全部共用，
 * 任何一处都不得自行拼回退值（AGENTS.md：one source of truth）。
 */
export function resolveIncomingTokenMeta(upstream: UpstreamApiToken): TokenSyncMeta {
  const meta: TokenSyncMeta = {};

  const name = (upstream.name || '').trim();
  if (name) meta.name = name;

  const explicitGroup = (upstream.tokenGroup || '').trim();
  if (explicitGroup) {
    // 刻意不传第二个参数 tokenName：传了就等于拿令牌名编造分组，是本次缺陷的根因之一。
    const group = normalizeTokenGroup(explicitGroup);
    if (group) meta.tokenGroup = group;
  }

  return meta;
}

/** 「有值才写」的落库补丁：只包含 meta 中真实存在的键。 */
function buildTokenMetaPatch(meta: TokenSyncMeta): { name?: string; tokenGroup?: string } {
  const patch: { name?: string; tokenGroup?: string } = {};
  if (meta.name !== undefined) patch.name = meta.name;
  if (meta.tokenGroup !== undefined) patch.tokenGroup = meta.tokenGroup;
  return patch;
}

/** 单条上游项的同步动作计划（纯数据，便于单测覆盖整棵决策树）。 */
export type TokenSyncPlan = {
  action: 'skip' | 'refresh-ready' | 'reuse-pending' | 'insert';
  /** refresh-ready / reuse-pending 的目标行 id。 */
  targetId?: number;
  /** 仅决策 8 判孤儿时非空：需要删除的 masked_pending 行 id。 */
  orphanIds?: number[];
  tokenValue: string;
  nextValueStatus: AccountTokenValueStatus;
  meta: TokenSyncMeta;
  enabled: boolean;
  skipReason?: 'empty_token_value' | 'missing_upstream_name' | 'duplicate_value_row';
  ambiguities: TokenSyncUndistinguishable[];
};

type TokenSyncCandidateRow = Pick<
  AccountTokenRow,
  'id' | 'name' | 'token' | 'tokenGroup' | 'valueStatus'
>;

/**
 * 决策顺序的唯一实现（无 DB 依赖）。顺序严格照 docs/plans/2026-10-09-token-sync-authority-fix.md 第 3 节。
 *
 * 身份判据只有两种：`row.token === tv`（值全等）与 `matchesMaskedTokenValue(row.token, tv)`（掩码匹配）。
 * `row.name` / `row.tokenGroup` 是命中后**要写的字段**，一律不作为身份前提——把它们当匹配前提是本次缺陷的根因。
 *
 * @param alreadySeenInThisRound 本轮是否已有另一条上游项使用同一个值（类型 C 判据）。
 */
export function planTokenSyncAction(input: {
  upstream: UpstreamApiToken;
  rows: TokenSyncCandidateRow[];
  alreadySeenInThisRound: boolean;
}): TokenSyncPlan {
  const tokenValue = normalizeTokenValue(input.upstream.key) || '';
  const meta = resolveIncomingTokenMeta(input.upstream);
  const enabled = input.upstream.enabled ?? true;
  const nextValueStatus: AccountTokenValueStatus = isMaskedTokenValue(tokenValue)
    ? ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
    : ACCOUNT_TOKEN_VALUE_STATUS_READY;
  const base = {
    tokenValue,
    nextValueStatus,
    meta,
    enabled,
    ambiguities: [] as TokenSyncUndistinguishable[],
  };

  if (!tokenValue) {
    return { ...base, action: 'skip', skipReason: 'empty_token_value' };
  }

  const upstreamName = meta.name ?? null;
  const rowsWithSameValue = input.rows.filter((row) => row.token === tokenValue);

  // 类型 C：上游同一轮返回两条脱敏同值项，会塌缩到同一本地行，必须上报。
  if (input.alreadySeenInThisRound) {
    base.ambiguities.push({
      maskedValue: tokenValue,
      candidateTokenIds: rowsWithSameValue.map((row) => row.id),
      upstreamName,
      kind: 'upstream-collapse',
    });
  }

  // 1) 明文值全等命中 ready 行：最确定的身份，直接刷新。
  const byToken = rowsWithSameValue
    .find((row) => resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY);
  if (byToken) {
    return { ...base, action: 'refresh-ready', targetId: byToken.id };
  }

  // 2) 脱敏值命中 ready 行：仅在上游返回的是脱敏值时进行。
  if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING) {
    let cands = input.rows.filter((row) => (
      resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_READY
      && matchesMaskedTokenValue(row.token, tokenValue)
    ));

    // 名称只做 tie-break，不做前提。
    if (cands.length > 1 && upstreamName) {
      const narrowed = cands.filter((row) => row.name === upstreamName);
      if (narrowed.length === 1) cands = narrowed;
    }

    if (cands.length === 1) {
      const ready = cands[0];
      const sameValuePendingRows = rowsWithSameValue.filter((row) => (
        resolveAccountTokenValueStatus(row) === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      ));

      if (sameValuePendingRows.length > 1) {
        // 类型 B：值全等命中多条 pending，只复用第一条，不删其余。
        base.ambiguities.push({
          maskedValue: tokenValue,
          candidateTokenIds: sameValuePendingRows.map((row) => row.id),
          upstreamName,
          kind: 'pending-duplicate',
        });
      }

      if (sameValuePendingRows.length > 0 && ready.token !== tokenValue) {
        // 决策 8 + 决策 10：判孤儿必须四条同时成立，且同值 pending **只有一条**时才删。
        // 多条同值 pending 全满足名称/分组也不删（计划类型 B：只复用第一条，不删其余）——
        // 此时它们彼此不可区分，「哪条是残留」没有证据，删两条就是拿猜测当证据。
        // 这是本函数唯一会减少数据行的路径，前提不可放宽（计划第 8 节遗留风险 3）。
        const isOrphan = sameValuePendingRows.length === 1
          && upstreamName !== null
          && sameValuePendingRows.every((row) => row.name === ready.name)
          && sameValuePendingRows.every((row) => (
            sameTokenGroup(row.tokenGroup, row.name, ready.tokenGroup, ready.name)
          ));

        if (isOrphan) {
          return {
            ...base,
            action: 'refresh-ready',
            targetId: ready.id,
            orphanIds: sameValuePendingRows.map((row) => row.id),
          };
        }

        // 不成立 → ready 行一行不动，只复用该 pending（宁留孤儿，不误删）。
        return {
          ...base,
          action: 'reuse-pending',
          targetId: sameValuePendingRows[0].id,
        };
      }

      return { ...base, action: 'refresh-ready', targetId: ready.id };
    }

    if (cands.length > 1) {
      // 决策 4 + 决策 12 类型 A：名称 tie-break 后仍多候选 → 不写任何 ready，
      // 继续往下走，让待补全行保留，并登记歧义请人工查验。
      base.ambiguities.push({
        maskedValue: tokenValue,
        candidateTokenIds: cands.map((row) => row.id),
        upstreamName,
        kind: 'ready-ambiguous',
      });
    }
  }

  // 3) pending 复用。先按值全等（确定身份）。
  const pendingSameValue = rowsWithSameValue.filter(isMaskedPendingAccountToken);
  if (pendingSameValue.length > 1) {
    base.ambiguities.push({
      maskedValue: tokenValue,
      candidateTokenIds: pendingSameValue.map((row) => row.id),
      upstreamName,
      kind: 'pending-duplicate',
    });
  }
  if (pendingSameValue.length > 0) {
    return { ...base, action: 'reuse-pending', targetId: pendingSameValue[0].id };
  }

  // 上游后来返回明文时，pending 只能靠名称升级（决策 3：值全等与掩码此时都无信息量）。
  // 分组在此**不参与判定**当上游没给 group 字段时：一个不可用的字段既不能拿来写值，
  // 也不能拿来否决身份，否则会新造出重复行。
  // 注意第 2 步的孤儿判定刻意仍要求分组一致——那里不一致的后果是「不删」（保守方向正确），
  // 这里不一致的后果是「多插一行」（伤害）。两处风险方向相反，故规则不同，勿「优化」成一致。
  if (nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY && upstreamName) {
    const pendingByName = input.rows.filter((row) => (
      isMaskedPendingAccountToken(row)
      && row.name === upstreamName
      && (meta.tokenGroup === undefined
        || sameTokenGroup(row.tokenGroup, row.name, meta.tokenGroup, upstreamName))
    ));
    if (pendingByName.length > 1) {
      base.ambiguities.push({
        maskedValue: tokenValue,
        candidateTokenIds: pendingByName.map((row) => row.id),
        upstreamName,
        kind: 'pending-duplicate',
      });
    }
    if (pendingByName.length > 0) {
      return { ...base, action: 'reuse-pending', targetId: pendingByName[0].id };
    }
  }

  // 4) insert：本地已存在同值行时绝不插入（决策 5：杜绝重复）。
  // 正常流程走不到这里（同值行必在第 1 步或第 3 步被命中），保留为防御性底线。
  if (rowsWithSameValue.length > 0) {
    return { ...base, action: 'skip', skipReason: 'duplicate_value_row' };
  }

  // 用户决策（2026-10-10 访谈确认）：上游没给名称时**跳过该上游项**，
  // 既不建 `default`/`token-N` 回退名，也不插一条无名行。勿改成自动补名。
  if (!meta.name) {
    return { ...base, action: 'skip', skipReason: 'missing_upstream_name' };
  }

  return { ...base, action: 'insert' };
}

export async function syncTokensFromUpstream(accountId: number, upstreamTokens: UpstreamApiToken[]) {
  const now = new Date().toISOString();
  const existing = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  let created = 0;
  let updated = 0;
  let maskedPending = 0;
  const pendingTokenIds: number[] = [];
  const undistinguishable: TokenSyncUndistinguishable[] = [];
  const seenUpstreamValues = new Set<string>();

  for (const upstream of upstreamTokens) {
    const rawTokenValue = normalizeTokenValue(upstream.key);
    const alreadySeenInThisRound = !!rawTokenValue && seenUpstreamValues.has(rawTokenValue);
    if (rawTokenValue) seenUpstreamValues.add(rawTokenValue);

    // 规划（纯函数）与落库分离：决策树可单测，落库只负责执行。
    const plan = planTokenSyncAction({
      upstream,
      rows: existing,
      alreadySeenInThisRound,
    });
    undistinguishable.push(...plan.ambiguities);
    if (plan.action === 'skip') continue;

    const metaPatch = buildTokenMetaPatch(plan.meta);

    if (plan.action === 'refresh-ready') {
      // 决策 9/A1：命中 ready 行后 name 一律上游优先，不受 source 影响；
      // 上游缺字段则不写该字段（metaPatch 里就没有该键）。
      await db.update(schema.accountTokens)
        .set({
          ...metaPatch,
          valueStatus: ACCOUNT_TOKEN_VALUE_STATUS_READY,
          source: 'sync',
          enabled: plan.enabled,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, plan.targetId!))
        .run();

      const target = existing.find((row) => row.id === plan.targetId);
      if (target) {
        if (metaPatch.name !== undefined) target.name = metaPatch.name;
        if (metaPatch.tokenGroup !== undefined) target.tokenGroup = metaPatch.tokenGroup;
        target.valueStatus = ACCOUNT_TOKEN_VALUE_STATUS_READY;
        target.enabled = plan.enabled;
        target.source = 'sync';
        target.updatedAt = now;
      }

      // 决策 8：唯一减少数据行的路径。删除前先落库刷新 ready 行，保持与旧实现一致的两步顺序。
      for (const orphanId of plan.orphanIds || []) {
        await db.delete(schema.accountTokens)
          .where(eq(schema.accountTokens.id, orphanId))
          .run();
      }
      for (const orphanId of plan.orphanIds || []) {
        const orphanIndex = existing.findIndex((row) => row.id === orphanId);
        if (orphanIndex >= 0) existing.splice(orphanIndex, 1);
      }

      updated++;
      continue;
    }

    if (plan.action === 'reuse-pending') {
      const nextEnabled = plan.nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY
        ? plan.enabled
        : false;
      await db.update(schema.accountTokens)
        .set({
          ...metaPatch,
          token: plan.tokenValue,
          valueStatus: plan.nextValueStatus,
          source: 'sync',
          enabled: nextEnabled,
          isDefault: false,
          updatedAt: now,
        })
        .where(eq(schema.accountTokens.id, plan.targetId!))
        .run();

      const target = existing.find((row) => row.id === plan.targetId);
      if (target) {
        if (metaPatch.name !== undefined) target.name = metaPatch.name;
        if (metaPatch.tokenGroup !== undefined) target.tokenGroup = metaPatch.tokenGroup;
        target.token = plan.tokenValue;
        target.valueStatus = plan.nextValueStatus;
        target.source = 'sync';
        target.enabled = nextEnabled;
        target.isDefault = false;
        target.updatedAt = now;
      }
      updated++;
      // 复用即一次写入，maskedPending 与 pendingTokenIds 都按**行**去重：
      // 同一行被本轮多条上游项命中时不重复计数、不重复 push（否则前端计数与 id 列表自相矛盾）。
      if (plan.nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
        && !pendingTokenIds.includes(plan.targetId!)
      ) {
        maskedPending++;
        pendingTokenIds.push(plan.targetId!);
      }
      continue;
    }

    // insert：只写上游真实给出的字段，不建回退名、不编造分组。
    const inserted = await db.insert(schema.accountTokens)
      .values({
        accountId,
        name: plan.meta.name!,
        token: plan.tokenValue,
        ...(plan.meta.tokenGroup !== undefined ? { tokenGroup: plan.meta.tokenGroup } : {}),
        valueStatus: plan.nextValueStatus,
        source: 'sync',
        enabled: plan.nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_READY ? plan.enabled : false,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const insertedId = getInsertedRowId(inserted);
    if (insertedId == null) continue;
    const createdRow = await db.select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, insertedId))
      .get();
    if (!createdRow) continue;

    existing.push(createdRow);
    created++;
    if (plan.nextValueStatus === ACCOUNT_TOKEN_VALUE_STATUS_MASKED_PENDING
      && !pendingTokenIds.includes(createdRow.id)
    ) {
      maskedPending++;
      pendingTokenIds.push(createdRow.id);
    }
  }

  const repaired = await repairDefaultToken(accountId);

  return {
    created,
    updated,
    maskedPending,
    pendingTokenIds,
    undistinguishable,
    total: existing.length,
    defaultTokenId: repaired?.id || null,
  };
}

export async function listTokensWithRelations(accountId?: number) {
  const base = db.select()
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id));

  const rows = accountId
    ? await base.where(eq(schema.accountTokens.accountId, accountId)).all()
    : await base.all();

  return rows
    .filter((row) => !isApiKeyConnection(row.accounts))
    .map((row) => {
    const { token, ...tokenMeta } = row.account_tokens;
    return {
      ...tokenMeta,
      valueStatus: resolveAccountTokenValueStatus(row.account_tokens),
      tokenMasked: maskToken(token, row.sites.platform),
      account: {
        id: row.accounts.id,
        username: row.accounts.username,
        status: row.accounts.status,
      },
      site: {
        id: row.sites.id,
        name: row.sites.name,
        url: row.sites.url,
        platform: row.sites.platform,
      },
    };
    });
}
