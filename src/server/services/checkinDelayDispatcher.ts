/**
 * 签到随机延迟派发器。
 *
 * 设计要点（逐条对应需求定稿）：
 * - **单只定时器**：每次发出后重挂到下一个待发账号（`armNextOrStop`）。定时通路因此天然串行，
 *   不需要周期轮询扫全表——cron 模式今天本来就不建轮询定时器（`checkinScheduler.ts` 的 `startCheckinSchedule`）。
 * - **当日计划落盘、时刻不重算**：`checkin_delay_plan` 存 accountId -> {bandIndex, plannedFireMs}。
 *   曾考虑只存子带序号、每次由哈希现算时刻（决策 3 的无状态重算），但该思路经数值验证不成立：
 *   `assignDelayBands` 的 `bandCount = len(orderedAccountIds)`，单账号复现会把带宽撑成整个窗口；
 *   且中途新增账号落在「部分过期子带」时采样下界依赖当时 nowMs，纯哈希无法还原。
 *   决策 3 的本意是**不存已发状态**（改用 lastCheckinAt 判定），这一条仍然成立。
 * - **已发判据复用既有列**：「今天已签」= accounts.lastCheckinAt 落在本地今天（决策 6）。
 *   cron 通路今天完全没有幂等（checkinService.ts:323-334 不看该列），守卫在此补上。
 * - **错过一律跳过当日**（决策 18）：计划时刻落后超过阈值且从未发起的账号，当日不再自动补，
 *   通知一次后由人工点「运行所有签到」补。签到**失败**不算错过，仍归既有到期重试。
 * - **手动全量按钮同样带延迟**（决策 19）：不新建并行计划，而是以点击时刻就地重锚当日计划。
 *
 * 关闭状态（默认）下调用方走原有整批路径，本模块不产生任何行为变化。
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  CHECKIN_DELAY_NARROW_HINT_MS,
  assignDelayBands,
  buildDailyAccountOrder,
  estimateDelayBands,
  normalizeCheckinDelayConfig,
  resolveDelayWindow,
  type CheckinDelayConfig,
} from '../shared/checkinDelayPolicy.js';
import { formatLocalDate, getLocalDayEndMs, toLocalDayKeyFromStoredUtc } from './localTimeService.js';
import { sendNotification } from './notifyService.js';
import { checkinAccount } from './checkinService.js';

/** 判定「错过当日」的墙钟偏差阈值：计划时刻落后超过此值即视为已错过（决策 15/18）。 */
const MISSED_THRESHOLD_MS = 30 * 60 * 1000;
/** 兜底扫描周期：远慢于原 60 秒全表轮询，仅用于重启恢复、配置变更自愈与漏触发补发。 */
const SAFETY_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export const CHECKIN_DELAY_SETTING_KEYS = {
  enabled: 'checkin_delay_enabled',
  min: 'checkin_delay_min',
  max: 'checkin_delay_max',
  unit: 'checkin_delay_unit',
  seed: 'checkin_delay_seed',
  plan: 'checkin_delay_plan',
  /** 当日已就「错过并跳过」发过通知的标记，避免每轮重复打扰。 */
  skippedNotice: 'checkin_delay_skipped_notice',
} as const;

type ScheduleMode = 'cron' | 'interval';

/** 单个账号的当日安排。bandIndex 用于给中途新增账号避让，plannedFireMs 是实际出发时刻。 */
export type PlannedAccountEntry = { accountId: number; bandIndex: number; plannedFireMs: number };

