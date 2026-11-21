import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * perf-metrics 权威层与展示出口的架构守卫（S0-5）。
 *
 * 权威层 perfMetricsValue.ts 位于 **src/shared**（零依赖纯函数，server 与 web 共用），
 * 这样"raw→cell 的语义解析"全仓只有一处（S3 服务端组装、S4 通道展示都调它，杜绝两套解析漂移）。
 *
 * 钉两条不变式：
 * 1. **页面/helper 不得直接解析 perf 原始字段**：上游字段名（avg_tps/avg_ttft_ms/…）与
 *    `perf-metrics` 端点字面量只能出现在 shared 权威层里；
 *    Models.tsx、SortableChannelRow.tsx、upstreamMetricsPresentation.tsx 等若出现即红
 *    （出口只消费权威层产出的 PerfMetricCell，不碰 raw）。
 * 2. **两族有效性判据物理分开**：perf 权威层里不得出现日志族哨兵判据
 *    （-1000/frt 属上游 /api/log/self，与 perf 的 0 哨兵两条链路，教训 L2）。
 */

const thisDir = fileURLToPath(new URL('./', import.meta.url));       // src/shared
const webDir = fileURLToPath(new URL('../web/', import.meta.url));   // src/web

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.architecture\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** 只允许在权威层出现的上游 perf 原始字段字面量。 */
const RAW_PERF_FIELD_PATTERNS: RegExp[] = [
  /\bavg_tps\b/,
  /\bavg_ttft_ms\b/,
  /\bavg_latency_ms\b/,
  /\brecent_success_series\b/,
  /\bperf-metrics\b/,
];

describe('perf-metrics 权威层边界（S0-5）', () => {
  it('web 全树（含 helpers 出口）不得直接解析 perf 原始字段，必须经 shared 权威层', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(webDir)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of RAW_PERF_FIELD_PATTERNS) {
        if (pattern.test(code)) offenders.push(`${file} → ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('权威层代码不得混入日志族哨兵判据（两族物理分开，教训 L2）', () => {
    const code = stripComments(readFileSync(join(thisDir, 'perfMetricsValue.js'), 'utf8'));
    // perf 层只允许 ">0 / >=0" 两族自己的判据；代码里出现 -1000 字面量或 frt 字样=有人把日志族语义塞进来。
    // 注释里为解释"为什么不是日志族"提及这些不作数（故先剥注释）。
    expect(code).not.toMatch(/-1000/);
    expect(code).not.toMatch(/\bfrt\b/);
  });

  it('perfMetricsValue 不导入 React/Fastify/服务层（纯函数中立层，可被 server+web 共用）', () => {
    const source = readFileSync(join(thisDir, 'perfMetricsValue.js'), 'utf8');
    expect(source).not.toMatch(/from ['"]react['"]/);
    expect(source).not.toMatch(/from ['"][^'"]*fastify/);
    expect(source).not.toMatch(/from ['"][^'"]*server\//);
    expect(source).not.toMatch(/from ['"][^'"]*web\//);
    // 无 fetch：capturedAt/stale 不进本层（advisor 勘误③）
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });
});
