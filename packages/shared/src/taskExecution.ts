// Fenced task execution and agent-declared capabilities: the pieces both the
// storage layer (upstash-client) and readers (inbox, web board) need.
//
// Ported from the hosted deployment (commercial #748). The open-source build
// has no server-derived seat origin, so the private seatKey returned by
// room_join is the only seat proof — see docs/oss-protocol-parity.md.
import type { AgentCapability, AgentCapabilityReport, Participant, Room, TaskCapabilityRequirements, TaskLease, TaskRequirements } from './types.js';

export const DEFAULT_TASK_LEASE_TTL_MS = 15 * 60 * 1000;
export const MAX_TASK_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

/** A reopened room is a new session; executions from the old one are fenced. */
export function sessionStartedAt(room: Pick<Room, 'createdAt' | 'reactivatedAt'>): number {
  return room.reactivatedAt ?? room.createdAt;
}

export function taskLeaseTtl(value?: number): number {
  const ttl = value ?? DEFAULT_TASK_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_TASK_LEASE_TTL_MS) throw new Error('Task lease TTL must be between 1 ms and 24 hours.');
  return ttl;
}

export function activeTaskLease(lease: TaskLease | undefined, now: number): boolean {
  return !!lease && lease.status === 'active' && lease.expiresAt > now;
}

export function capabilityGaps(requirements?: TaskCapabilityRequirements, report?: AgentCapabilityReport): string[] {
  if (!requirements) return [];
  const gaps: string[] = [];
  for (const key of ['workspaceId', 'repository', 'revision'] as const) {
    const expected = requirements[key];
    if (expected && report?.[key] !== expected) gaps.push(`${key}: needs ${expected}; ${report?.[key] ? `declared ${report[key]}` : 'unknown'}`);
  }
  for (const tool of requirements.tools ?? []) {
    if (report?.tools[tool] !== 'yes') gaps.push(`${tool}: ${report?.tools[tool] ?? 'unknown'}`);
  }
  return gaps;
}

export function participantMemberId(participant: Participant): string | undefined {
  return participant.seatId ? `seat:${participant.seatId}`
    : participant.seatKeyHash ? `seat:key:${participant.seatKeyHash}` : undefined;
}

/** The seat's report, only while it is still bound to the current seat identity. */
export function currentCapabilities(participant?: Participant): AgentCapabilityReport | undefined {
  const report = participant?.capabilities;
  return participant && report?.source === 'agent_report' && report.memberId === participantMemberId(participant) ? report : undefined;
}

export function normalizeTaskRequirements(input: unknown): TaskRequirements | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Task requirements must be an object.');
  if (Object.keys(input).some(key => !['owner', 'review'].includes(key))) throw new Error('Unknown task requirement role.');
  const result: TaskRequirements = {};
  for (const role of ['owner', 'review'] as const) {
    const raw = (input as Record<string, unknown>)[role];
    if (raw === undefined) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Invalid ${role} requirements.`);
    const data = raw as Record<string, unknown>;
    if (Object.keys(data).some(key => !['workspaceId', 'repository', 'revision', 'tools'].includes(key))) throw new Error('Unknown task capability requirement.');
    const req: TaskCapabilityRequirements = {};
    for (const key of ['workspaceId', 'repository', 'revision'] as const) {
      const value = data[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new Error(`Invalid required ${key}.`);
      req[key] = value.trim();
    }
    if (data.tools !== undefined) {
      if (!Array.isArray(data.tools) || data.tools.some(t => !['commands', 'room_files', 'native_continuation'].includes(t))) throw new Error('Unknown required tool capability.');
      req.tools = [...new Set(data.tools as AgentCapability[])].sort();
    }
    if (Object.keys(req).length) result[role] = req;
  }
  return Object.keys(result).length ? result : undefined;
}