/** 落盘的当日计划。configStamp 用于识别「用户在当天改过窗口参数」并自愈。 */
export type PersistedCheckinPlan = {
  planDateKey: string;
  anchorMs: number;
  mode: ScheduleMode;
  windowStartMs: number;
  windowEndMs: number;
  configStamp: string;
  /**
   * 窗口等分份数 N，建计划当天冻结。
   * 必须落盘而不是每次按「当前待发账号数」重算：份数一变，已落盘的老账号 plannedFireMs 就会
   * 与它的 bandIndex 不再自洽（这正是本轮修复的缺陷——原先用 pendingIds.length - occupiedBands.length
   * 推出一个错误的份数）。中途新增账号只在这 N 份里找空位，找不到就当日延后。
   */
  bandCount: number;
  /**
   * 本轮已发起过的账号（无论成功或失败）。
   * 必要性：签到失败时 checkinService.ts:203 刻意不推进 lastCheckinAt，若不记录「已发起」，
   * 每轮兜底扫描都会把该账号重新算进到期集，一个持续失败的账号一天会被发起数十次——
   * 比重试更糟，且「同账号高频失败请求」本身就是最强的脚本特征。
   * 定稿的「错过」只指**从未发起**，所以已发起者同时要从 missed 里排除，否则会误触发跳过通知。
   *
   * ⚠️ 适用范围：本字段按「一个锚点一轮」设计，对 cron 与手动重锚正确。
   * interval 模式的到期是**每账号各自的相对量**（lastCheckinAt + N 小时），且失败重试是它的既有语义
   * （定稿第 6 节明确不可套当日去重）。S3 接入 interval 时不得复用这份当日集合来阻断下一轮重试，
   * 应按「每个账号自己的本轮」作用域处理，或干脆不参与该过滤。
   */
  attemptedAccountIds: number[];
  entries: PlannedAccountEntry[];
};

async function readSetting<T>(key: string): Promise<T | undefined> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (!row?.value) return undefined;
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

/**
 * 读取并归一化延迟配置。解析规则的唯一权威是 shared/checkinDelayPolicy，
 * 这里不重复写钳制逻辑，避免 config、路由、调度器三处漂移。
 * 注意：数值非法时整体回落含「关闭」，因此用户存的坏配置会表现为功能未启用。
 */
export async function loadCheckinDelayConfig(): Promise<CheckinDelayConfig> {
  const [enabled, min, max, unit] = await Promise.all([
    readSetting<boolean>(CHECKIN_DELAY_SETTING_KEYS.enabled),
    readSetting<number>(CHECKIN_DELAY_SETTING_KEYS.min),
    readSetting<number>(CHECKIN_DELAY_SETTING_KEYS.max),
    readSetting<string>(CHECKIN_DELAY_SETTING_KEYS.unit),
  ]);
  return normalizeCheckinDelayConfig({
    enabled: enabled === true,
    min: min ?? config.checkinDelayMin,
    max: max ?? config.checkinDelayMax,
    unit: unit ?? config.checkinDelayUnit,
  });
}

/**
 * 首次使用时生成实例级随机种子并持久化；此后每天复用同一颗种子。
 * 导出给 interval 通路共用：两条通路必须共享同一颗实例级种子，各自生成会让「同一天两模式
 * 算出的分散形态互不相干」变成「同一实例内部不自洽」，排查时对不上号。
 */
export async function ensureSeed(): Promise<string> {
  const existing = await readSetting<string>(CHECKIN_DELAY_SETTING_KEYS.seed);
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  const seed = randomBytes(8).toString('hex');
  await upsertSetting(CHECKIN_DELAY_SETTING_KEYS.seed, seed);
  console.log('[CheckinDelay] Generated instance-level random seed');
  return seed;
}

/**
 * 参与本轮的账号：启用签到、账号 active、站点未禁用。一次带 where 的部分查询。
 * 导出给设置页的「窗口过窄」提示取账号数用：**必须与派发层同一份口径**，
 * 否则设置页按 A 集合算拥挤、实际发号按 B 集合，两处数字对不上就等于没有这条提示。
 */
export async function listEligibleAccounts(): Promise<Array<{ id: number; lastCheckinAt: string | null }>> {
  const rows = await db
    .select({
      id: schema.accounts.id,
      lastCheckinAt: schema.accounts.lastCheckinAt,
      siteStatus: schema.sites.status,
    })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(eq(schema.accounts.checkinEnabled, true), eq(schema.accounts.status, 'active')))
    .all();

  return rows
    .filter((row) => (row.siteStatus || 'active') !== 'disabled')
    .map((row) => ({ id: row.id, lastCheckinAt: row.lastCheckinAt ?? null }));
}

/** 今日是否已签过。命中即跳过，绝不制造「同账号同日两次请求」这一新特征。 */
export function hasCheckedInToday(lastCheckinAt: string | null, todayKey: string): boolean {
  if (!lastCheckinAt) return false;
  return toLocalDayKeyFromStoredUtc(lastCheckinAt) === todayKey;
}

