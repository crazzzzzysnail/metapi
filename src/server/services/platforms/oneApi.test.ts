import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { OneApiAdapter } from './oneApi.js';

/**
 * one-api 适配器余额换算测试。
 *
 * 此前该适配器零测试覆盖，`balance = quota - used` 的双扣缺陷长期未被发现：
 * one-api 的 `quota` 字段语义是「剩余额度」（与 new-api 一致），
 * 再减一次 `used_quota` 会把余额算少、并把总额也算少。
 */
describe('OneApiAdapter 余额换算', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  // 可通过环境变量式查询串切换载荷，便于同一 mock 服务覆盖多组数据。
  let payload: Record<string, unknown>;

  beforeEach(async () => {
    payload = {
      success: true,
      data: {
        quota: 30_000_000,
        used_quota: 20_000_000,
        today_income: 500_000,
        today_quota_consumption: 250_000,
      },
    };

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
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

  it('quota 视为剩余额度：balance 不再被双扣，total = quota + used', async () => {
    const adapter = new OneApiAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    // 30_000_000 / 500_000 = 60 剩余；20_000_000 / 500_000 = 40 已用；总额 100。
    expect(balance.balance).toBe(60);
    expect(balance.used).toBe(40);
    expect(balance.quota).toBe(100);
  });

  it('today_income 与今日消耗按 500_000 标尺换算', async () => {
    const adapter = new OneApiAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    expect(balance.todayIncome).toBe(1);
    expect(balance.todayQuotaConsumption).toBe(0.5);
  });

  it('缺失字段按 0 处理，不产生 NaN', async () => {
    payload = { success: true, data: {} };
    const adapter = new OneApiAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    expect(balance).toEqual({
      balance: 0,
      used: 0,
      quota: 0,
      todayIncome: undefined,
      todayQuotaConsumption: undefined,
    });
  });

  it('额度为字符串时仍可换算（上游偶发字符串序列化）', async () => {
    payload = { success: true, data: { quota: '500000', used_quota: '0' } };
    const adapter = new OneApiAdapter();
    const balance = await adapter.getBalance(baseUrl, 'token');

    expect(balance.balance).toBe(1);
    expect(balance.quota).toBe(1);
  });
});
