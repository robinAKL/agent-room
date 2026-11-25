// What a Moderator needs to see on each wake to keep moderating.
//
// Observed in long moderator rooms (YRD-U8P-J3K, MMW-S4W-D8U, 2026-11): past a
// few hundred messages the moderator stopped assigning and did the work
// itself. Nothing on the server changes with message count — the moderator's
// own session had been compacted several times, and the worker agents had run
// out of quota and gone quiet, leaving nobody to assign to. Its listens only
// listed the tasks it owned, so it never saw the board it was meant to run,
// and nothing told it that the room had emptied out under it.
import { PRESENCE_DISCONNECTED_MS, type Participant, type Room, type Task, type TaskBoard } from '@agent-room/shared';

const STALE_TASK_MS = 30 * 60 * 1000;
const LIST_MAX = 4;

function list(tasks: Task[], label: (task: Task) => string): string {
  const shown = tasks.slice(0, LIST_MAX).map(label).join(', ');
  return tasks.length > LIST_MAX ? `${shown} +${tasks.length - LIST_MAX} more` : shown;
}

function short(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

/**
 * One line summarising the open board for the Moderator: unowned work to
 * assign, who is working what, reviews waiting on a ruling, blocked tasks and
 * tasks that have not moved for a while.
 */
export function moderatorBoardDigest(board: TaskBoard | null | undefined, now = Date.now()): string {
  const open = (board?.tasks ?? []).filter(t => t.state === 'todo' || t.state === 'in_progress'
    || t.state === 'awaiting_review' || t.state === 'blocked');
  if (open.length === 0) {
    return 'BOARD: no open tasks. Put new work on the board (room_task create) and assign it by name before anyone starts.';
  }
  const parts: string[] = [];
  const unowned = open.filter(t => t.state === 'todo' && !t.owner);
  if (unowned.length) parts.push(`unassigned ${unowned.length} (${list(unowned, t => `${t.id} ${short(t.title)}`)})`);
  const todo = open.filter(t => t.state === 'todo' && t.owner);
  if (todo.length) parts.push(`assigned, not started ${todo.length} (${list(todo, t => `${t.id}→${t.owner}`)})`);
  const working = open.filter(t => t.state === 'in_progress');
  if (working.length) parts.push(`in progress ${working.length} (${list(working, t => `${t.id}→${t.owner ?? '?'}`)})`);
  const review = open.filter(t => t.state === 'awaiting_review');
  if (review.length) parts.push(`awaiting review ${review.length} (${list(review, t => `${t.id} verifier ${t.verifier ?? 'any'}`)})`);
  const blocked = open.filter(t => t.state === 'blocked');
  if (blocked.length) parts.push(`blocked ${blocked.length} (${list(blocked, t => t.id)})`);
  const stale = open.filter(t => t.state !== 'blocked' && now - t.updatedAt > STALE_TASK_MS);
  if (stale.length) parts.push(`no movement for 30+ min: ${list(stale, t => t.id)}`);
  return `BOARD: ${parts.join('; ')}. Assign unowned work, chase stalled owners, and get reviews ruled — do not take tasks over yourself.`;
}

/**
 * Agents the Moderator could hand work to right now: other agent seats that
 * can speak and are live (listening, or seen within the disconnect window).
 * A seat whose agent ran out of quota stays in the participant list long after
 * it stopped answering, so being seated is not enough.
 */
export function assignableAgents(
  room: Pick<Room, 'participants'>,
  moderatorName: string,
  now = Date.now(),
): Participant[] {
  return room.participants.filter(p => p.client === 'cc'
    && p.name !== moderatorName
    && p.canSpeak !== false
    && ((p.listenUntil ?? 0) > now || now - (p.lastSeenAt ?? 0) < PRESENCE_DISCONNECTED_MS));
}

export const MODERATOR_ALONE_HINT =
  'NO ONE TO ASSIGN: no other agent is live in this room. Do not quietly take the work over — say so in the room '
  + 'and ask the host whether to wait for agents to (re)join or to have you do it yourself.';

export function moderatorAloneNotice(moderatorName: string): string {
  return `${moderatorName} is moderating, but no other agent is live in this room to take the work. `
    + `Invite agents, switch to Open mode, or tell ${moderatorName} to do it directly.`;
}
