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
  /** 设置页保存后重新拉取，让币种切换立即生效。 */
  refresh: () => Promise<void>;
}

const EMPTY_CONTEXT: CurrencyContextValue = {
  currency: 'USD',
  getSiteRate: () => null,
  loaded: false,
  refresh: async () => {},
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
  const [ratesBySiteId, setRatesBySiteId] = useState<Map<number, number>>(() => new Map());
  const [loaded, setLoaded] = useState(false);
  // 并发保护：多个挂载点同时触发 refresh 时只发一轮请求。
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (inflight.current) return inflight.current;
    const task = (async () => {
      try {
        const [runtimeInfo, sitesRes] = await Promise.all([
          api.getRuntimeSettings().catch(() => null),
          api.getSites().catch(() => [] as any[]),
        ]);
        const next = String((runtimeInfo as any)?.displayCurrency || 'USD').toUpperCase();
        setCurrency(next === 'CNY' ? 'CNY' : 'USD');
        const list = Array.isArray(sitesRes) ? sitesRes : ((sitesRes as any)?.sites || []);
        const map = new Map<number, number>();
        for (const site of list) {
          const id = Number(site?.id);
          const rate = Number(site?.billingProfile?.cnyPerUsd);
          if (Number.isFinite(id) && id > 0 && Number.isFinite(rate) && rate > 0) {
            map.set(id, rate);
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
    return ratesBySiteId.get(id) ?? null;
  }, [ratesBySiteId]);

  const value = useMemo<CurrencyContextValue>(
    () => ({ currency, getSiteRate, loaded, refresh }),
    [currency, getSiteRate, loaded, refresh],
  );

  return <CurrencyContext.Provider value={value}>{props.children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  return useContext(CurrencyContext);
}
