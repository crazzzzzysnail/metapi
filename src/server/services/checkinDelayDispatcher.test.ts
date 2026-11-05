/**
 * checkinDelayDispatcher 纯函数测试。
 *
 * 覆盖范围：classifyPlanEntries / mergePlanEntries / hasCheckedInToday / CHECKIN_DELAY_THRESHOLDS。
 * 这四个导出不碰数据库、不碰定时器；派发主循环（runDispatchPass）、兜底扫描（runSafetySweep）、
 * 建计划（scheduleDelayedCheckinRun）与定时器重挂（armNextOrStop）都依赖 DB 与进程内状态，本文件不测。
 *
 * 副作用结论（为什么要 mock）：`src/server/db/index.ts:1458` 在**模块顶层**执行
 * `let activeDb: AppDb = initDb();`，initDb 会 new Database / createPool 并跑一堆
 * ensure*Schema() 迁移（initSqliteDb 见同文件 1352-1382 行）。也就是说只要 import 到真实
 * db/index.js，就会在收集测试阶段打开数据库连接。派发器第 23 行 import 了它，
 * 因此必须像同目录 checkinScheduler.test.ts:17 那样 mock 掉 '../db/index.js'
 * （checkinScheduler.ts 第 11-18 行就 import 本模块，那份测试能通过即是现成先例）。
 * checkinService（其第 2 行 import './platforms/index.js'，整条平台适配器图很重）与
 * notifyService（import undici / nodemailer）按同目录既有做法一并 mock：
 * 参照 checkinScheduler.test.ts:38 与 checkinService.autoRelogin.test.ts:65。
 * 被 mock 的两个模块本文件都不会真正调用，桩函数只为让模块图能安全加载。
 *
 * 桩全部写成「工厂体内自造普通函数」，不引用测试文件顶层变量、也不在工厂里用 vi.fn()：
 * vi.mock 会被 hoist 到静态 import 之上，工厂执行时顶层 const 仍在 TDZ；自造函数可以无歧义地
 * 配合本文件对派发器的**静态** import。
 *
 * 阈值边界（本文件钉得最紧的一条）：错过判定要求偏差**严格大于**阈值，因此「落后恰好等于 30 分钟」
 * 归 due 照常补发。这是定稿第 15 节的原文语义（「偏差 > 30 分钟视为休眠 → 跳过当日；偏差 ≤ 30 分钟
 * 照常立即补发」），也与跳过通知的文案「落后超过 30 分钟」一致。详见 classifyPlanEntries 边界用例的注释。
 *
 * 时区独立性：本文件所有日期 key 都在测试运行时用**源模块同一套日界算法**
 * （localTimeService 的 formatLocalDate）算出，再喂回 hasCheckedInToday；相邻日界用本地
 * Date 构造器（`new Date(y, m, d±1, 12)`）归一化得到，绝不用无参 new Date()，也不硬编码
 * 日期字符串。这样无论 VPS 设 TZ=Asia/Shanghai 还是开发机是别的时区，两侧日界同步移动，
 * 结论不变。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CHECKIN_DELAY_THRESHOLDS,
  classifyPlanEntries,
  hasCheckedInToday,
  mergePlanEntries,
  type PlannedAccountEntry,
} from './checkinDelayDispatcher.js';
import { formatLocalDate, formatUtcSqlDateTime } from './localTimeService.js';

// 数据库层：模块 import 即建连接，必须 mock（依据见文件头）。
vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => [],
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    // runtimeDbDialect 是 db/index.ts:48 的真实具名导出，被 '../db/upsertSetting.js' 顶层 import；
    // 缺失虽不影响加载，但按真实形状补全，避免将来有人在本文件里调用写路径时踩空。
    runtimeDbDialect: 'sqlite',
    db: {
      select: () => queryChain,
      insert: () => ({ values: () => ({ run: () => ({}) }), onConflictDoUpdate: () => ({ run: () => ({}) }) }),
      update: () => ({ set: () => ({ where: () => ({ run: () => ({}) }) }) }),
    },
    schema: {
      settings: { key: 'key', value: 'value' },
      accounts: {
        id: 'id',
        siteId: 'siteId',
        checkinEnabled: 'checkinEnabled',
        status: 'status',
        lastCheckinAt: 'lastCheckinAt',
      },
      sites: { id: 'id', status: 'status' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAccount: async () => ({ success: true }),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: async () => ({}),
}));

/** 构造一条当日安排，参数顺序与本模块类型定义一致。 */
function entry(accountId: number, bandIndex: number, plannedFireMs: number): PlannedAccountEntry {
  return { accountId, bandIndex, plannedFireMs };
}

