import { describe, expect, it } from 'vitest';
import {
  buildAccountFocusPath,
  buildEventNavigationPath,
  buildSiteFocusPath,
  buildUnknownRateSitesPath,
  clearFocusParams,
  readFocusAccountIntent,
  readFocusAnnouncementId,
  readFocusSiteId,
  readPendingSiteIds,
  readSiteEditorIntent,
} from './navigationFocus.js';

describe('navigationFocus helpers', () => {
  it('builds focus paths for site and account', () => {
    expect(buildSiteFocusPath(12)).toBe('/sites?focusSiteId=12');
    expect(buildSiteFocusPath(0)).toBe('/sites');
    expect(buildAccountFocusPath(34)).toBe('/accounts?focusAccountId=34');
    expect(buildAccountFocusPath(34, { openRebind: true })).toBe('/accounts?focusAccountId=34&openRebind=1');
    expect(buildAccountFocusPath(-1)).toBe('/accounts');
  });

  it('parses focus params from query string', () => {
    expect(readFocusSiteId('?focusSiteId=15')).toBe(15);
    expect(readFocusSiteId('?focusSiteId=abc')).toBeNull();
    expect(readFocusAnnouncementId('?focusAnnouncementId=21')).toBe(21);
    expect(readFocusAnnouncementId('?focusAnnouncementId=abc')).toBeNull();

    expect(readFocusAccountIntent('?focusAccountId=22&openRebind=1')).toEqual({
      accountId: 22,
      openRebind: true,
    });
    expect(readFocusAccountIntent('?focusAccountId=22&openRebind=true')).toEqual({
      accountId: 22,
      openRebind: true,
    });
    expect(readFocusAccountIntent('?focusAccountId=22')).toEqual({
      accountId: 22,
      openRebind: false,
    });
  });

  it('clears focus params but keeps other params', () => {
    expect(clearFocusParams('?focusSiteId=12&q=abc')).toBe('?q=abc');
    expect(clearFocusParams('?focusAnnouncementId=44&type=site_notice')).toBe('?type=site_notice');
    expect(clearFocusParams('?focusAccountId=2&openRebind=1&type=token')).toBe('?type=token');
    expect(clearFocusParams('?focusAccountId=2')).toBe('');
  });

  // F4：汇率未知提示 → 站点编辑弹窗汇率框。
  describe('unknown rate site navigation', () => {
    it('builds a single-site path that opens the editor on the rate field', () => {
      const path = buildUnknownRateSitesPath([7]);
      expect(path).toBe('/sites?focusSiteId=7&editTarget=site&editField=cnyRate');
      // 读过一遍就必须能被站点页识别为"打开弹窗并聚焦汇率框"
      expect(readSiteEditorIntent(path.slice(path.indexOf('?')))).toEqual({ siteId: 7, field: 'cnyRate' });
      // 单站点场景没有排队队列
      expect(readPendingSiteIds(path.slice(path.indexOf('?')))).toEqual([]);
    });

    it('builds a multi-site path that opens the first site and queues the rest', () => {
      const path = buildUnknownRateSitesPath([3, 9, 12]);
      const search = path.slice(path.indexOf('?'));
      expect(path).toBe('/sites?focusSiteId=3&editTarget=site&editField=cnyRate&pendingSiteIds=9,12');
      // 首个站点照常开弹窗（用户点的这条提示总要落到一个具体动作上）
      expect(readSiteEditorIntent(search)).toEqual({ siteId: 3, field: 'cnyRate' });
      // 其余站点进横幅队列，逐个处理
      expect(readPendingSiteIds(search)).toEqual([9, 12]);
    });

    it('drops invalid and duplicate ids instead of forwarding them', () => {
      expect(buildUnknownRateSitesPath([])).toBe('/sites');
      expect(buildUnknownRateSitesPath([0, -1, Number.NaN])).toBe('/sites');
      const deduped = buildUnknownRateSitesPath([5, 5, 6]);
      expect(deduped).toBe('/sites?focusSiteId=5&editTarget=site&editField=cnyRate&pendingSiteIds=6');
    });

    it('ignores an editTarget that is not exactly "site"', () => {
      // 负控制：去掉 editTarget 或换成别的值都不该弹窗，否则普通 focusSiteId 跳转
      // （比如事件中心点站点）会意外弹出编辑框
      expect(readSiteEditorIntent('?focusSiteId=7&editTarget=sites&editField=cnyRate')).toBeNull();
      expect(readSiteEditorIntent('?focusSiteId=7&editField=cnyRate')).toBeNull();
      // 字段名不合法时也不认，避免未来加了别的字段后被静默接受
      expect(readSiteEditorIntent('?focusSiteId=7&editTarget=site&editField=quotaPerUnit')).toBeNull();
      expect(readSiteEditorIntent('?focusSiteId=abc&editTarget=site&editField=cnyRate')).toBeNull();
    });

    it('clears the editor intent params along with focus params', () => {
      expect(clearFocusParams('?focusSiteId=7&editTarget=site&editField=cnyRate&q=abc')).toBe('?q=abc');
      expect(clearFocusParams('?focusSiteId=3&editTarget=site&editField=cnyRate&pendingSiteIds=9,12')).toBe('');
    });

    it('reads no queue when pendingSiteIds is absent or malformed', () => {
      expect(readPendingSiteIds('?focusSiteId=7&editTarget=site&editField=cnyRate')).toEqual([]);
      expect(readPendingSiteIds('?pendingSiteIds=abc,0,-3')).toEqual([]);
      expect(readPendingSiteIds('')).toEqual([]);
    });
  });

  it('builds event navigation path by related entity', () => {
    expect(buildEventNavigationPath({
      relatedType: 'account',
      relatedId: 18,
      type: 'token',
    })).toBe('/accounts?focusAccountId=18&openRebind=1');

    expect(buildEventNavigationPath({
      relatedType: 'account',
      relatedId: 18,
      type: 'checkin',
    })).toBe('/accounts?focusAccountId=18');

    expect(buildEventNavigationPath({
      relatedType: 'site',
      relatedId: 9,
      type: 'status',
    })).toBe('/sites?focusSiteId=9');

    expect(buildEventNavigationPath({
      relatedType: 'site_announcement',
      relatedId: 12,
      type: 'site_notice',
    })).toBe('/site-announcements?focusAnnouncementId=12');

    expect(buildEventNavigationPath({
      relatedType: 'route',
      relatedId: null,
      type: 'proxy',
    })).toBe('/routes');

    expect(buildEventNavigationPath({
      relatedType: 'update_center',
      relatedId: null,
      type: 'status',
    })).toBe('/settings');

    expect(buildEventNavigationPath({ type: 'proxy' })).toBe('/logs');
    expect(buildEventNavigationPath({ type: 'checkin' })).toBe('/checkin');
    expect(buildEventNavigationPath({ type: 'site_notice' })).toBe('/site-announcements');
    expect(buildEventNavigationPath({})).toBe('/events');
  });
});
