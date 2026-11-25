// Review assignment, responsibility notifications and explicit waits
// (ported from the hosted deployment's api/task-review-wait.test.ts, #747).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Room } from '@agent-room/shared';
import { taskInboxFor, wakesAgent } from '@agent-room/shared';
import {
  acknowledgeTaskReview,
  claimTask,
  createClient,
  createTask,
  getTaskBoard,
  publishTaskNotifications,
  reassignTaskRoles,
  reconcileTaskReviews,
  resumeTask,
  submitTask,
  TASK_NOTIFICATION_SCRIPT,
  updateTask,
  verifyTask,
  waitTask,
  type UpstashClient,
} from '../src/index.js';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';

const code = 'ABC-DEF-GHJ';
const owner = { name: 'Owner', client: 'cc' as const };
const reviewer = { name: 'Reviewer', client: 'cc' as const };
const evidence = { fileListing: 'report.md', fileExcerpt: '# Report', checks: 'Opened report and checked every acceptance criterion.' };
let fake: FakeRedis;
let client: UpstashClient;
let room: Room;

async function saveRoom() { await client.command(['SET', `room:${code}`, JSON.stringify(room)]); }
async function submit(verifier?: string) {
  await createTask(client, code, { title: 'Deliver report', owner: owner.name, ownerClient: 'cc', verifier, createdBy: owner.name });
  await claimTask(client, code, 'T-01', owner);
  return submitTask(client, code, 'T-01', owner, evidence);
}
async function events() {
  return (await client.command<string[]>(['LRANGE', `room-msgs:${code}`, 0, -1])).map(raw => JSON.parse(raw));
}

beforeEach(async () => {
  fake = installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
  const now = Date.now();
  room = { code, topic: 'Review recovery', createdBy: 'Host', createdAt: now - 1000, status: 'active', version: 1,
    replyMode: 'open', participants: ['Host', 'Owner', 'Reviewer', 'Other'].map((name, i) => ({
      name, client: i === 0 ? 'web' : 'cc', role: '', initials: name.slice(0, 2), color: '#000',
      joinedAt: i + 1, lastSeenAt: now, canSpeak: true,
    })) } as Room;
  await saveRoom();
});