const MINUTE_MS = 60_000;

describe('CHECKIN_DELAY_THRESHOLDS', () => {
  // 30 分钟是定稿选定的「容器休眠漂移」阈值：UptimeRobot 5 分钟拨测的抖动与一次普通重启
  // （通常 1-2 分钟内回来）都不应被误判为「休眠错过当日」；只有真正长停摆才走跳过+通知。
  // 改动这个数会直接改变「什么算错过」，所以钉在断言里，改值必须连同决策记录一起改。
  it('错过判定阈值为 30 分钟（容器休眠漂移定稿值）', () => {
    expect(CHECKIN_DELAY_THRESHOLDS.missedThresholdMs).toBe(30 * MINUTE_MS);
  });

  it('兜底扫描周期为 10 分钟（远慢于被删除的 60 秒全表轮询）', () => {
    expect(CHECKIN_DELAY_THRESHOLDS.safetySweepIntervalMs).toBe(10 * MINUTE_MS);
  });
});

describe('classifyPlanEntries', () => {
  // 生产阈值的整分钟用例：落后 29 分钟仍在射程内，31 分钟判错过（恰好 30 分钟归 due，见下方边界组）。
  it('按默认阈值分类：29 分钟前到期算 due，31 分钟前到期算 missed', () => {
    const NOW = 1_000_000_000_000;
    const threshold = CHECKIN_DELAY_THRESHOLDS.missedThresholdMs;
    const result = classifyPlanEntries({
      entries: [
        entry(11, 0, NOW - 29 * MINUTE_MS), // 落后 29 分钟 -> due
        entry(22, 1, NOW - 31 * MINUTE_MS), // 落后 31 分钟 -> missed
        entry(33, 2, NOW + 5 * MINUTE_MS), // 未来 5 分钟 -> upcoming
      ],
      nowMs: NOW,
      attemptedAccountIds: [],
    });

    expect(result.due.map((item) => item.accountId)).toEqual([11]);
    expect(result.missed.map((item) => item.accountId)).toEqual([22]);
    expect(result.upcoming.map((item) => item.accountId)).toEqual([33]);
    expect(NOW - result.missed[0].plannedFireMs).toBeGreaterThan(threshold);
  });

  // ⚠️ 阈值语义的唯一判据出处。源码判定式是：
  //   plannedFireMs >  nowMs                 -> upcoming（严格 >，所以相等归 due 而不是 upcoming）
  //   plannedFireMs >= nowMs - thresholdMs   -> due（取 >=，所以「落后恰好等于阈值」归 due）
  //   其余                                    -> missed（偏差**严格大于**阈值才算错过）
  // 边界取值按定稿第 15 节的原文钉死：「偏差 > 30 分钟视为休眠 → 跳过当日；偏差 ≤ 30 分钟照常补发」，
  // 且跳过通知的文案也是「落后超过 30 分钟」。改成严格 > 会让恰好 30 分钟的账号被跳过，
  // 并收到一句与实际不符的「落后超过 30 分钟」通知。改这条规则会在这里红。
  it('阈值边界：等于 now 归 due；落后恰好等于阈值仍归 due；再多 1ms 才判错过', () => {
    const NOW = 1_000_000_000_000;
    const T = CHECKIN_DELAY_THRESHOLDS.missedThresholdMs;
    const result = classifyPlanEntries({
      entries: [
        entry(1, 0, NOW + 1), // 领先 1ms -> upcoming
        entry(2, 0, NOW), // 恰好等于 now -> due（证明用的是严格 >）
        entry(3, 0, NOW - T + 1), // 落后 threshold-1ms -> due
        entry(4, 0, NOW - T), // 落后恰好等于 threshold -> due（定稿的 ≤ 归补发）
        entry(5, 0, NOW - T - 1), // 落后 threshold+1ms -> missed（错过判定的起点）
      ],
      nowMs: NOW,
      attemptedAccountIds: [],
    });

    expect(result.upcoming.map((item) => item.accountId)).toEqual([1]);
    // classifyPlanEntries 内部按 plannedFireMs **升序**排（派发必须先发最早到期的那个），
    // 而这三条里 4 的计划时刻最早（落后最多但仍在阈值内）、2 最晚，故顺序是 [4, 3, 2]。
    // 断言写成入参顺序会永远失败 —— 分类归属正确，是本用例的期望值写错了方向。
    expect(result.due.map((item) => item.accountId)).toEqual([4, 3, 2]);
    expect(result.missed.map((item) => item.accountId)).toEqual([5]);
    // 三类互斥且无遗漏：五条边界账号不得同时出现在两个集合里。
    expect(result.due.length + result.missed.length + result.upcoming.length).toBe(5);
  });

  it('自定义阈值参数覆盖默认值：同一时刻在阈值 1 分钟下算 missed', () => {
    const NOW = 1_000_000_000_000;
    const entryAt = entry(9, 0, NOW - 2 * MINUTE_MS);
    expect(classifyPlanEntries({ entries: [entryAt], nowMs: NOW, attemptedAccountIds: [] }).due).toEqual([entryAt]);
    expect(classifyPlanEntries({ entries: [entryAt], nowMs: NOW, attemptedAccountIds: [], missedThresholdMs: MINUTE_MS }).missed)
      .toEqual([entryAt]);
  });

  it('attemptedAccountIds 内的账号一律排除，三个集合都不出现（成功与失败都算已发起）', () => {
    const NOW = 1_000_000_000_000;
    const T = CHECKIN_DELAY_THRESHOLDS.missedThresholdMs;
    const result = classifyPlanEntries({
      entries: [
        entry(1, 0, NOW - T - MINUTE_MS), // 本应 missed
        entry(2, 0, NOW - MINUTE_MS), // 本应 due
        entry(3, 0, NOW + MINUTE_MS), // 本应 upcoming
      ],
      nowMs: NOW,
      attemptedAccountIds: [1, 2, 3],
    });

    expect(result).toEqual({ due: [], missed: [], upcoming: [] });
  });

  it('三个返回值都按 plannedFireMs 升序（乱序输入下跨类与类内各自有序）', () => {
    const NOW = 1_000_000_000_000;
    const T = CHECKIN_DELAY_THRESHOLDS.missedThresholdMs;
    const shuffled = [
      entry(30, 4, NOW + 9 * MINUTE_MS),
      entry(10, 1, NOW - T - 3 * MINUTE_MS),
      entry(21, 2, NOW - 3 * MINUTE_MS),
      entry(31, 5, NOW + 2 * MINUTE_MS),
      entry(11, 0, NOW - T - MINUTE_MS),
      entry(20, 3, NOW - 8 * MINUTE_MS),
    ];
    const { due, missed, upcoming } = classifyPlanEntries({
      entries: shuffled,
      nowMs: NOW,
      attemptedAccountIds: [],
    });

    for (const list of [due, missed, upcoming]) {
      for (let i = 1; i < list.length; i += 1) {
        expect(list[i].plannedFireMs).toBeGreaterThan(list[i - 1].plannedFireMs);
      }
    }
    // 升序意味着 armNextOrStop 取 upcoming[0] 就是最早的下一只，无需再排序。
    expect(upcoming.map((item) => item.accountId)).toEqual([31, 30]);
    expect(due.map((item) => item.accountId)).toEqual([20, 21]);
    // 升序 = 计划毫秒数从小到大：落后 33 分钟（时刻更早）的 10 号在落后 31 分钟的 11 号之前。
    expect(missed.map((item) => item.accountId)).toEqual([10, 11]);
  });

  it('空数组输入安全返回三个空集合', () => {
    expect(classifyPlanEntries({ entries: [], nowMs: 1_000_000_000_000, attemptedAccountIds: [] }))
      .toEqual({ due: [], missed: [], upcoming: [] });
  });

  it('不改动入参数组（不排序原列表、不增删元素）', () => {
    const NOW = 1_000_000_000_000;
    const first = entry(1, 0, NOW + MINUTE_MS);
    const second = entry(2, 1, NOW - MINUTE_MS);
    const input = [first, second];
    classifyPlanEntries({ entries: input, nowMs: NOW, attemptedAccountIds: [] });
    expect(input).toEqual([first, second]);
    expect(input[0].plannedFireMs).toBeGreaterThan(input[1].plannedFireMs);
  });
});

