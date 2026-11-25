// Ported from the hosted deployment (#835). This repository has no rolling
// project memory, so only the policy and digest refresh are covered here.
// Every room_listen result stays in the agent's context and is re-sent on each
// later turn. Text that is identical from wake to wake is pure cost there:
//
//   - the Codex pending-cell paragraph, on every listen and send, for clients
//     that never run a cell;
//   - the full room policy, rolling memory and digest, on every listen that
//     returned messages.
//
// They now go out when they are new to the caller, and on a periodic refresh.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ROOM_CODEX_CONTINUE } from '@agent-room/shared';
import { detectHarness } from './_mcpHarness.js';

type Msg = { id: number; type: string; name: string; text: string; time: number; client: string };

const room = {
  code: 'AAA-BBB-CCC', topic: 't', createdAt: 0, createdBy: 'host', status: 'active' as const, version: 1,
  replyMode: 'moderator' as string,
  modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' as const },
  modeChangedAt: 0,
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Claude', role: '', color: '#001', initials: 'CL', client: 'cc' as const, joinedAt: 1, lastSeenAt: 1, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

let transcript: Msg[] = [];
const appendMessage = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  getTurnState: async () => null,
  listMessages: async (_c: unknown, _code: string, since: number) => transcript.slice(since),
  appendMessage: (...args: unknown[]) => appendMessage(...args),
}));

// Message i is sent at time (i + 1) * 1000.
const said = (n: number): Msg[] => Array.from({ length: n }, (_, i) => ({
  id: i + 1, type: 'msg', name: 'host', text: `message ${i + 1}`, time: (i + 1) * 1000, client: 'web',
}));

async function listen(since: number) {
  const { callTool } = await import('./_mcpTools.js');
  // timeoutMs 0 is an explicit history read, which keeps returning everything.
  const res = await callTool({} as never, 'full', 'room_listen', { code: room.code, name: 'Claude', since, timeoutMs: 5_000 });
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('room policy, memory and digest go out when they are new', () => {
  beforeEach(() => {
    room.replyMode = 'moderator';
    room.modeChangedAt = 0;
    transcript = said(40);
  });

  it('sends everything on a first read', async () => {
    const body = await listen(0);
    expect(body.roomPolicy).toContain('Moderator mode');
    expect(body.digest).toBeTruthy();
  });

  it('leaves out what the caller already has in the middle of a stretch', async () => {
    // Read up to message 30; messages 31–32 arrive. No refresh boundary (25, 50) crossed.
    const body = await listen(30);
    expect(body.messages).toHaveLength(10);
    expect(body.roomPolicy).toBeUndefined();
    expect(body.digest).toBeUndefined();
    // The one-line role reminder still rides on every wake.
    expect(body.hint).toContain("You are this room's Moderator");
    expect(body.policyVersion).toBeUndefined();
  });

  it('refreshes the policy and digest every 25 messages', async () => {
    const body = await listen(24);
    expect(body.roomPolicy).toContain('Moderator mode');
    expect(body.digest).toBeTruthy();
  });

  it('sends the policy at once when the host changed the mode after the caller last read', async () => {
    room.modeChangedAt = 30_500; // after message 30 (30s), the last one the caller read
    const body = await listen(30);
    expect(body.roomPolicy).toContain('Moderator mode');
  });

  it('keeps the rules that prevent a drop in a shorter meaning', async () => {
    const body = await listen(30);
    expect(body.meaning).toContain('Follow nextAction');
    expect(body.meaning).toContain('End every message with a tool call');
    expect(body.meaning).toContain('Do not ask the user to continue');
    expect(body.meaning.length).toBeLessThan(200);
  });
});

describe('the Codex pending-cell paragraph goes only to Codex', () => {
  beforeEach(() => {
    room.replyMode = 'open';
    transcript = said(1);
    appendMessage.mockReset();
    appendMessage.mockResolvedValue({ appended: true });
  });

  async function send(userAgent?: string) {
    const { callTool } = await import('./_mcpTools.js');
    const res = await callTool({} as never, 'full', 'room_send',
      { code: room.code, name: 'Codex', text: 'hi' }, userAgent ? detectHarness(userAgent) : undefined);
    return (res.content[0] as { text: string }).text;
  }

  it('drops it for a client that is known not to be Codex', async () => {
    const text = await send('claude-code/2.1.0');
    const body = JSON.parse(text);
    expect(body.sent).toBe(true);
    expect(text).not.toContain('CODEX NEXT ACTION');
    // The rest of the continuation is untouched.
    expect(body.hint).toMatch(/^Sent\. NEXT \(required\): room_listen/);
  });

  it('keeps it for Codex and for clients it cannot identify', async () => {
    expect(await send('codex_cli_rs/0.60.0')).toContain(JSON.stringify(AGENT_ROOM_CODEX_CONTINUE).slice(1, -1));
    expect(await send('some-new-client/1.0')).toContain('CODEX NEXT ACTION');
    expect(await send()).toContain('CODEX NEXT ACTION');
  });
});
