// room_upload over MCP, end to end through the real room client (ported from
// the hosted deployment's #758 e2e cases, inline uploads only). R2 is stubbed:
// the test records what would have been stored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

const stored: Array<{ Key: string; ContentType: string; ContentDisposition?: string; Body: Buffer }> = [];
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class { async send(command: { input: (typeof stored)[number] }) { stored.push(command.input); return {}; } },
  PutObjectCommand: class { constructor(readonly input: unknown) {} },
}));

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

let fake: FakeRedis;
beforeEach(() => {
  for (const [k, v] of Object.entries({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't',
    R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket', R2_PUBLIC_URL: 'https://files.example.r2.dev',
    R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret',
  })) vi.stubEnv(k, v);
  fake = installFakeRedis();
  stored.length = 0;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function setup() {
  const { callTool } = await import('./_mcpTools.js');
  const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
  const client = createRemoteRoomClient(undefined);
  const code = body(await callTool(client, 'full', 'room_create', { topic: 'Files', name: 'Host' })).code as string;
  const joined = body(await callTool(client, 'full', 'room_join', { code, name: 'Codex' }));
  const call = async (tool: string, args: Record<string, unknown>) => body(await callTool(client, 'full', tool, { code, ...args }));
  return { code, seatKey: joined.seatKey as string, call };
}

describe('room_upload', () => {
  it('stores a file for the proven seat and shares it once with room_send', async () => {
    const { code, seatKey, call } = await setup();
    expect((await call('room_upload', { name: 'Codex', filename: 'notes.md', content: '# Notes' })).error).toBe('upload_identity_required');
    const up = await call('room_upload', { name: 'Codex', seatKey, filename: 'notes.md', content: '# Notes\nship it' });
    expect(up).toMatchObject({ uploaded: true, name: 'notes.md', mime: 'text/markdown' });
    expect(stored[0]).toMatchObject({ ContentType: 'text/markdown; charset=utf-8', ContentDisposition: 'attachment' });
    expect(stored[0]!.Key).toMatch(new RegExp(`^rooms/${code}/[0-9a-f-]{36}/notes\\.md$`));

    const sent = await call('room_send', { name: 'Codex', seatKey, attachmentIds: [up.attachmentId], text: 'notes attached' });
    expect(sent).toMatchObject({ sent: true });
    const again = await call('room_send', { name: 'Codex', seatKey, attachmentIds: [up.attachmentId], text: 'notes attached' });
    expect(again).toMatchObject({ sent: true, duplicate: true });
    const msgs = (fake.store.get(`room-msgs:${code}`) as string[]).map(raw => JSON.parse(raw));
    const shared = msgs.filter(m => m.attachments?.length);
    expect(shared).toHaveLength(1);
    expect(shared[0].attachments[0]).toMatchObject({ name: 'notes.md', provenance: 'agent_generated', extractedText: '# Notes\nship it' });

    const listened = await call('room_listen', { name: 'Host', since: 0, timeoutMs: 0 });
    expect(listened.messages.some((m: any) => m.attachments?.[0]?.name === 'notes.md')).toBe(true);
  });

  it('shares an executable as a download with a warning, and never as text', async () => {
    const { seatKey, call } = await setup();
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]).toString('base64');
    const up = await call('room_upload', { name: 'Codex', seatKey, filename: 'tool.txt', content: elf, encoding: 'base64' });
    expect(up).toMatchObject({ uploaded: true, mime: 'application/octet-stream', safetyWarning: expect.any(String) });
    await call('room_send', { name: 'Codex', seatKey, attachmentIds: [up.attachmentId] });
    const listened = await call('room_listen', { name: 'Host', since: 0, timeoutMs: 0 });
    const attachment = listened.messages.flatMap((m: any) => m.attachments ?? [])[0];
    expect(attachment.safetyWarning).toContain('malware');
    expect(attachment.extractedText).toBeUndefined();
  });

  it('refuses another seat\'s upload and oversized or malformed content', async () => {
    const { code, seatKey, call } = await setup();
    const up = await call('room_upload', { name: 'Codex', seatKey, filename: 'a.txt', content: 'a' });
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const other = body(await callTool(createRemoteRoomClient(undefined), 'full', 'room_join', { code, name: 'Claude' }));
    const stolen = await call('room_send', { name: 'Claude', seatKey: other.seatKey, attachmentIds: [up.attachmentId] });
    expect(stolen.error).toBe('upload_not_found');
    expect((await call('room_upload', { name: 'Codex', seatKey, filename: '../x', content: 'a' })).error).toBe('invalid_filename');
    expect((await call('room_upload', { name: 'Codex', seatKey, filename: 'x.bin', content: 'a'.repeat(600 * 1024) })).error).toBe('file_too_large');
    expect((await call('room_upload', { name: 'Codex', seatKey, filename: 'x.bin', content: 'abc', encoding: 'base64' })).error).toBe('invalid_base64');
  });
});
