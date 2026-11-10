import { describe, expect, it } from 'vitest';
import { normalizeAutoGroups, resolveIncomingTokenMeta } from './accountTokenService.js';

/**
 * 令牌实际 auto 链路的规范化与落库判据（T4.4）。
 *
 * 载荷形态取自 2026-11-09 对 siteA `/api/token/` 的真实响应：
 *   test（group=auto）        → auto_groups = [grp-codex, grp-codex-pro, 组丁-chs]
 *   glm / deepseek / claude …  → **上游根本不返回 auto_groups 字段**
 *
 * 关键契约：**字段缺失（undefined）≠ 空链路（[]）**。
 * 把前者存成后者会让 UI 显示"该令牌没有链路"，而事实是"它是固定分组令牌，
 * 本就不走链路"——两种情况的处理方式完全不同，不能混为一谈。
 */

describe('normalizeAutoGroups', () => {
  it('保留上游顺序（cross_group_retry 下即重试次序）', () => {
    expect(normalizeAutoGroups(['grp-codex', 'grp-codex-pro', '组丁-chs']))
      .toEqual(['grp-codex', 'grp-codex-pro', '组丁-chs']);
  });

  it('剔除空白项并按首次出现去重', () => {
    expect(normalizeAutoGroups(['grp-codex', '', '  ', 'grp-codex-pro', 'grp-codex', ' 组丁-chs ']))
      .toEqual(['grp-codex', 'grp-codex-pro', '组丁-chs']);
  });

  it('非数组一律返回 undefined（表示"上游未提供"，不写库）', () => {
    for (const value of [undefined, null, 'grp-daily', {}, 42]) {
      expect(normalizeAutoGroups(value)).toBeUndefined();
    }
  });

  it('空数组是合法结果，且与 undefined 可区分', () => {
    expect(normalizeAutoGroups([])).toEqual([]);
    expect(normalizeAutoGroups([])).not.toBeUndefined();
  });

  it('非字符串元素被忽略，不产生 [object Object] 之类的垃圾分组名', () => {
    expect(normalizeAutoGroups(['ok', null, undefined, 7, {}, [], true]))
      .toEqual(['ok', '7']);
    // String({}) === '[object Object]' 会骗过非空过滤，必须按类型排除
    expect(normalizeAutoGroups([{}, []])).toEqual([]);
  });
});

describe('resolveIncomingTokenMeta 对链路的处理', () => {
  it('上游给了链路 → meta 带 autoGroups', () => {
    const meta = resolveIncomingTokenMeta({
      name: 'test',
      key: 'sk-x',
      tokenGroup: 'auto',
      autoGroups: ['grp-codex', 'grp-codex-pro'],
    });
    expect(meta.autoGroups).toEqual(['grp-codex', 'grp-codex-pro']);
    expect(meta.tokenGroup).toBe('auto');
  });

  it('上游没给链路 → meta 不含该键（不得写成空数组）', () => {
    const meta = resolveIncomingTokenMeta({ name: 'glm', key: 'sk-y', tokenGroup: '组丁' });
    expect('autoGroups' in meta).toBe(false);
  });

  it('上游明确给空链路 → 落库为空数组（与"未知"不同）', () => {
    const meta = resolveIncomingTokenMeta({ name: 'z', key: 'k', autoGroups: [] });
    expect(meta.autoGroups).toEqual([]);
  });

  it('链路里的空白项不会导致整字段被丢弃', () => {
    const meta = resolveIncomingTokenMeta({ name: 'z', key: 'k', autoGroups: ['', 'grp-daily'] });
    expect(meta.autoGroups).toEqual(['grp-daily']);
  });
});
