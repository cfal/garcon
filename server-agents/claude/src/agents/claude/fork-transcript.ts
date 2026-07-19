import type { ForkTranscriptEntryContext } from '@garcon/server-agent-common/legacy/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function rewriteClaudeForkTranscriptEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  if (!isRecord(entry)) return entry;

  const rewritten = { ...entry };
  let changed = false;
  for (const key of ['sessionId', 'session_id']) {
    if (rewritten[key] === context.sourceAgentSessionId) {
      rewritten[key] = context.targetAgentSessionId;
      changed = true;
    }
  }
  return changed ? rewritten : entry;
}