describe('review assignment and recoverable notifications', () => {
  it.each(['open', 'sequential', 'moderator'] as const)('assigns one independent reviewer in %s mode', async mode => {
    room.replyMode = mode; await saveRoom();
    const { task } = await submit();
    expect(task).toMatchObject({ state: 'awaiting_review', verifier: 'Reviewer', reviewStatus: 'assigned' });
    expect(taskInboxFor({ tasks: [task] }, 'Reviewer').toVerify).toEqual(['T-01']);
    expect(task.notification).toMatchObject({ kind: 'review_requested', target: 'Reviewer' });
    await publishTaskNotifications(client, code);
    const [event] = await events();
    expect(event.metadata).toMatchObject({ eventType: 'task_update', taskId: 'T-01', taskEventId: task.notification!.id, targetAgentName: 'Reviewer' });
    expect(wakesAgent(event, 'Reviewer')).toBe(true);
    expect(wakesAgent(event, 'Other')).toBe(false);
  });

  it('never picks the host or the owner, and prefers the least-loaded reviewer', async () => {
    await createTask(client, code, { title: 'A', owner: 'Owner', createdBy: 'Owner' });
    await createTask(client, code, { title: 'B', owner: 'Owner', createdBy: 'Owner' });
    await submitTask(client, code, 'T-01', owner, evidence);
    const { task } = await submitTask(client, code, 'T-02', owner, evidence);
    const board = (await getTaskBoard(client, code))!;
    expect(board.tasks.map(t => t.verifier)).toEqual(['Reviewer', 'Other']);
    expect(task.verifier).toBe('Other');
  });

  it('keeps a solo submission and assigns it once when a reviewer joins, even with concurrent repairs', async () => {
    room.participants = room.participants.slice(0, 2); await saveRoom();
    const { task } = await submit();
    expect(task).toMatchObject({ state: 'awaiting_review', reviewStatus: 'waiting_for_verifier', evidence: { fileListing: 'report.md' } });
    expect(task.verifier).toBeUndefined();
    room.participants.push({ ...room.participants[1]!, name: 'Reviewer', joinedAt: 3 }); await saveRoom();
    await Promise.all([reconcileTaskReviews(client, code), reconcileTaskReviews(client, code), reconcileTaskReviews(client, code)]);
    const recovered = (await getTaskBoard(client, code))!.tasks[0]!;
    expect(recovered.verifier).toBe('Reviewer');
    expect(recovered.roleHistory).toHaveLength(1);
    await Promise.all([publishTaskNotifications(client, code), publishTaskNotifications(client, code)]);
    expect(await events()).toHaveLength(1);
    // A stable board costs reads only.
    const version = (await getTaskBoard(client, code))!.version;
    fake.log.length = 0;
    await reconcileTaskReviews(client, code);
    expect((await getTaskBoard(client, code))!.version).toBe(version);
    expect(fake.log.some(cmd => cmd[0] === 'EVAL')).toBe(false);
  });

  it('preserves explicit roles and rejects empty, self and unseated reviewer updates', async () => {
    await submit('Other');
    for (const verifier of ['Owner', 'Nobody']) {
      await expect(updateTask(client, code, 'T-01', { verifier })).rejects.toThrow();
      expect((await getTaskBoard(client, code))!.tasks[0]!.verifier).toBe('Other');
    }
    await expect(reassignTaskRoles(client, code, 'T-01', { verifier: '  ' }, owner)).rejects.toThrow();
    await reconcileTaskReviews(client, code);
    expect((await getTaskBoard(client, code))!.tasks[0]!.verifier).toBe('Other');
  });

  it('lets a seated human be the named reviewer instead of replacing them', async () => {
    room.participants.push({ ...room.participants[0]!, name: 'Robin', joinedAt: 9 }); await saveRoom();
    const { task } = await submit('Robin');
    expect(task).toMatchObject({ verifier: 'Robin', verifierClient: 'web', reviewStatus: 'assigned' });
  });

  it('retries a failed append and deduplicates the append/ack transaction', async () => {
    await submit();
    fake.failOnce(cmd => String(cmd[1]).startsWith('-- task-notification'));
    await expect(publishTaskNotifications(client, code)).rejects.toThrow();
    expect((await getTaskBoard(client, code))!.tasks[0]!.notification?.deliveredAt).toBeUndefined();
    expect(await publishTaskNotifications(client, code)).toBe(1);
    expect(await publishTaskNotifications(client, code)).toBe(0);
    expect(await events()).toHaveLength(1);
    const published = (await getTaskBoard(client, code))!.tasks[0]!;
    expect(published.notification?.deliveredAt).toBeTypeOf('number');
    expect(published.timeline?.some(e => e.kind === 'notification_published')).toBe(true);
  });

  it('suppresses old assignment events after a reviewer is reassigned', async () => {
    const { task } = await submit();
    const oldId = task.notification!.id;
    await reassignTaskRoles(client, code, 'T-01', { verifier: 'Other', verifierClient: 'cc' }, reviewer);
    const board = (await getTaskBoard(client, code))!;
    const stale = await client.command(['EVAL', TASK_NOTIFICATION_SCRIPT, 4, `room:${code}`, `room-msgs:${code}`,
      `room-msg-count:${code}`, `task-board:${code}`, String(room.createdAt), '{}', -500, 'T-01', oldId,
      String(board.version), JSON.stringify(board), 0]);
    expect(stale).toBe(0);
    await publishTaskNotifications(client, code);
    const sent = await events();
    expect(sent).toHaveLength(1);
    expect(sent[0].metadata.targetAgentName).toBe('Other');
  });

  it('does not publish notices for an ended room', async () => {
    await submit();
    room.status = 'ended'; await saveRoom();
    expect(await publishTaskNotifications(client, code)).toBe(0);
    expect(await events()).toHaveLength(0);
  });

  it('replaces an offline reviewer only after the review timeout', async () => {
    const { task } = await submit();
    expect(task.verifier).toBe('Reviewer');
    const stale = Date.now() - 60 * 60 * 1000;
    room.participants = room.participants.map(p => p.name === 'Reviewer' ? { ...p, lastSeenAt: stale } : p);
    await saveRoom();
    const board = (await getTaskBoard(client, code))!;
    board.tasks[0]!.reviewRequestedAt = stale;
    await client.command(['SET', `task-board:${code}`, JSON.stringify(board)]);
    await reconcileTaskReviews(client, code);
    const moved = (await getTaskBoard(client, code))!.tasks[0]!;
    expect(moved.verifier).toBe('Other');
    expect(moved.notification).toMatchObject({ kind: 'review_requested', target: 'Other' });
  });
});