describe('mergePlanEntries', () => {
  /**
   * 核心回归不变量（本模块最容易写错之处）：已排定账号的计划时刻**绝不改动**，
   * 且同一账号在结果里**只出现一次**。
   * 曾经的真实缺陷：合并时把已排定账号连同新账号一起重排，账号 5 同时带着 existing 的时刻
   * 与 assigned 的新时刻进入结果 → 同一账号当天被发起两次请求。
   * 这条用例就是那个缺陷的哨兵：合并若再取 assigned 一侧（或两条都留），这里立刻红。
   */
  it('已排定账号同时出现在两侧时，结果只保留 existing 那条且时刻分毫不改', () => {
    const scheduled = entry(5, 2, 5000);
    const result = mergePlanEntries({
      existing: [scheduled],
      assigned: [entry(5, 7, 9000), entry(6, 8, 7000)],
      pendingAccountIds: [5, 6],
    });

    const fives = result.filter((item) => item.accountId === 5);
    expect(fives.length).toBe(1);
    // 逐字段等于 existing：accountId/bandIndex/plannedFireMs 都不许被 assigned 覆盖。
    expect(fives[0]).toEqual(scheduled);
    expect(fives[0].plannedFireMs).toBe(5000);
    expect(fives[0].bandIndex).toBe(2);
    // 全新账号照常收入。
    expect(result).toContainEqual(entry(6, 8, 7000));
    expect(result.length).toBe(2);
  });

  it('pendingAccountIds 里没有的账号从两侧都清掉（已禁用 / 已删除 / 今日已签）', () => {
    const result = mergePlanEntries({
      existing: [entry(1, 0, 1000), entry(2, 1, 2000)],
      assigned: [entry(3, 2, 3000), entry(4, 3, 4000)],
      pendingAccountIds: [2, 3],
    });

    expect(result.map((item) => item.accountId).sort((a, b) => a - b)).toEqual([2, 3]);
    expect(result).toEqual([entry(2, 1, 2000), entry(3, 2, 3000)]);
  });

  it('结果按 plannedFireMs 升序，与两侧输入顺序无关', () => {
    const result = mergePlanEntries({
      existing: [entry(1, 0, 8000), entry(2, 1, 1000)],
      assigned: [entry(3, 2, 4000), entry(4, 3, 2000)],
      pendingAccountIds: [1, 2, 3, 4],
    });

    expect(result.map((item) => item.plannedFireMs)).toEqual([1000, 2000, 4000, 8000]);
    expect(result.map((item) => item.accountId)).toEqual([2, 4, 3, 1]);
  });

  it('一侧为空时等价于原样保留另一侧（仍过滤 + 排序）', () => {
    expect(mergePlanEntries({ existing: [], assigned: [entry(7, 0, 100)], pendingAccountIds: [7] }))
      .toEqual([entry(7, 0, 100)]);
    expect(mergePlanEntries({ existing: [entry(7, 0, 100)], assigned: [], pendingAccountIds: [7] }))
      .toEqual([entry(7, 0, 100)]);
    expect(mergePlanEntries({ existing: [], assigned: [], pendingAccountIds: [] })).toEqual([]);
  });

  // 表征既有行为（不是需求认可）：同账号在 existing 内部重复时按 Map 后写覆盖，以最后一条为准。
  it('existing 内部同账号重复时以最后一条为准，结果仍只有一条（表征）', () => {
    const result = mergePlanEntries({
      existing: [entry(5, 0, 1000), entry(5, 1, 2000)],
      assigned: [],
      pendingAccountIds: [5],
    });
    expect(result).toEqual([entry(5, 1, 2000)]);
  });

  it('不改动入参数组', () => {
    const existing = [entry(2, 1, 2000), entry(1, 0, 1000)];
    const assigned = [entry(3, 2, 3000)];
    const pending = [1, 2, 3];
    mergePlanEntries({ existing, assigned, pendingAccountIds: pending });

    expect(existing.map((item) => item.plannedFireMs)).toEqual([2000, 1000]);
    expect(assigned.length).toBe(1);
    expect(pending).toEqual([1, 2, 3]);
  });
});

