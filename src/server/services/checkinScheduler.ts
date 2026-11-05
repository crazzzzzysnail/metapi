import cron from 'node-cron';
import { and, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll } from './checkinService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs } from './logCleanupService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';
import { formatCheckinDelayWindow, intervalAccountOffsetMs } from '../shared/checkinDelayPolicy.js';
import { formatLocalDate, toLocalDayKeyFromStoredUtc } from './localTimeService.js';
import {
  ensureCheckinDelaySweep,
  ensureSeed,
  listPlanOwnedAccountIds,
  loadCheckinDelayConfig,
  scheduleDelayedCheckinRun,
  setCheckinIntervalResyncHook,
  resetCheckinDelayState,
  stopCheckinDelayRuntime,
  __resetCheckinDelayDispatcherForTests,
} from './checkinDelayDispatcher.js';

export type CheckinScheduleMode = 'cron' | 'interval';

let checkinTask: cron.ScheduledTask | null = null;
/** interval 通路的**单只**唤醒定时器（定稿第 14 节取代原先的 60 秒 setInterval）。 */
let intervalWakeTimer: ReturnType<typeof setTimeout> | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;
const intervalAttemptByAccount = new Map<number, number>();

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
/**
 * interval 通路在无候选账号时的兜底唤醒间隔。
 * 与派发器的低频安全扫描同量级（10 分钟），两条链路各留一只慢拍，避免其中一条未装载时整条链停摆。
 * 这是被删除的 60 秒全表轮询的替代物：频率低两个数量级，且只在「一个候选账号都没有」时才走到。
 */
const INTERVAL_FALLBACK_WAKE_MS = 10 * 60 * 1000;

