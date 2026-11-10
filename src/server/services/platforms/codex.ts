import { BasePlatformAdapter, unsupportedBalance, type BalanceInfo, type CheckinResult, type UserInfo } from './base.js';

function normalizeBaseUrl(baseUrl: string): string {
  let normalized = (baseUrl || '').trim();
  while (normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export class CodexAdapter extends BasePlatformAdapter {
  readonly platformName = 'codex';

  async detect(url: string): Promise<boolean> {
    const normalized = normalizeBaseUrl(url).toLowerCase();
    return normalized.includes('chatgpt.com/backend-api/codex');
  }

  override async login(_baseUrl: string, _username: string, _password: string) {
    return { success: false as const, message: 'codex oauth login is managed via OAuth flow' };
  }

  override async getUserInfo(_baseUrl: string, _accessToken: string): Promise<UserInfo | null> {
    return null;
  }

  async checkin(_baseUrl: string, _accessToken: string): Promise<CheckinResult> {
    return { success: false, message: 'codex oauth connections do not support checkin' };
  }

  async getBalance(_baseUrl: string, _accessToken: string): Promise<BalanceInfo> {
    // T2.4：不再伪造 0，改为显式声明无余额接口。
    return unsupportedBalance('codex oauth connections do not expose a balance API');
  }

  async getModels(_baseUrl: string, _token: string): Promise<string[]> {
    return [];
  }
}
