// Ported from the hosted deployment's api/task-timeline.test.ts (#749).
import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Room, Task, TaskBoard } from '@agent-room/shared';
import { appendTaskTimeline, TASK_TIMELINE_LIMIT } from '@agent-room/shared';
import { acknowledgeTaskReview, claimTask, createClient, createTask, getTaskBoard, operateTaskExecution,
  publishTaskNotifications, reconcileTaskReviews, reassignTaskRoles, resumeTask, submitTask, updateTask, verifyTask, waitTask,
  type UpstashClient } from '../src/index.js';
import { installFakeRedis, type FakeRedis } from './fakeRedis.js';

const code = 'ABC-DEF-GHM';
const owner = { name: 'Owner', client: 'cc' as const };
const reviewer = { name: 'Reviewer', client: 'cc' as const };
const key = (name: string) => `private-timeline-${name}`;
const proof = (name: string, attemptId?: string) => ({ seatKey: key(name), attemptId });
const evidence = { fileListing: 'result.md', fileExcerpt: '# Result', checks: 'Independently repeatable checks' };
let client: UpstashClient;
let fake: FakeRedis;
let room: Room;
const board = async () => (await getTaskBoard(client, code))!;
const task = async () => (await board()).tasks[0]!;
const kinds = (value: Task) => value.timeline!.map(event => event.kind);
const start = async () => {
  await createTask(client, code, { title: 'Trace work', owner: owner.name, verifier: reviewer.name, createdBy: owner.name });
  return claimTask(client, code, 'T-01', owner, Date.now(), proof(owner.name));
};

beforeEach(async () => {
  fake = installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
  const now = Date.now();
  room = { code, topic: 'Timeline', createdBy: 'Host', createdAt: now, status: 'active', version: 1,
    participants: ['Host', 'Owner', 'Reviewer', 'Other'].map((name, index) => ({ name, client: index ? 'cc' : 'web',
      role: '', color: '#000', initials: 'AG', joinedAt: now + index, lastSeenAt: now, canSpeak: true,
      seatId: name, seatKeyHash: createHash('sha256').update(key(name)).digest('hex') })) } as Room;
  await client.command(['SET', `room:${code}`, JSON.stringify(room)]);
});