/**
 * 合并当日安排。
 *
 * 关键不变量（本模块最容易写错之处）：**已排定账号的时刻绝不改动**。
 * 若把已排定账号连同新账号一起丢给 assignDelayBands，同一账号会同时出现在既有项与新分配项里，
 * 导致同日两次请求。因此新分配只针对「此前没有安排」的账号，且已排定者原样保留。
 * 同时清理本轮不再参与的账号，避免计划表膨胀。
 */
export function mergePlanEntries(input: {
  existing: PlannedAccountEntry[];
  assigned: PlannedAccountEntry[];
  pendingAccountIds: number[];
}): PlannedAccountEntry[] {
  const pending = new Set(input.pendingAccountIds);
  const byAccount = new Map<number, PlannedAccountEntry>();
  for (const entry of input.existing) {
    if (pending.has(entry.accountId)) byAccount.set(entry.accountId, entry);
  }
  for (const entry of input.assigned) {
    if (byAccount.has(entry.accountId)) continue;
    if (!pending.has(entry.accountId)) continue;
    byAccount.set(entry.accountId, entry);
  }
  return Array.from(byAccount.values()).sort((a, b) => a.plannedFireMs - b.plannedFireMs);
}

let fireTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let activePlan: PersistedCheckinPlan | null = null;
let dispatching = false;
/** 「今天还没有计划」这条日志每天只播一次的记位（进程内日期键，不落库）。 */
let noPlanNoticeDateKey: string | null = null;

function clearFireTimer() {
  if (fireTimer) {
    clearTimeout(fireTimer);
    fireTimer = null;
  }
}

/** 配置指纹：窗口参数一变，当日旧计划即不再可信（由扫描自愈）。 */
function buildConfigStamp(cfg: CheckinDelayConfig): string {
  return `${cfg.minMs}|${cfg.maxMs}`;
}

/**
 * 把当日安排按「当前时刻」分成三类。这是分类规则的唯一出处
 * （原先 armNextOrStop / runDispatchPass / describeCheckinDelayPlan 各写一份过滤，语义还不完全一致）。
 *
 * 规则：
 * - `attemptedAccountIds` 里的账号一律排除——本轮已发起过（无论成功或失败），当日不再重复打上游。
 * - `upcoming`：计划时刻仍在未来。
 * - `due`：已到时刻，且偏差**不大于**阈值（正常派发射程内，含恰好等于阈值的边界）。
 * - `missed`：偏差严格大于阈值且从未发起——按定稿「错过一律跳过当日」处理。
 *
 * 边界为何取「小于等于归 due」：定稿第 15 节原文是「时间偏差 > 30 分钟视为发生休眠 → 跳过当日；
 * 偏差 ≤ 30 分钟的少量过期账户照常立即补发」，而通知文案也写的是「落后超过 30 分钟」。
 * 用严格 `>` 会把「恰好 30 分钟」判成错过，既与定稿相反，也会对只落后 30 分钟的账号
 * 发出一句「落后超过 30 分钟」的误导通知。
 *
 * 纯函数、不依赖进程状态，因此可被单测直接覆盖（这是本模块唯一没接 DB 的判定面）。
 */
export function classifyPlanEntries(input: {
  entries: PlannedAccountEntry[];
  nowMs: number;
  attemptedAccountIds: number[];
  missedThresholdMs?: number;
}): { due: PlannedAccountEntry[]; missed: PlannedAccountEntry[]; upcoming: PlannedAccountEntry[] } {
  const thresholdMs = input.missedThresholdMs ?? MISSED_THRESHOLD_MS;
  const attempted = new Set(input.attemptedAccountIds);
  const sorted = input.entries
    .filter((entry) => !attempted.has(entry.accountId))
    .slice()
    .sort((a, b) => a.plannedFireMs - b.plannedFireMs);

  const due: PlannedAccountEntry[] = [];
  const missed: PlannedAccountEntry[] = [];
  const upcoming: PlannedAccountEntry[] = [];
  for (const entry of sorted) {
    if (entry.plannedFireMs > input.nowMs) {
      upcoming.push(entry);
    } else if (entry.plannedFireMs >= input.nowMs - thresholdMs) {
      due.push(entry);
    } else {
      missed.push(entry);
    }
  }
  return { due, missed, upcoming };
}

