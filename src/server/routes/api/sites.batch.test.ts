import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('sites batch routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-batch-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('enables system proxy for selected sites and reports failures', async () => {
    await db.insert(schema.sites).values([
      {
        id: 1,
        name: 'site-1',
        url: 'https://site-1.example.com',
        platform: 'new-api',
        useSystemProxy: false,
      },
      {
        id: 2,
        name: 'site-2',
        url: 'https://site-2.example.com',
        platform: 'new-api',
        useSystemProxy: false,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1, 2, 999],
        action: 'enableSystemProxy',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      successIds?: number[];
      failedItems?: Array<{ id: number; message: string }>;
    };
    expect(body.successIds).toEqual([1, 2]);
    expect(body.failedItems).toHaveLength(1);
    expect(body.failedItems?.[0]?.id).toBe(999);

    const rows = await db.select().from(schema.sites).all();
    expect(rows.every((row) => row.useSystemProxy === true)).toBe(true);
  });

  it('rejects invalid sites batch action', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'nope',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('action');
  });

  it('updates global weight and proxy url for selected sites', async () => {
    await db.insert(schema.sites).values([
      {
        id: 1,
        name: 'site-1',
        url: 'https://site-1.example.com',
        platform: 'new-api',
        globalWeight: 1,
        proxyUrl: null,
      },
      {
        id: 2,
        name: 'site-2',
        url: 'https://site-2.example.com',
        platform: 'new-api',
        globalWeight: 1,
        proxyUrl: null,
      },
    ]).run();

    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1, 2],
        action: 'updateSettings',
        globalWeight: 2.5,
        proxyUrl: 'socks5://127.0.0.1:1080',
        useSystemProxy: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { successIds?: number[] }).successIds).toEqual([1, 2]);

    const rows = await db.select().from(schema.sites).all();
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    expect(rowsById.get(1)?.globalWeight).toBe(2.5);
    expect(rowsById.get(2)?.globalWeight).toBe(2.5);
    expect(rowsById.get(1)?.proxyUrl).toBe('socks5://127.0.0.1:1080');
    expect(rowsById.get(2)?.proxyUrl).toBe('socks5://127.0.0.1:1080');
    expect(rowsById.get(1)?.useSystemProxy).toBe(true);
    expect(rowsById.get(2)?.useSystemProxy).toBe(true);
  });

  it('rejects invalid batch proxy url', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: [1],
        action: 'updateSettings',
        proxyUrl: 'not-a-proxy',
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { message?: string }).message).toContain('proxyUrl');
  });

  it('rejects non-number site ids at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/sites/batch',
      payload: {
        ids: ['1'],
        action: 'enable',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      message: 'Invalid ids. Expected number[].',
    });
  });
});