describe('durable task activity', () => {
  it('separates publication, participant acknowledgement, review start and verdict across reloads', async () => {
    const claimed = (await start()).task;
    const submitted = (await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId))).task;
    expect(kinds(submitted)).toEqual(expect.arrayContaining(['task_created', 'owner_assigned', 'reviewer_assigned',
      'execution_started', 'execution_ended', 'state_changed', 'notification_created']));
    expect(kinds(submitted)).not.toContain('notification_published');
    await publishTaskNotifications(client, code);
    const published = await task();
    expect(published.timeline!.filter(row => row.kind === 'notification_published')).toMatchObject([{ target: 'Reviewer', source: 'server' }]);
    expect(kinds(published)).not.toContain('review_acknowledged');
    await acknowledgeTaskReview(client, code, 'T-01', reviewer, false, published.notification!.id, Date.now(), proof(reviewer.name));
    await acknowledgeTaskReview(client, code, 'T-01', reviewer, true, published.notification!.id, Date.now(), proof(reviewer.name));
    await verifyTask(client, code, 'T-01', reviewer, 'done', 'Checked the artifact', Date.now(), { reviewerProof: proof(reviewer.name) });
    const final = await task();
    expect(final.timeline!.filter(row => row.kind === 'review_acknowledged')).toMatchObject([{ source: 'participant_report', actor: 'Reviewer' }]);
    expect(kinds(final).filter(kind => kind === 'review_started')).toHaveLength(1);
    expect(final.timeline!.find(row => row.kind === 'review_verdict')).toMatchObject({ to: 'done', attemptId: claimed.execution!.attemptId });
    expect(final.timeline!.slice(0, submitted.timeline!.length)).toEqual(submitted.timeline);
    expect(JSON.stringify(final.timeline)).not.toContain(key(owner.name));
    expect(JSON.stringify(final.timeline)).not.toContain('seatKeyHash');
  });

  it('does not add events or board writes for repeated claims, acknowledgements and maintenance polls', async () => {
    const first = await start();
    await Promise.all([1, 2, 3].map(() => claimTask(client, code, 'T-01', owner, Date.now(), proof(owner.name))));
    await reconcileTaskReviews(client, code);
    await updateTask(client, code, 'T-01', { title: first.task.title });
    expect(await board()).toEqual(first.board);
    await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, first.task.execution!.attemptId));
    const notice = (await task()).notification!;
    await acknowledgeTaskReview(client, code, 'T-01', reviewer, true, notice.id, Date.now(), proof(reviewer.name));
    const acknowledged = await board();
    await acknowledgeTaskReview(client, code, 'T-01', reviewer, true, notice.id, Date.now(), proof(reviewer.name));
    expect(await board()).toEqual(acknowledged);
  });

  it('keeps exactly one published event and message when publishers race', async () => {
    const { task: claimed } = await start();
    await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId));
    await Promise.all([publishTaskNotifications(client, code), publishTaskNotifications(client, code)]);
    expect(kinds(await task()).filter(kind => kind === 'notification_published')).toHaveLength(1);
    expect(await client.command(['LLEN', `room-msgs:${code}`])).toBe(1);
  });

  it('does not claim publication when the append transaction fails', async () => {
    const { task: claimed } = await start();
    await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId));
    const before = await board();
    fake.failOnce(command => String(command[1]).startsWith('-- task-notification'));
    await expect(publishTaskNotifications(client, code)).rejects.toThrow();
    expect(await board()).toEqual(before);
    await publishTaskNotifications(client, code);
    expect(kinds(await task()).filter(kind => kind === 'notification_published')).toHaveLength(1);
  });

  it('records superseded notifications and never publishes the previous reviewer assignment', async () => {
    const { task: claimed } = await start();
    const submitted = (await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId))).task;
    const noticeId = submitted.notification!.id;
    await reassignTaskRoles(client, code, 'T-01', { verifier: 'Other', verifierClient: 'cc' }, { name: 'Host', client: 'web' });
    await publishTaskNotifications(client, code);
    const final = await task();
    expect(final.timeline!.find(row => row.kind === 'notification_superseded')).toMatchObject({ notificationId: noticeId, target: 'Reviewer' });
    expect(final.timeline!.filter(row => row.kind === 'notification_published')).toMatchObject([{ target: 'Other' }]);
  });

  it('records reported waits and resolutions without attributing an IDE stop', async () => {
    const { task: claimed } = await start();
    await waitTask(client, code, 'T-01', owner, { scope: 'owner', reasonCode: 'missing_user_input', reason: 'Need screenshot',
      resumeWhen: 'Screenshot inspected', waitingFor: 'Host' }, Date.now(), false, proof(owner.name, claimed.execution!.attemptId));
    await resumeTask(client, code, 'T-01', owner, 'Screenshot inspected', Date.now(), false, proof(owner.name));
    const recovered = (await operateTaskExecution(client, code, 'T-01', owner, 'recover', proof(owner.name), { resolution: 'Continue retained work' })).task;
    expect(recovered.timeline!.find(row => row.kind === 'waiting')).toMatchObject({ source: 'participant_report', reason: 'missing_user_input', target: 'Host' });
    expect(recovered.timeline!.find(row => row.kind === 'resumed')).toMatchObject({ source: 'participant_report', detail: 'Screenshot inspected' });
    expect(recovered.timeline!.filter(row => row.kind === 'execution_started')).toHaveLength(2);
    expect(recovered.timeline!.find(row => row.kind === 'execution_ended')).toMatchObject({ reason: 'waiting_for_input' });
  });

  it('preserves the actual expiry time and separately records when maintenance observed it', async () => {
    await start();
    const expired = await board(); const deadline = Date.now() - 5000;
    expired.tasks[0]!.lease!.expiresAt = deadline;
    await client.command(['SET', `task-board:${code}`, JSON.stringify(expired)]);
    await reconcileTaskReviews(client, code);
    const event = (await task()).timeline!.find(row => row.kind === 'execution_ended')!;
    expect(event).toMatchObject({ at: deadline, reason: 'lease_expired', source: 'server' });
    expect(event.recordedAt).toBeGreaterThan(event.at);
    const after = await board();
    await reconcileTaskReviews(client, code);
    expect(await board()).toEqual(after);
  });

  it('keeps handoff history and never records a rejected stale submission as a state change', async () => {
    const { task: claimed } = await start();
    await operateTaskExecution(client, code, 'T-01', owner, 'handoff', proof(owner.name, claimed.execution!.attemptId), { to: 'Other' });
    const before = await board();
    await expect(submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId))).rejects.toThrow();
    expect(await board()).toEqual(before);
    expect(before.tasks[0]!.timeline!.find(row => row.kind === 'execution_ended')).toMatchObject({ reason: 'handed_off' });
    expect(before.tasks[0]!.timeline!.filter(row => row.kind === 'execution_started')).toHaveLength(2);
  });

  it('starts legacy recording honestly without reconstructing historical actions', async () => {
    const legacy: Task = { id: 'T-01', title: 'Legacy', state: 'in_progress', owner: 'Owner', ownerClient: 'cc',
      createdBy: 'Owner', createdAt: 1, updatedAt: 1 };
    await client.command(['SET', `task-board:${code}`, JSON.stringify({ code, tasks: [legacy], version: 10 } satisfies TaskBoard)]);
    await reconcileTaskReviews(client, code);
    expect((await task()).timeline).toBeUndefined();
    await updateTask(client, code, 'T-01', { dod: 'New acceptance criteria' });
    expect(kinds(await task())).toEqual(['history_started', 'scope_changed']);
    expect((await task()).timeline![0]!.at).toBeGreaterThan(legacy.createdAt);
  });

  it('bounds retained history and keeps an explicit count instead of silently losing events', async () => {
    let value = (await start()).task;
    const event = { id: 'sample', kind: 'execution_renewed' as const, at: 1, recordedAt: 1, boardVersion: 1, source: 'server' as const };
    const originalLength = value.timeline!.length;
    for (let index = 0; index < TASK_TIMELINE_LIMIT + 3; index++) value = appendTaskTimeline(value, { ...event, id: `renew-${index}` });
    expect(value.timeline).toHaveLength(TASK_TIMELINE_LIMIT);
    expect(value.timelineDropped).toBe(originalLength + 3);
    expect(appendTaskTimeline(value, value.timeline![0]!)).toBe(value);
  });

  it('renewal and timeline publication leave room lifetime, speech and progress clocks unchanged', async () => {
    const { task: claimed, board: startedBoard } = await start();
    const roomRaw = await client.command(['GET', `room:${code}`]);
    await operateTaskExecution(client, code, 'T-01', owner, 'renew', proof(owner.name, claimed.execution!.attemptId), {}, Date.now() + 1);
    expect((await board()).lastProgressAt).toBe(startedBoard.lastProgressAt);
    expect(kinds(await task())).toContain('execution_renewed');
    await submitTask(client, code, 'T-01', owner, evidence, Date.now(), proof(owner.name, claimed.execution!.attemptId));
    const progressAt = (await board()).lastProgressAt;
    await publishTaskNotifications(client, code);
    expect((await board()).lastProgressAt).toBe(progressAt);
    expect(await client.command(['GET', `room:${code}`])).toBe(roomRaw);
  });
});
