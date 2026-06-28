import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
} from './accountTokenService.js';
import { clearRouteDecisionSnapshot, clearRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';
import { matchesModelPattern } from './tokenRouter.js';
import { normalizeTokenRouteMode } from '../../shared/tokenRouteContract.js';

type PatternRouteChannelCandidate = {
  tokenId: number | null;
  accountId: number;
  oauthRouteUnitId: number | null;
  sourceModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
  sourceUnavailable: boolean;
};

export type PatternRouteChannelSyncResult = {
  rebuiltRoutes: number;
  routeIds: number[];
  removedChannels: number;
  createdChannels: number;
  changedChannels: number;
};

type RebuildPatternRouteOptions = {
  excludeExactModelPatterns?: string[];
};

type PatternRouteChannelAffectedRouteSnapshot = {
  modelPattern: string;
  routeMode?: string | null;
};

type SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {
  affectedRouteIds?: number[];
  removedRoutes?: PatternRouteChannelAffectedRouteSnapshot[];
};

type RouteModeModelPattern = {
  modelPattern: string;
  routeMode?: string | null;
};

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

function isPatternGroupRoute(route: RouteModeModelPattern): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && !isExactModelPattern(route.modelPattern);
}

function isExactSourceRoute(route: RouteModeModelPattern): boolean {
  return normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
    && isExactModelPattern(route.modelPattern);
}

function normalizeAffectedRouteIds(routeIds: number[] | undefined): number[] {
  const normalized: number[] = [];
  for (const rawRouteId of routeIds || []) {
    const routeId = Math.trunc(Number(rawRouteId));
    if (!Number.isFinite(routeId) || routeId <= 0 || normalized.includes(routeId)) continue;
    normalized.push(routeId);
  }
  return normalized;
}

function createEmptyPatternRouteChannelSyncResult(): PatternRouteChannelSyncResult {
  return {
    rebuiltRoutes: 0,
    routeIds: [],
    removedChannels: 0,
    createdChannels: 0,
    changedChannels: 0,
  };
}

function collectRemovedExactModelPatterns(routes: PatternRouteChannelAffectedRouteSnapshot[] | undefined): string[] {
  const normalized: string[] = [];
  for (const route of routes || []) {
    if (!isExactSourceRoute(route)) continue;
    const modelPattern = route.modelPattern.trim();
    const modelKey = normalizeModelKey(modelPattern);
    if (!modelKey || normalized.some((item) => normalizeModelKey(item) === modelKey)) continue;
    normalized.push(modelPattern);
  }
  return normalized;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildChannelPairKey(input: {
  accountId: number;
  tokenId: number | null;
  oauthRouteUnitId?: number | null;
  sourceModel: string | null;
}): string {
  const sourceModel = (input.sourceModel || '').trim().toLowerCase();
  if (typeof input.oauthRouteUnitId === 'number' && Number.isFinite(input.oauthRouteUnitId) && input.oauthRouteUnitId > 0) {
    return `route-unit:${input.oauthRouteUnitId}::${sourceModel}`;
  }
  const tokenId = typeof input.tokenId === 'number' && Number.isFinite(input.tokenId) ? input.tokenId : 0;
  return `account:${input.accountId}::${tokenId}::${sourceModel}`;
}

async function getPatternTokenCandidates(
  modelPattern: string,
  excludedExactModelNames: Set<string>,
): Promise<PatternRouteChannelCandidate[]> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const candidates: PatternRouteChannelCandidate[] = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName) continue;
    if (excludedExactModelNames.has(normalizeModelKey(modelName))) continue;
    if (!matchesModelPattern(modelName, modelPattern)) continue;
    candidates.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      oauthRouteUnitId: null,
      sourceModel: modelName,
      priority: 0,
      weight: 10,
      enabled: true,
      sourceUnavailable: false,
    });
  }

  return candidates;
}

