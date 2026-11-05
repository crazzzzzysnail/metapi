import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type BackupServiceModule = typeof import('./backupService.js');

/**
 * 签到随机延迟的备份面契约测试。
 *
 * 与 backupService.test.ts 一样使用**真 sqlite + 真迁移**而不是 mock db：
 * 这里要钉的是「导出到底写了哪些键、导入到底采纳了哪些值」这种跨函数的行为，
 * mock 掉查询链就只剩在测我自己的桩，钉不住任何回归。
 */
describe('签到随机延迟 · 备份排除与导入校验', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let backupService: BackupServiceModule;
  let dataDir = '';

  /** 当日运行时状态键：绝不进备份。 */
  const TRANSIENT_KEYS = ['checkin_delay_plan', 'checkin_delay_skipped_notice'] as const;
  /** 用户配置键 + 实例种子：应当随备份走，且必须过导入校验。 */
  const USER_KEYS = ['checkin_delay_enabled', 'checkin_delay_min', 'checkin_delay_max', 'checkin_delay_unit', 'checkin_delay_seed'] as const;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-checkin-delay-backup-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./backupService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    backupService = serviceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.settings).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function putSetting(key: string, value: unknown) {
    await db.insert(schema.settings).values({ key, value: JSON.stringify(value) }).onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(value) },
    }).run();
  }

  async function readSettingRaw(key: string): Promise<string | null> {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value ?? null;
  }

  /**
   * 取出某个设置并 JSON.parse。**缺失即抛错**而不是返回 null：
   * 原先写成 JSON.parse((await readSettingRaw(k))!) 时，一旦该键没落库，
   * 非空断言会把 null 骗过类型检查、再由 JSON.parse(null) 静默得到 null，
   * 断言于是以「null !== 期望值」失败，报错信息看不出是「根本没落库」。
   */
  async function readParsedSetting(key: string): Promise<unknown> {
    const raw = await readSettingRaw(key);
    if (raw === null) throw new Error(`设置表中缺少期望存在的键：${key}`);
    return JSON.parse(raw);
  }

  it('导出绝不含当日运行时状态键，但保留用户配置与实例种子', async () => {
    await putSetting('checkin_delay_enabled', true);
    await putSetting('checkin_delay_min', 30);
    await putSetting('checkin_delay_max', 240);
    await putSetting('checkin_delay_unit', 'minute');
    await putSetting('checkin_delay_seed', 'aabbccddeeff0011');
    // 两个瞬态键写入**今天的**真实结构，确保它们不是因为「恰好没数据」才没被导出。
    await putSetting('checkin_delay_plan', {
      planDateKey: '2026-11-04',
      anchorMs: Date.now(),
      mode: 'cron',
      windowStartMs: Date.now(),
      windowEndMs: Date.now() + 3600_000,
      configStamp: '0|3600000',
      bandCount: 2,
      attemptedAccountIds: [],
      entries: [{ accountId: 1, bandIndex: 0, plannedFireMs: Date.now() + 600_000 }],
    });
    await putSetting('checkin_delay_skipped_notice', '2026-11-04');

    const backup = await backupService.exportBackup('preferences');
    // BackupV2 是三支联合（all / accounts / preferences），其中 accounts 分支没有 preferences 字段，
    // 因此必须窄化而不是 `backup.preferences?.` —— 那样 TS 直接报 Property does not exist。
    if (!('preferences' in backup)) {
      throw new Error(`导出结果缺少 preferences 段，实际为：${JSON.stringify(Object.keys(backup))}`);
    }
    const exportedKeys = new Set(backup.preferences.settings.map((item) => item.key));

    for (const key of TRANSIENT_KEYS) {
      expect(exportedKeys.has(key), `瞬态键 ${key} 不应进入备份`).toBe(false);
    }
    for (const key of USER_KEYS) {
      expect(exportedKeys.has(key), `用户配置键 ${key} 应随备份导出`).toBe(true);
    }
  });

  it('导入会把脏的瞬态键挡在库外，而不会静默落库', async () => {
    // 模拟一份被人手工编辑过的备份：瞬态键混在里面。
    // 期望结果取决于实现 —— 这里断言的是「无论采纳还是丢弃，库里都不能出现这份往日计划」，
    // 因为带着往日计划恢复会让目标实例按一份对不上账的时刻表给真实账号排期。
    await backupService.importBackup({
      version: '2.1',
      timestamp: Date.now(),
      type: 'preferences',
      preferences: { settings: [
        { key: 'checkin_delay_plan', value: { planDateKey: '2020-01-01', anchorMs: 1, mode: 'cron', windowStartMs: 0, windowEndMs: 1, configStamp: 'x', bandCount: 1, attemptedAccountIds: [], entries: [] } },
        { key: 'checkin_delay_skipped_notice', value: '2020-01-01' },
      ] },
    } as never);

    expect(await readSettingRaw('checkin_delay_plan')).toBeNull();
    expect(await readSettingRaw('checkin_delay_skipped_notice')).toBeNull();
  });

  it('导入采纳合法的延迟配置并原样落库', async () => {
    await backupService.importBackup({
      version: '2.1',
      timestamp: Date.now(),
      type: 'preferences',
      preferences: { settings: [
        { key: 'checkin_delay_enabled', value: true },
        { key: 'checkin_delay_min', value: 15 },
        { key: 'checkin_delay_max', value: 180 },
        { key: 'checkin_delay_unit', value: 'minute' },
        { key: 'checkin_delay_seed', value: 'deadbeefcafe0001' },
      ] },
    } as never);

    expect(await readParsedSetting('checkin_delay_enabled')).toBe(true);
    expect(await readParsedSetting('checkin_delay_min')).toBe(15);
    expect(await readParsedSetting('checkin_delay_max')).toBe(180);
    expect(await readParsedSetting('checkin_delay_unit')).toBe('minute');
    expect(await readParsedSetting('checkin_delay_seed')).toBe('deadbeefcafe0001');
  });

  it('导入拒绝单位与数值型脏值（避免静默回落成默认窗口）', async () => {
    await backupService.importBackup({
      version: '2.1',
      timestamp: Date.now(),
      type: 'preferences',
      preferences: { settings: [
        // 已废弃的秒级单位：若被采纳，normalizeCheckinDelayConfig 会整体回落成默认窗口，
        // 用户以为导入了 5~60 秒，实际跑起来是 0~360 分钟。宁可不采纳也不能静默换值。
        { key: 'checkin_delay_unit', value: 'second' },
        { key: 'checkin_delay_min', value: -5 },
        { key: 'checkin_delay_max', value: 'many' },
        { key: 'checkin_delay_enabled', value: 'yes' },
        { key: 'checkin_delay_seed', value: '' },
      ] },
    } as never);

    for (const key of USER_KEYS) {
      expect(await readSettingRaw(key), `脏值不应落库：${key}`).toBeNull();
    }
  });

  it('往返一次后用户配置保持不变，瞬态键仍不在库里', async () => {
    await putSetting('checkin_delay_enabled', true);
    await putSetting('checkin_delay_min', 10);
    await putSetting('checkin_delay_max', 6);
    await putSetting('checkin_delay_unit', 'hour');
    await putSetting('checkin_delay_seed', 'roundtrip-seed-value');
    await putSetting('checkin_delay_skipped_notice', '2026-11-04');

    const backup = await backupService.exportBackup('preferences');
    await db.delete(schema.settings).run();
    await backupService.importBackup(backup as never);

    expect(await readParsedSetting('checkin_delay_unit')).toBe('hour');
    expect(await readParsedSetting('checkin_delay_seed')).toBe('roundtrip-seed-value');
    // min/max 倒挂（10 > 6）在这条路径上是**原样搬运**的：备份层的判据只管单值非负有限，
    // 「区间是否自洽」归策略层 normalizeCheckinDelayConfig 整体回落处理。这里把分工钉住，
    // 免得日后有人误以为备份层也会做区间校验，从而在两处各写一份钳制而漂移。
    expect(await readParsedSetting('checkin_delay_min')).toBe(10);
    expect(await readParsedSetting('checkin_delay_max')).toBe(6);
    expect(await readSettingRaw('checkin_delay_skipped_notice')).toBeNull();
  });
});