describe('explicit waits and review receipts', () => {
  it('parks owner work as a wait, notifies the unblocker once, and resumes only with a resolution', async () => {
    await createTask(client, code, { title: 'Admin page', owner: 'Owner', createdBy: 'Owner' });
    await claimTask(client, code, 'T-01', owner);
    const input = { scope: 'owner' as const, reasonCode: 'missing_credential' as const,
      reason: 'The host must log in first', resumeWhen: 'Login is complete' };
    const { task } = await waitTask(client, code, 'T-01', owner, input);
    expect(task).toMatchObject({ state: 'blocked', waiting: { scope: 'owner', reasonCode: 'missing_credential' } });
    expect(task.notification).toMatchObject({ kind: 'waiting', target: 'Host' });
    const inbox = taskInboxFor((await getTaskBoard(client, code))!, 'Owner');
    expect(inbox.current).toEqual([]);
    expect(inbox.waiting).toMatchObject([{ id: 'T-01', scope: 'owner', reason: 'The host must log in first' }]);
    await publishTaskNotifications(client, code);
    const version = (await getTaskBoard(client, code))!.version;
    await waitTask(client, code, 'T-01', owner, input); // identical repeat is a no-op
    expect((await getTaskBoard(client, code))!.version).toBe(version);
    expect(await publishTaskNotifications(client, code)).toBe(0);
    await expect(claimTask(client, code, 'T-01', owner)).rejects.toThrow(/resume/);
    await expect(submitTask(client, code, 'T-01', owner, evidence)).rejects.toThrow(/resume/);
    await expect(resumeTask(client, code, 'T-01', { name: 'Other', client: 'cc' }, 'done')).rejects.toThrow();
    await expect(resumeTask(client, code, 'T-01', owner, '  ')).rejects.toThrow();
    const resumed = await resumeTask(client, code, 'T-01', { name: 'Host', client: 'web' }, 'Logged in', Date.now(), true);
    expect(resumed.task).toMatchObject({ state: 'in_progress', waiting: { resumedBy: 'Host', resolution: 'Logged in' } });
    expect(resumed.task.notification).toMatchObject({ kind: 'work_requested', target: 'Owner' });
  });

  it('keeps a review wait in awaiting_review and blocks the verdict until it is resolved', async () => {
    await submit();
    const { task } = await waitTask(client, code, 'T-01', reviewer, { scope: 'review', reasonCode: 'missing_user_input',
      reason: 'No access to the staging URL', resumeWhen: 'The host shares access', waitingFor: 'Host' });
    expect(task).toMatchObject({ state: 'awaiting_review', verifier: 'Reviewer', evidence: { fileListing: 'report.md' } });
    expect(taskInboxFor({ tasks: [task] }, 'Reviewer')).toMatchObject({ toVerify: [], waiting: [{ id: 'T-01', scope: 'review' }] });
    await expect(verifyTask(client, code, 'T-01', reviewer, 'done', 'checked')).rejects.toThrow(/review wait/);
    await expect(waitTask(client, code, 'T-01', reviewer, { scope: 'review', reasonCode: 'other', reason: 'x', resumeWhen: 'y', waitingFor: 'Nobody' }))
      .rejects.toThrow(/not in this room/);
    const resumed = await resumeTask(client, code, 'T-01', { name: 'Host', client: 'web' }, 'Shared access', Date.now(), false);
    expect(resumed.task.state).toBe('awaiting_review');
    expect(resumed.task.notification).toMatchObject({ kind: 'review_requested', target: 'Reviewer' });
    const done = await verifyTask(client, code, 'T-01', reviewer, 'done', 'Opened the URL and walked the criteria');
    expect(done.task.state).toBe('done');
  });

  it('records review receipts for the current notice only', async () => {
    const { task } = await submit();
    await expect(acknowledgeTaskReview(client, code, 'T-01', { name: 'Other', client: 'cc' }, false)).rejects.toThrow();
    await expect(acknowledgeTaskReview(client, code, 'T-01', reviewer, false, 'superseded-id')).rejects.toThrow(/superseded/);
    const acked = await acknowledgeTaskReview(client, code, 'T-01', reviewer, false, task.notification!.id);
    expect(acked.task.reviewReceipt).toMatchObject({ by: 'Reviewer', notificationId: task.notification!.id });
    expect(acked.task.reviewReceipt?.startedAt).toBeUndefined();
    const started = await acknowledgeTaskReview(client, code, 'T-01', reviewer, true);
    expect(started.task.reviewReceipt?.startedAt).toBeTypeOf('number');
    const kinds = started.task.timeline!.map(e => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['task_created', 'review_acknowledged', 'review_started']));
    // Reassignment resets the receipt.
    const moved = await reassignTaskRoles(client, code, 'T-01', { verifier: 'Other' }, owner);
    expect(moved.task.reviewReceipt).toBeUndefined();
  });

  it('lets the host rule from the board even when an agent reviewer is designated', async () => {
    await submit();
    await expect(verifyTask(client, code, 'T-01', { name: 'Host', client: 'web' }, 'done', 'ok')).rejects.toThrow();
    const ruled = await verifyTask(client, code, 'T-01', { name: 'Host', client: 'web' }, 'done', 'ok', Date.now(), { hostOverride: true });
    expect(ruled.task).toMatchObject({ state: 'done', verdict: { by: 'Host' } });
  });
});
