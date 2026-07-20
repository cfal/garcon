import type { ForkTranscriptEntryContext } from '@garcon/server-agent-common/forking/fork-jsonl';
import { isRecord } from '@garcon/common/json';
import { normalizeCodexJsonlEntry } from './history-normalizer.js';

export function rewriteCodexForkTranscriptEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  const retainedMessageCount = context.retainedMessageCount;
  if (retainedMessageCount !== undefined) {
    const normalized = normalizeCodexJsonlEntry(entry);
    const emittedCount = normalized
      ? normalized.canonical.length
        + normalized.fallbackUser.length
        + normalized.fallbackAssistant.length
        + normalized.fallbackThinking.length
      : 0;
    if (emittedCount > retainedMessageCount) {
      if (retainedMessageCount === 0) return { type: 'garcon_fork_filtered' };
      if (
        retainedMessageCount === 1
        && entry.type === 'response_item'
        && isRecord(entry.payload)
        && entry.payload.type === 'web_search_call'
      ) {
        return {
          ...entry,
          payload: { ...entry.payload, status: 'in_progress' },
        };
      }
      throw new Error('Codex fork cutoff cannot preserve the selected provider entry prefix');
    }
  }

  if (entry.type !== 'session_meta' || !isRecord(entry.payload)) return entry;

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