/**
 * 计算并挂下一只定时器。任何计划重写后都必须调用它——
 * 旧定时器若仍 armed，账号会按已被作废的旧时刻发出，而新时刻无人认领（决策 19.8）。
 */
function armNextOrStop(nowMs = Date.now()) {
  clearFireTimer();
  const plan = activePlan;
  if (!plan) return;
  const { upcoming } = classifyPlanEntries({
    entries: plan.entries,
    nowMs,
    attemptedAccountIds: plan.attemptedAccountIds,
  });
  if (upcoming.length === 0) return;
  const next = upcoming[0]; // classifyPlanEntries 已按 plannedFireMs 升序，且上方已排除空集
  fireTimer = setTimeout(() => {
    void runDispatchPass();
  }, Math.max(0, next.plannedFireMs - nowMs));
  // 定时器不应阻止进程退出。
  (fireTimer as unknown as { unref?: () => void }).unref?.();
}

/** 跳过处置：丢弃当日剩余安排并通知一次，由人工点「运行所有签到」补。 */
async function handleMissedAccounts(count: number, planDateKey: string) {
  clearFireTimer();
  const notified = await readSetting<string>(CHECKIN_DELAY_SETTING_KEYS.skippedNotice);
  if (notified === planDateKey) return; // 同一天只打扰一次
  await upsertSetting(CHECKIN_DELAY_SETTING_KEYS.skippedNotice, planDateKey);
  console.warn(`[CheckinDelay] Skipped ${count} accounts for today (missed beyond threshold)`);
  await sendNotification(
    '签到随机延迟：当日部分账号已跳过',
    `有 ${count} 个账号的计划签到时刻落后超过 ${Math.round(MISSED_THRESHOLD_MS / 60_000)} 分钟未执行`
    + '（进程停摆或时间跳变）。按定稿规则当日不再自动补跑；如需补齐请手动点击「运行所有签到」，'
    + '该操作同样按随机延迟分散执行，不会瞬时齐发。',
    'warning',
  ).catch((err) => console.error('[CheckinDelay] Skip notice failed:', err));
}

/**
 * 一次派发：发出已到期且未判错过的账号，跳过落后超过阈值者，然后重挂下一只定时器。
 */
async function runDispatchPass(): Promise<{ fired: number; skipped: number }> {
  const plan = activePlan;
  if (!plan || dispatching) return { fired: 0, skipped: 0 };

  const nowMs = Date.now();
  const classified = classifyPlanEntries({
    entries: plan.entries,
    nowMs,
    attemptedAccountIds: plan.attemptedAccountIds,
  });
  const { due, missed } = classified;
  let fired = 0;

  if (due.length > 0) {
    dispatching = true;
    try {
      // 一次查询取回全部相关账号的 lastCheckinAt，避免每账号一次往返。
      const fresh = await listEligibleAccounts();
      const latestById = new Map(fresh.map((account) => [account.id, account.lastCheckinAt]));
      const handled: number[] = [];
      for (const entry of due) {
        // 三种情况都算「本轮已处理」，一律登记，否则该条目会一直留在到期集里，
        // 最终滑进 missed 并对一个当天其实已成功的账号发出误导性的「已跳过」通知。
        if (!latestById.has(entry.accountId)) {
          handled.push(entry.accountId); // 账号已禁用或删除
          continue;
        }
        if (hasCheckedInToday(latestById.get(entry.accountId) ?? null, plan.planDateKey)) {
          handled.push(entry.accountId); // 今日已签（可能由手动通路完成）
          continue;
        }
        handled.push(entry.accountId);
        try {
          await checkinAccount(entry.accountId, { skipEvent: true, scheduleMode: plan.mode });
          fired += 1;
        } catch (err) {
          console.error(`[CheckinDelay] Account ${entry.accountId} check-in error:`, err);
        }
      }

      if (handled.length > 0) {
        // 落盘「本轮已发起」：失败账号由此保证当日只发起一次（见 PersistedCheckinPlan 注释）。
        const merged = new Set(plan.attemptedAccountIds);
        for (const id of handled) merged.add(id);
        plan.attemptedAccountIds = Array.from(merged);
        await upsertSetting(CHECKIN_DELAY_SETTING_KEYS.plan, plan);
      }
    } finally {
      dispatching = false;
    }
  }

  if (missed.length > 0) {
    await handleMissedAccounts(missed.length, plan.planDateKey);
  }

  armNextOrStop(Date.now());
  return { fired, skipped: missed.length };
}

