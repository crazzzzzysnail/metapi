import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setBalanceEvidenceInExtraConfig } from "../../services/accountExtraConfig.js";

/**
 * F8 第 3 期：站点被标记「不计入总余额」时，仪表盘合计必须整站剔除并给出计数。
 *
 * 单独开文件而不是塞进 stats.snapshot-v2.test.ts：快照有 12s 的进程内缓存，
 * 同文件里先跑过的用例会把 summary 缓存在内存里，后续断言很容易读到上一次的数，
 * 变成"看起来通过其实没测到"。新文件有独立的模块实例与库。
 */

type DbModule = typeof import("../../db/index.js");

describe("dashboard summary 的站点余额排除", () => {
  let app: FastifyInstance;
  let db: DbModule["db"];
  let schema: DbModule["schema"];
  let dataDir = "";
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), "metapi-stats-balance-optout-"));
    process.env.DATA_DIR = dataDir;

    await import("../../db/migrate.js");
    const dbModule = await import("../../db/index.js");
    const routesModule = await import("./stats.js");
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.adminSnapshots).run();
    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteBillingProfiles).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (previousDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDir;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  interface SummaryShape {
    totalBalance: number;
    totalBalanceCny?: number;
    balanceOptOutSiteCount?: number;
    balanceExcludedSiteCount?: number;
    currencyExcludedSiteCount?: number;
  }

  async function readSummary(): Promise<SummaryShape> {
    // refresh=1 绕过快照缓存，确保读到的是本次用例刚写的数据
    const response = await app.inject({
      method: "GET",
      url: "/api/stats/dashboard?refresh=1&view=summary",
    });
    expect(response.statusCode).toBe(200);
    return response.json() as SummaryShape;
  }

  async function seedSiteWithAccount(input: {
    name: string;
    balance: number;
    excludeFromTotalBalance?: boolean;
  }) {
    const site = await db
      .insert(schema.sites)
      .values({
        name: input.name,
        url: `https://${input.name}.example.com`,
        platform: "new-api",
        excludeFromTotalBalance: input.excludeFromTotalBalance ?? false,
      })
      .returning()
      .get();
    // 顺手给一个已知充值价：否则两个站都会因为"充值价未知"进 excludedSites，
    // 后面那条"排除不等于充值价未知"的断言就分不清是谁贡献的计数了。
    await db
      .insert(schema.siteBillingProfiles)
      .values({ siteId: site.id, cnyPerUsd: 7.2, rateSource: "manual" })
      .run();
    await db
      .insert(schema.accounts)
      .values({
        siteId: site.id,
        username: `${input.name}-user`,
        accessToken: "session-sample",
        balance: input.balance,
        status: "active",
      })
      .returning()
      .get();
    return site;
  }

  it("默认把两个站点的余额都算进合计", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    await seedSiteWithAccount({ name: "siteB", balance: 5 });

    const summary = await readSummary();
    expect(summary.totalBalance).toBe(15);
    expect(summary.balanceOptOutSiteCount).toBe(0);
  });

  it("标记排除后整站余额从合计消失，并计入 balanceOptOutSiteCount", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    await seedSiteWithAccount({ name: "siteB", balance: 5, excludeFromTotalBalance: true });

    const summary = await readSummary();
    // 负控制的意义：只减 5 而不是减成 0/15，证明是按站剔除而不是整体归零
    expect(summary.totalBalance).toBe(10);
    expect(summary.balanceOptOutSiteCount).toBe(1);
    // "排除"与"充值价未知"是两回事，不应混进同一个计数
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(0);
  });

  /**
   * F8：余额「确认读不到」的站点要进 CNY 排除集。
   *
   * 为什么不能只在界面上画个 `—` 就完事：CNY 合计若继续把这种站算一份，用户看到的是一个
   * 静默偏小的总数（R7）。而"库里是默认 0、从没刷新过"的存量连接**不算**这一类 ——
   * 它没有任何证据，既不能证明读到过也不能证明读不到，据此改口径会把大量正常站点误伤。
   */
  it("充值价已知但证据为 unavailable 的站点：进 CNY 排除集", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    const siteB = await seedSiteWithAccount({ name: "siteB", balance: 5 });
    const account = await db.select({ id: schema.accounts.id, extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts).where(eq(schema.accounts.siteId, siteB.id)).get();
    await db.update(schema.accounts)
      .set({ extraConfig: setBalanceEvidenceInExtraConfig(account?.extraConfig, { status: "unavailable", reason: "all-sources-failed" }) })
      .where(eq(schema.accounts.id, account!.id))
      .run();

    const summary = await readSummary();
    // 美元口径不动：这条改动只影响 CNY，USD 合计必须仍等于全部站点之和
    expect(summary.totalBalance).toBe(15);
    // CNY 只剩 siteA 的 10 × 7.2 = 72，被剔的站给出计数
    expect(summary.totalBalanceCny ?? 0).toBeCloseTo(72, 6);
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(1);
    // 顶栏提示读的是合并后的单字段（方案 a1），必须同样看见这一站；
    // 否则站点页显示"读不到"，仪表盘那句"N 个站点未计入"却还是 0。
    expect(summary.currencyExcludedSiteCount ?? 0).toBeGreaterThanOrEqual(1);
    // 用户没主动排除任何站点，两个计数不能互相污染
    expect(summary.balanceOptOutSiteCount).toBe(0);
  });

  it("从未刷新过、也没有证据的存量站点：留在 CNY 合计里", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    // 只有 lastBalanceRefresh 为空、extra_config 里也没证据 —— 归并结果是 unknown
    await seedSiteWithAccount({ name: "siteB", balance: 5 });

    const summary = await readSummary();
    expect(summary.totalBalance).toBe(15);
    // 负控制的意义：若有人把 unknown 也当成"读不到"来排除，这里会变成 72 / 1
    expect(summary.totalBalanceCny ?? 0).toBeCloseTo(108, 6);
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(0);
  });

  it("无限配额站点不算“总额不完整”，不进 CNY 排除集", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    const siteB = await seedSiteWithAccount({ name: "siteB", balance: 5 });
    const account = await db.select({ id: schema.accounts.id, extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts).where(eq(schema.accounts.siteId, siteB.id)).get();
    await db.update(schema.accounts)
      .set({ extraConfig: setBalanceEvidenceInExtraConfig(account?.extraConfig, { status: "not-applicable", reason: "unlimited-quota" }) })
      .where(eq(schema.accounts.id, account!.id))
      .run();

    const summary = await readSummary();
    // "这站压根没有余额概念"与"这站的余额没读到"是两回事，只有后者需要提示总额不完整
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(0);
    expect(summary.totalBalanceCny ?? 0).toBeCloseTo(108, 6);
  });

  it("有 lastBalanceRefresh 时间戳即视为读到过，不排除", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    const siteB = await seedSiteWithAccount({ name: "siteB", balance: 0 });
    // 订阅式站点的副号常见形态：余额确实同步过，只是从不走余额刷新
    await db.update(schema.accounts)
      .set({ lastBalanceRefresh: new Date().toISOString() })
      .where(eq(schema.accounts.siteId, siteB.id))
      .run();

    const summary = await readSummary();
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(0);
  });

  it("余额非零且有 unavailable 证据：照样进排除集（界面另有“非零一律显示”的保护）", async () => {
    await seedSiteWithAccount({ name: "siteA", balance: 10 });
    // 有旁路写进来的真实余额（如订阅同步），同时留下了明确的"这次没读到"证据。
    // 合计口径按证据剔除；界面上那一格仍显示数字，两者不冲突 —— 前者说"CNY 总额不含它"，
    // 后者说"这行确实有个数可看"。
    const siteB = await seedSiteWithAccount({ name: "siteB", balance: 3 });
    const account = await db.select({ id: schema.accounts.id, extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts).where(eq(schema.accounts.siteId, siteB.id)).get();
    await db.update(schema.accounts)
      .set({ extraConfig: setBalanceEvidenceInExtraConfig(account?.extraConfig, { status: "unavailable", reason: "all-sources-failed" }) })
      .where(eq(schema.accounts.id, account!.id))
      .run();

    const summary = await readSummary();
    expect(summary.balanceExcludedSiteCount ?? 0).toBe(1);
    // 美元合计照旧包含它 —— 这条改动只影响 CNY 口径
    expect(summary.totalBalance).toBe(13);
    expect(summary.totalBalanceCny ?? 0).toBeCloseTo(72, 6);
  });
});