function clearIntervalTimer() {
  if (intervalWakeTimer) {
    clearTimeout(intervalWakeTimer);
    intervalWakeTimer = null;
  }
}

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Running check-in at ${new Date().toISOString()}`);
    try {
      // 随机延迟开启时改为生成当日计划并按时刻逐个发起；关闭时走原有整批路径，行为逐字不变。
      const delayConfig = await loadCheckinDelayConfig();
      if (delayConfig.enabled) {
        const result = await scheduleDelayedCheckinRun({ anchorMs: Date.now(), mode: 'cron', config: delayConfig });
        console.log(result.ok
          ? `[Scheduler] Delayed check-in planned: ${result.total} accounts, last fire at ${new Date(result.lastPlannedMs ?? Date.now()).toISOString()}`
          : `[Scheduler] Delayed check-in not started: ${result.reason}`);
        return;
      }
      const results = await checkinAll({ scheduleMode: 'cron' });
      const success = results.filter((r) => r.result.success).length;
      const failed = results.length - success;
      console.log(`[Scheduler] Check-in complete: ${success} success, ${failed} failed`);
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
    }
  });
}

type IntervalCheckinCandidate = {
  id: number;
  lastCheckinAt?: string | null;
};

export function selectDueIntervalCheckinAccountIds(
  rows: IntervalCheckinCandidate[],
  intervalHours: number,
  now = new Date(),
  attemptState = intervalAttemptByAccount,
  offsetMsOf?: (row: IntervalCheckinCandidate) => number,
) {
  const nowMs = now.getTime();
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  return rows
    .filter((row) => {
      // 定稿第 6 节第 59 行：interval 保留自身到期规则，只在到期基准上**叠加**每账户随机偏移。
      // 因此下面四条判定一律不动，只把比较用的门槛从 intervalMs 换成 intervalMs + 该账号的偏移。
      // 不传 offsetMsOf、或功能关闭时偏移为 0，判据与改造前逐字等价。
      const offsetMs = offsetMsOf ? Math.max(0, offsetMsOf(row) || 0) : 0;
      const dueAfterMs = intervalMs + offsetMs;
      const lastCheckinMs = row.lastCheckinAt ? Date.parse(row.lastCheckinAt) : Number.NaN;
      const lastAttemptMs = attemptState.get(row.id);
      if (Number.isFinite(lastCheckinMs)) {
        if (nowMs - lastCheckinMs < dueAfterMs) return false;
        if (typeof lastAttemptMs === 'number' && lastAttemptMs >= lastCheckinMs && nowMs - lastAttemptMs < dueAfterMs) {
          return false;
        }
        return true;
      }
      if (typeof lastAttemptMs === 'number' && nowMs - lastAttemptMs < dueAfterMs) return false;
      return true;
    })
    .map((row) => row.id);
}

/**
 * 单个账号在 interval 通路下的下次到期时刻（epoch 毫秒），以及延迟关闭时的退化值。
 *
 * 与 `selectDueIntervalCheckinAccountIds` 共用同一条门槛（起算点 + N 小时 + 每账户偏移），
 * 这是事件驱动成立的前提：定时器按这里的时刻挂，筛选按那边判，两者必须是同一个算式，
 * 否则会出现「挂到 10:00 却被判据拦下」或反之的空转/漏发。
 * 返回 null 表示该账号此刻不参与（不该发生，由调用方兜底）。
 */
export function nextIntervalDueMs(
  row: IntervalCheckinCandidate,
  intervalHours: number,
  attemptState = intervalAttemptByAccount,
  offsetMs = 0,
): number | null {
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
  const dueAfterMs = intervalMs + Math.max(0, offsetMs || 0);
  const lastCheckinMs = row.lastCheckinAt ? Date.parse(row.lastCheckinAt) : Number.NaN;
  const lastAttemptMs = attemptState.get(row.id);

  // 从未签到过：没有可依据的起算点，视为立刻到期（与改造前的轮询语义一致 —— 首轮就会带走它）。
  if (!Number.isFinite(lastCheckinMs)) {
    return typeof lastAttemptMs === 'number' ? lastAttemptMs + dueAfterMs : 0;
  }
  let baseMs = lastCheckinMs + dueAfterMs;
  // 失败时 checkinService.ts:203 刻意不推进时间戳，靠内存里的发起时刻挡住立刻重试；
  // 起算点取两者较大者，语义与原判据逐字相同，只是门槛里多了偏移。
  if (typeof lastAttemptMs === 'number' && lastAttemptMs >= lastCheckinMs) {
    baseMs = Math.max(baseMs, lastAttemptMs + dueAfterMs);
  }
  return baseMs;
}

/**
 * interval 通路的候选账号查询。**必须带 where**，这是定稿第 14 节把轮询收敛掉的主要收益之一：
 * 原先这里是 `accounts INNER JOIN sites` 的无 where 整表拉回再在 JS 里 filter，
 * 每 60 秒一次打到远端 TiDB。现在只在 SQL 层筛掉不启用签到与已停用的账号，
 * 站点停用这一条留在 JS（与派发器 listEligibleAccounts 同样的处理，避免两处口径不一）。
 */
async function listIntervalCheckinCandidates(): Promise<IntervalCheckinCandidate[]> {
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

/**
 * 候选账号里最早的下一次到期时刻。全部无候选时返回 null，由低频安全扫描重新装载。
 * 与 `selectDueIntervalCheckinAccountIds` / `nextIntervalDueMs` 共用同一条门槛算式 ——
 * 挂表与筛选若不同源，就会出现「定时器挂到某刻却被判据拦下」的空转，或反之的漏发。
 */
export function earliestIntervalDueMs(
  rows: IntervalCheckinCandidate[],
  intervalHours: number,
  offsetMsOf?: (row: IntervalCheckinCandidate) => number,
  attemptState = intervalAttemptByAccount,
): number | null {
  let earliest: number | null = null;
  for (const row of rows) {
    const dueMs = nextIntervalDueMs(row, intervalHours, attemptState, offsetMsOf ? offsetMsOf(row) : 0);
    if (dueMs === null || !Number.isFinite(dueMs)) continue;
    if (earliest === null || dueMs < earliest) earliest = dueMs;
  }
  return earliest;
}

async function runIntervalCheckinPass(now = new Date()) {
  // 当日计划已接管但尚未发起的账号必须让路：手动「运行所有签到」会以点击时刻重锚出一份
  // 当日计划（定稿第 19 节），若轮询再把它们整批提交，同一账号会被轮询与计划各发一次，
  // 正是本方案要消除的「同账号同日两次请求」。
  // 计划里已发起（attempted）的账号不在让路之列 —— 定稿第 18 节要求 interval 保留自己的
  // 到期与失败重试语义，不能用当日集合去阻断下一轮重试。
  const planOwnedIds = new Set(listPlanOwnedAccountIds(now.getTime()));
  // interval 通路同样要带每账户随机偏移（定稿第 6 节第 59 行）。种子复用派发器那一份实例级种子，
  // 不另起第二颗；延迟关闭时 offsetConfig.enabled 为假，偏移恒为 0，判据退回改造前的行为。
  const delayConfig = await loadCheckinDelayConfig();
  const offsetSeed = await ensureSeed();
  const offsetConfig = { enabled: delayConfig.enabled, minMs: delayConfig.minMs, maxMs: delayConfig.maxMs };
  /**
   * 某账号本轮的偏移。日键取「本轮起算点」（上次签到时刻）所在日，而不是今天：
   * 这样某一轮的偏移与它的起点绑定，跨过本地午夜或在等待途中重启都不会改变它，
   * 不会出现「每天零点所有在等账号的到期时刻集体移位」这种新的齐发特征。
   * 从未签过号的账号没有起算点，退用当前日键（它本来就该立刻被带走）。
   */
  const offsetFor = (row: IntervalCheckinCandidate): number => {
    if (!offsetConfig.enabled) return 0;
    const roundKey = row.lastCheckinAt ? toLocalDayKeyFromStoredUtc(row.lastCheckinAt) : null;
    return intervalAccountOffsetMs({
      seed: offsetSeed,
      roundPlanDateKey: roundKey ?? formatLocalDate(now),
      accountId: row.id,
      config: offsetConfig,
    });
  };
  const candidates = await listIntervalCheckinCandidates();

  const dueAccountIds = selectDueIntervalCheckinAccountIds(
    candidates,
    config.checkinIntervalHours,
    now,
    intervalAttemptByAccount,
    offsetFor,
  ).filter((id) => !planOwnedIds.has(id));

  if (dueAccountIds.length === 0) {
    // 一个都没到期不等于「什么都不用做」：必须按最早的下一次到期重挂，否则事件驱动会就此停摆，
    // 再也无人唤起下一轮（这正是删掉 setInterval 后最容易漏的一环）。
    await armNextIntervalPass(now);
    return;
  }

  try {
    const results = await checkinAll({
      accountIds: dueAccountIds,
      scheduleMode: 'interval',
    });
    const nowMs = now.getTime();
    for (const item of results) {
      intervalAttemptByAccount.set(item.accountId, nowMs);
    }
    const success = results.filter((r) => r.result.success).length;
    const failed = results.length - success;
    console.log(`[Scheduler] Interval check-in complete: ${success} success, ${failed} failed`);
  } catch (err) {
    console.error('[Scheduler] Interval check-in error:', err);
  }

  // 发出后必须重挂：本轮的 lastCheckinAt / attempt 时刻都变了，下次到期时刻随之改变。
  await armNextIntervalPass(new Date());
}

/**
 * 算出「最早的下一次到期」并只挂**一只** setTimeout（定稿第 13、14 节的事件驱动形态）。
 * 与 cron 通路共用同一个范式：不引入周期轮询，全天定时器数恒为 1。
 */
async function armNextIntervalPass(now = new Date()): Promise<void> {
  clearIntervalTimer();
  const delayConfig = await loadCheckinDelayConfig();
  const offsetSeed = await ensureSeed();
  const offsetConfig = { enabled: delayConfig.enabled, minMs: delayConfig.minMs, maxMs: delayConfig.maxMs };
  const candidates = await listIntervalCheckinCandidates();
  const nextDueMs = earliestIntervalDueMs(
    candidates,
    config.checkinIntervalHours,
    (row) => (offsetConfig.enabled
      ? intervalAccountOffsetMs({
        seed: offsetSeed,
        roundPlanDateKey: row.lastCheckinAt ? toLocalDayKeyFromStoredUtc(row.lastCheckinAt) ?? formatLocalDate(now) : formatLocalDate(now),
        accountId: row.id,
        config: offsetConfig,
      })
      : 0),
  );
  if (nextDueMs === null) {
    // 没有候选账号。**不能就此返回**：低频安全扫描只在延迟开启时装载，延迟关闭时它是整条链路上
    // 唯一的唤起者。若这里留空，一个当前无账号、后来才被加进来的实例将永远不会有人叫醒 ——
    // 这正是删掉 setInterval 最容易留下的停摆窗口。用一只兜底拍代替原来的每 60 秒轮询：
    // 频率低两个数量级，且到期判据仍由 runIntervalCheckinPass 独占（不在这里复制一份）。
    intervalWakeTimer = setTimeout(() => {
      void runIntervalCheckinPass();
    }, INTERVAL_FALLBACK_WAKE_MS);
    (intervalWakeTimer as unknown as { unref?: () => void }).unref?.();
    return;
  }
  const delayMs = Math.max(0, nextDueMs - now.getTime());
  intervalWakeTimer = setTimeout(() => {
    void runIntervalCheckinPass();
  }, delayMs);
  // 定时器不应阻止进程退出（与派发器同一处理，避免热更与测试挂住）。
  (intervalWakeTimer as unknown as { unref?: () => void }).unref?.();
}

function stopCheckinSchedule() {
  checkinTask?.stop();
  checkinTask = null;
  clearIntervalTimer();
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  if (config.checkinScheduleMode === 'interval') {
    // 定稿第 14 节：原来的 setInterval(..., 60_000) 无 where 全表轮询已删除，
    // 改为「算最早到期 → 挂单定时器 → 发出后重挂」。启动即跑一次，保证停机期间到期的
    // 账号在进程起来后立刻被带走（等价于旧轮询的第一轮，但不再周期性重复）。
    void runIntervalCheckinPass();
    return;
  }
  checkinTask = createCheckinTask(config.checkinCron);
}

/** 日志用的窗口描述，直接取设置页回显的那份「原值 + 原单位」，两处数字必须能对上。 */
function describeCheckinDelayWindow(): string {
  return formatCheckinDelayWindow(config.checkinDelayMin, config.checkinDelayMax, config.checkinDelayUnit);
}

/**
 * 让延迟运行时与「当前调度模式 + 当前延迟配置」对齐。
 *
 * 这是唯一的装载入口：启动、调度变更、延迟设置变更三处共用，避免「该不该建定时器」的判断
 * 在多处各写一份而漂移。异步是因为要读设置表里的延迟配置（cron 到点那条路径同理）。
 * **不要直接调用它**，一律走 `queueCheckinDelayRuntimeSync`，否则会与其他调用方并发交错（见该函数注释）。
 */
async function syncCheckinDelayRuntime(reason: string) {
  const delayConfig = await loadCheckinDelayConfig();
  if (!delayConfig.enabled) {
    // 用户确实打开了开关，但存下来的窗口参数非法 —— 归一化会整体回落成「未启用」。
    // 这属于静默失效，必须显式告警：否则设置页开关显示为开、实际永远不延迟，无从排查。
    if (config.checkinDelayEnabled) {
      console.warn(
        `[Scheduler] Check-in random delay is enabled but the stored window is invalid`
        + ` (${describeCheckinDelayWindow()}), treating it as disabled`,
      );
    }
    console.log(`[Scheduler] Check-in random delay: off (${reason})`);
    // 关闭时同样要摘掉 interval 钩子：否则派发器仍会在扫描拍上回调一条已经无人装载的重挂路径。
    setCheckinIntervalResyncHook(null);
    stopCheckinDelayRuntime('random delay disabled');
    return;
  }
  // 回显用户设置的原值 + 原单位（而不是换算后的毫秒）：与设置页看到的数字一致，便于人工核对。
  console.log(`[Scheduler] Check-in random delay: on (window ${describeCheckinDelayWindow()}, ${reason})`);
  // interval 模式先交还重挂权：扫描拍到这一拍时由本模块按自己的到期判据重算最早到期并重挂定时器，
  // 派发器不参与发号（定稿第 6/18 节禁止对它套用当日去重与跳过当日）。
  setCheckinIntervalResyncHook(
    config.checkinScheduleMode === 'interval' ? () => armNextIntervalPass() : null,
  );
  // 切到 interval 时必须丢弃 cron 通路残留的当日计划：那份计划的时刻是按已被作废的模式算出来的，
  // 留着它，派发器的 cron 分支仍会在安全扫描上把它继续发出去，与 interval 自己的到期通路双发同一账号。
  if (config.checkinScheduleMode === 'interval') {
    resetCheckinDelayState(`schedule mode = ${config.checkinScheduleMode}`);
  }
  // 两条通路都只装载**低频安全扫描**，装载后立刻跑一次（ensureCheckinDelaySweep 内建这一次）。
  // 这次扫描对 interval 是必需的而非可选的：单只 setTimeout 不会自己从进程重启、中途新增账号、
  // 或日键翻转变化的到期时刻中恢复，没有它整个 interval 通路会在第一次重启后永久停摆。
  // 定稿第 18 节禁止的是把「当日去重 / 错过跳过当日」套到 interval，不是禁止复用这条扫描。
  ensureCheckinDelaySweep(delayConfig);
}

/**
 * 延迟运行时同步的唯一排队入口。
 *
 * 必须串行：一次 PUT 同时改了签到方式与延迟设置时会触发两次同步，而每次都要 await 读库。
 * 若并发跑，「读到的旧配置 → 拆掉运行时」这一步可能后于「读到新配置 → 装载运行时」落地，
 * 用户刚打开的开关会被上一次过期的读取盖掉。排队后永远是最后一次请求的配置说了算。
 */
let delayRuntimeSyncChain: Promise<void> = Promise.resolve();

function queueCheckinDelayRuntimeSync(reason: string): Promise<void> {
  delayRuntimeSyncChain = delayRuntimeSyncChain
    .then(() => syncCheckinDelayRuntime(reason))
    .catch((err) => {
      console.error('[Scheduler] Delay runtime refresh error:', err);
    });
  return delayRuntimeSyncChain;
}

/**
 * 延迟设置变更后由设置路由调用：按新参数装载或卸载运行时。
 *
 * 这里**不**重建 cron 任务，也不丢弃当日计划：cron 表达式没变，今天的锚点就没变，
 * 已排定的时刻仍然有效。窗口参数（min/max/unit）的变化交给派发层的兜底扫描处理 ——
 * 它比对 configStamp，发现不一致就按**原锚点**全量重排并重挂定时器（`scheduleDelayedCheckinRun`
 * 内部完成），因此这条通路只负责装载与触发扫描。
 */
export function updateCheckinDelaySettings() {
  void queueCheckinDelayRuntimeSync('delay settings updated');
}

/**
 * 手动全量按钮入口（定稿第 19 节）：以点击时刻为新锚点，就地重锚当日计划。
 *
 * 之所以由调度器而不是路由直接叫派发层：「当前模式是否适用延迟」这个策略应当只有一处出处，
 * 否则路由与派发层会各自维护一份模式判断并逐渐漂移。
 *
 * `handled` 表示「延迟功能已介入并对这次点击作出了裁决」，此时调用方**不得**再回落整批路径。
 * 派发层拒绝的最常见原因是「今日已无待发账号」（全部已签到），若照原样整批发起，就等于让同一批
 * 账号当天再被打一次 —— 正是本功能要消除的特征。只有 `handled === false`（功能关闭或 interval
 * 模式，即本功能根本不适用）才回落原有整批路径，保证关闭时行为与启用本功能前逐字相同。
 */
export async function reanchorCheckinDelayRun(): Promise<{
  handled: boolean;
  ok: boolean;
  reason?: string;
  total?: number;
  lastPlannedMs?: number;
}> {
  const delayConfig = await loadCheckinDelayConfig();
  if (!delayConfig.enabled) return { handled: false, ok: false, reason: 'disabled' };
  if (config.checkinScheduleMode !== 'cron') return { handled: false, ok: false, reason: 'interval-mode' };
  const result = await scheduleDelayedCheckinRun({
    anchorMs: Date.now(),
    mode: 'cron',
    config: delayConfig,
    forceReanchor: true,
  });
  return { ...result, handled: true };
}

function createBalanceTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await refreshAllBalances();
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      console.log('[Scheduler] Balance refresh complete');
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      const metrics = await collectDailySummaryMetrics();
      const { title, message } = buildDailySummaryNotification(metrics);
      await sendNotification(title, message, 'info', {
        bypassThrottle: true,
        requireChannel: true,
        throwOnFailure: true,
      });
      console.log(`[Scheduler] Daily summary sent: ${title}`);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinScheduleMode = await resolveJsonSetting<CheckinScheduleMode>(
    'checkin_schedule_mode',
    (value): value is CheckinScheduleMode => value === 'cron' || value === 'interval',
    config.checkinScheduleMode as CheckinScheduleMode,
  );
  const activeCheckinIntervalHours = await resolvePositiveIntegerSetting(
    'checkin_interval_hours',
    config.checkinIntervalHours,
  );
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.checkinScheduleMode = activeCheckinScheduleMode;
  config.checkinIntervalHours = Math.min(24, Math.max(1, activeCheckinIntervalHours));
  config.balanceRefreshCron = activeBalanceCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  startCheckinSchedule();
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);

  console.log(`[Scheduler] Check-in schedule: ${config.checkinScheduleMode} (${config.checkinScheduleMode === 'cron' ? activeCheckinCron : `${config.checkinIntervalHours}h`})`);
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
  // 延迟运行时放在最后装载：它按最终确定的 checkinScheduleMode 决定是否建兜底扫描，
  // 装载过程自己还要读一次库，并把「on/off + 窗口」的日志打在那里面（同一份判断只播一次）。
  await queueCheckinDelayRuntimeSync('scheduler start');
}

export function updateCheckinCron(cronExpr: string) {
  updateCheckinSchedule({
    mode: 'cron',
    cronExpr,
    intervalHours: config.checkinIntervalHours,
  });
}

export function updateCheckinSchedule(input: {
  mode: CheckinScheduleMode;
  cronExpr?: string;
  intervalHours?: number;
}) {
  const nextMode = input.mode;
  if (nextMode !== 'cron' && nextMode !== 'interval') {
    throw new Error(`Invalid checkin schedule mode: ${String(nextMode)}`);
  }

  const nextCronExpr = input.cronExpr ?? config.checkinCron;
  if (!cron.validate(nextCronExpr)) throw new Error(`Invalid cron: ${nextCronExpr}`);

  const nextIntervalHours = input.intervalHours ?? config.checkinIntervalHours;
  if (!Number.isFinite(nextIntervalHours) || nextIntervalHours < 1 || nextIntervalHours > 24) {
    throw new Error(`Invalid interval hours: ${String(nextIntervalHours)}`);
  }

  config.checkinScheduleMode = nextMode;
  config.checkinCron = nextCronExpr;
  config.checkinIntervalHours = Math.trunc(nextIntervalHours);
  startCheckinSchedule();
  // 顺序是有意的：startCheckinSchedule 同步把 interval 的单只唤醒定时器挂好（或重建 cron 任务），
  // 之后才排队装载延迟运行时，因此扫描拍到这一拍时重挂路径已经存在，不存在空窗。
  // 切到 interval 时派发器不再建当日计划、不判错过（定稿第 6/18 节），切换前残留的 cron 计划
  // 属于已被作废的模式，由 queue 下去的同步负责丢弃，免得它带着旧时刻继续发。
  // 仅改 cron 表达式时**故意不丢弃**当日计划：今天这张时刻表是按上一个锚点算出来的，
  // 让它跑完比让用户在 08:30 改一次表达式就丢掉当天剩余账号更可预期；新锚点从下一次到点起生效。
  void queueCheckinDelayRuntimeSync('checkin schedule updated');
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function __resetCheckinSchedulerForTests() {
  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  balanceTask = null;
  dailySummaryTask = null;
  logCleanupTask = null;
  intervalAttemptByAccount.clear();
  // 延迟派发器持有进程内计划与两只定时器，与本模块的测试隔离必须一起清，
  // 否则上一条用例留下的当日计划会让下一条用例看到残留的到期集合。
  __resetCheckinDelayDispatcherForTests();
}
