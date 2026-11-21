import { isAgentRunFailureCertainty, type AgentRunEndedEvent } from '@garcon/server-agent-interface';
import { parseCommandOutcome, parseCommandWorkingDirectory } from '../../../common/command-output.js';
import type { TranscriptCommitEvent } from './contracts.js';
import { projectFinalResponse } from './final-response.js';

type TerminalEvidence = Pick<Extract<TranscriptCommitEvent, { type: 'run-ended' }>,
  'finalResponse' | 'workingDirectory' | 'commandOutcome' | 'failureCertainty'>;

export function projectProviderTerminal(event: AgentRunEndedEvent): TerminalEvidence {
  const certainty = event.outcome === 'failed' && event.error?.code !== 'OUTCOME_UNKNOWN'
    ? event.failureCertainty : undefined;
  return {
    finalResponse: event.outcome === 'finished' ? projectFinalResponse(event.finalResponse) : null,
    workingDirectory: parseCommandWorkingDirectory(event.workingDirectory) ?? undefined,
    commandOutcome: parseCommandOutcome(event.commandOutcome) ?? undefined,
    failureCertainty: event.outcome === 'failed' ? (isAgentRunFailureCertainty(certainty) ? certainty : 'unknown') : undefined,
  };
}
