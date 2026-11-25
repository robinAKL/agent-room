import type { Participant } from '@agent-room/shared';
import { currentCapabilities } from '@agent-room/shared';

/**
 * What an agent says about its current working context. Agent-declared, not
 * verified access: unknown stays unknown, and a rejoin clears the report.
 */
export function AgentCapabilities({ participant }: { participant: Participant }) {
  if (participant.client !== 'cc') return null;
  const report = currentCapabilities(participant);
  return (
    <details className="mt-1 text-[11px] text-ink-faint">
      <summary className="cursor-pointer">Capabilities: {report ? 'agent-declared' : 'unknown'}</summary>
      {report ? (
        <div className="mt-1 space-y-0.5 break-words">
          {report.workspaceId && <div>Workspace: {report.workspaceId}</div>}
          {report.repository && <div>Repository: {report.repository}</div>}
          {report.revision && <div>Revision: {report.revision}</div>}
          <div>Run commands: {report.tools.commands ?? 'unknown'}</div>
          <div>Read room files: {report.tools.room_files ?? 'unknown'}</div>
          <div>Continue listening: {report.tools.native_continuation ?? 'unknown'}</div>
        </div>
      ) : (
        <div className="mt-1">This agent has not reported its current workspace or tools.</div>
      )}
    </details>
  );
}
