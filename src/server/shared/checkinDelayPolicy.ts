/**
 * 签到随机延迟策略（纯函数层，零依赖）。
 *
 * 背景：签到定时任务原先在 cron 到点时所有账号同一秒齐发，容易被上游站点人工判定为脚本。
 * 这里把「锚点时刻之后的延迟窗口」等分成若干子带，每个账号领一个子带并在带内取随机出发时刻，
 * 从而同时满足三条：同一天可复现（进程重启重算结果一致）、每天不一样（日键参与哈希）、
 * 任意两个账号不落在同一个子带（不碰撞就不会同秒）。
 *
 * 层级约束（务必保持）：
 * - 本文件位于 src/server/shared/，在本仓库是严格零依赖层。前端设置页会直接引用本模块，
 *   而 vite.config.ts 只注册了 react 与 tailwind 插件、没有为 node:crypto 提供 shim/alias，
 *   所以这里不能出现任何 import（包括 node:crypto），哈希用纯算术实现。
 * - 「本地日界」的权威拥有者是 src/server/services/localTimeService.ts
 *   （formatLocalDate / getLocalDayKeyRangeUtc / getLocalDayRangeUtc）。shared/ 不得反向依赖
 *   services/，因此本模块不做任何日期与时区运算：dayEndMs 与 planDateKey 一律由调用方注入。
 */

/**
 * 支持的延迟单位。**唯一枚举出处**：服务端路由的入参校验、配置模块的单位判定、
 * 前端下拉选项都从这里取，避免三处各写一份 `'minute' | 'hour'` 而漂移。
 * 刻意不含秒级 —— 定稿判定：对手工审查时间戳的站点管理员，秒级散布无判别力。
 */
export const CHECKIN_DELAY_UNITS = ['minute', 'hour'] as const;

export type CheckinDelayUnit = typeof CHECKIN_DELAY_UNITS[number];

/**
 * 单位的中文显示名。前端下拉选项与服务端的设置变更日志共用这一份，
 * 避免同一个概念在两侧各写一种译法（本模块零依赖，两侧都可直接引用）。
 */
export const CHECKIN_DELAY_UNIT_LABELS: Record<CheckinDelayUnit, string> = {
  minute: '分钟',
  hour: '小时',
};

/** 归一化后的延迟配置。内部时间量统一使用 epoch 毫秒。 */
export type CheckinDelayConfig = {
  enabled: boolean;
  minMs: number;
  maxMs: number;
};

/** 配置界面展示的默认值：关闭、0 至 360、单位为分钟。数值不设硬上限。 */
export const CHECKIN_DELAY_DEFAULTS = {
  min: 0,
  max: 360,
  unit: 'minute',
} as const satisfies { min: number; max: number; unit: CheckinDelayUnit };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** 默认窗口宽度（360 分钟），用于非法输入整体回落。 */
const DEFAULT_WINDOW_MAX_MS = CHECKIN_DELAY_DEFAULTS.max * MINUTE_MS;

/** 32 位无符号整数空间大小，用于把哈希整数映射到 [0,1)。 */
const UINT32_SPACE = 4_294_967_296;

/**
 * 单位换算：只支持分钟与小时（秒级已判定为无必要）。
 * 非有限数返回 NaN；单位不认识时同样返回 NaN，交由上层判定为非法并整体回落。
 */
export function toDelayMs(value: number, unit: CheckinDelayUnit): number {
  if (!Number.isFinite(value)) return Number.NaN;
  switch (unit) {
    case 'minute':
      return value * MINUTE_MS;
    case 'hour':
      return value * HOUR_MS;
    default:
      // 运行期可能拿到持久化里的历史脏值（例如已废弃的秒级单位），一律视为非法。
      return Number.NaN;
  }
}

/**
 * 把窗口渲染成人能读的一句话，例如 `0~360分钟`、`2~6小时`。
 *
 * 导出给调度器日志与设置变更日志共用：这两处描述的是同一个东西，写法必须一致，
 * 否则用户在启动日志里看到的窗口和在事件列表里看到的对不上，就成了排查障碍。
 */
