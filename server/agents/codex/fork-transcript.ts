import type { ForkTranscriptEntryContext } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function rewriteCodexForkTranscriptEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  if (!isRecord(entry) || entry.type !== 'session_meta' || !isRecord(entry.payload)) {
    return entry;
  }

  const payload = { ...entry.payload };
  let changed = false;
  for (const key of ['id', 'session_id']) {
    if (payload[key] === context.sourceAgentSessionId) {
      payload[key] = context.targetAgentSessionId;
      changed = true;
    }
  }
  if (!changed) return entry;

  return {
    ...entry,
    payload,
  };
}
