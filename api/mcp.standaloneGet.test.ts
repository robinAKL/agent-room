// Ported from the hosted deployment (#751, #752).
// The hosted endpoint is stateless and has nothing to push, so a client asking
// for the standalone SSE stream (GET, Accept: text/event-stream) must be told
// 405 — not handed a 200 stream that stays silent until a proxy cuts it.
//
// That silent stream is what dropped Antigravity out of rooms every ~15
// minutes: its MCP client reconnects a cut stream, counts five reconnects that
// made no progress, and closes the whole server connection ("standalone SSE
// stream: exceeded 5 retries without progress"), failing the room_listen that
// was in flight.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseUrl } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Listing tools never touches storage, but the client refuses to start unconfigured.
process.env.UPSTASH_REDIS_REST_URL ??= 'https://example.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN ??= 'test-token';

let server: http.Server;
let base = '';

beforeAll(async () => {
  const mcpHandler = (await import('./mcp.js')).default;
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
    const { query } = parseUrl(req.url ?? '/', true);
    const vreq = Object.assign(req, { body, query, cookies: {} });
    const vres = Object.assign(res, {
      status(code: number) { res.statusCode = code; return vres; },
      json(obj: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
      send(data: string) { res.end(data); return vres; },
    });
    try {
      await mcpHandler(vreq as never, vres as never);
    } catch (e) {
      if (!res.headersSent) vres.status(500).json({ error: 'crash', message: String(e) });
    }
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
});

describe('hosted MCP endpoint — standalone GET stream', () => {
  it('refuses an SSE GET with 405 instead of opening a silent stream', async () => {
    // A 200 stream would never resolve headers-then-body here; the timeout is
    // what turns "hangs open" into a failure rather than a stuck test.
    const res = await fetch(base, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type') ?? '').not.toContain('text/event-stream');
    expect(res.headers.get('allow')).toContain('POST');
    const body = await res.json() as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/POST/);
  });

  it('refuses a GET that names no Accept type the same way', async () => {
    const res = await fetch(base, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(5_000) });
    expect(res.status).toBe(405);
  });

  it('still serves the landing page to a browser', async () => {
    const res = await fetch(base, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5_000) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Agent Room hosted MCP endpoint');
  });

  it('keeps both GET answers out of a shared cache', async () => {
    // The CDN keys on the URL alone. A landing page cached there is served,
    // status 200, to the next MCP client's SSE GET — which undoes the 405.
    const html = await fetch(base, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5_000) });
    const htmlCache = html.headers.get('cache-control') ?? '';
    expect(htmlCache).toContain('private');
    expect(htmlCache).not.toMatch(/public|s-maxage/);
    expect(html.headers.get('vary') ?? '').toMatch(/accept/i);

    const sse = await fetch(base, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(5_000) });
    expect(sse.headers.get('cache-control')).toBe('no-store');
    expect(sse.headers.get('vary') ?? '').toMatch(/accept/i);
  });

  it('keeps a real Streamable HTTP client working over POST', async () => {
    // The SDK client opens the same GET after initialize; 405 must read to it
    // as "no stream offered", never as a failed connection.
    const client = new Client({ name: 'standalone-get-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(base)));
    try {
      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toContain('room_join');
    } finally {
      await client.close();
    }
  });
});
