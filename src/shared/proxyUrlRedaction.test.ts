import { describe, expect, it } from 'vitest';
import {
  PROXY_MASK_MARKER,
  containsMaskMarker,
  hasProxyCredentials,
  redactProxyUrl,
} from './proxyUrlRedaction.js';

/** 与 OAuth 页原内联实现逐字符对齐的用例集（上提为共享实现后的对拍） */
describe('redactProxyUrl', () => {
  it('用户名替换为掩码并删除密码', () => {
    expect(redactProxyUrl('http://user:{{PASSWORD_ae0q4q8f}}@proxy.example.com:8080'))
      .toBe(`http://${PROXY_MASK_MARKER}@proxy.example.com:8080`);
  });

  it('仅有用户名时同样掩码', () => {
    expect(redactProxyUrl('socks5://onlyuser@proxy.example.com:1080'))
      .toBe(`socks5://${PROXY_MASK_MARKER}@proxy.example.com:1080`);
  });

  it('无凭据时原样返回', () => {
    expect(redactProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
    expect(redactProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });

  it('根路径去掉尾部斜杠，非根路径保留', () => {
    expect(redactProxyUrl('http://proxy.example.com/')).toBe('http://proxy.example.com');
    expect(redactProxyUrl('http://proxy.example.com/a/b')).toBe('http://proxy.example.com/a/b');
  });

  it('带查询或片段时保留原序列化结果', () => {
    expect(redactProxyUrl('http://u:{{PASSWORD_ae0q4q8f}}@proxy.example.com/?x=1'))
      .toBe(`http://${PROXY_MASK_MARKER}@proxy.example.com/?x=1`);
  });

  it('解析失败走正则兜底', () => {
    expect(redactProxyUrl('not a url but //secret:{{PASSWORD_ae0q4q8f}}@host'))
      .toBe('not a url but //***@host');
  });

  it('空值返回空串', () => {
    expect(redactProxyUrl('')).toBe('');
    expect(redactProxyUrl(null)).toBe('');
    expect(redactProxyUrl(undefined)).toBe('');
  });
});

describe('hasProxyCredentials', () => {
  it('识别用户名/密码组合', () => {
    expect(hasProxyCredentials('http://user:{{PASSWORD_ae0q4q8f}}@h:1')).toBe(true);
    expect(hasProxyCredentials('socks5://user@h:1')).toBe(true);
  });

  it('无凭据与空值返回 false', () => {
    expect(hasProxyCredentials('http://127.0.0.1:7890')).toBe(false);
    expect(hasProxyCredentials('')).toBe(false);
    expect(hasProxyCredentials(null)).toBe(false);
  });

  it('解析失败时按正则兜底判断', () => {
    expect(hasProxyCredentials('weird //u:{{PASSWORD_ae0q4q8f}}@host')).toBe(true);
    expect(hasProxyCredentials('weird-host-no-credentials')).toBe(false);
  });
});

describe('containsMaskMarker', () => {
  it('检出字面掩码标记', () => {
    expect(containsMaskMarker('http://***@proxy.example.com:8080')).toBe(true);
    expect(containsMaskMarker('http://u:***@h')).toBe(true);
  });

  it('检出用户名/密码里的星号', () => {
    expect(containsMaskMarker('http://pa*s:p@h')).toBe(true);
  });

  it('正常地址返回 false', () => {
    expect(containsMaskMarker('http://user:{{PASSWORD_ae0q4q8f}}@h:1')).toBe(false);
    expect(containsMaskMarker('http://127.0.0.1:7890')).toBe(false);
    expect(containsMaskMarker('')).toBe(false);
    expect(containsMaskMarker(null)).toBe(false);
  });
});