/**
 * 生成或复用当日计划。
 * @param anchorMs 锚点：cron 到点时刻，或手动点击时刻（后者实现决策 19 的「就地重锚」）
 * @param forceReanchor 丢弃既有当日安排全量重排（手动全量按钮使用）
 */
export async function scheduleDelayedCheckinRun(input: {
  anchorMs: number;
  mode: ScheduleMode;
  config?: CheckinDelayConfig;
  forceReanchor?: boolean;
}): Promise<{ ok: boolean; reason?: string; total?: number; lastPlannedMs?: number }> {
  const cfg = input.config ?? await loadCheckinDelayConfig();
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };

  const anchorMs = input.anchorMs;
  const window = resolveDelayWindow({ anchorMs, config: cfg, dayEndMs: getLocalDayEndMs(anchorMs) });
  if (!window.ok) {
    console.warn(`[CheckinDelay] No usable window (${window.reason})`);
    return { ok: false, reason: window.reason };
  }

  const planDateKey = formatLocalDate(new Date(anchorMs));
  const seed = await ensureSeed();
  const accounts = await listEligibleAccounts();
  const pendingAccounts = accounts.filter((account) => !hasCheckedInToday(account.lastCheckinAt, planDateKey));
  if (pendingAccounts.length === 0) return { ok: false, reason: 'nothing-pending' };
  const pendingIds = pendingAccounts.map((account) => account.id);

  // 复用条件：同一天、同锚点、同配置指纹。手动重锚或参数变更都会走全量重排。
  const stored = await readSetting<PersistedCheckinPlan>(CHECKIN_DELAY_SETTING_KEYS.plan);
  const reusable = !input.forceReanchor && stored
    && stored.planDateKey === planDateKey
    && stored.anchorMs === anchorMs
    && stored.configStamp === buildConfigStamp(cfg)
    ? stored
    : null;
  const existingEntries = reusable ? reusable.entries : [];
  // 份数取冻结值：复用当日计划时沿用库里的 N，新建时才按当次待发账号数确定。
  const bandCount = reusable ? reusable.bandCount : pendingIds.length;
  // 已发起集合只保留「当次仍待发」的账号：失败账号必须留在里面（当日不再重复发起），
  // 而当日已成功或已删除的账号会退出待发集，若不清理就会永久堆积在计划 JSON 里。
  const pendingSet = new Set(pendingIds);
  const attemptedAccountIds = reusable && !input.forceReanchor
    ? reusable.attemptedAccountIds.filter((id) => pendingSet.has(id))
    : [];

  const newcomers = pendingIds.filter((id) => !existingEntries.some((entry) => entry.accountId === id));
  const assigned: PlannedAccountEntry[] = [];
  let deferredCount = 0;

  if (newcomers.length > 0) {
    const occupiedBands = existingEntries.map((entry) => entry.bandIndex);
    const orderedNewcomers = buildDailyAccountOrder({ accountIds: newcomers, planDateKey, seed });
    const result = assignDelayBands({
      orderedAccountIds: orderedNewcomers,
      occupiedBands,
      // 显式传入冻结份数，令窗口切分与已落盘的老账号保持同一套带边界。
      bandCount,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      nowMs: Date.now(),
      planDateKey,
      seed,
    });
    // 冻结的 N 份被占满后，多出来的账号当日延后（决策 11：不重排已排定者）。
    deferredCount = newcomers.length - result.items.length;
    assigned.push(...result.items.map((item) => ({
      accountId: item.accountId,
      bandIndex: item.bandIndex,
      plannedFireMs: item.plannedFireMs,
    })));
  }

  const entries = mergePlanEntries({ existing: existingEntries, assigned, pendingAccountIds: pendingIds });
  if (entries.length === 0) return { ok: false, reason: 'no-entry-assigned' };

  const plan: PersistedCheckinPlan = {
    planDateKey,
    anchorMs,
    mode: input.mode,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    configStamp: buildConfigStamp(cfg),
    bandCount,
    attemptedAccountIds,
    entries,
  };
  await upsertSetting(CHECKIN_DELAY_SETTING_KEYS.plan, plan);
  activePlan = plan;
  armNextOrStop();

  const lastPlannedMs = entries.reduce((max, entry) => Math.max(max, entry.plannedFireMs), anchorMs);
  if (deferredCount > 0) {
    console.warn(`[CheckinDelay] ${deferredCount} accounts deferred today (no future band available)`);
  }
  console.log(
    `[CheckinDelay] Plan ready: ${entries.length} accounts, window `
    + `${Math.round((window.endMs - window.startMs) / 60_000)}min`
    + `${window.compressed ? ' (compressed to end of day)' : ''}, last fire at ${new Date(lastPlannedMs).toISOString()}`,
  );

  // 已有到期项（锚点在过去、或新账号拿到当前时刻后的第一格）立即处理一轮。
  if (entries.some((entry) => entry.plannedFireMs <= Date.now())) {
    await runDispatchPass();
  }

  return { ok: true, total: entries.length, lastPlannedMs };
}

