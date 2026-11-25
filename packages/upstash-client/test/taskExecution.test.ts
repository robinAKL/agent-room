// Fenced task execution, seat proof and capability-aware assignment
// (ported from the hosted deployment's api/task-execution-capabilities.test.ts, #748).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Participant, Room } from '@agent-room/shared';
import { taskInboxFor } from '@agent-room/shared';
import {
  claimTask,
  createClient,
  createTask,
  getTaskBoard,
  joinRoom,
  operateTaskExecution,
  reactivateRoom,
  reconcileTaskReviews,
  reportAgentCapabilities,
  sanitizeCapabilityReport,
  submitTask,
  verifyTask,
  waitTask,
  resumeTask,
  TaskExecutionError,
  type UpstashClient,
} from '../src/index.js';
import { installFakeRedis } from './fakeRedis.js';

const code = 'ABC-DEF-GHK';
const evidence = { fileListing: 'out.txt', fileExcerpt: 'ok', checks: 'Ran the check by hand.' };
let client: UpstashClient;
const keys: Record<string, string> = {};

function seat(name: string, clientKind: 'cc' | 'web' = 'cc'): Participant {
  return { name, client: clientKind, role: '', initials: name.slice(0, 2), color: '#000', joinedAt: Date.now(), lastSeenAt: Date.now() };
}
async function join(name: string, seatKey?: string) {
  const joined = await joinRoom(client, code, seat(name), { priorIdentity: { name, client: 'cc' }, ...(seatKey ? { seatKey } : {}) });
  keys[name] = joined.seatKey!;
  return joined;
}
const as = (name: string) => ({ name, client: 'cc' as const });
const errorCode = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e instanceof TaskExecutionError ? e.code : String(e));

beforeEach(async () => {
  installFakeRedis();
  client = createClient({ url: 'https://example.upstash.io', token: 't' });
  const room: Room = { code, topic: 'Execution', createdBy: 'Host', createdAt: Date.now() - 1000, status: 'active', version: 1,
    replyMode: 'open', participants: [{ ...seat('Host', 'web'), joinedAt: 0 }] };
  await client.command(['SET', `room:${code}`, JSON.stringify(room)]);
  for (const name of ['Alpha', 'Beta', 'Gamma']) await join(name);
  await createTask(client, code, { title: 'Build it', owner: 'Alpha', createdBy: 'Host' });
});

describe('seat keys', () => {
  it('issues a key per agent seat, keeps it on a matching rejoin and rotates it otherwise', async () => {
    const first = keys.Alpha!;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const again = await join('Alpha', first);
    expect(again.seatKey).toBe(first);
    const seatId = again.participant.seatId;
    const takeover = await join('Alpha');
    expect(takeover.seatKey).not.toBe(first);
    expect(takeover.participant.seatId).not.toBe(seatId);
    // Caller-supplied identity fields are discarded.
    const forged = await joinRoom(client, code, { ...seat('Beta'), seatKeyHash: 'x', seatId: 'forged' } as Participant,
      { priorIdentity: { name: 'Beta', client: 'cc' }, seatKey: keys.Beta });
    expect(forged.participant.seatId).not.toBe('forged');
  });
});

