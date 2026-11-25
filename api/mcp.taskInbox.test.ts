// The board notifies through the transcript — a sys message naming the agent on
// every action, plus a stall nudge — which reaches whoever is present and
// nobody else. A reconnect returns the last 16 messages and a digest, so a
// board event from hours ago is simply gone.
//
// RCC-FY5-75M, 2026-09-07: the agent that held one session tracked the board
// perfectly; the one that kept dropping out had T-02 and T-04 wait on it for
// just under four hours, its slot reassigned four times.
//
// taskInboxFor is unit-tested in packages/shared. What is tested here is the
// wiring — that join and listen actually ask, which no pure test can catch.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const room = {
  code: 'AAA-BBB-CCC',
  topic: 't',
  createdAt: 0,
  createdBy: 'host',
  status: 'active' as const,
  version: 1,
  replyMode: 'open' as const,
  participants: [
    { name: 'host', role: '', color: '#000', initials: 'HO', client: 'web' as const, joinedAt: 0, lastSeenAt: 0, canSpeak: true },
    { name: 'Codex', role: '', color: '#002', initials: 'CO', client: 'cc' as const, joinedAt: 2, lastSeenAt: 2, canSpeak: true },
    { name: 'Bystander', role: '', color: '#003', initials: 'BY', client: 'cc' as const, joinedAt: 3, lastSeenAt: 3, canSpeak: true },
  ],
};

const listMessages = vi.fn();

vi.mock('./_mcpRoomClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_mcpRoomClient.js')>();
  return {
    ...actual,
    createRemoteRoomClient: () => ({}),
    getRoom: async () => room,
    sweepRoom: async () => room,
    setListenUntil: async () => {},
    joinRoom: async (_c: unknown, _code: string, p: { name: string }) => ({
      ...room,
      participant: room.participants.find(x => x.name === p.name && x.client === 'cc'),
    }),
    appendMessage: async () => ({ appended: true, metadata: { roleAtSend: 'status' } }),
    listMessages: (...args: unknown[]) => listMessages(...args),
  };
});

const BOARD = {
  tasks: [
    { id: 'T-02', title: 'a', state: 'awaiting_review', owner: 'Cursor Grok', verifier: 'Codex' },
    { id: 'T-04', title: 'b', state: 'awaiting_review', owner: 'Cursor Grok', verifier: 'Codex' },
    { id: 'T-08', title: 'c', state: 'in_progress', owner: 'Codex', verifier: 'Claude' },
    { id: 'T-01', title: 'd', state: 'done', owner: 'Codex', verifier: 'Claude' },
  ],
};

/** A client that answers the board read the way the real one does. */
const clientWithBoard = () => ({ post: vi.fn(async () => ({ board: BOARD })) }) as never;

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

