import { describe, expect, it } from 'vitest';
import {
  buildBatchProxyFields,
  isValidProxyUrlValue,
  proxyPoolLabel,
  proxyPoolOptionLabel,
  resolveEffectiveProxy,
  type ProxyPoolSummary,
} from './proxySelection.js';

const pool: ProxyPoolSummary[] = [
  { id: 1, name: '池甲', url: 'http://127.0.0.1:7890' },
  { id: 2, name: '池乙', url: 'socks5://127.0.0.1:1080' },
];

describe('resolveEffectiveProxy', () => {
  it('prefers a custom address over pool and system', () => {
    expect(resolveEffectiveProxy({
      proxyUrl: 'http://custom.example:8080',
      proxyId: 1,
      useSystemProxy: true,
    }, pool)).toBe('custom');
  });

  it('prefers a pool reference over the system toggle', () => {
    expect(resolveEffectiveProxy({ proxyId: 2, useSystemProxy: true }, pool)).toBe('pool');
  });

  it('uses the system cell only when explicitly checked', () => {
    expect(resolveEffectiveProxy({ useSystemProxy: true }, pool)).toBe('system');
    expect(resolveEffectiveProxy({ useSystemProxy: false }, pool)).toBe('direct');
    expect(resolveEffectiveProxy({}, pool)).toBe('direct');
  });

  it('treats blank custom strings and unknown pool ids as empty cells', () => {
    expect(resolveEffectiveProxy({ proxyUrl: '   ' }, pool)).toBe('direct');
    // 池里查不到的 id 视为该格未选，不能按“有 id 就是池”处理
    expect(resolveEffectiveProxy({ proxyId: 99 }, pool)).toBe('direct');
    expect(resolveEffectiveProxy({ proxyId: 99, useSystemProxy: true }, pool)).toBe('system');
  });
});

describe('proxyPoolLabel', () => {
  it('returns the entry name when present', () => {
    expect(proxyPoolLabel(pool, 1)).toBe('池甲');
  });

  it('falls back to the id when the entry is missing', () => {
    expect(proxyPoolLabel(pool, 99)).toBe('#99');
  });

  it('returns an empty string for no id', () => {
    expect(proxyPoolLabel(pool, null)).toBe('');
    expect(proxyPoolLabel(pool, undefined)).toBe('');
  });
});

describe('proxyPoolOptionLabel', () => {
  it('shows only the name and default marker, never the url', () => {
    const longUrl = 'socks5://userA:secret@proxy.example.com:1080/?ticket=very-long-token-value';
    expect(proxyPoolOptionLabel({ id: 1, name: '池甲', url: longUrl, isDefault: true })).toBe('池甲 · 默认');
    expect(proxyPoolOptionLabel({ id: 2, name: '池乙', url: longUrl, isDefault: false })).toBe('池乙');
  });

  it('does not leak credentials even when the name itself is long', () => {
    const entry = { id: 3, name: '很长的代理备注名称'.repeat(20), url: 'http://userA:secret@host:8080' };
    expect(proxyPoolOptionLabel(entry)).toBe(entry.name);
  });
});

describe('buildBatchProxyFields', () => {
  it('maps the custom mode to a single address cell', () => {
    expect(buildBatchProxyFields('custom', { proxyUrl: '  http://a:1  ', proxyId: 2 }))
      .toEqual({ proxyUrl: 'http://a:1', proxyId: null, useSystemProxy: false });
  });

  it('maps the pool mode to a single reference cell', () => {
    expect(buildBatchProxyFields('pool', { proxyUrl: 'http://a:1', proxyId: 2 }))
      .toEqual({ proxyUrl: '', proxyId: 2, useSystemProxy: false });
  });

  it('maps the system mode to the system toggle', () => {
    expect(buildBatchProxyFields('system', { proxyUrl: 'http://a:1', proxyId: 2 }))
      .toEqual({ proxyUrl: '', proxyId: null, useSystemProxy: true });
  });

  it('clears all three cells in clear mode', () => {
    expect(buildBatchProxyFields('clear', { proxyUrl: 'http://a:1', proxyId: 2 }))
      .toEqual({ proxyUrl: '', proxyId: null, useSystemProxy: false });
  });
});

describe('isValidProxyUrlValue', () => {
  it('accepts supported proxy protocols', () => {
    expect(isValidProxyUrlValue('http://127.0.0.1:7890')).toBe(true);
    expect(isValidProxyUrlValue('https://proxy.example:443')).toBe(true);
    expect(isValidProxyUrlValue('socks5://127.0.0.1:1080')).toBe(true);
    expect(isValidProxyUrlValue('socks5h://127.0.0.1:1080')).toBe(true);
  });

  it('rejects other protocols and unparsable values', () => {
    expect(isValidProxyUrlValue('ftp://127.0.0.1:21')).toBe(false);
    expect(isValidProxyUrlValue('127.0.0.1:7890')).toBe(false);
    expect(isValidProxyUrlValue('')).toBe(false);
  });
});
