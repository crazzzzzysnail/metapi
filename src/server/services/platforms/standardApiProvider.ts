import {
  BasePlatformAdapter,
  unsupportedBalance,
  type BalanceInfo,
  type CheckinResult,
  type UserInfo,
} from './base.js';
import { parseUpstreamUrlMode, resolveModelDiscoveryUrl } from '../../proxy-core/orchestration/upstreamRequest.js';

type FetchModelsOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
  resolveUrl?: (normalizedBaseUrl: string) => string;
  mapResponse?: (payload: any) => unknown[];
};

export function normalizePlatformBaseUrl(baseUrl: string): string {
  let normalized = baseUrl || '';
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function resolveVersionedModelsUrl(baseUrl: string): string {
  const modeResolved = resolveModelDiscoveryUrl(baseUrl, '/v1/models');
  if (modeResolved) return modeResolved;
  if (parseUpstreamUrlMode(baseUrl).mode === 'fixed') return '';
  const normalized = normalizePlatformBaseUrl(baseUrl);
  if (/\/v\d+(?:\.\d+)?(?:beta)?$/i.test(normalized)) {
    return `${normalized}/models`;
  }
  return `${normalized}/v1/models`;
}

export abstract class StandardApiProviderAdapterBase extends BasePlatformAdapter {
  protected loginUnsupportedMessage = 'login endpoint not supported';
  protected checkinUnsupportedMessage = 'checkin endpoint not supported';

  override async login(_baseUrl: string, _username: string, _password: string) {
    return {
      success: false as const,
      message: this.loginUnsupportedMessage,
    };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  override async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return {
      success: false,
      message: this.checkinUnsupportedMessage,
    };
  }

  // T2.4：这类上游没有余额接口。返回 unsupported 而不是伪造 0，
  // 否则「读不到」会被显示成「已用尽」，并把账户原有余额覆盖掉。
  override async getBalance(_baseUrl: string, _accessToken: string): Promise<BalanceInfo> {
    return unsupportedBalance('this platform does not expose a balance API');
  }

  protected async fetchModelsFromStandardEndpoint(options: FetchModelsOptions): Promise<string[]> {
    const normalizedBaseUrl = normalizePlatformBaseUrl(options.baseUrl);
    const url = options.resolveUrl
      ? options.resolveUrl(normalizedBaseUrl)
      : resolveVersionedModelsUrl(normalizedBaseUrl);

    let payload: any;
    try {
      payload = await this.fetchJson<any>(url, {
        headers: options.headers,
      });
    } catch {
      return [];
    }

    const rows = options.mapResponse
      ? options.mapResponse(payload)
      : Array.isArray(payload?.data)
        ? payload.data.map((item: any) => item?.id)
        : null;

    if (!Array.isArray(rows)) {
      throw new Error('invalid standard models payload');
    }

    return rows
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
}