export function formatCheckinDelayWindow(min: number, max: number, unit: CheckinDelayUnit): string {
  return `${min}~${max}${CHECKIN_DELAY_UNIT_LABELS[unit]}`;
}

/**
 * 单位是否为受支持的枚举值。导出给设置路由与前端做入参校验，避免各处再写一份判定。
 */
export function isCheckinDelayUnit(value: unknown): value is CheckinDelayUnit {
  return typeof value === 'string' && (CHECKIN_DELAY_UNITS as readonly string[]).includes(value);
}

/** 只接受 number 类型的有限值；字符串数字不予采纳，避免隐式转换带来意外钳制。 */
function readOptionalFinite(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * 唯一权威的校验与钳制入口。
 *
 * 非法输入（非有限数、负数、min > max、单位不认识）一律**整体**回落默认值，
 * 不做逐项部分采纳，避免出现「一半默认一半自定义」这种难以描述的中间状态。
 */
export function normalizeCheckinDelayConfig(raw: {
  enabled?: unknown;
  min?: unknown;
  max?: unknown;
  unit?: unknown;
}): CheckinDelayConfig {
  const fallback: CheckinDelayConfig = {
    enabled: false,
    minMs: 0,
    maxMs: DEFAULT_WINDOW_MAX_MS,
  };
  if (!raw) return fallback;

  // 单位缺失时按默认单位采纳；单位存在但不是合法枚举值时必须**整体回落**。
  // 不能悄悄替换成默认单位：否则 `{min:5,max:60,unit:'second'}`（旧数据或前端误传）会被当成
  // 5–60 **分钟**采纳，用户以为设的是秒，实际跑出一小时的窗口——属于静默错值，比直接报错更难发现。
  if (raw.unit !== undefined && !isCheckinDelayUnit(raw.unit)) return fallback;
  const unit: CheckinDelayUnit = isCheckinDelayUnit(raw.unit) ? raw.unit : CHECKIN_DELAY_DEFAULTS.unit;

  const minValue = readOptionalFinite(raw.min);
  const maxValue = readOptionalFinite(raw.max);
  if (minValue === null || maxValue === null) return fallback;
  if (minValue < 0 || maxValue < 0) return fallback;

  const minMs = toDelayMs(minValue, unit);
  const maxMs = toDelayMs(maxValue, unit);
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return fallback;
  if (minMs > maxMs) return fallback;

  return {
    enabled: raw.enabled === true,
    minMs,
    maxMs,
  };
}

/** 延迟窗口的解析结果；失败时只给出原因，不给出可用区间。 */
export type DelayWindow =
  | { ok: true; startMs: number; endMs: number; compressed: boolean }
  | { ok: false; reason: 'no-remaining-window' | 'disabled' };

/**
 * 解析本轮可用的延迟窗口。
 *
 * - anchorMs 是锚点时刻：cron 到点时刻或用户点击手动签到的时刻。
 * - dayEndMs 由调用方从 localTimeService 算好注入（本地日终），本模块不做时区运算。
 * - 窗口起点取「锚点 + minMs」，终点取「锚点 + maxMs」与 dayEndMs 的较小者；
 *   被日终截断即视为压缩（compressed = true）。
 * - 只有当窗口宽度不大于 0（锚点已达/超过日终，或压缩后无剩余）才判定为无剩余窗口。
 *   这意味着允许出现极窄窗口（例如只剩几秒），由下游分层算法继续处理。
 */
export function resolveDelayWindow(input: {
  anchorMs: number;
  config: CheckinDelayConfig;
  dayEndMs: number;
}): DelayWindow {
  if (!input.config.enabled) return { ok: false, reason: 'disabled' };
  if (!Number.isFinite(input.anchorMs) || !Number.isFinite(input.dayEndMs)) {
    return { ok: false, reason: 'no-remaining-window' };
  }

  const { minMs, maxMs } = input.config;
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs < minMs) {
    return { ok: false, reason: 'no-remaining-window' };
  }

  const startMs = input.anchorMs + minMs;
  const rawEndMs = input.anchorMs + maxMs;
  const endMs = Math.min(rawEndMs, input.dayEndMs);
  if (!(startMs < endMs)) return { ok: false, reason: 'no-remaining-window' };

  return {
    ok: true,
    startMs,
    endMs,
    compressed: rawEndMs > input.dayEndMs,
  };
}

