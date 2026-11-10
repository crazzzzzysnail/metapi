import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { VeloeraAdapter } from './veloera.js';

/**
 * veloera 适配器余额换算测试。
 *
 * 此前零覆盖。veloera 有两个易错点：
 * 1. 标尺是 1_000_000 额度 = 1 USD，不是 new-api 系的 500_000；
 * 2. `quota` 同样是剩余额度，旧实现又减一次 used，导致余额与总额双双算少。
 */
describe('VeloeraAdapter 余额换算', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastHeaders: IncomingMessage['headers'];
  let payload: Record<string, unknown>;

  beforeEach(async () => {
    payload = {
      success: true,
      data: {
        quota: 30_000_000,
        used_quota: 20_000_000,
        today_income: 1_000_000,
        today_quota_consumption: 500_000,
      },
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      lastHeaders = req.headers;
      if (req.url === '/api/user/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('按 1_000_000 标尺换算且不做双扣', async () => {
    const adapter = new VeloeraAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    // 30_000_000 / 1_000_000 = 30 剩余；20_000_000 / 1_000_000 = 20 已用；总额 50。
    expect(balance.balance).toBe(30);
    expect(balance.used).toBe(20);
    expect(balance.quota).toBe(50);
  });

  it('若误用 new-api 标尺会得到两倍数值 —— 本用例锁定不会回退', async () => {
    const adapter = new VeloeraAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    // 500_000 口径会得到 balance 60 / total 100，正是历史 one-api 的错误值。
    expect(balance.balance).not.toBe(60);
    expect(balance.quota).not.toBe(100);
  });

  it('today_income 与今日消耗同样按 1_000_000 标尺', async () => {
    const adapter = new VeloeraAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    expect(balance.todayIncome).toBe(1);
    expect(balance.todayQuotaConsumption).toBe(0.5);
  });

  it('缺失字段按 0 处理，不产生 NaN', async () => {
    payload = { success: true, data: {} };
    const adapter = new VeloeraAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    expect(balance).toEqual({
      balance: 0,
      used: 0,
      quota: 0,
      todayIncome: undefined,
      todayQuotaConsumption: undefined,
    });
  });

  it('平台用户 ID 以 veloera 约定的三个头同时透传', async () => {
    const adapter = new VeloeraAdapter();
    await adapter.getBalance(baseUrl, 'token', 1234);

    expect(lastHeaders['veloera-user']).toBe('1234');
    expect(lastHeaders['new-api-user']).toBe('1234');
    expect(lastHeaders['user-id']).toBe('1234');
  });
});
