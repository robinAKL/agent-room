import { describe, expect, it } from 'vitest';
import type { Task, TaskBoard } from '@agent-room/shared';
import { pendingAgentStarts } from './pendingAgentStarts.js';

const review: Task = {
  id: 'T-08', title: 'Review changes', state: 'awaiting_review', owner: 'Cursor', verifier: 'Codex',
  createdBy: 'Host', createdAt: 1, updatedAt: 2,
  notification: { id: 'review-current', kind: 'review_requested', target: 'Codex', at: 2, deliveredAt: 3 },
};
const board = (...tasks: Task[]): TaskBoard => ({ code: 'AAA-BBB-CCC', version: 1, tasks });

describe('pendingAgentStarts', () => {
  it('counts delivered and acknowledged reviews until their current assignment actually starts', () => {
    const receipt = { by: 'Codex', byClient: 'cc' as const, notificationId: 'review-current', readAt: 4 };
    expect(pendingAgentStarts(board({ ...review, reviewReceipt: receipt }), 'Codex')).toBe('1 review');
    expect(pendingAgentStarts(board({ ...review, reviewReceipt: { ...receipt, startedAt: 5 } }), 'Codex')).toBeNull();
    expect(pendingAgentStarts(board({
      ...review, reviewReceipt: { ...receipt, notificationId: 'review-old', startedAt: 5 },
    }), 'Codex')).toBe('1 review');
  });

  it('counts queued assignments without treating blocked reviews or active work as unstarted', () => {
    const queued = { ...review, id: 'T-09', state: 'todo' as const, owner: 'Codex', verifier: 'Cursor' };
    expect(pendingAgentStarts(board(review, queued), 'Codex')).toBe('1 task and 1 review');
    expect(pendingAgentStarts(board(
      { ...review, reviewStatus: 'waiting_for_capability' },
      { ...queued, state: 'in_progress' },
    ), 'Codex')).toBeNull();
  });
});