describe('hasCheckedInToday', () => {
  /**
   * 时区无关的做法：
   * - `todayKey` 不写死字符串，而是在测试运行时用**源模块同一套日界算法**算出：
   *   `formatLocalDate(anchorDate)` —— 与 hasCheckedInToday 内部
   *   （toLocalDayKeyFromStoredUtc → parseStoredUtcDateTime → formatLocalDate）同一条路径。
   * - 昨天/明天不走「ANCHOR ± 24h」的毫秒算术（夏令时切换日一天可能是 23h 或 25h，算术日界会漂），
   *   而是用本地 Date 构造器取「相邻日正午」再从其历法字段推出各日本地零点；正午远离零点切换，
   *   日溢出由构造器按进程时区归一化，任何时区下都成立。
   *   注意刻意**不用** getLocalDayEndMs：它的「本地零点 + 24h」是派发器窗口压缩的自有约定，
   *   在夏令时切换日并不恒等于真实次日零点，而本函数判的是日历日（formatLocalDate），两者定义不同。
   * - ANCHOR 的字面量（约 2025-11-03 UTC）在部分时区恰好落在夏令时结束的 25 小时日
   *   （如 America/New_York 的 11-02）。这不影响本组用例：所有日界都由「本地 Date 构造器 +
   *   历法字段」推导，不假设一天等于 24h，也不取「零点为跳变点」的罕见切换日。
   * - 输入串全部由带参 `new Date(ms)` 序列化而来；不使用无参 new Date()，因此 VPS 的
   *   TZ=Asia/Shanghai 与本机的差异只会让两侧同步平移，不改变任何一条断言的真假。
   */
  const ANCHOR = 1_762_137_600_000; // 任意固定字面量（约 2025-11-03），仅作日界算法的输入
  const anchorDate = new Date(ANCHOR);
  const year = anchorDate.getFullYear();
  const month = anchorDate.getMonth();
  const dayOfMonth = anchorDate.getDate();

  /** 相对今天偏移 offsetDays 的「当地正午」（日溢出/月溢出由本地 Date 构造器归一化）。 */
  function localNoon(offsetDays: number): Date {
    return new Date(year, month, dayOfMonth + offsetDays, 12, 0, 0, 0);
  }

  const todayKey = formatLocalDate(anchorDate);
  const yesterdayNoon = localNoon(-1);
  const tomorrowNoon = localNoon(1);
  const yesterdayKey = formatLocalDate(yesterdayNoon);
  const tomorrowKey = formatLocalDate(tomorrowNoon);
  // 今天与明天的**真实**本地零点（从各自历法字段构造，不用 24h 算术，见上方注释）。
  const dayStartMs = new Date(year, month, dayOfMonth, 0, 0, 0, 0).getTime();
  const nextDayStartMs = new Date(
    tomorrowNoon.getFullYear(),
    tomorrowNoon.getMonth(),
    tomorrowNoon.getDate(),
    0, 0, 0, 0,
  ).getTime();

  it('null、空串、纯空白、非法字符串一律判未签到（false）', () => {
    expect(hasCheckedInToday(null, todayKey)).toBe(false);
    expect(hasCheckedInToday('', todayKey)).toBe(false);
    expect(hasCheckedInToday('   ', todayKey)).toBe(false);
    expect(hasCheckedInToday('not-a-date', todayKey)).toBe(false);
  });

  it('同一时刻的 ISO 串落在 todayKey 当天（任何 TZ 都成立的自反用例）', () => {
    expect(hasCheckedInToday(new Date(ANCHOR).toISOString(), todayKey)).toBe(true);
    // 同一天另一个时刻（当地正午）同样为 true：钉住的是「日」而不是「那一毫秒」。
    expect(hasCheckedInToday(yesterdayNoon.toISOString(), yesterdayKey)).toBe(true);
    expect(hasCheckedInToday(new Date(dayStartMs + 6 * 3_600_000).toISOString(), todayKey)).toBe(true);
  });

  it('库里的 UTC SQL 文本格式（"YYYY-MM-DD HH:mm:ss"，无 Z 后缀）同样判今天已签', () => {
    // accounts.lastCheckinAt 的真实存储形状；parseStoredUtcDateTime 显式补 Z 解析，
    // 此处钉住该往返不被日界算法误伤。
    expect(hasCheckedInToday(formatUtcSqlDateTime(anchorDate), todayKey)).toBe(true);
  });

  it('昨天正午配 todayKey 为 false，配自己的 yesterdayKey 为 true（排除解析失败的假阴性）', () => {
    const iso = yesterdayNoon.toISOString();
    expect(yesterdayKey).not.toBe(todayKey);
    expect(hasCheckedInToday(iso, todayKey)).toBe(false);
    expect(hasCheckedInToday(iso, yesterdayKey)).toBe(true);
    // 前天也不误判为今天。
    expect(hasCheckedInToday(localNoon(-2).toISOString(), todayKey)).toBe(false);
  });

  it('明天正午配 todayKey 为 false，配自己的 tomorrowKey 为 true（跨日不误判）', () => {
    const iso = tomorrowNoon.toISOString();
    expect(tomorrowKey).not.toBe(todayKey);
    expect(hasCheckedInToday(iso, todayKey)).toBe(false);
    expect(hasCheckedInToday(iso, tomorrowKey)).toBe(true);
    expect(hasCheckedInToday(localNoon(2).toISOString(), todayKey)).toBe(false);
  });

  it('日界恰好 1ms 的平移：今天首毫秒 true、其前一瞬（昨天末尾）false；今天末毫秒 true、明天首毫秒 false', () => {
    expect(hasCheckedInToday(new Date(dayStartMs).toISOString(), todayKey)).toBe(true);
    expect(hasCheckedInToday(new Date(dayStartMs - 1).toISOString(), todayKey)).toBe(false);
    // 日终开区间：今天最后一毫秒仍属今天，次日起点第一毫秒即改判 false。
    expect(hasCheckedInToday(new Date(nextDayStartMs - 1).toISOString(), todayKey)).toBe(true);
    expect(hasCheckedInToday(new Date(nextDayStartMs).toISOString(), todayKey)).toBe(false);
  });
});