/**
 * 设置页两条「只提示、不拦截」判据的权威计算处（定稿第 8.2 条与第 4 条）。
 *
 * 放在派发层而不是前端，理由有三：
 * - 账号数必须复用 `listEligibleAccounts` 那份带 where 的查询，前端拿不到也不该自己拼口径；
 * - 「过窄」的阈值线 `CHECKIN_DELAY_NARROW_HINT_MS` 属策略层常量，不该被抄进 UI；
 * - 单位换算同样只有策略层一份权威（`toDelayMs`），前端重抄一份必然与服务端漂移。
 *
 * 只做只读估算，**不参与任何排期决策**：这两条按定稿明确「仅提示不拦截」。
 */
export async function describeCheckinDelayHintInput(): Promise<{
  windowMs: number;
  accountCount: number;
  avgBandMs: number;
  tooNarrow: boolean;
  compressed: boolean;
}> {
  const cfg = await loadCheckinDelayConfig();
  // 功能未开启时**不给出任何拥挤判断**：窗口宽度此时按 0 算会得到 avgBandMs=0 → tooNarrow=true，
  // 那是一句谎报 —— 用户没开这个功能，却被告知「分散效果有限」。账号数仍照常返回（它是客观事实），
  // 但两条判据一律为 false，让「关闭态的回显」与「关闭态的行为」一致。
  if (!cfg.enabled) {
    return { windowMs: 0, accountCount: (await listEligibleAccounts()).length, avgBandMs: 0, tooNarrow: false, compressed: false };
  }

  const accounts = await listEligibleAccounts();
  const windowMs = Math.max(0, cfg.maxMs - cfg.minMs);
  const { avgBandMs, tooNarrow } = estimateDelayBands({
    windowMs,
    accountCount: accounts.length,
    minBandMs: CHECKIN_DELAY_NARROW_HINT_MS,
  });

  // 压缩判定：窗口终点是否被本地日终截断。
  // 取「已建成的当日计划」里的实际边界来判，而不是在这里重算一次 cron 下次执行时刻 ——
  // 后者要么引入 cron-parser 新依赖，要么自己实现一套 cron 求解器，两条都比这条提示本身贵。
  // 代价是诚实的：进程刚重启、当天还没跑过 cron 时 activePlan 为空，compressed 只能报 false
  // （不谎报），用户保存一次设置或等当天首次到点后这个值才会亮。
  let compressed = false;
  // 此处已在「功能开启」分支内（上面关闭时已提前返回），故只判模式。
  if (config.checkinScheduleMode === 'cron') {
    const plan = activePlan ?? await readSetting<PersistedCheckinPlan>(CHECKIN_DELAY_SETTING_KEYS.plan);
    if (plan) {
      const dayEndMs = getLocalDayEndMs(plan.anchorMs);
      compressed = plan.anchorMs + cfg.maxMs > dayEndMs;
    }
  }

  return { windowMs, accountCount: accounts.length, avgBandMs, tooNarrow, compressed };
}

