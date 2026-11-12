import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { CurrencyProvider, useCurrency, type CurrencyContextValue } from './currencyContext.js';

/**
 * CurrencyContext 的行为契约（F1）。
 *
 * 为什么值得单独立一个文件：这个 Provider 是全站金额换算的唯一数据源，
 * 而它此前**没有任何直接测试** —— 各页面测试都没挂 Provider，useCurrency()
 * 落到 EMPTY_CONTEXT，等于真实逻辑一次都没被执行过。
 *
 * 重点锁三件事：
 *   ① 汇率来自专用端点而非站点全量（B1 解耦的目的）；
 *   ② cnyPerUsd 为 null / 0 / 负数的站点必须视为未知（getSiteRate → null），
 *      绝不能退化成 0 或 1，那会把金额悄悄算错；
 *   ③ 切换币种落库失败要回滚，不能出现"界面 ¥ / 服务端 USD"的分裂。
 *
 * 写法沿用仓库既有范式：react-test-renderer（项目未安装 @testing-library），
 * 用一个探针组件把 context 值捕获到闭包里再断言。
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getRuntimeSettings: vi.fn(),
    getCurrencyRates: vi.fn(),
    updateRuntimeSettings: vi.fn(),
    getSites: vi.fn(),
  },
}));

vi.mock('./api.js', () => ({ api: apiMock }));

function mountCurrency(): { read: () => CurrencyContextValue; unmount: () => void } {
  let current: CurrencyContextValue | null = null;
  const Probe = () => {
    current = useCurrency();
    return null;
  };
  let root!: ReturnType<typeof create>;
  act(() => {
    root = create(
      <CurrencyProvider>
        <Probe />
      </CurrencyProvider>,
    );
  });
  return {
    read: () => {
      if (!current) throw new Error('context 未被挂载');
      return current;
    },
    unmount: () => act(() => { root.unmount(); }),
  };
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getRuntimeSettings.mockResolvedValue({ displayCurrency: 'USD' });
  apiMock.getCurrencyRates.mockResolvedValue({
    rates: [
      { siteId: 271, cnyPerUsd: 7.3 },
      { siteId: 266, cnyPerUsd: null },   // 汇率未知
      { siteId: 272, cnyPerUsd: 0 },      // 非法
      { siteId: 273, cnyPerUsd: -1 },     // 非法
      { siteId: 0, cnyPerUsd: 9 },        // 非法站点 id
    ],
    generatedAt: '2026-11-11T00:00:00.000Z',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CurrencyProvider', () => {
  it('reads rates from the dedicated endpoint and keeps only valid ones', async () => {
    const h = mountCurrency();
    try {
      await flush();
      // 关键：不再拉站点全量 —— 这正是 B1 拆端点的目的
      expect(apiMock.getSites).not.toHaveBeenCalled();
      expect(apiMock.getCurrencyRates).toHaveBeenCalledTimes(1);
      expect(h.read().loaded).toBe(true);

      expect(h.read().getSiteRate(271)).toBe(7.3);
      expect(h.read().getSiteRate(266)).toBeNull();
      expect(h.read().getSiteRate(272)).toBeNull();
      expect(h.read().getSiteRate(273)).toBeNull();
      expect(h.read().getSiteRate(9999)).toBeNull();
      expect(h.read().getSiteRate(null)).toBeNull();
    } finally {
      h.unmount();
    }
  });

  /**
   * F3 新增：未维护汇率的活跃站点数必须能被数出来。
   *
   * 立这条的直接原因是我做过一次负控制 —— 把 map 改回"只存有效值"（丢弃 null 行）
   * 之后，上面那组断言**依然全部通过**，因为 getSiteRate 对"缺键"和"值为 null"
   * 返回的都是 null，两者不可区分。也就是说这个计数若写坏了，原有测试抓不住。
   *
   * 期望值按 fixture 算：266(null)、272(0)、273(-1)、siteId 0 被过滤掉不进 map，
   * 所以未知 = 266 / 272 / 273 三站。
   */
  it('counts active sites whose rate is unmaintained or invalid', async () => {
    const h = mountCurrency();
    try {
      await flush();
      expect(h.read().unknownRateSiteCount).toBe(3);
      // F4：计数与可跳转 id 必须同源 —— 否则提示说「已排除 3 个」，
      // 点进去却只能处理 2 个，用户会以为剩下的不存在。
      expect(h.read().unknownRateSiteIds).toEqual([266, 272, 273]);
      expect(h.read().unknownRateSiteIds).toHaveLength(h.read().unknownRateSiteCount);
    } finally {
      h.unmount();
    }
  });

  it('reports zero unknown-rate sites when every site has a valid rate', async () => {
    apiMock.getCurrencyRates.mockResolvedValue({
      rates: [
        { siteId: 1, cnyPerUsd: 7.3 },
        { siteId: 2, cnyPerUsd: 1 },
      ],
      generatedAt: '',
    });
    const h = mountCurrency();
    try {
      await flush();
      expect(h.read().unknownRateSiteCount).toBe(0);
      expect(h.read().unknownRateSiteIds).toEqual([]);
      expect(h.read().getSiteRate(1)).toBe(7.3);
    } finally {
      h.unmount();
    }
  });

  it('reports not-loaded until the first probe settles', async () => {
    let resolveRates: (v: unknown) => void = () => {};
    apiMock.getCurrencyRates.mockReturnValue(new Promise((r) => { resolveRates = r; }));

    const h = mountCurrency();
    try {
      expect(h.read().currency).toBe('USD');
      expect(h.read().loaded).toBe(false);

      await act(async () => { resolveRates({ rates: [], generatedAt: '' }); });
      expect(h.read().loaded).toBe(true);
    } finally {
      h.unmount();
    }
  });

  it('falls back to USD when the runtime probe fails instead of throwing', async () => {
    apiMock.getRuntimeSettings.mockRejectedValue(new Error('network down'));
    const h = mountCurrency();
    try {
      await flush();
      expect(h.read().currency).toBe('USD');
      expect(h.read().loaded).toBe(true);
    } finally {
      h.unmount();
    }
  });

  it('toggles currency optimistically and persists the new value', async () => {
    apiMock.updateRuntimeSettings.mockResolvedValue({ success: true });
    const h = mountCurrency();
    try {
      await flush();

      await act(async () => { await h.read().toggleCurrency(); });
      expect(h.read().currency).toBe('CNY');
      expect(apiMock.updateRuntimeSettings).toHaveBeenCalledWith({ displayCurrency: 'CNY' });

      await act(async () => { await h.read().toggleCurrency(); });
      expect(h.read().currency).toBe('USD');
      expect(h.read().toggling).toBe(false);
    } finally {
      h.unmount();
    }
  });

  /**
   * 乐观更新先改本地、再落库，那么落库失败就**必须回滚**。
   * 少了回滚会出现"界面显示 ¥、服务端仍是 USD"，刷新后数字又变回去 ——
   * 用户只会认为设置没保存。这条是最容易被漏掉的分支。
   */
  it('rolls back the optimistic switch when persisting fails', async () => {
    apiMock.updateRuntimeSettings.mockRejectedValue(new Error('403'));
    const h = mountCurrency();
    try {
      await flush();

      await act(async () => {
        await h.read().toggleCurrency().catch(() => undefined);
      });

      expect(h.read().currency).toBe('USD');
      expect(h.read().toggling).toBe(false);
    } finally {
      h.unmount();
    }
  });
});
