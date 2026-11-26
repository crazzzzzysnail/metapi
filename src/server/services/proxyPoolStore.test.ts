import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProxyPoolCache,
  proxyPoolDefaultUrl,
  proxyPoolHasId,
  proxyPoolUrlOf,
  setProxyPoolCache,
} from './proxyPoolStore.js';

describe('proxyPoolStore', () => {
  beforeEach(() => {
    clearProxyPoolCache();
  });

  it('indexes normalized urls by id and keeps the first default', () => {
    setProxyPoolCache([
      { id: 2, url: 'socks5://127.0.0.1:1080/', isDefault: false },
      { id: 1, url: ' http://127.0.0.1:7890 ', isDefault: true },
      { id: 3, url: 'http://127.0.0.1:8888', isDefault: true },
    ]);

    expect(proxyPoolUrlOf(1)).toBe('http://127.0.0.1:7890');
    expect(proxyPoolUrlOf(2)).toBe('socks5://127.0.0.1:1080');
    // 多条默认属脏数据，缓存只认第一条，与服务端播种修正口径一致
    expect(proxyPoolDefaultUrl()).toBe('http://127.0.0.1:7890');
  });

  it('skips invalid urls so they cannot be resolved', () => {
    setProxyPoolCache([
      { id: 1, url: 'ftp://127.0.0.1:21', isDefault: true },
      { id: 2, url: 'not-a-url', isDefault: false },
    ]);

    expect(proxyPoolUrlOf(1)).toBeNull();
    expect(proxyPoolUrlOf(2)).toBeNull();
    expect(proxyPoolDefaultUrl()).toBeNull();
  });

  it('treats missing ids as unselected', () => {
    setProxyPoolCache([{ id: 1, url: 'http://127.0.0.1:7890', isDefault: false }]);
    expect(proxyPoolUrlOf(null)).toBeNull();
    expect(proxyPoolUrlOf(undefined)).toBeNull();
    expect(proxyPoolUrlOf(99)).toBeNull();
    expect(proxyPoolHasId(1)).toBe(true);
    expect(proxyPoolHasId(99)).toBe(false);
  });

  it('replaces the whole cache on each set and clears on demand', () => {
    setProxyPoolCache([{ id: 1, url: 'http://127.0.0.1:7890', isDefault: true }]);
    setProxyPoolCache([{ id: 5, url: 'http://127.0.0.1:7890', isDefault: false }]);

    expect(proxyPoolHasId(1)).toBe(false);
    expect(proxyPoolHasId(5)).toBe(true);
    expect(proxyPoolDefaultUrl()).toBeNull();

    clearProxyPoolCache();
    expect(proxyPoolHasId(5)).toBe(false);
  });
});
