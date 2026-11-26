import { describe, expect, it } from 'vitest';
import { normalizeSiteProxyUrl, parseSiteProxyUrlInput } from './proxyUrlNormalize.js';

describe('normalizeSiteProxyUrl', () => {
  it('trims, keeps supported protocols and drops trailing slashes', () => {
    expect(normalizeSiteProxyUrl('  http://127.0.0.1:7890/  ')).toBe('http://127.0.0.1:7890');
    expect(normalizeSiteProxyUrl('SOCKS5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
    expect(normalizeSiteProxyUrl('https://proxy.example:443')).toBe('https://proxy.example');
  });

  it('rejects blank, non-string and unsupported protocols', () => {
    expect(normalizeSiteProxyUrl('')).toBeNull();
    expect(normalizeSiteProxyUrl('   ')).toBeNull();
    expect(normalizeSiteProxyUrl(null)).toBeNull();
    expect(normalizeSiteProxyUrl(123)).toBeNull();
    expect(normalizeSiteProxyUrl('ftp://127.0.0.1:21')).toBeNull();
    expect(normalizeSiteProxyUrl('not-a-url')).toBeNull();
  });
});

describe('parseSiteProxyUrlInput', () => {
  it('distinguishes an absent field from an explicit clear', () => {
    expect(parseSiteProxyUrlInput(undefined)).toEqual({ present: false, valid: true, proxyUrl: null });
    expect(parseSiteProxyUrlInput(null)).toEqual({ present: true, valid: true, proxyUrl: null });
    expect(parseSiteProxyUrlInput('   ')).toEqual({ present: true, valid: true, proxyUrl: null });
  });

  it('reports present-but-invalid values without silently clearing', () => {
    expect(parseSiteProxyUrlInput('ftp://127.0.0.1:21')).toEqual({ present: true, valid: false, proxyUrl: null });
    expect(parseSiteProxyUrlInput(123)).toEqual({ present: true, valid: false, proxyUrl: null });
  });

  it('normalizes valid input', () => {
    expect(parseSiteProxyUrlInput(' http://127.0.0.1:7890/ '))
      .toEqual({ present: true, valid: true, proxyUrl: 'http://127.0.0.1:7890' });
  });
});
