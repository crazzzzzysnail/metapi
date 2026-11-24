import { isAutoGroupName } from './groupNames.js';

/**
 * 计费分组解析的**唯一实现**（S1-1）。
 *
 * 为什么单独立在这个 billing 窄模块、而不是留在 modelPricingService：
 * `tokens.channel-presentation.test.ts` 用**只有两个导出**的工厂函数 mock 了整个
 * `modelPricingService.js`。若展示层（tokens.ts）从 modelPricingService 新 import
 * 任何具名符号，都会在链接期拿到 undefined 而崩（该文件 623 行注释与
 * modelPricingService 198 行注释反复记录过这个坑）。
 * 而 `billing/*` 不经过那层 mock：modelPricingService 与 tokens.ts **都直接 import**
 * `billing/groupNames`（isAutoGroupName 先例）。故共用函数放这里，两侧拿到的是**同一个函数对象**，
 * "展示档与实扣档同函数同结果"（验收判据 1）由构造保证，不是靠两边各写一份再祈祷一致。
 */

/** 本次请求携带的令牌分组提示（三-3）。 */
export interface BillingGroupHint {
  tokenGroup?: string | null;
  autoGroups?: string[] | null;
}

/**
 * 解析只需模型声明的分组列表；用结构化类型避免 billing → services 的循环 import。
 * PricingModel 与 ModelPricingCatalogEntry 都带 `enableGroups: string[]`，天然满足。
 */
export interface BillingGroupDeclaredModel {
  enableGroups?: string[] | null;
}

/** 分组倍率是否被显式给出（含合法的 0）。 */
export function hasExplicitRatio(groupRatio: Record<string, number>, group: string): boolean {
  const value = groupRatio[group];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * 解析本次计价的分组倍率与实际命中分组名（三-2 / 三-3）。
 *
 * 顺序（与上游 new-api 家族的实际命中一致，已由 siteA 真实账单验证）：
 *   ① 令牌是显式分组且模型声明了它 → 用该分组的倍率；
 *   ② 令牌是 auto（或未标注）且有链路 → **按链路顺序取第一个模型声明了的分组**。
 *      链路是降级顺序，上游命中第一个可用档，所以是"第一个"不是"最后一个"：
 *      实测 sample-model-ratio 链路 [grp-codex, grp-codex-pro, 组丁-chs]，
 *      模型同时挂在 grp-codex 与 grp-codex-pro，上游扣的是 grp-codex(0.15)。
 *   ③ 以上都不成立 → 有 hint 时返回 null（分组未知，拒绝出价）；
 *      没有 hint（老调用方 / apikey 类无令牌分组）才走声明首档启发式。
 */
export function resolveBillingGroup(
  model: BillingGroupDeclaredModel,
  groupRatio: Record<string, number>,
  hint?: BillingGroupHint | null,
): { ratio: number; groupName: string | null } | null {
  const groups = (model.enableGroups || [])
    .map((group) => String(group || '').trim())
    .filter(Boolean);

  const tokenGroup = String(hint?.tokenGroup || '').trim();
  const chain = (hint?.autoGroups ?? [])
    .map((group) => String(group || '').trim())
    .filter(Boolean);
  const hasHint = Boolean(tokenGroup) || chain.length > 0;

  if (hasHint) {
    // ① 显式分组优先。auto 不是真分组（上游在 usable_group 里明确标它无效），
    //    不能拿它去查倍率。
    if (tokenGroup && !isAutoGroupName(tokenGroup) && groups.includes(tokenGroup)) {
      return hasExplicitRatio(groupRatio, tokenGroup)
        ? { ratio: groupRatio[tokenGroup]!, groupName: tokenGroup }
        : null;
    }

    // ② 链路顺序命中：第一个模型声明了的分组。
    for (const candidate of chain) {
      if (!groups.includes(candidate)) continue;
      // 模型声明了该分组却拿不到倍率：这是"已知分组但倍率未知"，不能继续往后猜。
      return hasExplicitRatio(groupRatio, candidate)
        ? { ratio: groupRatio[candidate]!, groupName: candidate }
        : null;
    }

    // ③ 显式令牌分组不在模型声明里：**本地令牌元数据可能过期**。
    //    实测 2026-11-22：某站令牌本地仍标 default（11-21 手工建），
    //    而模型只声明 [deepseek套餐, 按次]；请求在上游成功、且上游日志记的组是「按次」。
    //    请求既然成功，真实分组必在声明内 —— 只有"声明内恰有一个已知倍率的分组"时
    //    才按它计价（无歧义，等于元数据过期自愈）；多于一个就仍拒绝，绝不瞎猜。
    if (tokenGroup && !isAutoGroupName(tokenGroup) && groups.length > 0) {
      const known = groups.filter((group) => hasExplicitRatio(groupRatio, group));
      if (known.length === 1) {
        return { ratio: groupRatio[known[0]]!, groupName: known[0] };
      }
    }

    // ④ 其余情况：有令牌信息但无法确定分组 —— 拒绝出价，绝不退到别的分组。
    return null;
  }

  // ⚠️ 兼容路径：没有分组信息时返回 null（未知），**不再**退到 default。
  // 实扣路径拿不到倍率就该拒绝出价，而不是猜一个 —— siteB 的 default 是 ×2，
  // 猜测会直接导致多扣一倍。有声明则严格按声明顺序，不注入、不重排。
  if (groups.length === 0) return null;

  for (const group of groups) {
    if (hasExplicitRatio(groupRatio, group)) {
      return { ratio: groupRatio[group]!, groupName: group };
    }
  }

  return null;
}
