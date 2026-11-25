// Review assignment, responsibility notifications and execution reconciliation,
// applied inside every task-board CAS so assignment, audit and notification
// intent commit together (ported from the hosted deployment's #747/#748).
//
// Open-source adaptation: a human seated in the room may still be named as a
// task's reviewer and rule from the board UI. Automatic selection only picks
// agents, and never the host or the owner.
import type { Participant, Room, Task, TaskBoard } from '@agent-room/shared';
import { TASK_REVIEW_TIMEOUT_MS, capabilityGaps, currentCapabilities, participantMemberId, sessionStartedAt } from '@agent-room/shared';
import { isParticipantStale } from './rooms.js';
import { currentAttempt, finishTaskAttempt, reconcileTaskExecution } from './taskExecution.js';

const same = (a?: string, b?: string) => !!a?.trim() && !!b?.trim()
  && a.trim().toLowerCase() === b.trim().toLowerCase();

export type TaskRoster = Pick<Room, 'participants' | 'createdBy' | 'modeConfig'>
  & Partial<Pick<Room, 'status' | 'endedAt' | 'createdAt' | 'reactivatedAt'>>;

/** Deterministic independent reviewer selection, shared by submission and recovery. */
export function pickTaskReviewer(room: TaskRoster, board: TaskBoard, task: Task, now: number, excludeCurrent = false): Participant | undefined {
  const load = (name: string) => board.tasks.filter(t => t.state === 'awaiting_review' && same(t.verifier, name)).length;
  return room.participants.filter(p => p.client === 'cc' && p.canSpeak !== false
    && !same(p.name, room.createdBy) && !same(p.name, task.owner)
    && (!excludeCurrent || !same(p.name, task.verifier)) && !isParticipantStale(p, now)
    && capabilityGaps(task.requirements?.review, currentCapabilities(p)).length === 0)
    .sort((a, b) => load(a.name) - load(b.name) || a.joinedAt - b.joinedAt || a.name.localeCompare(b.name))[0];
}

