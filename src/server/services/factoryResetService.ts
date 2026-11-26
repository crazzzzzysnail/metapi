import { buildConfig, config } from '../config.js';
import { db, schema, switchRuntimeDatabase } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { updateBalanceRefreshCron, updateCheckinCron, updateLogCleanupSettings } from './checkinScheduler.js';
import { ensureDefaultSitesSeeded } from './defaultSiteSeedService.js';
import { startProxyLogRetentionService } from './proxyLogRetentionService.js';
import { invalidateSiteProxyCache } from './siteProxy.js';
import { clearProxyPoolCache } from './proxyPoolStore.js';

export const FACTORY_RESET_ADMIN_TOKEN = 'change-me-admin-token';

type FactoryResetDependencies = {
  switchRuntimeDatabase?: typeof switchRuntimeDatabase;
  runSqliteMigrations?: () => Promise<void> | void;
  ensureDefaultSitesSeeded?: typeof ensureDefaultSitesSeeded;
};

/**
 * 基础设施保留项。系统代理**不**在此列：它归业务数据（代理池）管理，
 * 若跨重置保留，下次启动播种会凭残留镜像重新种出默认代理条目，等于没重置干净。
 */
type PreservedInfrastructureState = {
  authToken: string;
  proxyToken: string;
  dbType: 'sqlite' | 'mysql' | 'postgres';
  dbUrl: string;
  dbSsl: boolean;
};

async function clearAllBusinessData() {
  await db.transaction(async (tx) => {
    await tx.delete(schema.routeChannels).run();
    await tx.delete(schema.tokenModelAvailability).run();
    await tx.delete(schema.modelAvailability).run();
    await tx.delete(schema.proxyLogs).run();
    await tx.delete(schema.proxyVideoTasks).run();
    await tx.delete(schema.proxyFiles).run();
    await tx.delete(schema.checkinLogs).run();
    await tx.delete(schema.accountTokens).run();
    await tx.delete(schema.accounts).run();
    await tx.delete(schema.tokenRoutes).run();
    await tx.delete(schema.proxyPool).run();
    await tx.delete(schema.sites).run();
    await tx.delete(schema.downstreamApiKeys).run();
    await tx.delete(schema.events).run();
    await tx.delete(schema.settings).run();
  });
}

function captureInfrastructureState(): PreservedInfrastructureState {
  return {
    authToken: config.authToken,
    proxyToken: config.proxyToken,
    dbType: config.dbType,
    dbUrl: config.dbUrl,
    dbSsl: config.dbSsl,
  };
}

function shouldPreserveExternalRuntime(state: PreservedInfrastructureState): boolean {
  return state.dbType !== 'sqlite' && !!state.dbUrl.trim();
}

function resetRuntimeConfigToInitialState(preserved: PreservedInfrastructureState) {
  const baseline = buildConfig(process.env);
  Object.assign(config, baseline);
  config.authToken = preserved.authToken || baseline.authToken || FACTORY_RESET_ADMIN_TOKEN;
  config.proxyToken = preserved.proxyToken || baseline.proxyToken;
  // 系统代理不再跨重置保留：Object.assign(baseline) 后保持 env 初值（通常为空）
  if (shouldPreserveExternalRuntime(preserved)) {
    config.dbType = preserved.dbType;
    config.dbUrl = preserved.dbUrl;
    config.dbSsl = preserved.dbSsl;
  }
  config.logCleanupConfigured = false;
  config.logCleanupUsageLogsEnabled = config.proxyLogRetentionDays > 0;
  config.logCleanupProgramLogsEnabled = false;
  config.logCleanupRetentionDays = Math.max(1, Math.trunc(config.proxyLogRetentionDays || config.logCleanupRetentionDays || 30));
  updateCheckinCron(config.checkinCron);
  updateBalanceRefreshCron(config.balanceRefreshCron);
  updateLogCleanupSettings({
    cronExpr: config.logCleanupCron,
    usageLogsEnabled: config.logCleanupUsageLogsEnabled,
    programLogsEnabled: config.logCleanupProgramLogsEnabled,
    retentionDays: config.logCleanupRetentionDays,
  });
  startProxyLogRetentionService();
  // 池缓存与站点代理缓存同步作废：重置后池表已空，解析必须回到“无默认→直连”
  clearProxyPoolCache();
  invalidateSiteProxyCache();
}

/** 系统代理不写回：它随代理池一起被清空，重启后按实际 env/池状态重建 */
async function restoreInfrastructureSettings(preserved: PreservedInfrastructureState): Promise<void> {
  await upsertSetting('auth_token', preserved.authToken || FACTORY_RESET_ADMIN_TOKEN);
  await upsertSetting('proxy_token', preserved.proxyToken);

  if (shouldPreserveExternalRuntime(preserved)) {
    await upsertSetting('db_type', preserved.dbType);
    await upsertSetting('db_url', preserved.dbUrl);
    await upsertSetting('db_ssl', preserved.dbSsl);
    return;
  }

  await upsertSetting('db_type', config.dbType);
  await upsertSetting('db_url', config.dbUrl);
  await upsertSetting('db_ssl', config.dbSsl);
}

async function runDefaultSqliteMigrations() {
  const migrateModule = await import('../db/migrate.js');
  migrateModule.runSqliteMigrations();
}

export async function performFactoryReset(deps: FactoryResetDependencies = {}): Promise<void> {
  const switchRuntimeDatabaseImpl = deps.switchRuntimeDatabase ?? switchRuntimeDatabase;
  const runSqliteMigrationsImpl = deps.runSqliteMigrations ?? runDefaultSqliteMigrations;
  const ensureDefaultSitesSeededImpl = deps.ensureDefaultSitesSeeded ?? ensureDefaultSitesSeeded;
  const preserved = captureInfrastructureState();

  await clearAllBusinessData();
  resetRuntimeConfigToInitialState(preserved);
  await switchRuntimeDatabaseImpl(config.dbType, config.dbUrl, config.dbSsl);
  if (config.dbType === 'sqlite') {
    await runSqliteMigrationsImpl();
  }
  await clearAllBusinessData();
  await restoreInfrastructureSettings(preserved);
  await ensureDefaultSitesSeededImpl();
}
