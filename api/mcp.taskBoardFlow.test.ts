// End to end through the real room client: two agents join, one claims with its
// seatKey, submits with the attempt, and the board assigns and notifies the
// other as reviewer — no HTTP room server involved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeRedis, type FakeRedis } from '../packages/upstash-client/test/fakeRedis.js';

function body(res: { content: unknown[] }): Record<string, any> {
  return JSON.parse((res.content[0] as { text: string }).text);
}

let fake: FakeRedis;

beforeEach(() => {
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 't');
  fake = installFakeRedis();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('task board over MCP with no room server', () => {
  it('assigns, notifies and fences a review flow', async () => {
    const { callTool } = await import('./_mcpTools.js');
    const { createRemoteRoomClient } = await import('./_mcpRoomClient.js');
    const client = createRemoteRoomClient(undefined);
    const created = body(await callTool(client, 'full', 'room_create', { topic: 'Flow', name: 'Host' }));
    const code = created.code as string;
    const alpha = body(await callTool(client, 'full', 'room_join', { code, name: 'Alpha' }));
    const beta = body(await callTool(client, 'full', 'room_join', { code, name: 'Beta' }));
    expect(alpha.seatKey).toMatch(/^[0-9a-f]{64}$/);
    expect(alpha.seatProof).toMatchObject({ required: 'seatKey' });

    body(await callTool(client, 'full', 'room_task', { code, name: 'Alpha', action: 'create', title: 'Write report', owner: 'Alpha', dod: 'report exists' }));
    const refused = body(await callTool(client, 'full', 'room_task', { code, name: 'Alpha', action: 'claim', id: 'T-01' }));
    expect(refused.error).toBe('task_execution_identity_required');
    const claimed = body(await callTool(client, 'full', 'room_task', { code, name: 'Alpha', action: 'claim', id: 'T-01', seatKey: alpha.seatKey }));
    const attemptId = claimed.execution.attemptId as string;
    expect(attemptId).toMatch(/^attempt-/);
    const submitted = body(await callTool(client, 'full', 'room_task', { code, name: 'Alpha', action: 'submit', id: 'T-01',
      seatKey: alpha.seatKey, attemptId, fileListing: 'report.md', fileExcerpt: '# Report', checks: 'Opened it' }));
    expect(submitted.task).toMatchObject({ state: 'awaiting_review', verifier: 'Beta', reviewStatus: 'assigned' });
    expect(submitted.task.timeline).toBeUndefined(); // stripped from replies

    const msgs = (fake.store.get(`room-msgs:${code}`) as string[]).map(raw => JSON.parse(raw));
    const notice = msgs.filter(m => m.metadata?.taskEventId);
    expect(notice).toHaveLength(1);
    expect(notice[0].metadata).toMatchObject({ targetAgentName: 'Beta', taskId: 'T-01', eventType: 'task_update' });

    const joined = body(await callTool(client, 'full', 'room_join', { code, name: 'Beta', seatKey: beta.seatKey }));
    expect(joined.seatKey).toBe(beta.seatKey);
    expect(joined.nextAction).toMatchObject({ kind: 'task_review', taskId: 'T-01' });
    body(await callTool(client, 'full', 'room_task', { code, name: 'Beta', action: 'review_start', id: 'T-01',
      notificationId: joined.nextAction.startReview.arguments.notificationId, seatKey: beta.seatKey }));
    const ruled = body(await callTool(client, 'full', 'room_task', { code, name: 'Beta', action: 'verify', id: 'T-01',
      verdict: 'done', note: 'Opened report.md', seatKey: beta.seatKey }));
    expect(ruled.task.state).toBe('done');
    const history = body(await callTool(client, 'full', 'room_task', { code, action: 'history', id: 'T-01', limit: 50 }));
    expect(history.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining([
      'task_created', 'execution_started', 'notification_published', 'review_started', 'review_verdict']));
  });
});
