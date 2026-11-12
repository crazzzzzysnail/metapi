/**
 * 显示币种的单一出处（4 / 5 / 7）。
 *
 * 背景：`displayCurrency` 原先只在模型广场与设置页各自 fetch、各自存 state，
 * 而路由通道和使用日志压根没有币种概念 —— 同一个价在三处显示成三种样子
 * （模型广场 ¥3.2、路由通道 `0.8/3.2 USD /1M`、日志 `$0.006934`）。
 * 这里收敛成一个共享只读源，各页面订阅同一份口径。
 *
 * 汇率来源与模型广场一致：站点的 `billingProfile.cnyPerUsd`（逐站维护，不猜全局汇率）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import type { DisplayCurrency } from './numberFormat.js';

export interface CurrencyContextValue {
  currency: DisplayCurrency;
  /** 站点汇率；null = 未知（调用方须显式标注，不得回退成美元数字冒充人民币）。 */
  getSiteRate: (siteId: number | null | undefined) => number | null;
  /** 汇率档案是否已就绪；未就绪时调用方应显示占位而不是猜测值。 */
  loaded: boolean;
  /**
   * 活跃站点里有多少个汇率未维护（F3）。
   *
   * 由 context 统一算，而不是各页面自己拉 getSites() 数一遍：后者会与这里的
   * 汇率表成两个数据源，站点改完汇率两边刷新时机不同就对不上。
   * 端点以活跃站点为基准返回（含无档案的行，值为 null），所以这个数是完整的；
   * 未加载完成时返回 0，调用方须配合 loaded 判断，不能据此断言"全都设好了"。
   */
  unknownRateSiteCount: number;
  /**
   * F4：汇率未维护的活跃站点 id（升序）。
   *
   * 与 unknownRateSiteCount 同一口径、同一个 Map 派生，这样「已排除 N 个」这句提示
   * 和它点击后能跳转到的站点数必然一致；各页面不要再自己拉站点表数第二遍。
   */
  unknownRateSiteIds: number[];
  /** 设置页保存后重新拉取，让币种切换立即生效。 */
  refresh: () => Promise<void>;
  /**
   * 在 USD / CNY 之间切换并落库（顶栏按钮用）。
   * 返回 Promise 以便调用方在失败时提示——币种是服务端配置，不是纯前端开关。
   */
  toggleCurrency: () => Promise<void>;
  /** 切换进行中；用于禁用按钮避免连点写乱。 */
  toggling: boolean;
}

const EMPTY_CONTEXT: CurrencyContextValue = {
  currency: 'USD',
  getSiteRate: () => null,
  loaded: false,
  unknownRateSiteCount: 0,
  unknownRateSiteIds: [],
  refresh: async () => {},
  toggleCurrency: async () => {},
  toggling: false,
};

const CurrencyContext = createContext<CurrencyContextValue>(EMPTY_CONTEXT);
CurrencyContext.displayName = 'CurrencyContext';

/**
 * Provider 自己拉一次运行时配置与站点列表。
 * 不做成每组件各自 fetch 的原因：一屏几十张卡片会打出 N 次相同请求，
 * 而且"哪个站点汇率未知"必须整屏一致，不能各算各的。
 */
export function CurrencyProvider(props: { children: React.ReactNode }) {
  const [currency, setCurrency] = useState<DisplayCurrency>('USD');
  // 存三态：number = 有效汇率，null = 该活跃站点未维护汇率。
  // 之前只存有效值，于是"有多少站没设汇率"这个数算不出来，各页面只好自己再拉一份。
  const [ratesBySiteId, setRatesBySiteId] = useState<Map<number, number | null>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  // 并发保护：多个挂载点同时触发 refresh 时只发一轮请求。
  const inflight = useRef<Promise<void> | null>(null);
  // 防止连点切换把服务端写成中间态。
  const togglingRef = useRef(false);
  const [toggling, setToggling] = useState(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const task = (async () => {
      try {
        // 汇率走专用轻量端点（B1），不再搭 getSites() 的便车：
        // 站点行里有 url / api_key / extra_config 等大字段，而换算只要两个数。
        const [runtimeInfo, ratesRes] = await Promise.all([
          api.getRuntimeSettings().catch(() => null),
          api.getCurrencyRates().catch(() => ({ rates: [], generatedAt: '' })),
        ]);
        const next = String((runtimeInfo as any)?.displayCurrency || 'USD').toUpperCase();
        setCurrency(next === 'CNY' ? 'CNY' : 'USD');
        const map = new Map<number, number | null>();
        for (const row of (Array.isArray(ratesRes?.rates) ? ratesRes.rates : [])) {
          const id = Number(row?.siteId);
          const raw = Number(row?.cnyPerUsd);
          // cnyPerUsd 为 null / 0 / 负数一律记成"未知"：保留这一行而不是丢弃，
          // 才能数出到底有几个活跃站点没设汇率（unknownRateSiteCount）。
          if (Number.isFinite(id) && id > 0) {
            map.set(id, Number.isFinite(raw) && raw > 0 ? raw : null);
          }
        }
        setRatesBySiteId(map);
      } catch {
        // 探测失败保持 USD：这是展示口径，不该因为一次网络抖动报错或给出假汇率。
        setCurrency('USD');
      } finally {
        setLoaded(true);
        inflight.current = null;
      }
    })();
    inflight.current = task;
    return task;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const getSiteRate = useCallback((siteId: number | null | undefined) => {
    const id = Number(siteId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const rate = ratesBySiteId.get(id);
    return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
  }, [ratesBySiteId]);

  const unknownRateSiteCount = useMemo(
    () => Array.from(ratesBySiteId.values()).filter((rate) => rate == null).length,
    [ratesBySiteId],
  );

  // F4：同上，但保留 id，供「已排除 N 个站点」这类提示做成可点击入口。
  const unknownRateSiteIds = useMemo(() => {
    const ids: number[] = [];
    for (const [siteId, rate] of ratesBySiteId) {
      if (rate == null) ids.push(siteId);
    }
    return ids.sort((a, b) => a - b);
  }, [ratesBySiteId]);

  /**
   * 顶栏货币切换：先乐观改本地（全站价格立刻跟着变），再落库；
   * 落库失败则回滚到原值并抛出，由调用方提示。
   * 之所以乐观：等接口回来再改会让按钮"点了没反应"，而这是纯显示配置，
   * 短暂不一致的代价远小于无反馈。
   */
  const toggleCurrency = useCallback(async () => {
    if (togglingRef.current) return;
    const next: DisplayCurrency = currency === 'USD' ? 'CNY' : 'USD';
    togglingRef.current = true;
    setToggling(true);
    setCurrency(next);
    try {
      await api.updateRuntimeSettings({ displayCurrency: next } as any);
    } catch (error) {
      // 回滚，避免界面显示 ¥ 而服务端仍是 USD。
      setCurrency(currency);
      throw error;
    } finally {
      togglingRef.current = false;
      setToggling(false);
    }
  }, [currency]);

  const value = useMemo<CurrencyContextValue>(
    () => ({ currency, getSiteRate, loaded, unknownRateSiteCount, unknownRateSiteIds, refresh, toggleCurrency, toggling }),
    [currency, getSiteRate, loaded, unknownRateSiteCount, unknownRateSiteIds, refresh, toggleCurrency, toggling],
  );

  return <CurrencyContext.Provider value={value}>{props.children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}