async function getMatchedExactRouteChannelCandidates(
  modelPattern: string,
  excludedExactModelNames: Set<string>,
): Promise<{
  candidates: PatternRouteChannelCandidate[];
  exactModelNames: Set<string>;
}> {
  const matchedExactRoutes = (await db.select().from(schema.tokenRoutes).all())
    .filter((route) => (
      normalizeTokenRouteMode(route.routeMode) !== 'explicit_group'
      && isExactModelPattern(route.modelPattern)
      && matchesModelPattern(route.modelPattern, modelPattern)
    ));

  const exactModelNames = new Set<string>(excludedExactModelNames);
  for (const route of matchedExactRoutes) {
    exactModelNames.add(normalizeModelKey(route.modelPattern));
  }

  if (matchedExactRoutes.length === 0) {
    return { candidates: [], exactModelNames };
  }

  const routeMap = new Map<number, typeof matchedExactRoutes[number]>();
  for (const route of matchedExactRoutes) routeMap.set(route.id, route);

  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, matchedExactRoutes.map((route) => route.id)))
    .all();

  return {
    exactModelNames,
    candidates: channels.map((channel) => {
      const route = routeMap.get(channel.routeId);
      return {
        tokenId: channel.tokenId ?? null,
        accountId: channel.accountId,
        oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
        sourceModel: (channel.sourceModel || route?.modelPattern || '').trim(),
        priority: channel.priority ?? 0,
        weight: channel.weight ?? 10,
        enabled: !!channel.enabled,
        sourceUnavailable: !route?.enabled || !channel.enabled || !!channel.sourceUnavailable,
      };
    }).filter((candidate) => candidate.sourceModel.length > 0),
  };
}

export async function populateRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  options: RebuildPatternRouteOptions = {},
): Promise<{ createdChannels: number; changedChannels: number }> {
  const excludedExactModelNames = new Set(
    (options.excludeExactModelPatterns || [])
      .map(normalizeModelKey)
      .filter(Boolean),
  );
  const routeCandidates = await getMatchedExactRouteChannelCandidates(modelPattern, excludedExactModelNames);
  const availabilityExclusions = isExactModelPattern(modelPattern)
    ? excludedExactModelNames
    : routeCandidates.exactModelNames;
  const availabilityCandidates = await getPatternTokenCandidates(modelPattern, availabilityExclusions);
  const candidates = [...routeCandidates.candidates, ...availabilityCandidates];

  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const existingPairs = new Set(existingChannels.map((channel) => buildChannelPairKey({
    accountId: channel.accountId,
    tokenId: channel.tokenId ?? null,
    oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
    sourceModel: channel.sourceModel,
  })));

  const candidatePairs = new Set(candidates.map((candidate) => buildChannelPairKey(candidate)));
  let created = 0;
  let changed = 0;
  for (const candidate of candidates) {
    const pairKey = buildChannelPairKey(candidate);
    if (existingPairs.has(pairKey)) {
      const existingChannel = existingChannels.find((channel) => buildChannelPairKey({
        accountId: channel.accountId,
        tokenId: channel.tokenId ?? null,
        oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
        sourceModel: channel.sourceModel,
      }) === pairKey);
      if (existingChannel && !!existingChannel.sourceUnavailable !== candidate.sourceUnavailable) {
        await db.update(schema.routeChannels)
          .set({ sourceUnavailable: candidate.sourceUnavailable })
          .where(eq(schema.routeChannels.id, existingChannel.id))
          .run();
        existingChannel.sourceUnavailable = candidate.sourceUnavailable;
        changed += 1;
      }
      continue;
    }
    await db.insert(schema.routeChannels).values({
      routeId,
      accountId: candidate.accountId,
      tokenId: candidate.tokenId,
      oauthRouteUnitId: candidate.oauthRouteUnitId,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
      sourceUnavailable: candidate.sourceUnavailable,
      manualOverride: false,
    }).run();
    existingPairs.add(pairKey);
    created += 1;
    changed += 1;
  }

  for (const channel of existingChannels) {
    if (!channel.manualOverride) continue;
    if (channel.sourceUnavailable) continue;
    const sourceModel = (channel.sourceModel || '').trim();
    if (!sourceModel || !matchesModelPattern(sourceModel, modelPattern)) continue;
    const pairKey = buildChannelPairKey({
      accountId: channel.accountId,
      tokenId: channel.tokenId ?? null,
      oauthRouteUnitId: channel.oauthRouteUnitId ?? null,
      sourceModel: channel.sourceModel,
    });
    if (candidatePairs.has(pairKey)) continue;

    await db.update(schema.routeChannels)
      .set({ sourceUnavailable: true })
      .where(eq(schema.routeChannels.id, channel.id))
      .run();
    changed += 1;
  }

  return {
    createdChannels: created,
    changedChannels: changed,
  };
}

