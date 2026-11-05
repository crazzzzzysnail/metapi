import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { eq, desc } from 'drizzle-orm';
import { checkinAccount, checkinAll } from '../../services/checkinService.js';
import { updateCheckinSchedule, reanchorCheckinDelayRun } from '../../services/checkinScheduler.js';
import { formatLocalDateTime } from '../../services/localTimeService.js';
import { startBackgroundTask, summarizeCheckinResults } from '../../services/backgroundTaskService.js';
import { classifyFailureReason } from '../../services/failureReasonService.js';

/**
 * 延迟功能已介入、但本轮没有排入任何账号时的用户可读说明。
 *
 * reason 的取值全部来自派发层 `scheduleDelayedCheckinRun` 与 `resolveDelayWindow` 的有限集合
 * （nothing-pending / no-remaining-window / no-entry-assigned / disabled）。
 * 默认分支兜住将来新增的原因，避免路由因为一个没见过的取值而给出误导性说明。
 */
function buildCheckinDelaySkipMessage(reason?: string): string {
  switch (reason) {
    case 'nothing-pending':
      return '本次没有需要排期的账号（今日均已签到，或没有启用签到的账号）';
    case 'no-remaining-window':
      return '今日剩余时间已不足以安排随机延迟窗口，本次未发起签到';
    case 'no-entry-assigned':
      return '当日窗口内已无可用的未来时段，本次未新增排期';
    default:
      return '随机延迟未排入任何账号，本次未发起整批签到';
  }
}

function buildCheckinAccountLabel(item: any): string {
  const username = item?.username || (item?.accountId ? `#${item.accountId}` : 'unknown');
  const site = item?.site || 'unknown-site';
  return `${username} @ ${site}`;
}

function buildCheckinReason(item: any): string {
  const message = String(item?.result?.message || '').trim();
  if (!message) return '';
  if (message.length <= 32) return message;
  return `${message.slice(0, 32)}...`;
}

function buildCheckinTaskDetailMessage(results: any[]): string {
  if (!Array.isArray(results) || results.length === 0) return '';

  const successRows = results.filter((item) => {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) return false;
    return !!item?.result?.success;
  });
  const skippedRows = results.filter((item) => {
    const status = item?.result?.status;
    return status === 'skipped' || !!item?.result?.skipped;
  });
  const failedRows = results.filter((item) => {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) return false;
    return !item?.result?.success;
  });

  const renderRows = (rows: any[], withReason = false) => {
    const sliced = rows.slice(0, 12).map((item) => {
      const base = buildCheckinAccountLabel(item);
      if (!withReason) return base;
      const reason = buildCheckinReason(item);
      return reason ? `${base}(${reason})` : base;
    });
    if (rows.length > 12) sliced.push(`...等${rows.length}个`);
    return sliced.join('、');
  };

  const segments: string[] = [
    `成功(${successRows.length}): ${successRows.length > 0 ? renderRows(successRows) : '-'}`,
    `跳过(${skippedRows.length}): ${skippedRows.length > 0 ? renderRows(skippedRows, true) : '-'}`,
    `失败(${failedRows.length}): ${failedRows.length > 0 ? renderRows(failedRows, true) : '-'}`,
  ];
  return segments.join('\n');
}