describe('board inbox on join and listen', () => {
  beforeEach(() => { listMessages.mockReset(); listMessages.mockResolvedValue([]); });

  it('tells a joining agent what the board is holding for it', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'full', 'room_join', {
      code: room.code, name: 'Codex',
    }));

    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'], toDo: ['T-08'] });
    // The hint is what a weak client reads when it ignores everything else.
    expect(res.hint).toContain('T-02, T-04 are awaiting YOUR verdict');
    expect(res.hint).toContain('CURRENT WORK: T-08');
    // Structured work/review outranks the generic listen continuation.
    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_review', action: 'verify_task', taskId: 'T-02',
    });
  });

  it('says nothing when the board holds nothing for this agent', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'full', 'room_join', {
      code: room.code, name: 'Bystander',
    }));
    expect(res.yourTasks).toBeUndefined();
    expect(res.hint).not.toContain('BOARD:');
  });

  // The catch-up read is exactly when an agent that has been away is working
  // out what it missed.
  it('includes it in a non-blocking catch-up read', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex review please', client: 'web', time: 1 },
    ]);
    const res = body(await callTool(clientWithBoard(), 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 0,
    }));
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'] });
    expect(res.hint).toContain('awaiting YOUR verdict');
    expect(res.nextAction).toMatchObject({ kind: 'task_review', taskId: 'T-02' });
  });

  it('repeats it on a blocking listen that woke the agent', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex review please', client: 'web', time: 1 },
    ]);
    const res = body(await callTool(clientWithBoard(), 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000,
    }));
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'] });
    expect(res.hint).toContain('awaiting YOUR verdict');
    expect(res.nextAction).toMatchObject({ kind: 'task_review', taskId: 'T-02' });
  });

  it('makes active task execution the structured next action, not another listen', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex continue', client: 'web', time: 1 },
    ]);
    const activeOnly = {
      post: vi.fn(async () => ({
        board: { code: room.code, tasks: [{ id: 'T-12B', title: 'CRUD', state: 'in_progress', owner: 'Codex' }] },
      })),
    } as never;
    const res = body(await callTool(activeOnly, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));

    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_work', action: 'execute_task', taskId: 'T-12B',
    });
    expect(res.nextAction.instruction).toContain('do not call room_listen first');
    expect(res.hint).toContain('BOARD WORK OVERRIDES PRESENCE');
    expect(res.hint).not.toContain('NEXT (required): room_listen');
  });

  it('keeps active task execution ahead of listening after a status send', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const activeOnly = {
      post: vi.fn(async () => ({
        board: { code: room.code, tasks: [{ id: 'T-12B', title: 'CRUD', state: 'in_progress', owner: 'Codex' }] },
      })),
    } as never;
    const res = body(await callTool(activeOnly, 'full', 'room_send', {
      code: room.code, name: 'Codex', text: 'still working on T-12B', kind: 'status',
    }));

    expect(res.nextAction).toMatchObject({
      required: true, kind: 'task_work', action: 'execute_task', taskId: 'T-12B',
    });
    expect(res.nextAction.tool).toBeUndefined();
    expect(res.hint).toContain('CURRENT WORK: T-12B');
    expect(res.hint).not.toContain('NEXT (required): room_listen');
  });

  // The board was silent at the one moment it mattered: the room asks for work,
  // nothing is on the board, so yourTasks was omitted entirely and the only
  // guidance left was a tool description the agent would have had to look up.
  // ED9-FKF-4SK and FQ5-H8E-CXN, 2026-09-08.
  it('tells an addressed agent to open a task when the board is empty', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Codex analyse this project', client: 'web', time: 1 },
    ]);
    const emptyBoard = { post: vi.fn(async () => ({ board: { code: room.code, tasks: [], version: 0 } })) } as never;
    const res = body(await callTool(emptyBoard, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));
    expect(res.addressedYou).toBe(true);
    expect(res.yourTasks?.hint).toContain('nothing on the board is yours');
    expect(res.yourTasks?.hint).toContain('room_task({ action: "create", title, dod })');
  });

  // In open mode human speech is a broadcast even in a multi-agent room. The
  // speaking policy still decides who replies; wake routing must not hide the
  // host's request from the rest of the room.
  it('treats a host message as addressed to the whole open room', async () => {
    const { callTool } = await import('./_mcpTools.js');
    listMessages.mockResolvedValue([
      { id: 1, type: 'msg', name: 'host', text: '@Bystander your turn', client: 'web', time: 1 },
    ]);
    const emptyBoard = { post: vi.fn(async () => ({ board: { code: room.code, tasks: [], version: 0 } })) } as never;
    const res = body(await callTool(emptyBoard, 'full', 'room_listen', {
      code: room.code, since: 0, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    }));
    expect(res.addressedYou).toBe(true);
    expect(res.yourTasks?.hint).toContain('nothing on the board is yours');
  });

  // A quiet hold is the hot path — it must not pay for a board read.
  // The board outlives chat (#755): a quiet timeout still reads it once, and a
  // blocking listen with work returns board_action_required (#756).
  it('breaks a quiet blocking listen with an actionable MCP error when a review is already assigned', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const client = clientWithBoard();
    const result = await callTool(client, 'full', 'room_listen', {
      code: room.code, since: 171, name: 'Codex', timeoutMs: 1000, wakeOn: 'addressed',
    });
    const res = body(result);
    expect(result.isError).toBe(true);
    expect(res.error).toBe('board_action_required');
    // Some Codex wrappers only forward error/message after checking isError.
    expect(res.message).toContain('room_task review_start for T-02');
    expect(res.listenStatus).toBe('active');
    expect(res.messages).toEqual([]);
    expect(res.cursor).toBe(171);
    expect(res.nextAction).toMatchObject({
      kind: 'task_review', taskId: 'T-02', startReview: { arguments: { action: 'review_start' } },
    });
    expect(res.yourTasks).toMatchObject({ toVerify: ['T-02', 'T-04'] });
    expect((client as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledTimes(1);
  });

  it('continues listening after a quiet timeout when this seat owes no work', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const result = await callTool(clientWithBoard(), 'full', 'room_listen', {
      code: room.code, since: 171, name: 'Bystander', timeoutMs: 1000,
    });
    const res = body(result);
    expect(result.isError).not.toBe(true);
    expect(res.messages).toEqual([]);
    expect(res.yourTasks).toBeUndefined();
    expect(res.nextAction).toMatchObject({ kind: 'presence', tool: 'room_listen' });
  });

  it('allows blocking listens for a reviewer who recorded an unresolved blocker', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const client = { post: vi.fn(async () => ({ board: { tasks: [{
      ...BOARD.tasks[0], waiting: { scope: 'review', reason: 'Access needed', resumeWhen: 'Access restored' },
    }] } })) } as never;
    const result = await callTool(client, 'full', 'room_listen', {
      code: room.code, since: 171, name: 'Codex', timeoutMs: 1000,
    });
    expect(result.isError).not.toBe(true);
    expect(body(result).nextAction).toMatchObject({ kind: 'task_wait', tool: 'room_listen' });
  });

  it('stays quiet on the core profile, which has no board tools', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const res = body(await callTool(clientWithBoard(), 'core', 'room_join', {
      code: room.code, name: 'Codex',
    }));
    expect(res.yourTasks).toBeUndefined();
  });

  // Failing to read the board must never cost someone their join.
  it('joins normally when the board read throws', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const broken = { post: () => { throw new Error('upstash down'); } } as never;
    const res = body(await callTool(broken, 'full', 'room_join', {
      code: room.code, name: 'Codex',
    }));
    expect(res.assignedName).toBe('Codex');
    expect(res.yourTasks).toBeUndefined();
  });
});