describe('fenced execution', () => {
  it('requires seat proof to claim and an attempt token to submit', async () => {
    expect(await errorCode(claimTask(client, code, 'T-01', as('Alpha'), Date.now(), {}))).toBe('identity_required');
    expect(await errorCode(claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Beta }))).toBe('identity_required');
    const { task } = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    expect(task).toMatchObject({ state: 'in_progress', owner: 'Alpha', lease: { status: 'active' }, execution: { recoveryRequired: false } });
    const attemptId = task.execution!.attemptId;
    // Repeating the claim from the same seat is idempotent.
    const again = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    expect(again.task.execution!.attemptId).toBe(attemptId);
    expect(await errorCode(submitTask(client, code, 'T-01', as('Alpha'), evidence))).toBe('identity_required');
    expect(await errorCode(submitTask(client, code, 'T-01', as('Alpha'), evidence, Date.now(), { seatKey: keys.Alpha, attemptId: 'attempt-old' }))).toBe('stale_attempt');
    const submitted = await submitTask(client, code, 'T-01', as('Alpha'), evidence, Date.now(), { seatKey: keys.Alpha, attemptId });
    expect(submitted.task).toMatchObject({ state: 'awaiting_review', submittedAttemptId: attemptId, verifier: 'Beta' });
    expect(submitted.task.attempts![0]).toMatchObject({ status: 'submitted', endReason: 'submitted_for_review' });
  });

  it('fences a process whose seat was taken over, and recovers with a resolution', async () => {
    const { task } = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    const oldKey = keys.Alpha!;
    await join('Alpha'); // a new process without the key takes the seat
    const board = (await reconcileTaskReviews(client, code))!;
    expect(board.tasks[0]!.attempts![0]).toMatchObject({ status: 'interrupted', endReason: 'holder_removed' });
    expect(taskInboxFor(board, 'Alpha').toRecover).toEqual(['T-01']);
    expect(await errorCode(submitTask(client, code, 'T-01', as('Alpha'), evidence, Date.now(), { seatKey: oldKey, attemptId: task.execution!.attemptId }))).toBe('identity_required');
    expect(await errorCode(operateTaskExecution(client, code, 'T-01', as('Alpha'), 'recover', { seatKey: keys.Alpha }))).toBe('resolution_required');
    const recovered = await operateTaskExecution(client, code, 'T-01', as('Alpha'), 'recover', { seatKey: keys.Alpha },
      { resolution: 'Read the prior attempt; continuing the missing checks' });
    expect(recovered.task.attempts).toHaveLength(2);
    expect(recovered.task.attempts![1]).toMatchObject({ status: 'running', recoveryNote: 'Read the prior attempt; continuing the missing checks' });
    expect(recovered.task.execution!.attemptId).not.toBe(task.execution!.attemptId);
  });

  it('renews, releases and hands off only with the current attempt', async () => {
    const { task } = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha, ttlMs: 1000 });
    const attemptId = task.execution!.attemptId;
    expect(await errorCode(operateTaskExecution(client, code, 'T-01', as('Beta'), 'renew', { seatKey: keys.Beta, attemptId }))).toBe('lease_not_active');
    const renewed = await operateTaskExecution(client, code, 'T-01', as('Alpha'), 'renew', { seatKey: keys.Alpha, attemptId, ttlMs: 60_000 });
    expect(renewed.task.lease!.expiresAt).toBeGreaterThan(task.lease!.expiresAt);
    expect(await errorCode(operateTaskExecution(client, code, 'T-01', as('Beta'), 'recover', { seatKey: keys.Beta }, { resolution: 'x' }))).toBe('lease_held');
    const handed = await operateTaskExecution(client, code, 'T-01', as('Alpha'), 'handoff', { seatKey: keys.Alpha, attemptId }, { to: 'Gamma' });
    expect(handed.task).toMatchObject({ owner: 'Gamma', lease: { holderName: 'Gamma' } });
    expect(handed.task.attempts![0]).toMatchObject({ status: 'interrupted', endReason: 'handed_off' });
    expect(await errorCode(submitTask(client, code, 'T-01', as('Alpha'), evidence, Date.now(), { seatKey: keys.Alpha, attemptId }))).not.toBe('resolved');
    const released = await operateTaskExecution(client, code, 'T-01', as('Gamma'), 'release',
      { seatKey: keys.Gamma, attemptId: handed.task.execution!.attemptId });
    expect(released.task).toMatchObject({ state: 'in_progress', execution: { recoveryRequired: true }, lease: { status: 'released' } });
  });

  it('records an expired lease as interruption, not failure', async () => {
    await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha, ttlMs: 1 });
    await new Promise(r => setTimeout(r, 5));
    const board = (await reconcileTaskReviews(client, code))!;
    const t = board.tasks[0]!;
    expect(t.state).toBe('in_progress');
    expect(t.attempts![0]).toMatchObject({ status: 'interrupted', endReason: 'lease_expired' });
    expect(t.notification).toMatchObject({ kind: 'work_requested', target: 'Alpha' });
  });

  it('fences the previous session when the room is reopened', async () => {
    const { task } = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    await reactivateRoom(client, code);
    expect(await errorCode(submitTask(client, code, 'T-01', as('Alpha'), evidence, Date.now(),
      { seatKey: keys.Alpha, attemptId: task.execution!.attemptId }))).toBe('lease_not_active');
  });

  it('moves an owner wait off execution and needs recovery after resume', async () => {
    const { task } = await claimTask(client, code, 'T-01', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    const proof = { seatKey: keys.Alpha, attemptId: task.execution!.attemptId };
    const waited = await waitTask(client, code, 'T-01', as('Alpha'), { scope: 'owner', reasonCode: 'missing_user_input',
      reason: 'Need the API spec', resumeWhen: 'Spec posted' }, Date.now(), false, proof);
    expect(waited.task.attempts![0]).toMatchObject({ status: 'waiting' });
    const resumed = await resumeTask(client, code, 'T-01', as('Alpha'), 'Spec posted in chat', Date.now(), false, proof);
    expect(resumed.task.state).toBe('in_progress');
    expect(taskInboxFor(resumed.board, 'Alpha').toRecover).toEqual(['T-01']);
  });
});

