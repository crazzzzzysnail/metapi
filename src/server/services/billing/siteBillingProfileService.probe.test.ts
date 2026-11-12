import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 探测写库的来源优先级（F7 回归）。
 *
 * 缺陷现场：站点汇率先被手动设成 10，再点「探测上游汇率」，上游给的是 7.3，
 * 结果库里的值仍是 10、来源仍写「手动」——同一函数既服务"保存后的静默探测"
 * 又服务"用户显式点探测"，两者意图被混成一条规则。
 *
 * 这里用可控的假 db 直接观察写库补丁，不依赖真实 SQLite：
 * 断言的是"到底写不写、写成什么来源"，而不是 drizzle 的行为。
 */

const hoisted = vi.hoisted(() => {
  const state: {
    row: Record<string, unknown> | null;
    patch: Record<string, unknown> | null;
  } = { row: null, patch: null };
  return { state };
});

vi.mock('../../db/index.js', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    get: () => hoisted.state.row,
    all: () => [],
  };
  const insertChain = {
    values: (values: Record<string, unknown>) => {
      hoisted.state.patch = { ...values };
      hoisted.state.row = { ...(hoisted.state.row || {}), ...values };
      return insertChain;
    },
    // 冲突更新用同一份补丁；这里只需知道写了什么
    onConflictDoUpdate: () => insertChain,
    run: () => ({ changes: 1 }),
  };
  return {
    db: {
      select: () => selectChain,
      insert: () => insertChain,
    },
    schema: {
      siteBillingProfiles: {
        siteId: 'siteId',
        cnyPerUsd: 'cnyPerUsd',
        quotaPerUnit: 'quotaPerUnit',
        rateSource: 'rateSource',
        quotaSource: 'quotaSource',
        capturedAt: 'capturedAt',
      },
    },
  };
});

const { probeAndPersistSiteBillingProfile } = await import('./siteBillingProfileService.js');

const SITE = { id: 1, url: 'https://siteA.example' };

/** 构造一个按 /api/status 返回给定数据的探测桩。 */
function statusStub(data: Record<string, unknown>) {
  return vi.fn(async (_url: string, _init?: unknown) => ({ data }));
}

function seedManual(rate: number, quota?: number) {
  hoisted.state.row = {
    siteId: SITE.id,
    cnyPerUsd: rate,
    rateSource: 'manual',
    quotaPerUnit: quota ?? null,
    quotaSource: quota === undefined ? null : 'manual',
    capturedAt: '2026-11-01T00:00:00.000Z',
  };
  hoisted.state.patch = null;
}

describe('probeAndPersistSiteBillingProfile 来源优先级', () => {
  beforeEach(() => {
    hoisted.state.row = null;
    hoisted.state.patch = null;
  });

  it('保存后的静默探测：手动汇率不被上游覆盖', async () => {
    seedManual(10);
    const profile = await probeAndPersistSiteBillingProfile(SITE, statusStub({ price: 7.3 }));

    expect(profile.cnyPerUsd).toBe(10);
    expect(profile.rateSource).toBe('manual');
    // 没写任何字段时连 capturedAt 都不该动（探测没落地就不算"最近探测"）
    expect(profile.capturedAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('显式探测（overrideManual）：上游汇率覆盖手动值并改标 auto', async () => {
    seedManual(10);
    const profile = await probeAndPersistSiteBillingProfile(SITE, statusStub({ price: 7.3 }), {
      overrideManual: true,
    });

    expect(profile.cnyPerUsd).toBe(7.3);
    expect(profile.rateSource).toBe('auto');
    expect(profile.capturedAt).not.toBe('2026-11-01T00:00:00.000Z');
  });

  it('显式探测时手动标尺同样可被覆盖（两个字段同源同规则）', async () => {
    seedManual(10, 500000);
    const profile = await probeAndPersistSiteBillingProfile(
      SITE,
      statusStub({ price: 7.3, quota_per_unit: 1000000 }),
      { overrideManual: true },
    );

    expect(profile.quotaPerUnit).toBe(1000000);
    expect(profile.quotaSource).toBe('auto');
  });

  it('上游未提供汇率时显式探测也不清空手动值（不拿 null 覆盖）', async () => {
    seedManual(10);
    const profile = await probeAndPersistSiteBillingProfile(SITE, statusStub({ system_name: 'siteA' }), {
      overrideManual: true,
    });

    expect(profile.cnyPerUsd).toBe(10);
    expect(profile.rateSource).toBe('manual');
  });

  it('探测失败（请求抛错）不动已有值，且不写猜测值', async () => {
    seedManual(10);
    const failing = vi.fn(async () => {
      throw new Error('HTTP 502');
    });
    const profile = await probeAndPersistSiteBillingProfile(SITE, failing, { overrideManual: true });

    expect(failing).toHaveBeenCalledTimes(1);
    expect(profile.cnyPerUsd).toBe(10);
    expect(profile.rateSource).toBe('manual');
    expect(hoisted.state.patch).toBeNull();
  });

  it('首次探测（无档案行）写入 auto', async () => {
    const profile = await probeAndPersistSiteBillingProfile(SITE, statusStub({ price: 7.3 }));

    expect(profile.cnyPerUsd).toBe(7.3);
    expect(profile.rateSource).toBe('auto');
  });

  it('探测地址一律是 <站点>/api/status，尾部斜杠被裁掉', async () => {
    const request = statusStub({ price: 7.3 });
    await probeAndPersistSiteBillingProfile({ id: 2, url: 'https://siteB.example///' }, request);
    expect(request.mock.calls[0]?.[0]).toBe('https://siteB.example/api/status');
  });
});
