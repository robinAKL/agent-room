import { buildAgentResumePrompt, type Participant } from '@agent-room/shared';

/**
 * The prompt a host pastes back into an agent's own client after it stopped
 * listening — its session restarted, the network dropped, or it ended its turn
 * with a report. It keeps the same seat and resumes from the last cursor.
 * Only for agent seats that are not listening right now (from #810).
 */
export function resumePromptFor(
  participant: Pick<Participant, 'name' | 'client'>,
  presenceKind: string,
  code: string,
  origin: string,
): string | undefined {
  if (participant.client !== 'cc' || !code) return undefined;
  if (presenceKind !== 'disconnected' && presenceKind !== 'idle') return undefined;
  return buildAgentResumePrompt(`${origin}/j/${code}`, participant.name);
}
