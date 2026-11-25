import { describe, expect, it } from 'vitest';
import type { Task, TaskState } from '@agent-room/shared';
import { canRuleOn, executionSummary, partitionTasks, taskReviewLabel } from './TaskBoard.js';

function task(id: string, state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: `task ${id}`,
    state,
    createdBy: 'Robin',
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('partitionTasks', () => {
  it('puts what needs a ruling first and drops closed states into the archive', () => {
    const { open, closed } = partitionTasks([
      task('T-01', 'todo'),
      task('T-02', 'done', { updatedAt: 10 }),
      task('T-03', 'awaiting_review'),
      task('T-04', 'in_progress'),
      task('T-05', 'blocked'),
      task('T-06', 'cancelled', { updatedAt: 30 }),
      task('T-07', 'rejected', { updatedAt: 20 }),
    ]);

    expect(open.map(t => t.id)).toEqual(['T-03', 'T-05', 'T-04', 'T-01']);
    // Closed is newest-first so the most recent ruling is at the top.
    expect(closed.map(t => t.id)).toEqual(['T-06', 'T-07', 'T-02']);
  });

  it('breaks ties within a state by id so the list does not reshuffle between polls', () => {
    const { open } = partitionTasks([task('T-09', 'todo'), task('T-02', 'todo'), task('T-05', 'todo')]);
    expect(open.map(t => t.id)).toEqual(['T-02', 'T-05', 'T-09']);
  });
});

describe('canRuleOn', () => {
  const web = { name: 'Robin', client: 'web' as const };

  it('allows a non-owner peer when no verifier is designated', () => {
    expect(canRuleOn(task('T-01', 'awaiting_review', { owner: 'Claude' }), web, false)).toBe(true);
  });

  it('never lets the owner rule on their own delivery', () => {
    expect(canRuleOn(task('T-01', 'awaiting_review', { owner: 'Robin' }), web, false)).toBe(false);
  });

  it('locks ruling to the designated verifier', () => {
    const t = task('T-01', 'awaiting_review', { owner: 'Claude', verifier: 'Codex' });
    expect(canRuleOn(t, { name: 'Codex', client: 'web' }, false)).toBe(true);
    expect(canRuleOn(t, web, false)).toBe(false);
  });

  it('only rules on submitted work, and never in an ended room', () => {
    for (const state of ['todo', 'in_progress', 'blocked', 'done', 'rejected', 'cancelled'] as TaskState[]) {
      expect(canRuleOn(task('T-01', state, { owner: 'Claude' }), web, false)).toBe(false);
    }
    expect(canRuleOn(task('T-01', 'awaiting_review', { owner: 'Claude' }), web, true)).toBe(false);
  });

  // A room can hold both "Robin - web" (the host) and "Robin - cc" (an agent).
  // Matching on name alone hid Approve from the host whenever an agent shared
  // their display name, even though the server would have accepted the ruling.
  it('separates same-name participants by client, as the server does', () => {
    const ownedByAgentRobin = task('T-01', 'awaiting_review', { owner: 'Robin', ownerClient: 'cc' });
    expect(canRuleOn(ownedByAgentRobin, web, false)).toBe(true);
    expect(canRuleOn(ownedByAgentRobin, { name: 'Robin', client: 'cc' }, false)).toBe(false);
  });

  it('treats an unrecorded owner client as a match, failing closed', () => {
    expect(canRuleOn(task('T-01', 'awaiting_review', { owner: 'Robin' }), web, false)).toBe(false);
  });

  it('lets a designated verifier rule only from the recorded client', () => {
    const t = task('T-01', 'awaiting_review', { owner: 'Claude', verifier: 'Robin', verifierClient: 'cc' });
    expect(canRuleOn(t, web, false)).toBe(false);
    expect(canRuleOn(t, { name: 'Robin', client: 'cc' }, false)).toBe(true);
  });
});

describe('review and execution lines', () => {
  const web = { name: 'Robin', client: 'web' as const };

  it('lets the host rule over a designated agent reviewer, but never on an open review wait', () => {
    const t = task('T-01', 'awaiting_review', { owner: 'Claude', verifier: 'Codex', verifierClient: 'cc' });
    expect(canRuleOn(t, web, false)).toBe(false);
    expect(canRuleOn(t, web, false, true)).toBe(true);
    const waiting = { ...t, waiting: { scope: 'review' as const, reasonCode: 'missing_credential' as const, reason: 'no access',
      resumeWhen: 'access granted', by: 'Codex', byClient: 'cc' as const, at: 1 } };
    expect(canRuleOn(waiting, web, false, true)).toBe(false);
  });

  it('explains missing or offline reviewers and names who actually ruled', () => {
    expect(taskReviewLabel(task('T-1', 'awaiting_review'))).toBe('Waiting for an independent reviewer');
    expect(taskReviewLabel(task('T-1', 'todo'))).toBe('Assigned on submission');
    expect(taskReviewLabel(task('T-1', 'awaiting_review', { verifier: 'Codex', reviewStatus: 'verifier_offline' }))).toContain('offline');
    expect(taskReviewLabel(task('T-1', 'done', { verdict: { by: 'Actual Reviewer', byClient: 'cc', verdict: 'done', at: 1 } })))
      .toBe('Verified by @Actual Reviewer');
  });

  it('summarises the current fenced execution', () => {
    const base = { execution: { attemptId: 'a2', recoveryRequired: false },
      attempts: [
        { id: 'a1', leaseId: 'l1', memberId: 'm', name: 'Codex', client: 'cc' as const, status: 'interrupted' as const, startedAt: 1, confirmedAt: 1 },
        { id: 'a2', leaseId: 'l2', memberId: 'm', name: 'Codex', client: 'cc' as const, status: 'running' as const, startedAt: 2, confirmedAt: 2 },
      ],
      lease: { id: 'l2', holderId: 'm', holderName: 'Codex', holderClient: 'cc' as const, status: 'active' as const, grantedAt: 2, expiresAt: 10_000 } };
    expect(executionSummary(task('T-1', 'in_progress', base), 5_000)).toBe('Executing · @Codex · attempt 2');
    expect(executionSummary(task('T-1', 'in_progress', { ...base, execution: { attemptId: 'a2', recoveryRequired: true },
      attempts: [{ ...base.attempts[1]!, status: 'interrupted', endReason: 'lease_expired' }] }), 20_000)).toBe('Execution lease expired · needs recovery');
    expect(executionSummary(task('T-1', 'todo'))).toBeNull();
  });
});
