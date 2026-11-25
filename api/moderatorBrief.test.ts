import { describe, expect, it } from 'vitest';
import type { Room, Task, TaskBoard } from '@agent-room/shared';
import { assignableAgents, moderatorAloneNotice, moderatorBoardDigest } from './_moderatorBrief.js';

const NOW = 10_000_000;

function task(id: string, state: Task['state'], extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, state, createdAt: NOW - 1000, updatedAt: NOW - 1000, ...extra } as Task;
}

function board(tasks: Task[]): TaskBoard {
  return { code: 'ABC-DEF-GHJ', tasks, version: 1 } as TaskBoard;
}

describe('moderatorBoardDigest', () => {
  it('tells the moderator to put work on the board when nothing is open', () => {
    expect(moderatorBoardDigest(board([task('T-01', 'done')]), NOW)).toMatch(/^BOARD: no open tasks/);
    expect(moderatorBoardDigest(null, NOW)).toMatch(/^BOARD: no open tasks/);
  });

  it('lists unowned work, who is on what, reviews, blocked and stalled tasks', () => {
    const text = moderatorBoardDigest(board([
      task('T-01', 'todo'),
      task('T-02', 'todo', { owner: 'Codex' }),
      task('T-03', 'in_progress', { owner: 'Grok', updatedAt: NOW - 45 * 60 * 1000 }),
      task('T-04', 'awaiting_review', { owner: 'Codex', verifier: 'Claude (2)' }),
      task('T-05', 'blocked', { owner: 'Grok' }),
      task('T-06', 'done'),
    ]), NOW);
    expect(text).toContain('unassigned 1 (T-01 Task T-01)');
    expect(text).toContain('assigned, not started 1 (T-02→Codex)');
    expect(text).toContain('in progress 1 (T-03→Grok)');
    expect(text).toContain('awaiting review 1 (T-04 verifier Claude (2))');
    expect(text).toContain('blocked 1 (T-05)');
    expect(text).toContain('no movement for 30+ min: T-03');
    expect(text).not.toContain('T-06');
    expect(text).toContain('do not take tasks over yourself');
  });

  it('stays short on a big board', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => task(`T-${i + 1}`, 'todo', { title: 'x'.repeat(200) }));
    const text = moderatorBoardDigest(board(tasks), NOW);
    expect(text).toContain('+26 more');
    expect(text.length).toBeLessThan(500);
  });
});

describe('assignableAgents', () => {
  const seat = (name: string, extra: Record<string, unknown> = {}) =>
    ({ name, client: 'cc', role: '', color: '', initials: 'XX', joinedAt: 0, lastSeenAt: NOW - 1000, ...extra });

  it('counts only other live agent seats that can speak', () => {
    const room = { participants: [
      seat('Claude'),                                            // the moderator
      seat('Codex'),                                             // live
      seat('Grok', { lastSeenAt: NOW - 10 * 60 * 1000 }),       // quota ran out, seat left behind
      seat('Cursor', { lastSeenAt: 0, listenUntil: NOW + 30_000 }), // holding a listen
      seat('Muted', { canSpeak: false }),
      { ...seat('Robin'), client: 'web' },
    ] } as unknown as Room;
    expect(assignableAgents(room, 'Claude', NOW).map(p => p.name)).toEqual(['Codex', 'Cursor']);
  });

  it('is empty when every worker has gone quiet', () => {
    const room = { participants: [seat('Claude'), seat('Codex', { lastSeenAt: NOW - 60 * 60 * 1000 })] } as unknown as Room;
    expect(assignableAgents(room, 'Claude', NOW)).toEqual([]);
    expect(moderatorAloneNotice('Claude')).toContain('no other agent is live');
  });
});