describe('capability-aware assignment', () => {
  it('blocks a claim and an automatic review until matching capabilities are reported', async () => {
    await createTask(client, code, { title: 'Repo work', owner: 'Alpha', createdBy: 'Host', requirements: {
      owner: { repository: 'org/repo', tools: ['commands'] }, review: { repository: 'org/repo' } } });
    expect(await errorCode(claimTask(client, code, 'T-02', as('Alpha'), Date.now(), { seatKey: keys.Alpha }))).toBe('capability_required');
    await expect(reportAgentCapabilities(client, code, 'Alpha', { repository: 'org/repo' }, keys.Beta, sanitizeCapabilityReport)).rejects.toThrow();
    await reportAgentCapabilities(client, code, 'Alpha', { repository: 'org/repo', tools: { commands: 'yes' } }, keys.Alpha, sanitizeCapabilityReport);
    const { task } = await claimTask(client, code, 'T-02', as('Alpha'), Date.now(), { seatKey: keys.Alpha });
    const submitted = await submitTask(client, code, 'T-02', as('Alpha'), evidence, Date.now(), { seatKey: keys.Alpha, attemptId: task.execution!.attemptId });
    // Nobody else declared org/repo: no reviewer is assigned yet.
    expect(submitted.task).toMatchObject({ reviewStatus: 'waiting_for_verifier' });
    await reportAgentCapabilities(client, code, 'Gamma', { repository: 'org/repo' }, keys.Gamma, sanitizeCapabilityReport);
    const board = (await reconcileTaskReviews(client, code))!;
    expect(board.tasks[1]).toMatchObject({ verifier: 'Gamma', reviewStatus: 'assigned' });
    expect(await errorCode(verifyTask(client, code, 'T-02', as('Gamma'), 'done', 'checked'))).toBe('identity_required');
    const done = await verifyTask(client, code, 'T-02', as('Gamma'), 'done', 'Re-ran it in org/repo', Date.now(), { reviewerProof: { seatKey: keys.Gamma } });
    expect(done.task.state).toBe('done');
  });

  it('clears a capability report when the seat rejoins', async () => {
    await reportAgentCapabilities(client, code, 'Beta', { workspaceId: 'w-1' }, keys.Beta, sanitizeCapabilityReport);
    const rejoined = await join('Beta', keys.Beta);
    expect(rejoined.participant.capabilities).toBeUndefined();
  });
});

describe('legacy tasks', () => {
  it('keeps name-only claim and submit for tasks that never started a fenced execution', async () => {
    await claimTask(client, code, 'T-01', as('Alpha'));
    const { task } = await submitTask(client, code, 'T-01', as('Alpha'), evidence);
    expect(task.state).toBe('awaiting_review');
    expect((await getTaskBoard(client, code))!.tasks[0]!.execution).toBeUndefined();
  });
});
