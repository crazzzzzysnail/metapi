import { describe, expect, it } from 'vitest';
import { billingPlanToPerMillion, parseBillingExpr } from './billingExpr.js';

/**
 * 动态计费表达式解析（S5b 第一片）。
 *
 * 设计取向是**白名单 + 明确拒绝**：解析不出来的语法必须返回 unsupported，
 * 绝不能"尽力算一个数"。理由是这些数字直接决定用户看到的单价，
 * 一个看似合理的错数比一句"未解析"危害更大。
 */

describe('parseBillingExpr 接受范围', () => {
  it('解析取证到的真实形态 tier("base", p * 1 + c * 1)', () => {
    const plan = parseBillingExpr('tier("base", p * 1 + c * 1)');
    expect(plan).toEqual({
      kind: 'flat',
      tierName: 'base',
      rates: { input: 1, output: 1 },
    });
  });

  it('支持五个计量变量与任意顺序', () => {
    const plan = parseBillingExpr(
      'tier("standard", cc1h * 6 + c * 15 + cr * 0.3 + p * 3 + cc * 3.75)',
    );
    expect(plan.kind).toBe('flat');
    if (plan.kind !== 'flat') return;
    expect(plan.rates).toEqual({
      cacheWrite1h: 6,
      output: 15,
      cacheRead: 0.3,
      input: 3,
      cacheWrite: 3.75,
    });
  });

  it('系数写在前侧也接受', () => {
    const plan = parseBillingExpr('tier("base", 2 * p + 8 * c)');
    expect(plan.kind === 'flat' && plan.rates.input).toBe(2);
    expect(plan.kind === 'flat' && plan.rates.output).toBe(8);
  });

  it('裸变量按系数 1 处理', () => {
    const plan = parseBillingExpr('tier("base", p + c)');
    expect(billingPlanToPerMillion(plan)).toEqual({ input: 1, output: 1 });
  });

  it('只给输入价时不臆造输出价', () => {
    const plan = parseBillingExpr('tier("base", p * 3)');
    expect(plan.kind === 'flat' ? plan.rates.output : 'has').toBeUndefined();
  });
});

describe('parseBillingExpr 拒绝范围', () => {
  it('空表达式', () => {
    expect(parseBillingExpr('')).toMatchObject({ kind: 'unsupported', reason: 'empty-expr' });
    expect(parseBillingExpr(null)).toMatchObject({ kind: 'unsupported', reason: 'empty-expr' });
    expect(parseBillingExpr(undefined)).toMatchObject({ kind: 'unsupported', reason: 'empty-expr' });
  });

  it('多档 + 区间条件（方案设想的 v1:len <= 200000 ? … : … 形态）', () => {
    const complex = 'v1:len <= 200000 ? tier("standard", p * 3 + c * 15)'
      + ' : tier("long_context", p * 6 + c * 22.5)';
    expect(parseBillingExpr(complex)).toMatchObject({ kind: 'unsupported', reason: 'has-conditional' });
  });

  it('两个 tier 调用判为多档', () => {
    expect(parseBillingExpr('tier("a", p * 1) + tier("b", c * 1)'))
      .toMatchObject({ kind: 'unsupported', reason: 'multiple-tiers' });
  });

  it('不是 tier 调用', () => {
    expect(parseBillingExpr('fixed(0.002)')).toMatchObject({ kind: 'unsupported', reason: 'not-a-tier-call' });
    expect(parseBillingExpr('p * 1 + c * 1')).toMatchObject({ kind: 'unsupported', reason: 'not-a-tier-call' });
  });

  it('未知变量不得映射成任何计量项', () => {
    // img / ai / ao 等模态因子当前不支持；若误映射会给出错误单价
    expect(parseBillingExpr('tier("base", img * 0.1)'))
      .toMatchObject({ kind: 'unsupported', reason: 'unknown-variable' });
    expect(parseBillingExpr('tier("base", p * 1 + hour * 0.1)'))
      .toMatchObject({ kind: 'unsupported', reason: 'unknown-variable' });
  });

  it('含减法或畸形项一律拒绝', () => {
    expect(parseBillingExpr('tier("base", p * 1 - c * 0.5)'))
      .toMatchObject({ kind: 'unsupported', reason: 'malformed-term' });
    expect(parseBillingExpr('tier("base", p * )'))
      .toMatchObject({ kind: 'unsupported', reason: 'malformed-term' });
    expect(parseBillingExpr('tier("base", )'))
      .toMatchObject({ kind: 'unsupported', reason: 'malformed-term' });
  });

  it('拒绝时保留原文，便于人工补录', () => {
    const expr = 'tier("x", p * 1 + unknown_var * 2)';
    const plan = parseBillingExpr(expr);
    expect(plan.kind === 'unsupported' && plan.expr).toBe(expr);
  });
});

describe('安全性', () => {
  it('永不执行表达式：注入代码只会被当作非法语法', () => {
    const malicious = 'tier("base", p * 1 + require("fs").rmSync("/tmp/x"))';
    const plan = parseBillingExpr(malicious);
    expect(plan.kind).toBe('unsupported');
  });

  it('负系数被拒绝（不会出现负单价）', () => {
    expect(parseBillingExpr('tier("base", p * -1)'))
      .toMatchObject({ kind: 'unsupported' });
  });

  it('billingPlanToPerMillion 对 unsupported 返回 null 而不是 0', () => {
    expect(billingPlanToPerMillion(parseBillingExpr('garbage'))).toBeNull();
  });
});
