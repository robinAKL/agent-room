import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Participant } from '@agent-room/shared';
import { AgentCapabilities } from './AgentCapabilities.js';

describe('capability provenance', () => {
  const participant = { name: 'Agent', client: 'cc', seatId: 'seat-1' } as Participant;
  it('shows unknown for missing or stale reports', () => {
    const html = renderToStaticMarkup(createElement(AgentCapabilities, { participant }));
    expect(html).toContain('Capabilities: unknown');
    const stale = { ...participant, capabilities: { source: 'agent_report', memberId: 'seat:other', reportedAt: 1, tools: { commands: 'yes' } } } as Participant;
    expect(renderToStaticMarkup(createElement(AgentCapabilities, { participant: stale }))).toContain('Capabilities: unknown');
  });
  it('labels reports as agent-declared and leaves unreported tools unknown', () => {
    const declared = { ...participant, capabilities: { source: 'agent_report', memberId: 'seat:seat-1', reportedAt: 1, workspaceId: 'work-A', tools: { commands: 'yes' } } } as Participant;
    const html = renderToStaticMarkup(createElement(AgentCapabilities, { participant: declared }));
    expect(html).toContain('agent-declared'); expect(html).toContain('work-A');
    expect(html).toContain('Read room files: unknown'); expect(html).not.toContain('verified');
  });
});
