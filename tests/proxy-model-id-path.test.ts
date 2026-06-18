import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startProxy, type ProxyHandle } from '../src/proxy.js';

describe('proxy GET /v1/models with models/ prefix ids', () => {
  let handle: ProxyHandle | null = null;

  afterEach(() => {
    handle?.close();
    handle = null;
  });

  it('returns 1M context_window for Google-style model ids', async () => {
    handle = await startProxy('', 'gemini-3.5-flash', false, 1_000_000, {
      npm: '@ai-sdk/google',
      upstreamModelId: 'gemini-3.5-flash',
    });

    async function get(path: string) {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: handle!.port, path }, res => {
          let d = '';
          res.on('data', c => { d += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
        }).on('error', reject);
      });
    }

    const list = await get('/v1/models');
    expect(list.status).toBe(200);
    const listJson = JSON.parse(list.body) as { data: Array<{ id: string; context_window: number }> };
    expect(listJson.data[0]?.id).toBe('gemini-3.5-flash[1m]');
    expect(listJson.data[0]?.context_window).toBe(1_000_000);

    const withSuffix = await get('/v1/models/gemini-3.5-flash%5B1m%5D');
    expect(withSuffix.status).toBe(200);
    expect(JSON.parse(withSuffix.body).context_window).toBe(1_000_000);

    const bare = await get('/v1/models/gemini-3.5-flash');
    expect(bare.status).toBe(200);
    expect(JSON.parse(bare.body).context_window).toBe(1_000_000);
  });
});