/** 设置页与扫描用的计划概览。 */
export function describeCheckinDelayPlan(nowMs = Date.now()): {
  active: boolean;
  planDateKey: string | null;
  anchorMs: number | null;
  scheduled: number;
  upcoming: number;
  missed: number;
  attempted: number;
  nextFireAt: string | null;
} {
  const plan = activePlan;
  if (!plan) {
    return { active: false, planDateKey: null, anchorMs: null, scheduled: 0, upcoming: 0, missed: 0, attempted: 0, nextFireAt: null };
  }
  // 与派发通路共用同一分类器，保证「设置页看到的数」与「实际会发的数」不是两套算法。
  const { due, missed, upcoming } = classifyPlanEntries({
    entries: plan.entries,
    nowMs,
    attemptedAccountIds: plan.attemptedAccountIds,
  });
  const next = upcoming[0];
  return {
    active: true,
    planDateKey: plan.planDateKey,
    anchorMs: plan.anchorMs,
    scheduled: plan.entries.length,
    upcoming: upcoming.length,
    missed: missed.length,
    attempted: plan.attemptedAccountIds.length + due.length,
    nextFireAt: next ? new Date(next.plannedFireMs).toISOString() : null,
  };
}

/**
 * 兜底扫描：重启后从库中恢复当日计划、参数变更自愈、补发漏掉的到期项。
 * 每天一次小 JSON 读写，频率远低于被删除的 60 秒全表轮询。
 */
/**
 * interval 通路的安全扫描回调。
 *
 * 为什么需要它：本模块的三条扫描分支做的全是 **cron 语义** 的事（当日计划、锚点重排、当日去重），
 * 而定稿第 6 节与第 18 节明确禁止把这些套到 interval。可 interval 又确实需要这条低频扫描 ——
 * 单只 setTimeout 无法从进程重启、中途新增账号、日键翻转中自行恢复，没有扫描就会永久停摆。
 * 所以这里不复制到期逻辑（那是 `checkinScheduler` 的权威），只在 interval 模式下回调过去
 * 让它「按自己的判据重算最早到期并重挂」。回调未装载时静默跳过，绝不在 interval 下发 cron 计划。
 */
type IntervalResyncHook = () => Promise<void> | void;
let intervalResyncHook: IntervalResyncHook | null = null;

/** 由调度器在装载 interval 通路时注册；传 null 卸载。注册动作本身无副作用。 */
export function setCheckinIntervalResyncHook(hook: IntervalResyncHook | null) {
  intervalResyncHook = hook;
}

async function runSafetySweep(cfg: CheckinDelayConfig): Promise<void> {
  if (!cfg.enabled) {
    resetCheckinDelayState('delay disabled');
    return;
  }
  // interval 模式：把这一拍整个交还给调度器，本模块不建计划、不发号、不判错过。
  if (config.checkinScheduleMode === 'interval') {
    await intervalResyncHook?.();
    return;
  }
  const nowMs = Date.now();
  const todayKey = formatLocalDate(new Date(nowMs));
  const stored = await readSetting<PersistedCheckinPlan>(CHECKIN_DELAY_SETTING_KEYS.plan);
  const stamp = buildConfigStamp(cfg);

  // ① 进程内有当天计划：正常推进，或参数变更时按原锚点重排。
  if (activePlan && activePlan.planDateKey === todayKey) {
    if (activePlan.configStamp !== stamp) {
      await scheduleDelayedCheckinRun({
        anchorMs: activePlan.anchorMs,
        mode: activePlan.mode,
        config: cfg,
        forceReanchor: true,
      });
      return;
    }
    await runDispatchPass();
    return;
  }

  // ② 库里存在当天计划（进程刚重启）：原样恢复冻结的窗口与已发起集合，不做任何重算。
  // 之所以直接用 stored 的窗口边界而不是按当前 cfg 重算：计划是当天冻结的，
  // 用新参数重算会让已落盘的 plannedFireMs 落到新窗口之外，与 bandIndex 不再自洽。
  if (stored && stored.planDateKey === todayKey) {
    if (stored.configStamp !== stamp) {
      // 停摆期间改过参数：按原锚点重排，而不是带着过期边界继续发。
      await scheduleDelayedCheckinRun({
        anchorMs: stored.anchorMs,
        mode: stored.mode,
        config: cfg,
        forceReanchor: true,
      });
      return;
    }
    activePlan = stored;
    console.log(`[CheckinDelay] Restored day plan after restart (${stored.entries.length} accounts)`);
    await runDispatchPass();
    return;
  }

  // ③ 今天没有计划，库里只有往日计划（或从来没有过）：**静默返回，不判错过、不发通知**。
  // 这条分支无法区分两种情形：「今天的 cron 还没到点」与「到点时进程正停摆所以没建成计划」——
  // 因为 cron 到点必然会覆盖写当天计划，看到「昨天的计划 + 今天没人签」时两种都可能。
  // 早上 07:00 重启就会命中它：今天一个号都还没签，若据此发「当日部分账号已跳过」通知，
  // 就是一句每次开机都可能出现的误导话。误报比漏报更糟（通知渠道一旦不可信就没人看）。
  // 「错过跳过当日」的通知只在 ①② 两条分支产生：那两处确实存在**当天**的计划，
  // 由 classifyPlanEntries 判出 missed，正是定稿第 18 节描述的场景（带着计划停摆后醒来）。
  // 残留缺口（已知并接受）：整个 cron 时刻都停机 → 当天没建过计划 → 不发通知；
  // 该情形会体现在 23:58 的签到日报里（成功数为 0），设置页的 checkinDelayPlan 也会显示 active=false。
  if (!stored) return;
  // 一天只播一次：这行在 cron 到点前每 10 分钟命中一次，按扫描频率刷屏会把日志刷成噪声，
  // 反而让真正要看的「当日已跳过」通知没人信。
  if (noPlanNoticeDateKey === todayKey) return;
  noPlanNoticeDateKey = todayKey;
  console.log(`[CheckinDelay] No day plan for ${todayKey} yet (latest stored plan: ${stored.planDateKey})`);
}

