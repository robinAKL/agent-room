import { PRESENCE_DISCONNECTED_MS, PRESENCE_STALE_MS, type Participant, type TaskBoard } from '@agent-room/shared';

// An agent that owns an in-progress task is expected to go quiet while it
// works: it codes between listens, and long builds or test runs take a while.
// Within this window that silence reads as working, not as Disconnected
// (from the hosted deployment's #809).
export const WORKING_GRACE_MS = 30 * 60 * 1000;

/** Names (lower-cased) of agents that own an in-progress task on the board. */
export function agentsWithTaskInProgress(board: TaskBoard | null | undefined): Set<string> {
  return new Set((board?.tasks ?? [])
    .filter(t => t.state === 'in_progress' && t.owner)
    .map(t => t.owner!.toLowerCase()));
}

export function participantPresence(p: Participant, now: number, holdsTask = false) {
  // Not listening, but holding a task and heard from within the grace window:
  // it is out doing the work. Past the window it falls through to the usual
  // labels and is reported as Disconnected like any other silent seat.
  const lastSeen = typeof p.lastSeenAt === 'number' && Number.isFinite(p.lastSeenAt) ? p.lastSeenAt : 0;
  const listening = typeof p.listenUntil === 'number' && p.listenUntil > now;
  if (p.client === 'cc' && holdsTask && !listening && now - lastSeen > PRESENCE_STALE_MS && now - lastSeen <= WORKING_GRACE_MS) {
    return {
      kind: 'online' as const,
      label: 'Working',
      detail: '',
      className: 'text-amber-700',
      dotClassName: 'bg-amber-500',
    };
  }

  if (listening) {
    return {
      kind: 'listening' as const,
      label: 'Listening now',
      detail: '',
      className: 'text-emerald-700',
      dotClassName: 'bg-emerald-500',
    };
  }

  if (now - lastSeen <= PRESENCE_STALE_MS) {
    return {
      kind: 'online' as const,
      label: 'Online',
      detail: '',
      className: 'text-blue-700',
      dotClassName: 'bg-blue-500',
    };
  }

  // Past 5 minutes silent → almost certainly disconnected. Most common cause:
  // a CLI agent (Cursor / Claude Code / Codex) was terminated by the user
  // without calling room_leave, so the participant row stays in the room
  // forever. The "Disconnected" label is a hint to the host that this
  // participant is unlikely to come back, paired with the always-visible
  // kick button so they can clean up in one click.
  if (now - lastSeen > PRESENCE_DISCONNECTED_MS) {
    return {
      kind: 'disconnected' as const,
      label: 'Disconnected',
      detail: p.client === 'cc' ? 'host can remove' : '',
      className: 'text-ink-faint',
      dotClassName: 'bg-slate-400',
    };
  }

  return {
    kind: 'idle' as const,
    label: 'Idle',
    detail: p.client === 'cc' ? 'not listening' : '',
    className: 'text-ink-faint',
    dotClassName: 'bg-slate-300',
  };
}
