import { isRecord } from './json.js';

export const AGENT_START_PROGRESS_PHASES = [
  'preparing-context', 'compacting-context', 'starting-agent', 'started', 'failed', 'interrupted',
] as const;

export type AgentStartProgressPhase = typeof AGENT_START_PROGRESS_PHASES[number];

export interface AgentStartProgressNoticeDetail {
  readonly type: 'agent-start-progress';
  readonly phase: AgentStartProgressPhase;
}

export const AGENT_START_PROGRESS_CONTENT = {
  'preparing-context': 'Context preparation started.',
  'compacting-context': 'Compacting inherited context.',
  'starting-agent': 'Context ready; starting agent.',
  started: 'Agent started.',
  failed: 'Agent startup failed. The chat and task have been retained.',
  interrupted: 'Agent startup was interrupted.',
} satisfies Record<AgentStartProgressPhase, string>;

export function parseAgentStartProgressNotice(value: unknown): AgentStartProgressNoticeDetail | null {
  if (!isRecord(value) || value.type !== 'agent-start-progress'
    || Object.keys(value).some((key) => key !== 'type' && key !== 'phase')) return null;
  const phase = AGENT_START_PROGRESS_PHASES.find((phase) => phase === value.phase);
  return phase ? { type: 'agent-start-progress', phase } : null;
}
