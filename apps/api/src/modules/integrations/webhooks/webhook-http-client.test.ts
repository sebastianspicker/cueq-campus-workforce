import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhookDeliveryRecord } from '../webhook-delivery.mapper.js';
import { postWebhook } from './webhook-http-client.js';

// The SSRF guard rejects loopback targets; this test needs a local server.
vi.mock('./webhook-url.js', () => ({
  resolveWebhookDispatchTarget: async (url: string) => ({
    url: new URL(url),
    address: '127.0.0.1',
    family: 4,
  }),
}));

let server: Server | undefined;

async function serve(status: number, body: string): Promise<string> {
  server = createServer((_req, res) => {
    res.statusCode = status;
    res.end(body);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

describe('postWebhook response cap', () => {
  it('keeps the real status and a truncated body when the reply exceeds the cap', async () => {
    const url = await serve(200, 'x'.repeat(9_000));
    const result = await postWebhook({
      url,
      headers: {},
      body: '{}',
      timeoutMs: 5_000,
      maxResponseBytes: 8_000,
    });
    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.body)).toBe(8_000);
  });
});

describe('webhookDeliveryRecord', () => {
  it('stores response bodies without NUL characters', () => {
    const record = webhookDeliveryRecord('e', 'ep', 1, 200, 'a\u0000b');
    expect(record.responseBody).toBe('ab');
  });
});