/** Run inside the board CAS: assignments, audit and notification intent commit together. */
export function applyTaskPolicy(board: TaskBoard, previous: TaskBoard, room: TaskRoster | null, now: number): TaskBoard {
  if (room?.endedAt || (room?.status && room.status !== 'active')) {
    const tasks = board.tasks.map(task => currentAttempt(task)?.status === 'running'
      ? finishTaskAttempt(task, 'interrupted', 'room_closed', room.endedAt ?? now) : task);
    return tasks.some((t, i) => t !== board.tasks[i]) ? { ...board, tasks } : board;
  }
  const session = room && typeof room.createdAt === 'number' ? sessionStartedAt(room as Pick<Room, 'createdAt' | 'reactivatedAt'>) : undefined;
  let changed = false;
  const tasks: Task[] = [];
  for (const original of board.tasks) {
    const old = previous.tasks.find(t => t.id === original.id);
    let task = reconcileTaskExecution(original, old, now, session);
    const attempt = currentAttempt(task);
    if (room && attempt?.status === 'running' && !room.participants.some(p => p.client === 'cc' && participantMemberId(p) === attempt.memberId)) {
      task = finishTaskAttempt(task, 'interrupted', 'holder_removed', now);
    }
    if (task.waiting && task.waiting.resumedAt === undefined
      && (task.waiting.scope === 'owner' ? task.state !== 'blocked' : task.state !== 'awaiting_review')) {
      task = { ...task, waiting: { ...task.waiting, resumedAt: now, resumedBy: 'system', resumedClient: 'cc', resolution: 'Task state changed' } };
    }
    if (task.waiting && task.waiting.resumedAt === undefined && task.waiting.scope === 'review'
      && old && !same(old.verifier, task.verifier)) {
      task = { ...task, waiting: { ...task.waiting, resumedAt: now, resolution: 'Review reassigned' } };
    }
    if (task.state === 'awaiting_review') {
      const seat = room?.participants.find(p => p.canSpeak !== false
        && same(p.name, task.verifier) && !same(p.name, task.owner));
      const valid = room ? !!seat : !!task.verifier?.trim() && !same(task.verifier, task.owner);
      const gaps = seat?.client === 'cc' ? capabilityGaps(task.requirements?.review, currentCapabilities(seat)) : [];
      if (seat && (task.verifier !== seat.name || task.verifierClient !== seat.client)) {
        task = { ...task, verifier: seat.name, verifierClient: seat.client };
      }
      const startedAt = task.reviewReceipt?.startedAt ?? 0;
      const offline = !!seat && isParticipantStale(seat, now) && (!startedAt || now - startedAt > TASK_REVIEW_TIMEOUT_MS);
      const overdue = now - Math.max(task.reviewRequestedAt ?? task.updatedAt, startedAt) > TASK_REVIEW_TIMEOUT_MS;
      const replace = !valid || gaps.length > 0 || (offline && overdue && (!task.waiting || task.waiting.resumedAt !== undefined));
      const replacement = room && replace ? pickTaskReviewer(room, { ...board, tasks: [...tasks, ...board.tasks.slice(tasks.length)] }, task, now) : undefined;
      if (replacement || !valid) {
        const verifier = replacement?.name;
        if (task.verifier !== verifier || task.verifierClient !== replacement?.client) {
          task = { ...task, verifier, verifierClient: replacement?.client, reviewRequestedAt: now,
            roleHistory: [...(task.roleHistory ?? []), { by: 'system', byClient: 'cc', at: now,
              field: 'verifier', from: task.verifier, to: verifier }],
            ...(task.waiting?.scope === 'review' ? { waiting: { ...task.waiting, resumedAt: now } } : {}) };
        }
      }
      const chosen = room?.participants.find(p => same(p.name, task.verifier));
      const remaining = chosen?.client === 'cc' || !chosen ? capabilityGaps(task.requirements?.review, currentCapabilities(chosen)) : [];
      const status = task.verifier && remaining.length > 0 ? 'waiting_for_capability' : !task.verifier ? 'waiting_for_verifier'
        : (same(task.verifier, seat?.name) && offline ? 'verifier_offline' : 'assigned');
      const readiness = task.verifier && remaining.length ? remaining.join('; ') : undefined;
      if (task.reviewReadiness !== readiness) task = { ...task, reviewReadiness: readiness };
      if (task.reviewStatus !== status) task = { ...task, reviewStatus: status };
    }
    const waiting = task.waiting && task.waiting.resumedAt === undefined;
    let kind: 'review_requested' | 'work_requested' | 'waiting' | undefined;
    let target: string | undefined;
    let targetClient = task.ownerClient;
    if (waiting && (!old?.waiting || old.waiting.resumedAt !== undefined || task.waiting!.at !== old.waiting.at
      || task.waiting!.scope !== old.waiting.scope || task.waiting!.reason !== old.waiting.reason
      || task.waiting!.reasonCode !== old.waiting.reasonCode || task.waiting!.resumeWhen !== old.waiting.resumeWhen
      || task.waiting!.waitingFor !== old.waiting.waitingFor)) {
      kind = 'waiting'; target = task.waiting!.waitingFor ?? room?.createdBy;
      targetClient = room?.participants.find(p => same(p.name, target))?.client;
    } else if (!waiting && task.state === 'awaiting_review' && task.verifier && task.reviewStatus === 'assigned'
      && (old?.state !== 'awaiting_review' || !same(old.verifier, task.verifier) || old.verifierClient !== task.verifierClient
        || old.reviewStatus === 'waiting_for_capability' || old.reviewRequestedAt !== task.reviewRequestedAt || (old.waiting && old.waiting.resumedAt === undefined))) {
      kind = 'review_requested'; target = task.verifier; targetClient = task.verifierClient;
    } else if (!waiting && !task.execution?.decisionRequired && task.owner && ((old?.state === 'awaiting_review' && ['in_progress', 'rejected'].includes(task.state))
      || (old?.state === 'blocked' && task.state === 'in_progress') || (old && old.owner !== task.owner && task.state === 'in_progress')
      || (task.execution?.recoveryRequired && !old?.execution?.recoveryRequired && task.state === 'in_progress'))) {
      kind = 'work_requested'; target = task.owner;
    }
    if (kind && target) {
      task = { ...task, notification: {
        id: `${board.code}:${task.id}:${previous.version + 1}:${kind}`, kind, target, targetClient, at: now,
      }, ...(kind === 'review_requested' ? { reviewReceipt: undefined } : {}) };
    } else if (task.notification && task.notification.deliveredAt === undefined) {
      const notice = task.notification;
      const current = notice.kind === 'review_requested' ? task.state === 'awaiting_review' && task.reviewStatus !== 'waiting_for_capability' && !waiting && same(task.verifier, notice.target)
        : notice.kind === 'work_requested' ? ['in_progress', 'rejected'].includes(task.state) && !task.execution?.decisionRequired && !waiting && same(task.owner, notice.target)
          : !!waiting;
      if (!current) task = { ...task, notification: undefined };
    }
    if (task !== original) changed = true;
    tasks.push(task);
  }
  return changed ? { ...board, tasks } : board;
}
