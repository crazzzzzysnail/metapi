import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { clearProxyPoolCache, setProxyPoolCache } from './proxyPoolStore.js';
import { resolveHolderProxyUrl } from './proxyResolution.js';

const originalSystemProxyUrl = config.systemProxyUrl;

describe('resolveHolderProxyUrl', () => {
  beforeEach(() => {
    clearProxyPoolCache();
    config.systemProxyUrl = '';
  });

  afterAll(() => {
    config.systemProxyUrl = originalSystemProxyUrl;
    clearProxyPoolCache();
  });

  it('prefers the custom address and normalizes it', () => {
    expect(resolveHolderProxyUrl({
      proxyUrl: ' http://127.0.0.1:7890/ ',
      proxyId: 1,
      useSystemProxy: true,
    })).toBe('http://127.0.0.1:7890');
  });

  it('falls back to the pool entry when the custom address is empty', () => {
    setProxyPoolCache([{ id: 2, url: 'socks5://127.0.0.1:1080', isDefault: false }]);
    expect(resolveHolderProxyUrl({ proxyUrl: '', proxyId: 2, useSystemProxy: true }))
      .toBe('socks5://127.0.0.1:1080');
  });

  it('uses the pool default only when the system cell is checked', () => {
    setProxyPoolCache([{ id: 1, url: 'http://127.0.0.1:7890', isDefault: true }]);
    expect(resolveHolderProxyUrl({ useSystemProxy: true })).toBe('http://127.0.0.1:7890');
    // 未勾选时绝不被动套用池默认条目
    expect(resolveHolderProxyUrl({ useSystemProxy: false })).toBeNull();
    expect(resolveHolderProxyUrl({})).toBeNull();
  });

  it('falls back to the explicit system url or config when the pool has no default', () => {
    expect(resolveHolderProxyUrl({
      useSystemProxy: true,
      systemProxyUrl: 'http://mirror.example:8000',
    })).toBe('http://mirror.example:8000');

    config.systemProxyUrl = 'http://config.example:9000';
    expect(resolveHolderProxyUrl({ useSystemProxy: true })).toBe('http://config.example:9000');

    // 池默认条目优先于镜像地址
    setProxyPoolCache([{ id: 1, url: 'http://pool.example:7000', isDefault: true }]);
    expect(resolveHolderProxyUrl({
      useSystemProxy: true,
      systemProxyUrl: 'http://mirror.example:8000',
    })).toBe('http://pool.example:7000');
  });

  it('treats an unknown pool id as empty and moves to the next cell', () => {
    expect(resolveHolderProxyUrl({ proxyId: 99 })).toBeNull();
    expect(resolveHolderProxyUrl({ proxyId: 99, useSystemProxy: true, systemProxyUrl: 'http://mirror.example:8000' }))
      .toBe('http://mirror.example:8000');
  });

  it('returns null for a missing holder', () => {
    expect(resolveHolderProxyUrl(null)).toBeNull();
    expect(resolveHolderProxyUrl(undefined)).toBeNull();
  });
});
