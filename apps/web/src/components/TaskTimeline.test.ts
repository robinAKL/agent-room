import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Task, TaskTimelineEvent } from '@agent-room/shared';
import { TaskTimeline } from './TaskTimeline.js';

const base = { at: 1000, recordedAt: 1000, boardVersion: 1, source: 'server' as const };
const task = (timeline?: TaskTimelineEvent[]): Task => ({ id: 'T-01', title: 'Inspect result', state: 'awaiting_review',
  owner: 'Owner', createdBy: 'Host', createdAt: 1, updatedAt: 1, timeline });
const render = (tasks: Task[]) => renderToStaticMarkup(createElement(TaskTimeline, { tasks, filterable: true }));

describe('task activity timeline', () => {
  it('distinguishes publication from client confirmation and explains unobservable IDE stops', () => {
    const html = render([task([{ ...base, id: 'published', kind: 'notification_published', target: 'Reviewer' },
      { ...base, id: 'ack', kind: 'review_acknowledged', source: 'participant_report', actor: 'Reviewer' }])]);
    expect(html).toContain('Notification published to room');
    expect(html).toContain('Reviewer acknowledged');
    expect(html).toContain('Participant report');
    expect(html).toContain('Publication does not confirm receipt');
    expect(html).toContain('stop reasons are unknown unless reported');
    expect(html).toContain('Filter activity by task');
  });

  it('shows newest committed events first, retaining expiry time and delayed observation separately', () => {
    const html = render([task([{ ...base, id: 'first', kind: 'execution_started' },
      { ...base, id: 'expired', kind: 'execution_ended', at: 100, recordedAt: 5000, boardVersion: 2, reason: 'lease_expired' }])]);
    expect(html.indexOf('Execution ended')).toBeLessThan(html.indexOf('Execution assigned'));
    expect(html).toContain('lease expired');
    expect(html).toContain('Recorded');
    expect(html).toMatch(/datetime=/i);
    expect(html).toContain('IDE work is not observed');
  });

  it('explains absent and trimmed history and escapes participant text', () => {
    const html = render([{ ...task([{ ...base, id: 'wait', kind: 'waiting', detail: '<script>bad()</script>' }]), timelineDropped: 8 },
      { ...task(), id: 'T-02' }]);
    expect(html).toContain('8 older events');
    expect(html).toContain('Earlier activity is not reconstructed');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(render([task()])).toContain('No activity recorded yet');
  });
});
