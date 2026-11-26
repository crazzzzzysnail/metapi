import { fetch } from 'undici';
import { withExplicitProxyRequestInit } from './siteProxy.js';

/** 连通性探测端点与超时：设置页系统代理测试与代理池测试共用 */
export const PROXY_TEST_PROBE_URL = 'https://www.gstatic.com/generate_204';
export const PROXY_TEST_TIMEOUT_MS = 15_000;

export type ProxyConnectivityResult = {
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  probeUrl: string;
  finalUrl: string;
};

function extractNestedErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const visited = new Set<unknown>();
  let current: any = error;

  while (current && !visited.has(current)) {
    visited.add(current);
    const message = typeof current?.message === 'string' ? current.message.trim() : '';
    if (message) {
      messages.push(message);
    }
    current = current?.cause;
  }

  return messages;
}

function describeProxyTestFailure(error: unknown): string {
  const messages = extractNestedErrorMessages(error);
  const detail = messages.find((message) => message && message !== 'fetch failed')
    || messages[0]
    || '未知错误';

  if (/ECONNREFUSED/i.test(detail)) {
    return '系统代理测试失败：连接被拒绝，请检查代理地址、端口和本地代理程序是否已启动';
  }

  if (/ETIMEDOUT|timed out|timeout/i.test(detail)) {
    return '系统代理测试失败：连接超时，请检查代理服务或当前网络是否可用';
  }

  if (/ENOTFOUND|EAI_AGAIN/i.test(detail)) {
    return '系统代理测试失败：域名解析失败，请检查网络或代理的 DNS 配置';
  }

  if (/ECONNRESET/i.test(detail)) {
    return '系统代理测试失败：连接被对端重置，请检查代理链路是否稳定';
  }

  if (/407/.test(detail) || /proxy authentication/i.test(detail)) {
    return '系统代理测试失败：代理要求认证，请检查用户名、密码或代理配置';
  }

  return `系统代理测试失败：${detail}`;
}

/** 用给定代理地址探测一次连通性；失败抛带中文说明的 Error */
export async function testProxyConnectivity(proxyUrl: string): Promise<ProxyConnectivityResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      PROXY_TEST_PROBE_URL,
      withExplicitProxyRequestInit(proxyUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'cache-control': 'no-cache',
          'user-agent': 'metapi-system-proxy-tester/1.0',
        },
      }),
    );

    try {
      await response.arrayBuffer();
    } catch {
      // 读取响应体失败不影响可达性判定：拿到响应即算可达
    }

    return {
      reachable: true,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Math.max(1, Date.now() - startedAt),
      probeUrl: PROXY_TEST_PROBE_URL,
      finalUrl: response.url || PROXY_TEST_PROBE_URL,
    };
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`系统代理测试超时（${Math.round(PROXY_TEST_TIMEOUT_MS / 1000)}s）`);
    }
    throw new Error(describeProxyTestFailure(error));
  } finally {
    clearTimeout(timeout);
  }
}
