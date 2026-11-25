import { useState } from 'react';
import type { Task, TaskTimelineEvent, TaskTimelineKind } from '@agent-room/shared';

const LABELS: Record<TaskTimelineKind, string> = {
  history_started: 'Activity recording started', task_created: 'Task created', owner_assigned: 'Owner assigned',
  reviewer_assigned: 'Reviewer assigned', state_changed: 'Task state changed', scope_changed: 'Requirements changed',
  execution_started: 'Execution assigned', execution_renewed: 'Execution renewed', execution_ended: 'Execution ended',
  waiting: 'Waiting declared', resumed: 'Wait resolved', review_readiness: 'Review availability changed',
  notification_created: 'Notification queued', notification_published: 'Notification published to room',
  notification_superseded: 'Pending notification replaced or withdrawn',
  review_acknowledged: 'Reviewer acknowledged', review_started: 'Reviewer reported starting', review_verdict: 'Review verdict',
};

const readable = (value: string) => value.replaceAll('_', ' ');
const when = (at: number) => new Date(at).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function taskEventLabel(event: TaskTimelineEvent): string {
  return LABELS[event.kind] ?? 'Task activity';
}

export function TaskTimeline({ tasks, filterable = false }: { tasks: Task[]; filterable?: boolean }) {
  const [selected, setSelected] = useState('all');
  const [limit, setLimit] = useState(50);
  const selectedTasks = selected === 'all' ? tasks : tasks.filter(task => task.id === selected);
  const rows = selectedTasks.flatMap(task => (task.timeline ?? []).map((event, index) => ({ task, event, index })) )
    .sort((a, b) => b.event.boardVersion - a.event.boardVersion || b.event.recordedAt - a.event.recordedAt
      || b.index - a.index || a.task.id.localeCompare(b.task.id));
  const dropped = selectedTasks.reduce((sum, task) => sum + (task.timelineDropped ?? 0), 0);
  return <div className="min-w-0 space-y-2 text-[10px] leading-relaxed text-ink-soft">
    {filterable && <label className="flex items-center gap-2">
      <span>Task</span>
      <select aria-label="Filter activity by task" className="min-w-0 flex-1 rounded border border-border bg-white px-1.5 py-1"
        value={selected} onChange={event => { setSelected(event.target.value); setLimit(50); }}>
        <option value="all">All tasks</option>
        {tasks.map(task => <option key={task.id} value={task.id}>{task.id} · {task.title}</option>)}
      </select>
    </label>}
    <p className="text-ink-faint">Newest first · times are local. Publication does not confirm receipt.
      {' '}External IDE activity and stop reasons are unknown unless reported.</p>
    {dropped > 0 && <p className="text-amber-800">{dropped} older events are no longer retained.</p>}
    {selectedTasks.some(task => !task.timeline?.length) && <p className="text-ink-faint">
      Some tasks have no recorded activity. Earlier activity is not reconstructed.
    </p>}
    {!rows.length ? <p className="rounded border border-dashed border-border-faint p-2">No activity recorded yet.</p>
      : <ol aria-label="Task activity timeline" className="max-h-96 space-y-2 overflow-y-auto overscroll-contain pr-1">
        {rows.slice(0, limit).map(({ task, event }) => <li key={`${task.id}:${event.id}`}
          className="break-words rounded border border-border-faint bg-surface-softer px-2 py-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-[9px] text-ink-faint">
            <time dateTime={new Date(event.at).toISOString()}>{when(event.at)}</time>
            <span>{event.source === 'participant_report' ? 'Participant report' : 'Server event'}</span>
          </div>
          <div className="font-semibold text-ink">{filterable && `${task.id} · `}{taskEventLabel(event)}</div>
          {filterable && <div className="text-ink-faint">{task.title}</div>}
          {(event.actor || event.target) && <div>{event.actor ? `@${event.actor}` : ''}{event.target ? ` → @${event.target}` : ''}</div>}
          {(event.from !== undefined || event.to !== undefined) && <div>
            {event.from !== undefined ? `${readable(event.from)} → ` : ''}{event.to !== undefined ? readable(event.to) : 'unassigned'}
          </div>}
          {event.scope && <div>{event.scope === 'review' ? 'Review' : 'Owner'} wait</div>}
          {event.reason && <div>{readable(event.reason)}</div>}
          {event.detail && <p className="whitespace-pre-wrap">{event.detail}</p>}
          {event.kind === 'execution_started' && <p className="text-ink-faint">Task execution granted; IDE work is not observed.</p>}
          {event.recordedAt - event.at > 1000 && <div className="text-[9px] text-ink-faint">Recorded {when(event.recordedAt)}</div>}
        </li>)}
      </ol>}
    {rows.length > limit && <button type="button" className="rounded border border-border px-2 py-1 font-semibold"
      onClick={() => setLimit(count => count + 50)}>Show older events ({rows.length - limit})</button>}
  </div>;
}
