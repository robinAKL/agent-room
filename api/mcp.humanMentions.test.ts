// "@x t d can you check this" is one person talking to another. A human message
// that @-mentions only humans must not wake agents through the human-broadcast
// or sole-agent paths; an @ of an agent still wakes that agent (from #853).
import { describe, expect, it, vi } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC', topic: 't', createdAt: 0, createdBy: 'Robin', status: 'active' as const, version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'Robin', role: '', color: '#000', initials: 'RO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'x t d', role: '', color: '#001', initials: 'XT', client: 'web' as const, joinedAt: 1, lastSeenAt: 1, canSpeak: true },
    { name: 'Claude', role: '', color: '#002', initials: 'CL', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  listMessages: (...args: unknown[]) => listMessages(...args),
}));

const said = (id: number, text: string) => ({
  id, type: 'msg', name: 'Robin', initials: 'RO', color: '#000', role: '', client: 'web', time: id, text,
});

async function listen() {
  const { callTool } = await import('./_mcpTools.js');
  const started = Date.now();
  const res = await callTool({ post: async () => ({ board: { tasks: [] } }) } as never, 'full', 'room_listen',
    { code: room.code, name: 'Claude', since: 0, timeoutMs: 2500, wakeOn: 'addressed' });
  return { ms: Date.now() - started, body: JSON.parse((res.content[0] as { text: string }).text) };
}

describe('mentions aimed only at humans', () => {
  it('does not wake the room\'s only agent for a message to a spaced human name', async () => {
    listMessages.mockResolvedValue([said(1, '@x t d can you check this')]);
    const { ms, body } = await listen();
    expect(ms).toBeGreaterThanOrEqual(2000);
    expect(body.addressedYou).toBeUndefined();
    expect(body.messages).toHaveLength(1);
  }, 20_000);

  it('still wakes the agent when it is mentioned alongside the human', async () => {
    listMessages.mockResolvedValue([said(1, '@x t d and @Claude please compare')]);
    const { ms, body } = await listen();
    expect(ms).toBeLessThan(2000);
    expect(body.addressedYou).toBe(true);
  }, 20_000);

  it('keeps the plain human broadcast waking the agent', async () => {
    listMessages.mockResolvedValue([said(1, 'what do we think?')]);
    const { ms, body } = await listen();
    expect(ms).toBeLessThan(2000);
    expect(body.addressedYou).toBe(true);
  }, 20_000);
});

describe('harness echo (#724)', () => {
  it('reports the raw client signals behind the guess, one short line', async () => {
    const { detectHarness, harnessSummary } = await import('./_mcpHarness.js');
    expect(harnessSummary(detectHarness('Some-Proxy/2.1 (connector)', 'mcp-client'))).toMatchObject({
      detected: 'unknown', seen: { userAgent: 'Some-Proxy/2.1 (connector)', clientName: 'mcp-client' },
    });
    const seen = harnessSummary(detectHarness(`a\r\nb${'x'.repeat(400)}`)).seen!;
    expect(seen.userAgent).not.toMatch(/[\r\n]/);
    expect(seen.userAgent!.length).toBeLessThanOrEqual(160);
    expect(harnessSummary(detectHarness(undefined)).seen).toBeUndefined();
    detectHarness('claude-code/2.0');
    expect(detectHarness(undefined, 'claude-code').seen).toEqual({ clientName: 'claude-code' });
  });
});
