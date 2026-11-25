// An agent that claimed a task and started a long command (a data collection)
// had nowhere to wait: every blocking room_listen came back as
// board_action_required while the task was in_progress. It either ended its
// turn, which drops it from the room, or submitted the evidence it had so far.
// A running_job wait parks the task so the agent can listen, in short windows,
// until the command finishes.

import { describe, expect, it, vi } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC', topic: 't', createdAt: 0, createdBy: 'host', status: 'active' as const, version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
  ],
};

vi.mock('./_mcpRoomClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_mcpRoomClient.js')>()),
  createRemoteRoomClient: () => ({}),
  getRoom: async () => room,
  sweepRoom: async () => room,
  setListenUntil: async () => {},
  getTurnState: async () => null,
  // One message, so the listen returns at once instead of holding the poll.
  listMessages: async (_c: unknown, _code: string, since: number) =>
    [{ id: 1, type: 'msg', name: 'host', text: 'status?', time: 1000, client: 'web' }].slice(since),
}));

const withTask = (task: Record<string, unknown>) =>
  ({ post: vi.fn(async () => ({ board: { tasks: [task] } })) }) as never;

async function listen(client: never, timeoutMs: number) {
  const { callTool } = await import('./_mcpTools.js');
  const res = await callTool(client, 'full', 'room_listen', { code: room.code, name: 'Codex', since: 0, timeoutMs });
  return { isError: res.isError === true, body: JSON.parse((res.content[0] as { text: string }).text) };
}

describe('waiting on your own running command', { timeout: 30_000 }, () => {
  it('tells an agent with in_progress work how to wait on a running command instead of dropping', async () => {
    const { isError, body } = await listen(withTask({ id: 'T-37', state: 'in_progress', owner: 'Codex' }), 5_000);
    expect(isError).toBe(true);
    expect(body.error).toBe('board_action_required');
    expect(body.message).toContain('reasonCode running_job');
    expect(body.message).toContain('do not submit partial evidence');
  });

  it('lets a running_job wait listen, in windows of at most a minute', async () => {
    const task = { id: 'T-37', state: 'blocked', owner: 'Codex',
      waiting: { scope: 'owner', reasonCode: 'running_job', reason: 'Collection running', resumeWhen: 'Script exits', at: 1, by: 'Codex', byClient: 'cc' } };
    const { isError, body } = await listen(withTask(task), 300_000);
    expect(isError).toBe(false);
    expect(body.error).toBeUndefined();
    expect(body.nextAction).toMatchObject({ kind: 'task_wait', tool: 'room_listen' });
    expect(body.nextAction.arguments.timeoutMs ?? 0).toBeLessThanOrEqual(60_000);
    expect(body.nextAction.instruction).toContain('room_task resume for T-37');
  });

  it('keeps an ordinary input wait on the caller\'s own listen window', async () => {
    const task = { id: 'T-38', state: 'blocked', owner: 'Codex',
      waiting: { scope: 'owner', reasonCode: 'missing_user_input', reason: 'Need login', resumeWhen: 'Host logs in', at: 1, by: 'Codex', byClient: 'cc' } };
    const { body } = await listen(withTask(task), 300_000);
    expect(body.nextAction.instruction).not.toContain('still running');
  });

  it('accepts running_job in the room_task schema', async () => {
    const { listTools } = await import('./_mcpTools.js');
    const schema = listTools('full').find(t => t.name === 'room_task')!.inputSchema as { properties: { reasonCode: { enum: string[] } } };
    expect(schema.properties.reasonCode.enum).toContain('running_job');
  });
});
