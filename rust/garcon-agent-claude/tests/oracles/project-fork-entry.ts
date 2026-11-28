import { projectClaudeForkEntry } from '../../../../server-agents/claude/src/agents/claude/fork-transcript.ts';

export function projectForkEntry(entry: unknown, retainedMessageCount: number) {
  return projectClaudeForkEntry(entry, {
    sourceAgentSessionId: 'synthetic-source',
    targetAgentSessionId: 'synthetic-target',
    retainedMessageCount,
  });
}
