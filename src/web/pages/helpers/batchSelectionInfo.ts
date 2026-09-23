import { tr } from '../../i18n.js';

/**
 * 组装批量栏计数文案（提示层的唯一事实源）。
 * - total：已勾选总数（提交即按此集合执行，方案 A 契约）。
 * - visibleSelected：已勾选且在当前可见集中的数量；hidden = total - visibleSelected。
 * hidden > 0 时追加后缀，显式表达"含不可见项"。
 * 可见集恒等于全量的页面（站点/令牌无文本筛选）会自然退化为无后缀。
 */
export function buildBatchSelectionInfo(total: number, visibleSelected: number, unit: string): string {
  const hidden = total - visibleSelected;
  const base = tr(`已选 ${total} ${unit}`);
  return hidden > 0 ? `${base}（${tr(`其中 ${hidden} 项不在当前筛选内`)}）` : base;
}
