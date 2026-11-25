// Ported from the hosted deployment (#817), with the floor read through
// getSpeakingTurn, which is how this repository asks storage for it.
// Fewer model turns per room: every agent wake re-sends the agent's whole
// context, so a wake that carries nothing to act on is pure cost.
//
//   1. A Moderator holds the floor for its whole turn. Board events used to
//      wake it through the floor check every time another agent claimed,
//      submitted or verified a task (147 of 162 no-action wakes in
//      YRD-U8P-J3K). They now wait for the end of the window; a real message
//      from an assignee still wakes it at once.
//   2. thenListen on room_send: post and wait in one call instead of two.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC', topic: 't', createdAt: 0, createdBy: 'host', status: 'active' as const, version: 1,
  replyMode: 'moderator' as string,
  modeConfig: { moderatorAgentName: 'Claude', moderatorAgentClient: 'cc' as const },
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Claude', role: '', color: '#001', initials: 'CL', client: 'cc' as const, joinedAt: 1, lastSeenAt: 1, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
    { name: 'Grok', role: '', color: '#003', initials: 'GR', client: 'cc' as const, joinedAt: 3, lastSeenAt: 3, canSpeak: true },
  ],
};

const listMessages = vi.fn();
const getSpeakingTurn = vi.fn();
const appendMessage = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  listMessages: (...args: unknown[]) => listMessages(...args),
  getSpeakingTurn: (...args: unknown[]) => getSpeakingTurn(...args),
  appendMessage: (...args: unknown[]) => appendMessage(...args),
}));

const moderatorFloor = { mode: 'moderator', round: 1, role: 'moderator', isLead: false };

const sys = (id: number, text: string, target?: string) => ({
  id, type: 'sys', name: 'system', initials: 'AR', color: '#000', role: '', client: 'cc', time: id, text,
  metadata: { eventType: 'task_update', ...(target ? { targetAgentName: target } : {}) },
});
const said = (id: number, name: string, text: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'msg', name, initials: 'XX', color: '#000', role: '', client: 'cc', time: id, text, ...extra,
});

async function call(tool: string, args: Record<string, unknown>) {
  const { callTool } = await import('./_mcpTools.js');
  const res = await callTool({} as never, 'full', tool, { code: room.code, ...args });
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('a Moderator is not woken by board events while it holds the floor', () => {
  beforeEach(() => {
    listMessages.mockReset();
    getSpeakingTurn.mockReset();
    getSpeakingTurn.mockResolvedValue(moderatorFloor);
  });

  it('holds claims and verifies by other agents until the window ends, then hands them over together', async () => {
    listMessages.mockResolvedValue([
      sys(1, '🔵 T-05 "Fly" — claimed by Codex (now in_progress).', 'Codex'),
      sys(2, '📋 @Grok: T-03 — Independently inspect the submitted evidence, then room_task verify.', 'Grok'),
      said(3, 'Codex', '[STATUS] on it', { metadata: { roleAtSend: 'status' } }),
    ]);
    const started = Date.now();
    const body = await call('room_listen', { name: 'Claude', since: 0, timeoutMs: 3000, wakeOn: 'addressed' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
    expect(body.messages).toHaveLength(3);
    expect(body.addressedYou).toBeUndefined();
  }, 20_000);

  it('still wakes it at once for an assignee answer', async () => {
    listMessages.mockResolvedValue([
      sys(1, '🔵 T-05 — claimed by Codex (now in_progress).', 'Codex'),
      said(2, 'Codex', '[RESULT] T-05 done, PR #900'),
    ]);
    const started = Date.now();
    const body = await call('room_listen', { name: 'Claude', since: 0, timeoutMs: 10_000, wakeOn: 'addressed' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(body.addressedYou).toBe(true);
  }, 20_000);

  it('still wakes it at once for a board event aimed at it', async () => {
    listMessages.mockResolvedValue([sys(1, '📋 @Claude: T-04 — Independently inspect the submitted evidence.', 'Claude')]);
    const started = Date.now();
    const body = await call('room_listen', { name: 'Claude', since: 0, timeoutMs: 10_000, wakeOn: 'addressed' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(body.addressedYou).toBe(true);
  }, 20_000);
});

describe('thenListen', () => {
  beforeEach(() => {
    listMessages.mockReset();
    getSpeakingTurn.mockReset();
    getSpeakingTurn.mockResolvedValue(null);
    appendMessage.mockReset();
    appendMessage.mockResolvedValue({ appended: true });
    room.replyMode = 'open';
  });

  it('posts and returns the next message in the same call', async () => {
    const mine = said(1, 'Codex', 'Pushed the fix.');
    const reply = { ...said(2, 'host', 'Thanks, merging'), client: 'web' };
    // send reads the transcript once (cursor 1); the listen that follows sees the reply.
    listMessages.mockResolvedValueOnce([mine]).mockResolvedValue([reply]);
    const body = await call('room_send', { name: 'Codex', text: 'Pushed the fix.', thenListen: true, listenTimeoutMs: 5000 });
    expect(body.posted).toMatchObject({ tool: 'room_send', sent: true, appended: true, cursor: 1 });
    expect(body.posted).not.toHaveProperty('hint');
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['Thanks, merging']);
    expect(body.listenStatus).toBe('active');
  }, 20_000);

  it('does nothing extra without thenListen', async () => {
    listMessages.mockResolvedValue([said(1, 'Codex', 'hi')]);
    const body = await call('room_send', { name: 'Codex', text: 'hi' });
    expect(body.sent).toBe(true);
    expect(body).not.toHaveProperty('posted');
    expect(body).not.toHaveProperty('messages');
  });
});