export async function checkinRoutes(app: FastifyInstance) {
  // Trigger check-in for all accounts
  app.post('/api/checkin/trigger', async (_, reply) => {
    // 随机延迟定稿方案：全量签到按钮先尝试以点击时刻为重锚，把今日未成功签到的账号
    // 按随机延迟窗口重新分层排期（定稿第 19 节）。
    // handled 为真表示延迟功能已介入并作出裁决，此时**不得**回落整批路径；只有功能根本不适用
    // （关闭 / interval 模式）才逐字走下方原有通路，保证关闭时行为与启用本功能前完全一致。
    const reanchor = await reanchorCheckinDelayRun();
    if (reanchor.handled && !reanchor.ok) {
      // 延迟功能生效但本轮无事可排。最常见的原因是「今日全部账号都已签到成功」，
      // 若照原样整批发起就等于让同一批账号当天再被打一次 —— 正是本功能要消除的特征。
      return reply.code(200).send({
        success: true,
        scheduled: false,
        total: 0,
        message: buildCheckinDelaySkipMessage(reanchor.reason),
      });
    }
    if (reanchor.ok) {
      const total = reanchor.total ?? 0;
      // 取进程本地时区的时分 HH:MM，供管理员对照上游站点看到的时间戳
      const hhmm = typeof reanchor.lastPlannedMs === 'number'
        ? formatLocalDateTime(new Date(reanchor.lastPlannedMs)).slice(11, 16)
        : '';
      return reply.code(202).send({
        success: true,
        scheduled: true,
        total,
        lastPlannedMs: reanchor.lastPlannedMs,
        message: hhmm
          ? `已按随机延迟排期 ${total} 个账号，最迟 ${hhmm} 完成`
          : `已按随机延迟排期 ${total} 个账号`,
      });
    }
    if (reanchor.reason === 'interval-mode') {
      // interval 模式有自己的到期与失败重试语义，随机延迟不介入，按原样整批执行
      console.info('[checkin] 全量签到按 interval 模式原样整批执行，随机延迟不生效');
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'checkin',
        title: '全部账号签到',
        dedupeKey: 'checkin-all',
        notifyOnFailure: true,
        successTitle: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          if (!summary) return '全部账号签到已完成';
          return `全部账号签到已完成（成功${summary.success}/跳过${summary.skipped}/失败${summary.failed}）`;
        },
        failureTitle: () => '全部账号签到失败',
        successMessage: (currentTask) => {
          const summary = (currentTask.result as any)?.summary;
          const results = (currentTask.result as any)?.results;
          if (!summary) return '全部账号签到任务已完成';
          const detail = buildCheckinTaskDetailMessage(Array.isArray(results) ? results : []);
          return detail
            ? `全部账号签到完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}\n${detail}`
            : `全部账号签到完成：成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.failed}`;
        },
        failureMessage: (currentTask) => `全部账号签到任务失败：${currentTask.error || 'unknown error'}`,
      },
      async () => {
        const results = await checkinAll({ scheduleMode: config.checkinScheduleMode });
        return {
          summary: summarizeCheckinResults(results),
          total: results.length,
          results,
        };
      },
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '签到任务执行中，请稍后查看签到日志'
        : '已开始全部签到，请稍后查看签到日志',
    });
  });

  // Trigger check-in for a specific account
  app.post<{ Params: { id: string } }>('/api/checkin/trigger/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    const result = await checkinAccount(id, { scheduleMode: config.checkinScheduleMode });
    return result;
  });

  // Get check-in logs
  app.get<{ Querystring: { limit?: string; offset?: string; accountId?: string } }>('/api/checkin/logs', async (request) => {
    const limit = parseInt(request.query.limit || '50', 10);
    const offset = parseInt(request.query.offset || '0', 10);
    let query = db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .orderBy(desc(schema.checkinLogs.createdAt))
      .limit(limit)
      .offset(offset);

    if (request.query.accountId) {
      query = query.where(eq(schema.checkinLogs.accountId, parseInt(request.query.accountId, 10))) as any;
    }

    const rows = await query.all();
    return rows.map((row: any) => {
      const source = row?.checkin_logs || row;
      const failureReason = classifyFailureReason({
        message: source?.message,
        status: source?.status,
      });
      return {
        ...row,
        failureReason,
      };
    });
  });

  // Update check-in schedule
  app.put<{ Body: { mode?: 'cron' | 'interval'; cron?: string; intervalHours?: number } }>('/api/checkin/schedule', async (request) => {
    try {
      const body = request.body || {};
      const nextMode: 'cron' | 'interval' = body.mode === 'interval' ? 'interval' : 'cron';
      const nextCron = typeof body.cron === 'string' ? body.cron : undefined;
      const nextIntervalHours = body.intervalHours !== undefined ? Number(body.intervalHours) : undefined;
      const normalizedIntervalHours = typeof nextIntervalHours === 'number' && Number.isFinite(nextIntervalHours)
        ? Math.trunc(nextIntervalHours)
        : undefined;

      updateCheckinSchedule({
        mode: nextMode,
        cronExpr: nextCron,
        intervalHours: normalizedIntervalHours,
      });

      await upsertSetting('checkin_schedule_mode', nextMode);
      if (nextCron !== undefined) await upsertSetting('checkin_cron', nextCron);
      if (normalizedIntervalHours !== undefined) {
        await upsertSetting('checkin_interval_hours', normalizedIntervalHours);
      }
      return {
        success: true,
        mode: nextMode,
        cron: nextCron,
        intervalHours: normalizedIntervalHours,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  });
}
