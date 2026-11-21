import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * perf-metrics 取数边界架构守卫（S2.5-7）。
 *
 * 钉死两条不变式：
 * 1. **routes 层禁止直接打 perf 端点**：路由是适配器，不拥有取数与流式生命周期（AGENTS.md「Server Layers」）。
 *    界面要公示指标只能读 `perfMetricsWarmService` 的只读缓存入口，
 *    这样"任何渲染路径都不同步等上游"（验收判据 5）由结构强制，不靠人工自觉。
 * 2. **services 层只有预热服务持有 perf 端点字面量**：探测/预热/单飞补拉三条路径共用同一取数实现，
 *    避免出现第二个"看着像 perf-metrics 但鉴权/超时/退避口径不同"的 fetch。
 *
 * 扫描前剥注释：本仓多处注释会解释"为什么不走同步 fetch"并点名 perf-metrics，
 * 那些是文档不是代码（S0-5 踩过的坑，守卫只拦代码里的用法）。
 */

const thisDir = fileURLToPath(new URL('./', import.meta.url));             // src/server/services
const routesDir = fileURLToPath(new URL('../routes/', import.meta.url));   // src/server/routes

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules') listTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const PERF_ENDPOINT_PATTERN = /\/api\/perf-metrics/;

describe('perf-metrics 取数边界（S2.5-7）', () => {
  it('routes 层不得直接请求 perf-metrics 端点（一律读预热缓存）', () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(routesDir)) {
      if (PERF_ENDPOINT_PATTERN.test(stripComments(readFileSync(file, 'utf8')))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('services 层只有 perfMetricsWarmService 持有 perf-metrics 端点字面量', () => {
    const holders: string[] = [];
    for (const file of listTsFiles(thisDir)) {
      if (PERF_ENDPOINT_PATTERN.test(stripComments(readFileSync(file, 'utf8')))) {
        holders.push(file.split(/[\\/]/).pop() as string);
      }
    }
    expect(holders).toEqual(['perfMetricsWarmService.ts']);
  });
});