/** 安装兜底扫描定时器（幂等；关闭状态不安装）。启动即跑一次以覆盖进程重启。 */
export function ensureCheckinDelaySweep(cfg: CheckinDelayConfig) {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  if (!cfg.enabled) return;
  sweepTimer = setInterval(() => {
    void runSafetySweep(cfg).catch((err) => console.error('[CheckinDelay] Safety sweep error:', err));
  }, SAFETY_SWEEP_INTERVAL_MS);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
  void runSafetySweep(cfg).catch((err) => console.error('[CheckinDelay] Initial sweep error:', err));
}

/** 作废进程内计划与定时器（配置变更、模式切换、热更时调用）。 */
export function resetCheckinDelayState(reason: string) {
  clearFireTimer();
  if (activePlan) {
    console.log(`[CheckinDelay] Day plan invalidated: ${reason}`);
    activePlan = null;
  }
}

/**
 * 停掉延迟运行时的全部定时器并丢弃当日计划。
 * 切到 interval 模式或关闭功能时由调度器调用，比让调用方伪造一个 `enabled:false` 的配置对象更清楚。
 */
export function stopCheckinDelayRuntime(reason: string) {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  resetCheckinDelayState(reason);
}

/**
 * 当日计划已接管、但尚未发起的账号 id。
 *
 * 存在理由：interval 模式的 60 秒轮询按自己的到期规则整批提交（`checkinScheduler.ts` 的
 * `runIntervalCheckinPass`），而手动「运行所有签到」会以点击时刻重锚出一份当日计划（决策 19）。两者若同时生效，
 * 同一账号会被轮询与计划各发一次 —— 正是本方案要避免的「同账号同日两次请求」。
 * 已发起（attempted）的账号不在此列：交还给 interval 自身的到期与重试语义（定稿第 6 节不可套当日去重）。
 */
export function listPlanOwnedAccountIds(nowMs = Date.now()): number[] {
  const plan = activePlan;
  if (!plan) return [];
  const { due, upcoming, missed } = classifyPlanEntries({
    entries: plan.entries,
    nowMs,
    attemptedAccountIds: plan.attemptedAccountIds,
  });
  return [...due, ...upcoming, ...missed].map((entry) => entry.accountId);
}

/** 测试用：清空全部进程内状态。 */
export function __resetCheckinDelayDispatcherForTests() {
  clearFireTimer();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  activePlan = null;
  dispatching = false;
  noPlanNoticeDateKey = null;
}

/** 导出阈值供测试与概览使用。 */
export const CHECKIN_DELAY_THRESHOLDS = {
  missedThresholdMs: MISSED_THRESHOLD_MS,
  safetySweepIntervalMs: SAFETY_SWEEP_INTERVAL_MS,
};