export async function rebuildAutomaticRouteChannelsByModelPattern(
  routeId: number,
  modelPattern: string,
  options: RebuildPatternRouteOptions = {},
): Promise<PatternRouteChannelSyncResult> {
  const removableChannels = await db.select().from(schema.routeChannels)
    .where(
      and(
        eq(schema.routeChannels.routeId, routeId),
        eq(schema.routeChannels.manualOverride, false),
      ),
    )
    .all();

  for (const channel of removableChannels) {
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
  }

  const populated = await populateRouteChannelsByModelPattern(routeId, modelPattern, options);
  if (removableChannels.length > 0 || populated.changedChannels > 0) {
    await clearRouteDecisionSnapshot(routeId);
  }

  return {
    rebuiltRoutes: 1,
    routeIds: [routeId],
    removedChannels: removableChannels.length,
    createdChannels: populated.createdChannels,
    changedChannels: populated.changedChannels,
  };
}

export async function rebuildAllPatternRouteChannels(
  options: RebuildPatternRouteOptions = {},
): Promise<PatternRouteChannelSyncResult> {
  const patternRoutes = (await db.select().from(schema.tokenRoutes).all())
    .filter((route) => route.enabled && isPatternGroupRoute(route));

  const result: PatternRouteChannelSyncResult = {
    rebuiltRoutes: 0,
    routeIds: [],
    removedChannels: 0,
    createdChannels: 0,
    changedChannels: 0,
  };

  for (const route of patternRoutes) {
    const routeResult = await rebuildAutomaticRouteChannelsByModelPattern(route.id, route.modelPattern, options);
    result.rebuiltRoutes += 1;
    result.routeIds.push(route.id);
    result.removedChannels += routeResult.removedChannels;
    result.createdChannels += routeResult.createdChannels;
    result.changedChannels += routeResult.changedChannels;
  }

  if (result.removedChannels > 0 || result.changedChannels > 0) {
    await clearRouteDecisionSnapshots(result.routeIds);
  }

  return result;
}

export async function syncPatternRouteChannelsAfterAffectedRouteChanges(
  input: SyncPatternRouteChannelsAfterAffectedRouteChangesInput = {},
): Promise<PatternRouteChannelSyncResult> {
  const affectedRouteIds = normalizeAffectedRouteIds(input.affectedRouteIds);
  const removedExactModelPatterns = collectRemovedExactModelPatterns(input.removedRoutes);
  if (affectedRouteIds.length === 0 && removedExactModelPatterns.length === 0) {
    return createEmptyPatternRouteChannelSyncResult();
  }

  let hasAffectedExactSourceRoute = false;
  if (affectedRouteIds.length > 0) {
    const routes = await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, affectedRouteIds))
      .all();

    hasAffectedExactSourceRoute = routes.some(isExactSourceRoute);
  }

  if (!hasAffectedExactSourceRoute && removedExactModelPatterns.length === 0) {
    return createEmptyPatternRouteChannelSyncResult();
  }

  return rebuildAllPatternRouteChannels({
    excludeExactModelPatterns: removedExactModelPatterns,
  });
}
