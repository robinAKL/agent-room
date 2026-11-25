// A busy task holder reads as Working, not Disconnected (from #809).
import { describe, expect, it } from 'vitest';
import type { Participant, TaskBoard } from '@agent-room/shared';
import { agentsWithTaskInProgress, participantPresence, WORKING_GRACE_MS } from './participantPresence.js';

const NOW = 100_000_000;
const agent = (lastSeenAgo: number, extra: Partial<Participant> = {}): Participant => ({
  name: 'Codex', role: '', color: '#000', initials: 'CO', client: 'cc', joinedAt: 0, lastSeenAt: NOW - lastSeenAgo, ...extra,
});

describe('participantPresence', () => {
  it('shows a quiet agent holding an in-progress task as Working within the grace window', () => {
    expect(participantPresence(agent(10 * 60_000), NOW, true).label).toBe('Working');
    expect(participantPresence(agent(10 * 60_000), NOW, false).label).toBe('Disconnected');
    expect(participantPresence(agent(WORKING_GRACE_MS + 1), NOW, true).label).toBe('Disconnected');
  });

  it('keeps a live listen and recent activity ahead of Working', () => {
    expect(participantPresence(agent(10 * 60_000, { listenUntil: NOW + 5000 }), NOW, true).label).toBe('Listening now');
    expect(participantPresence(agent(1000), NOW, true).label).toBe('Online');
  });

  it('never applies to people', () => {
    expect(participantPresence(agent(10 * 60_000, { client: 'web' }), NOW, true).label).toBe('Disconnected');
  });

  it('collects the owners of in-progress tasks', () => {
    const board = { code: 'C', version: 1, tasks: [
      { id: 'T-1', title: 'a', state: 'in_progress', owner: 'Codex', createdBy: 'h', createdAt: 0, updatedAt: 0 },
      { id: 'T-2', title: 'b', state: 'todo', owner: 'Claude', createdBy: 'h', createdAt: 0, updatedAt: 0 },
    ] } as TaskBoard;
    expect([...agentsWithTaskInProgress(board)]).toEqual(['codex']);
  });
});
