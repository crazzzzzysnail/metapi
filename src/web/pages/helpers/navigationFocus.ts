import { isTruthyFlag } from './accountConnection.js';

const FOCUS_SITE_ID_KEY = 'focusSiteId';
const FOCUS_ANNOUNCEMENT_ID_KEY = 'focusAnnouncementId';
const FOCUS_ACCOUNT_ID_KEY = 'focusAccountId';
const FOCUS_TOKEN_ID_KEY = 'focusTokenId';
const OPEN_REBIND_KEY = 'openRebind';
/**
 * F4：跨页直达时要求目标页「打开哪条记录的编辑弹窗」以及「焦点落在弹窗内哪个字段」。
 * 目前只有站点页的汇率输入框用到；新增取值时请同步扩展 SiteEditorFocusField。
 */
const EDIT_TARGET_KEY = 'editTarget';
const EDIT_FIELD_KEY = 'editField';

/** 站点编辑弹窗里可被外部定位的字段。取值进 URL，改名即是破坏兼容。 */
export type SiteEditorFocusField = 'cnyRate';

function normalizePositiveId(input: unknown): number | null {
  const value = Number.parseInt(String(input ?? ''), 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizePositiveIdList(input: unknown): number[] {
  const raw = String(input ?? '');
  if (!raw) return [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const id = normalizePositiveId(part);
    if (id) seen.add(id);
  }
  return [...seen];
}

export function buildSiteFocusPath(
  siteId: number,
  options?: { editField?: SiteEditorFocusField },
): string {
  const normalizedId = normalizePositiveId(siteId);
  if (!normalizedId) return '/sites';
  const params = new URLSearchParams();
  params.set(FOCUS_SITE_ID_KEY, String(normalizedId));
  // 只有要求直达编辑弹窗时才带 editTarget，纯滚动定位的老调用不受影响。
  if (options?.editField) {
    params.set(EDIT_TARGET_KEY, 'site');
    params.set(EDIT_FIELD_KEY, options.editField);
  }
  return `/sites?${params.toString()}`;
}

/**
 * F4：「汇率未知的站点」列表 → 站点管理页。
 *
 * 无论几个站点，都先打开第一个的编辑弹窗并定位到汇率框——这是用户点这条提示
 * 唯一想要的动作。多余的站点不能同时开弹窗，作为一个待办队列随 URL 带过去，
 * 由站点页顶部横幅逐个处理（继续处理 → 下一个）。
 */
export function buildUnknownRateSitesPath(siteIds: number[]): string {
  const ids = [...new Set(siteIds.map((id) => normalizePositiveId(id)).filter((id): id is number => !!id))];
  if (ids.length === 0) return '/sites';
  const path = buildSiteFocusPath(ids[0], { editField: 'cnyRate' });
  if (ids.length === 1) return path;
  return `${path}&pendingSiteIds=${ids.slice(1).join(',')}`;
}

export function buildAnnouncementFocusPath(announcementId: number): string {
  const normalizedId = normalizePositiveId(announcementId);
  if (!normalizedId) return '/site-announcements';
  return `/site-announcements?${FOCUS_ANNOUNCEMENT_ID_KEY}=${normalizedId}`;
}

export function buildAccountFocusPath(
  accountId: number,
  options?: { openRebind?: boolean; segment?: 'session' | 'apikey' | 'tokens' },
): string {
  const normalizedId = normalizePositiveId(accountId);
  if (!normalizedId) return '/accounts';
  const params = new URLSearchParams();
  if (options?.segment && options.segment !== 'session') params.set('segment', options.segment);
  params.set(FOCUS_ACCOUNT_ID_KEY, String(normalizedId));
  if (options?.openRebind) params.set(OPEN_REBIND_KEY, '1');
  return `/accounts?${params.toString()}`;
}

export function buildTokenFocusPath(tokenId: number): string {
  const normalizedId = normalizePositiveId(tokenId);
  if (!normalizedId) return '/accounts?segment=tokens';
  const params = new URLSearchParams();
  params.set('segment', 'tokens');
  params.set(FOCUS_TOKEN_ID_KEY, String(normalizedId));
  return `/accounts?${params.toString()}`;
}

export function readFocusSiteId(search: string): number | null {
  const params = new URLSearchParams(search);
  return normalizePositiveId(params.get(FOCUS_SITE_ID_KEY));
}

/**
 * F4：读取「直达站点编辑弹窗某字段」的意图。
 *
 * editTarget 必须恰好是 'site'，字段名必须白名单命中 —— 缺参数或字段名不认识
 * 都返回 null，宁可不弹窗，也不要弹出一个定位错的窗。
 */
export function readSiteEditorIntent(search: string): { siteId: number; field: SiteEditorFocusField } | null {
  const params = new URLSearchParams(search);
  if (params.get(EDIT_TARGET_KEY) !== 'site') return null;
  const siteId = normalizePositiveId(params.get(FOCUS_SITE_ID_KEY));
  if (!siteId) return null;
  const field = params.get(EDIT_FIELD_KEY);
  if (field !== 'cnyRate') return null;
  return { siteId, field };
}

/**
 * F4：多站点场景下排在首个站点之后的待办 id（首个站点本身不在列表里）。
 *
 * 不校验 editTarget：队列只由 pendingSiteIds 的存在决定，这样首个站点照常
 * 开弹窗（editTarget='site'），后续站点排进横幅，两者互不排斥。
 */
export function readPendingSiteIds(search: string): number[] {
  const params = new URLSearchParams(search);
  return normalizePositiveIdList(params.get('pendingSiteIds'));
}

export function readFocusAnnouncementId(search: string): number | null {
  const params = new URLSearchParams(search);
  return normalizePositiveId(params.get(FOCUS_ANNOUNCEMENT_ID_KEY));
}

export function readFocusAccountIntent(search: string): { accountId: number | null; openRebind: boolean } {
  const params = new URLSearchParams(search);
  return {
    accountId: normalizePositiveId(params.get(FOCUS_ACCOUNT_ID_KEY)),
    openRebind: isTruthyFlag(params.get(OPEN_REBIND_KEY)),
  };
}

export function readFocusTokenId(search: string): number | null {
  const params = new URLSearchParams(search);
  return normalizePositiveId(params.get(FOCUS_TOKEN_ID_KEY));
}

export function clearFocusParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(FOCUS_SITE_ID_KEY);
  params.delete(FOCUS_ANNOUNCEMENT_ID_KEY);
  params.delete(FOCUS_ACCOUNT_ID_KEY);
  params.delete(FOCUS_TOKEN_ID_KEY);
  params.delete(OPEN_REBIND_KEY);
  params.delete(EDIT_TARGET_KEY);
  params.delete(EDIT_FIELD_KEY);
  params.delete('pendingSiteIds');
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function buildEventNavigationPath(event: {
  relatedType?: string | null;
  relatedId?: number | null;
  type?: string | null;
}): string {
  const relatedType = (event.relatedType || '').toLowerCase();
  const relatedId = normalizePositiveId(event.relatedId);
  const eventType = (event.type || '').toLowerCase();

  if (relatedType === 'account' && relatedId) {
    return buildAccountFocusPath(relatedId, { openRebind: eventType === 'token' });
  }
  if (relatedType === 'site' && relatedId) {
    return buildSiteFocusPath(relatedId);
  }
  if (relatedType === 'site_announcement' && relatedId) {
    return buildAnnouncementFocusPath(relatedId);
  }
  if (relatedType === 'update_center') {
    return '/settings';
  }
  if (relatedType === 'route') {
    return '/routes';
  }
  if (eventType === 'proxy') {
    return '/logs';
  }
  if (eventType === 'checkin') {
    return '/checkin';
  }
  if (eventType === 'site_notice') {
    return '/site-announcements';
  }

  return '/events';
}