/**
 * FNV-1a 32 位变体加雪崩收尾，得到确定性伪随机整数（[0, 2^32)）。
 *
 * 注意：这**不是密码学哈希**，不可用于任何安全用途（令牌、签名、鉴权一律禁止使用），
 * 仅用于让签到出发时刻在时间轴上去相关。它只做时序打散，不承载任何保密性或抗攻击性。
 */
function fnv1aAvalanche(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    // 只用低 16 位，避免 BMP 之外的码点在截断后产生大量相同前缀；对时序打散足够。
    hash = Math.imul(hash ^ (text.charCodeAt(index) & 0xffff), 0x01000193) >>> 0;
  }

  // 雪崩收尾（32 位 xorshift 三段），改善 FNV 高位扩散不足的问题。
  hash ^= hash << 13;
  hash >>>= 0;
  hash ^= hash >>> 17;
  hash ^= hash << 5;
  return hash >>> 0;
}

/** [0, 1) 区间的确定性伪随机数。同样的四元组永远得到同一个值，跨进程、跨平台一致。 */
export function delayHashUnit(input: {
  seed: string;
  planDateKey: string;
  accountId: number;
  salt: string;
}): number {
  const key = `${input.seed}|${input.planDateKey}|${input.accountId}|${input.salt}`;
  // 分子最大为 2^32-1，除以 2^32 保证结果严格小于 1。
  return fnv1aAvalanche(key) / UINT32_SPACE;
}

/** 当日置换用的盐，与子偏移盐区分开，避免同一哈希值同时决定「顺序」和「位置」。 */
const ORDER_SALT = 'order';
/** 子带内偏移用的盐。 */
const SUB_BAND_SALT = 'subband';
/**
 * interval 通路每账户偏移用的盐。
 * 必须是**第三个独立**的字面量：定稿要求「顺序」与「带内位置」不由同一个哈希值决定，
 * 同理，interval 的到期偏移也不能复用上面两个值，否则某账号「当天排第几」与「晚多久到期」
 * 会完全相关，等于给账号序号开了一个可被上游观测到的后门。
 */
const INTERVAL_OFFSET_SALT = 'interval-offset';

