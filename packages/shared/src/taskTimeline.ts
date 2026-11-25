import type { Task, TaskTimelineEvent, TaskTimelineKind } from './types.js';

export const TASK_TIMELINE_LIMIT = 200;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const text = (value?: string) => value?.slice(0, 1000);

/** Only called inside the corresponding board CAS / notification transaction. */
export function appendTaskTimeline(task: Task, event: TaskTimelineEvent): Task {
  if (task.timeline?.some(row => row.id === event.id)) return task;
  const rows = [...(task.timeline ?? []), { ...event, detail: text(event.detail), reason: text(event.reason) }];
  const removed = Math.max(0, rows.length - TASK_TIMELINE_LIMIT);
  return { ...task, timeline: rows.slice(-TASK_TIMELINE_LIMIT),
    ...(removed ? { timelineDropped: (task.timelineDropped ?? 0) + removed } : {}) };
}

/** Derive events from accepted state transitions, never from polling or chat guesses. */
export function recordTaskTimeline(previous: Task | undefined, next: Task, version: number, recordedAt: number): Task {
  const events: TaskTimelineEvent[] = [];
  const add = (kind: TaskTimelineKind, at: number, fields: Partial<TaskTimelineEvent> = {}) => {
    events.push({ id: `${next.id}:${version}:${events.length}:${kind}`, kind, at, recordedAt,
      boardVersion: version, source: 'server', ...fields });
  };
  if (!previous) add('task_created', next.createdAt, { actor: next.createdBy });
  for (const [field, kind] of [['owner', 'owner_assigned'], ['verifier', 'reviewer_assigned']] as const) {
    if (next[field] !== previous?.[field]) {
      const change = next.roleHistory?.slice(previous?.roleHistory?.length ?? 0).find(row => row.field === field);
      add(kind, change?.at ?? next.updatedAt, { actor: change?.by, from: previous?.[field], to: next[field] });
    }
  }
  if (previous && next.state !== previous.state) add('state_changed', next.updatedAt, { from: previous.state, to: next.state });
  if (previous && (next.dod !== previous.dod || !same(next.requirements, previous.requirements))) {
    add('scope_changed', next.updatedAt);
  }
  for (const attempt of next.attempts ?? []) {
    const old = previous?.attempts?.find(row => row.id === attempt.id);
    // Do not invent old attempt history when a legacy task first acquires a timeline.
    if (!old) add('execution_started', attempt.startedAt, { actor: attempt.name, attemptId: attempt.id,
      detail: attempt.recoveryNote, reason: attempt.recoveryNote ? 'recovered' : undefined });
    if (attempt.status !== 'running' && old?.status === 'running') add('execution_ended', attempt.endedAt ?? recordedAt,
      { actor: attempt.name, attemptId: attempt.id, reason: attempt.endReason ?? 'unknown', to: attempt.status });
    if (old && attempt.confirmedAt !== old.confirmedAt) add('execution_renewed', attempt.confirmedAt,
      { actor: attempt.name, attemptId: attempt.id });
  }
  const wait = next.waiting;
  if (wait && (!previous?.waiting || !same({ ...wait, resumedAt: undefined, resumedBy: undefined, resumedClient: undefined, resolution: undefined },
    { ...previous.waiting, resumedAt: undefined, resumedBy: undefined, resumedClient: undefined, resolution: undefined }))) {
    add('waiting', wait.at, { source: 'participant_report', actor: wait.by, scope: wait.scope,
      target: wait.waitingFor, reason: wait.reasonCode, detail: `${wait.reason}\nResume when: ${wait.resumeWhen}` });
  } else if (!wait && next.blocked && !same(next.blocked, previous?.blocked)) {
    add('waiting', next.blocked.at, { source: 'participant_report', actor: next.blocked.by, scope: 'owner', detail: next.blocked.reason });
  }
  if (wait?.resumedAt !== undefined && wait.resumedAt !== previous?.waiting?.resumedAt) {
    add('resumed', wait.resumedAt, { source: wait.resumedBy === 'system' ? 'server' : 'participant_report',
      actor: wait.resumedBy, scope: wait.scope, detail: wait.resolution });
  }
  if (next.state === 'awaiting_review' && (next.reviewStatus !== previous?.reviewStatus || next.reviewReadiness !== previous?.reviewReadiness)) {
    add('review_readiness', recordedAt, { to: next.reviewStatus, detail: next.reviewReadiness });
  }
  if (next.notification && next.notification.id !== previous?.notification?.id) {
    add('notification_created', next.notification.at, { target: next.notification.target,
      notificationId: next.notification.id, reason: next.notification.kind });
  }
  if (previous?.notification && previous.notification.id !== next.notification?.id && previous.notification.deliveredAt === undefined) {
    add('notification_superseded', recordedAt, { target: previous.notification.target,
      notificationId: previous.notification.id, detail: 'Pending notification replaced or withdrawn before publication.' });
  }
  const receipt = next.reviewReceipt;
  const oldReceipt = previous?.reviewReceipt;
  if (receipt) {
    const fresh = !oldReceipt || receipt.notificationId !== oldReceipt.notificationId || receipt.by !== oldReceipt.by;
    if (fresh || receipt.readAt !== oldReceipt.readAt) add('review_acknowledged', receipt.readAt,
      { source: 'participant_report', actor: receipt.by, notificationId: receipt.notificationId });
    if (receipt.startedAt !== undefined && (fresh || receipt.startedAt !== oldReceipt.startedAt)) add('review_started', receipt.startedAt,
      { source: 'participant_report', actor: receipt.by, notificationId: receipt.notificationId });
  }
  if (next.verdict && !same(next.verdict, previous?.verdict)) add('review_verdict', next.verdict.at,
    { source: 'participant_report', actor: next.verdict.by, to: next.verdict.verdict, detail: next.verdict.note,
      attemptId: next.submittedAttemptId });
  if (!events.length) return next;
  let task = next;
  if (previous && !previous.timeline?.length && !previous.timelineDropped) {
    task = appendTaskTimeline(task, { id: `${next.id}:${version}:history`, kind: 'history_started', at: recordedAt,
      recordedAt, boardVersion: version, source: 'server', detail: 'Earlier task activity was not recorded.' });
  }
  for (const event of events) task = appendTaskTimeline(task, event);
  return task;
}

export function recordTaskNotificationPublished(task: Task, version: number, at: number): Task {
  const notice = task.notification;
  if (!notice) return task;
  if (!task.timeline?.length && !task.timelineDropped) task = appendTaskTimeline(task, {
    id: `${task.id}:${version}:history`, kind: 'history_started', at, recordedAt: at, boardVersion: version,
    source: 'server', detail: 'Earlier task activity was not recorded.',
  });
  return appendTaskTimeline(task, { id: `${notice.id}:published`, kind: 'notification_published', at, recordedAt: at,
    boardVersion: version, source: 'server', target: notice.target, notificationId: notice.id,
    detail: 'Published to the room. Client receipt is not confirmed.' });
}