// Ported from the hosted deployment's api/mcp.taskInbox.test.ts (#747, #748, #749).
describe('waits, fenced execution and task history over MCP', () => {
  beforeEach(() => { listMessages.mockReset(); listMessages.mockResolvedValue([]); });

  it('keeps blocked owner work waiting instead of issuing an execute directive', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const client = { post: vi.fn(async () => ({ board: { tasks: [{ id: 'T-WAIT', state: 'blocked', owner: 'Codex',
      blocked: { reason: 'Waiting for user login' } }] } })) } as never;
    const res = body(await callTool(client, 'full', 'room_join', { code: room.code, name: 'Codex' }));
    expect(res.nextAction).toMatchObject({ kind: 'task_wait', tool: 'room_listen' });
    expect(res.yourTasks.current).toEqual([]);
    expect(res.hint).not.toContain('CURRENT WORK: T-WAIT');
  });

  it('exposes wait/resume and returns a listening directive after a successful wait', async () => {
    const { callTool, listTools } = await import('./_mcpTools.js');
    const schema = listTools('full').find(t => t.name === 'room_task')!.inputSchema as any;
    expect(schema.properties.action.enum).toEqual(expect.arrayContaining(['wait', 'block', 'resume', 'ack', 'review_start',
      'capabilities', 'renew', 'recover', 'release', 'handoff', 'history', 'update']));
    expect(schema.properties.seatKey).toBeDefined();
    const waiting = { scope: 'review', reason: 'No access', resumeWhen: 'Access restored', at: 1, by: 'Codex', byClient: 'cc' };
    const task = { id: 'T-01', state: 'awaiting_review', owner: 'Bystander', verifier: 'Codex', waiting };
    const post = vi.fn(async () => ({ task, board: { tasks: [task] } }));
    const res = body(await callTool({ post } as never, 'full', 'room_task', { code: room.code, name: 'Codex',
      action: 'wait', id: task.id, scope: 'review', reasonCode: 'missing_credential', reason: 'No access', resumeWhen: 'Access restored' }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ action: 'taskWait', scope: 'review' }));
    expect(res.nextAction).toMatchObject({ kind: 'task_wait', tool: 'room_listen' });
    expect(res.yourTasks.toVerify).toEqual([]);
  });

  it('asks a reviewer to acknowledge the current review event before ruling', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const task = { id: 'T-05', state: 'awaiting_review', owner: 'Bystander', verifier: 'Codex',
      notification: { id: 'n-1', kind: 'review_requested', target: 'Codex', at: 1 } };
    const res = body(await callTool({ post: vi.fn(async () => ({ board: { tasks: [task] } })) } as never, 'full', 'room_join',
      { code: room.code, name: 'Codex' }));
    expect(res.nextAction.startReview).toMatchObject({ tool: 'room_task', arguments: { action: 'review_start', id: 'T-05', notificationId: 'n-1' } });
    expect(res.yourTasks.reviewEvents).toEqual({ 'T-05': 'n-1' });
  });

  it('claims with the seatKey and forwards the attempt on submit', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const task = { id: 'T-01', owner: 'Codex', state: 'in_progress', execution: { attemptId: 'attempt-1', recoveryRequired: false }, lease: { expiresAt: Date.now() + 900_000 } };
    const post = vi.fn(async () => ({ task, board: { tasks: [task] } }));
    const claimed = body(await callTool({ post } as never, 'full', 'room_task', { code: room.code, name: 'Codex', id: task.id, action: 'claim', seatKey: 'private-seat' }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ action: 'taskClaim', seatKey: 'private-seat' }));
    expect(claimed.workNext.instruction).toContain('attempt-1');
    expect(claimed.renewExecution.arguments).toMatchObject({ action: 'renew', attemptId: 'attempt-1' });
    await callTool({ post } as never, 'full', 'room_task', { code: room.code, name: 'Codex', id: task.id, action: 'submit', seatKey: 'private-seat',
      attemptId: 'attempt-1', fileListing: 'x.md', fileExcerpt: 'Report', checks: 'Checked' });
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'taskSubmit', attemptId: 'attempt-1', seatKey: 'private-seat' }));
  });

  it('turns a missing seat proof into a hint that fixes the same call', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { RemoteRoomApiError } = await import('./_mcpRoomClient.js');
    const post = vi.fn(async () => { throw new RemoteRoomApiError('no proof', 409, 'task_execution_identity_required'); });
    const missing = body(await callTool({ post } as never, 'full', 'room_task', { code: room.code, name: 'Codex', id: 'T-01', action: 'claim' }));
    expect(missing).toMatchObject({ error: 'task_execution_identity_required' });
    expect(missing.hint).toContain('Retry this SAME room_task call with seatKey');
    const wrong = body(await callTool({ post } as never, 'full', 'room_task', { code: room.code, name: 'Codex', id: 'T-01', action: 'claim', seatKey: 'stale' }));
    expect(wrong.hint).toContain('does not match the seat');
  });

  it('offers explicit recovery for an expired execution rather than asking it to keep executing', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const task = { id: 'T-OLD', owner: 'Codex', state: 'in_progress', execution: { attemptId: 'old', recoveryRequired: true },
      lease: { status: 'expired', expiresAt: Date.now() - 1 }, attempts: [{ id: 'old', status: 'interrupted' }] };
    const post = vi.fn(async () => ({ board: { tasks: [task] } }));
    const result = body(await callTool({ post } as never, 'full', 'room_join', { code: room.code, name: 'Codex' }));
    expect(result.nextAction).toMatchObject({ kind: 'task_recovery', action: 'recover', taskId: 'T-OLD' });
    expect(result.yourTasks.current).toEqual([]);
  });
});