function normalizeAccountIds(accountIds: readonly number[]): number[] {
  const seen = new Set<number>();
  const normalized: number[] = [];
  for (const raw of accountIds) {
    // 过滤非有限值并截断取整，保证同一账号只有一个身份。
    if (!Number.isFinite(raw)) continue;
    const id = Math.trunc(raw);
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

/**
 * 构造当日置换：按 hash(seed, planDateKey, accountId) 升序返回账号 id。
 *
 * 输入数组的顺序不影响输出（先排序再去重，比较函数在哈希相等时以账号 id 兜底），
 * 因此调用方可以任意顺序传入。planDateKey 参与哈希，保证每天的置换不同。
 */
export function buildDailyAccountOrder(input: {
  accountIds: number[];
  planDateKey: string;
  seed: string;
}): number[] {
  const entries = normalizeAccountIds(input.accountIds).map((accountId) => ({
    accountId,
    orderValue: delayHashUnit({
      seed: input.seed,
      planDateKey: input.planDateKey,
      accountId,
      salt: ORDER_SALT,
    }),
  }));

  entries.sort((a, b) => a.orderValue - b.orderValue || a.accountId - b.accountId);
  return entries.map((entry) => entry.accountId);
}

/** 单个账号的分配结果：领到的子带序号与带内的计划出发时刻（epoch 毫秒）。 */
export type DelayPlanItem = {
  accountId: number;
  bandIndex: number;
  plannedFireMs: number;
};

export type AssignDelayBandsResult = {
  items: DelayPlanItem[];
  /** 拿不到未来空子带的账号，当日延后（不参与本轮）。 */
  deferredAccountIds: number[];
};

/**
 * 分配子带。
 *
 * 算法：窗口按子带份数（`bandCount`）等分成若干个子带，按当日冻结顺序依次领取**最小的空闲且未整体过期**的子带；
 * 带内再用哈希取一个子偏移。子带整体过期指「带尾 <= nowMs」（此时已不可能在未来出发，判当日延后）；
 * 部分过期（带头 <= nowMs < 带尾）则在 [nowMs, 带尾] 内采样。
 *
 * `bandCount` 与「本次参与分配的账号数」是**两个独立**的量，缺省时才等于账号数（保持历史行为）。
 * 显式传入用于「冻结当日置换上的增量入带」：当天已排定账号占用的带由 `occupiedBands` 传入，
 * 本次只有新账号参与分配，但窗口必须仍按冻结时的份数等分，否则老账号占用的带会被当作越界丢弃、
 * 进而被新账号抢注（两个账号同一秒出发）。因此：
 * - `bandCount` 大于账号数是常态（新账号只占空位，窗口照原样铺满）；
 * - `bandCount` 小于账号数同样合法（先分配者拿最小的空闲未过期带，拿不到空位的账号进 deferred），
 *   绝不抛错，也绝不复用已占用带；
 * - 带内子偏移只由 `hash(seed, planDateKey, accountId, 'subband')` 决定，与 `bandCount` 无关，
 *   所以同一账号在同一带内的相对位置稳定。
 * 子带份数由调用方负责给出合理值：份数极大时「找首个可用带」是 O(bandCount) 的线性扫描。
 *
 * 关键不变量：只要一批账号的顺序、占用集合与子带份数固定，重算（进程重启）得到完全相同的结果；
 * plannedFireMs 恒落在 [floor(带头), 带尾) 内，因此不会早于当前时刻、也不会越过窗口终点。
 */
export function assignDelayBands(input: {
  orderedAccountIds: number[];
  occupiedBands?: number[];
  /** 窗口等分的份数。缺省时等于本次参与分配的账号数（保持既有行为）。 */
  bandCount?: number;
  windowStartMs: number;
  windowEndMs: number;
  nowMs: number;
  planDateKey: string;
  seed: string;
}): AssignDelayBandsResult {
  const orderedAccountIds = normalizeAccountIds(input.orderedAccountIds);
  const items: DelayPlanItem[] = [];
  const deferredAccountIds: number[] = [];
  if (orderedAccountIds.length <= 0) return { items, deferredAccountIds };

  const nowMs = Number.isFinite(input.nowMs) ? Math.floor(input.nowMs) : 0;
  const windowStartMs = Number.isFinite(input.windowStartMs) ? input.windowStartMs : nowMs;
  const windowEndMs = Number.isFinite(input.windowEndMs) ? input.windowEndMs : windowStartMs;
  // 窗口无效（终点不晚于起点）时全部当日延后，绝不做除零。
  if (!(windowEndMs > windowStartMs)) {
    return { items, deferredAccountIds: [...orderedAccountIds] };
  }

  // 子带份数与本次账号数解耦：缺省时等于去重后的账号数（与历史行为逐字等价），
  // 显式传入时按传入值切分窗口，供「冻结当日置换上增量入带」的调用方使用。
  // 只采纳「有限、不小于 1 且本身就是整数」的份数；用 Math.trunc 判定整数性，
  // 0、负数、NaN、±Infinity、小数（截断后与原值不等）一律视为非法并整体回落为账号数，绝不抛错。
  // 回落而不是四舍五入：静默改变窗口切分份数会让已排定账号的带边界错位，比直接回落更难排查。
  const fallbackBandCount = orderedAccountIds.length;
  const requestedBandCount = input.bandCount;
  const bandCount = requestedBandCount !== undefined
    && Number.isFinite(requestedBandCount)
    && requestedBandCount >= 1
    && Math.trunc(requestedBandCount) === requestedBandCount
    ? requestedBandCount
    : fallbackBandCount;
  const bandWidthMs = (windowEndMs - windowStartMs) / bandCount;

  const occupied = new Set<number>();
  for (const raw of input.occupiedBands ?? []) {
    if (!Number.isFinite(raw)) continue;
    const index = Math.trunc(raw);
    if (index < 0 || index >= bandCount) continue;
    occupied.add(index);
  }

  const findNextFreeBand = (): number => {
    for (let index = 0; index < bandCount; index += 1) {
      if (occupied.has(index)) continue;
      // 整体过期的子带不再占用：它已经不可能提供未来的出发时刻。
      if (windowStartMs + (index + 1) * bandWidthMs <= nowMs) continue;
      return index;
    }
    return -1;
  };

  for (const accountId of orderedAccountIds) {
    const bandIndex = findNextFreeBand();
    if (bandIndex < 0) {
      deferredAccountIds.push(accountId);
      continue;
    }
    occupied.add(bandIndex);

    const bandStartMs = windowStartMs + bandIndex * bandWidthMs;
    const bandEndMs = bandStartMs + bandWidthMs;

    // 采样下界：部分过期的子带从 nowMs 起采样；下界最多压到带尾，绝不越出子带。
    const sampleFloorMs = Math.min(nowMs, Math.floor(bandEndMs));
    const sampleStartMs = Math.max(Math.floor(bandStartMs), sampleFloorMs);
    const sampleSpanMs = bandEndMs - sampleStartMs;
    if (!(sampleSpanMs > 0)) {
      // 浮点极端情况下带尾与带起重合：仍留在本子带内，取带尾前 1 毫秒。
      const fallbackMs = Math.floor(bandEndMs) - 1;
      items.push({
        accountId,
        bandIndex,
        plannedFireMs: Math.max(sampleStartMs, Math.min(fallbackMs, bandEndMs - 1)),
      });
      continue;
    }

    const ratio = delayHashUnit({
      seed: input.seed,
      planDateKey: input.planDateKey,
      accountId,
      salt: SUB_BAND_SALT,
    });
    const offsetMs = Math.min(ratio * sampleSpanMs, sampleSpanMs - 1);
    const plannedFireMs = Math.min(
      Math.floor(sampleStartMs + offsetMs),
      Math.floor(bandEndMs) - 1,
    );

    items.push({ accountId, bandIndex, plannedFireMs });
  }

  return { items, deferredAccountIds };
}

/**
 * 缺省阈值：平均子带不足 1 秒。它只回答**一个**问题——「两个账号会不会落进同一秒」。
 *
 * 判据不是主观的「够不够宽裕」，而是**多条子带是否共享同一个秒桶**：子带互不重叠地等分窗口，
 * 只要每条带宽度 >= 1 秒，两个账号就不可能同秒出发；低于 1 秒才可能出现同秒。
 * 实测依据见 docs/plans/2026-11-03-checkin-random-delay/evidence/s1-verification.md 第 26-29 行：
 * 带宽 600ms 时计划**毫秒值**仍 100/100 唯一，但毫秒唯一不等于秒不唯一（100 个号铺在 60 秒里
 * 必有秒桶装两个号），所以 600ms 判过窄是对的。
 *
 * **不要把它当作用户-facing 的「拥挤」线来改**：「分散效果够不够好」是另一个问题、另一条线，
 * 见 `CHECKIN_DELAY_NARROW_HINT_MS`（定稿第 8.2 条的每账号 60 秒）。10 分钟窗口 / 20 账号
 * 平均 30 秒：按本常量「不挤」（不会同秒），按提示线「挤」（人工可见的密集簇），两者都对。
 */
const MIN_USABLE_BAND_MS = 1_000;

/**
 * 设置页「分散效果有限」提示的判据：平均子带宽度低于每账号 60 秒。
 *
 * 出处是定稿第 8.2 条（「(max-min) < 站点内账户数 × 60s 时提示，仅提示不拦截」）。
 * 刻意与 `MIN_USABLE_BAND_MS`（1 秒，防同秒碰撞）分开：100 个账号挤在 1 小时窗口里
 * 平均 36 秒，不会同秒碰撞，但对人工审查时间戳的管理员仍是一眼可见的密集簇。
 */
export const CHECKIN_DELAY_NARROW_HINT_MS = 60_000;

/**
 * interval 通路的每账户到期偏移（定稿第 6 节第 59 行）。
 *
 * 语义：账号的到期判据从「距上次签到满 N 小时」变成「满 N 小时 **再加** 本函数给出的偏移」，
 * 只在既有到期基准上叠加，不改动到期规则本身 —— 这是定稿明确要求的做法。
 *
 * 三条刻意与 cron 通路不同的地方（都有定稿出处，越界即回归）：
 * - **不做日界压缩**：cron 的第 4 节把窗口终点裁到当日日终，是因为它服务「一天一次」的语义；
 *   interval 的到期是每账号各自的相对量、本来就可以跨日，套用压缩会把周期改坏。
 *   所以这里只用 `[minMs, maxMs]` 原值，**不接受也不计算 dayEndMs**。
 * - **不参与「错过跳过当日」**（定稿第 18 节第 1 条：interval 套用会每次启动都判错过）。
 * - **不参与当日去重**（定稿第 6 节第 60 条：会把 N<24 的一天多次误砍成一天一次）。
 *
 * 关于 `roundPlanDateKey`（本轮起算日的日键）为什么必须由调用方传入、且**不能**直接用今天的日键：
 * 偏移要在一轮之内保持稳定。若用当前日键，跨过本地午夜的那一刻所有在等账号的到期时刻会集体前移或
 * 后移，等于每天零点凭空制造一次齐发。取「本轮起算点」（上次签到/上次发起时刻）所在的日键，
 * 这一轮的偏移就与它的起点绑定，跨日、重启、热更都不改变它，只在开始新一轮时才换值。
 */
export function intervalAccountOffsetMs(input: {
  seed: string;
  roundPlanDateKey: string;
  accountId: number;
  config: CheckinDelayConfig;
}): number {
  if (!input.config.enabled) return 0;
  const { minMs, maxMs } = input.config;
  // 配置非法（NaN、负数、区间倒挂）时退化为 0 偏移，也就是改造前的行为，绝不抛错也绝不给负偏移。
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs < minMs) return 0;
  if (maxMs === minMs) return minMs;

  const ratio = delayHashUnit({
    seed: input.seed,
    planDateKey: input.roundPlanDateKey,
    accountId: input.accountId,
    salt: INTERVAL_OFFSET_SALT,
  });
  // 严格小于 maxMs：比例恰好取到 1 时压回 1 毫秒，保证偏移恒落在 [minMs, maxMs) 内。
  const spanMs = maxMs - minMs;
  const offsetMs = Math.min(ratio * spanMs, spanMs - 1);
  return Math.floor(minMs + offsetMs);
}

/**
 * 仅供设置页提示用的粗略估算，不参与任何分配决策。
 *
 * 两个问题要用两条不同的线，别混用：
 * - **会不会同秒碰撞**：用 `MIN_USABLE_BAND_MS`（1 秒，默认值）。低于它两条带才可能落进同一秒。
 * - **分散效果够不够好**：由调用方传 `minBandMs`（定稿第 8.2 条给的是每账号 60 秒，见
 *   `CHECKIN_DELAY_NARROW_HINT_MS`）。100 个账号挤在 1 小时窗口里不会同秒碰撞，但
 *   平均 36 秒一个仍然会呈现「一小时内密集签到」的形态，对人工审查有意义 —— 这条只提示不拦截。
 *
 * 账号数为 0 时不存在子带，平均宽度按 0 返回且不算过窄，避免误导提示并规避除零。
 */
export function estimateDelayBands(input: {
  windowMs: number;
  accountCount: number;
  minBandMs?: number;
}): { avgBandMs: number; tooNarrow: boolean } {
  const thresholdMs = typeof input.minBandMs === 'number'
    && Number.isFinite(input.minBandMs)
    && input.minBandMs > 0
    ? input.minBandMs
    : MIN_USABLE_BAND_MS;
  const windowMs = Number.isFinite(input.windowMs) && input.windowMs > 0 ? input.windowMs : 0;
  const accountCount = Number.isFinite(input.accountCount)
    ? Math.max(0, Math.trunc(input.accountCount))
    : 0;
  if (accountCount <= 0) return { avgBandMs: 0, tooNarrow: false };

  const avgBandMs = windowMs / accountCount;
  return { avgBandMs, tooNarrow: avgBandMs < thresholdMs };
}
