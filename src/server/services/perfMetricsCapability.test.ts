import { describe, expect, it } from 'vitest';
import {
  classifyPerfMetricsProbe,
  normalizePerfMetricsCapabilityInput,
} from './perfMetricsCapability.js';

/**
 * perf-metrics 能力分类单测（S2-2）。
 * 四态各钉正/负例，重点是 cred_invalid 与 none **不可合并**（Q9 裁定的核心区别）：
 * 前者=会话挂了，后者=站没这功能；混起来运维排查方向相反。
 */

describe('classifyPerfMetricsProbe', () => {
  it('匿名 200 → public', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 200 })).toBe('public');
    // 带凭据也 200 不改变结论（siteA 匿名与登录逐字节相同）
    expect(classifyPerfMetricsProbe({ anonStatus: 200, authedStatus: 200 })).toBe('public');
  });

  it('匿名 401 + 带凭据 200 → auth（siteC 形）', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 401, authedStatus: 200 })).toBe('auth');
  });

  it('匿名 403 + 带凭据 200 → auth', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 403, authedStatus: 200 })).toBe('auth');
  });

  it('匿名 401 + 带凭据仍 401 → cred_invalid（会话挂了，与 none 严格区分）', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 401, authedStatus: 401 })).toBe('cred_invalid');
    expect(classifyPerfMetricsProbe({ anonStatus: 403, authedStatus: 403 })).toBe('cred_invalid');
  });

  it('匿名 404 → none（无端点），不看凭据', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 404 })).toBe('none');
    expect(classifyPerfMetricsProbe({ anonStatus: 404, authedStatus: 200 })).toBe('none');
  });

  it('传输错误 → null（保持原列，绝不因抖动洗列）', () => {
    expect(classifyPerfMetricsProbe({ transportError: true })).toBeNull();
    // 匿名都没拿到状态码
    expect(classifyPerfMetricsProbe({})).toBeNull();
  });

  it('匿名要登录但带凭据结果不确定（404/超时/未发）→ null，不猜', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 401, authedStatus: 404 })).toBeNull();
    expect(classifyPerfMetricsProbe({ anonStatus: 401 })).toBeNull();
  });

  it('匿名 5xx → null（上游故障不等于能力缺失）', () => {
    expect(classifyPerfMetricsProbe({ anonStatus: 502 })).toBeNull();
  });

  // 负控制（L5）：若把 cred_invalid 误并入 none，这条必红。
  it('钉死 cred_invalid ≠ none（不可合并回退）', () => {
    const credInvalid = classifyPerfMetricsProbe({ anonStatus: 401, authedStatus: 403 });
    const none = classifyPerfMetricsProbe({ anonStatus: 404 });
    expect(credInvalid).toBe('cred_invalid');
    expect(none).toBe('none');
    expect(credInvalid).not.toBe(none);
  });
});

describe('normalizePerfMetricsCapabilityInput（PUT 值域守卫）', () => {
  it('null / 空串 → 清空为未探测', () => {
    expect(normalizePerfMetricsCapabilityInput(null)).toEqual({ ok: true, value: null });
    expect(normalizePerfMetricsCapabilityInput('')).toEqual({ ok: true, value: null });
  });

  it('四态合法值（含大小写与首尾空白）通过', () => {
    expect(normalizePerfMetricsCapabilityInput('PUBLIC')).toEqual({ ok: true, value: 'public' });
    expect(normalizePerfMetricsCapabilityInput(' cred_invalid ')).toEqual({ ok: true, value: 'cred_invalid' });
    expect(normalizePerfMetricsCapabilityInput('auth')).toEqual({ ok: true, value: 'auth' });
    expect(normalizePerfMetricsCapabilityInput('none')).toEqual({ ok: true, value: 'none' });
  });

  it('balance 那套 auto 别名不接受（perf 无 auto 语义）', () => {
    expect(normalizePerfMetricsCapabilityInput('auto')).toEqual({ ok: false });
  });

  it('非法值 / 非字符串拒绝', () => {
    expect(normalizePerfMetricsCapabilityInput('bogus')).toEqual({ ok: false });
    expect(normalizePerfMetricsCapabilityInput(42)).toEqual({ ok: false });
    expect(normalizePerfMetricsCapabilityInput(undefined)).toEqual({ ok: false });
  });
});