describe('task history context and pagination', () => {
  const events = [1, 2, 3].map(index => ({ id: `event-${index}`, kind: 'state_changed', at: index,
    recordedAt: index, boardVersion: index, source: 'server' }));
  const withHistory = { ...BOARD.tasks[0], timeline: events, timelineDropped: 4 };
  const historyClient = () => ({ post: vi.fn(async () => ({ board: { tasks: [withHistory] }, task: withHistory })) }) as never;

  it('omits full timelines from normal list and mutation replies', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const listed = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'list' }));
    expect(listed.board.tasks[0].timeline).toBeUndefined();
    expect(listed.board.tasks[0].state).toBe('awaiting_review');
    const updated = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'update', name: 'Codex', id: 'T-02', title: 'New title' }));
    expect(updated.task.timeline).toBeUndefined();
    expect(withHistory.timeline).toHaveLength(3);
  });

  it('returns explicit history newest first with a stable event cursor and retention information', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const first = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'history', id: 'T-02', limit: 2 }));
    expect(first.events.map((event: { id: string }) => event.id)).toEqual(['event-3', 'event-2']);
    expect(first.nextBeforeEventId).toBe('event-2');
    expect(first.olderEventsDropped).toBe(4);
    const second = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'history', id: 'T-02', limit: 2, beforeEventId: first.nextBeforeEventId }));
    expect(second.events.map((event: { id: string }) => event.id)).toEqual(['event-1']);
    expect(second.nextBeforeEventId).toBeUndefined();
  });

  it('rejects invalid limits and stale cursors rather than silently skipping activity', async () => {
    const { callTool } = await import('./_mcpTools.js');
    for (const limit of [0, 51, 1.5, '10']) {
      const result = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'history', id: 'T-02', limit }));
      expect(result.error).toBe('bad_request');
    }
    const stale = body(await callTool(historyClient(), 'full', 'room_task', { code: room.code, action: 'history', id: 'T-02', beforeEventId: 'trimmed' }));
    expect(stale.error).toBe('history_cursor_expired');
  });
});
