import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createJsonlNativeActivityProbe } from '@garcon/server-agent-common/native-session/jsonl-activity';
import { normalizeCodexJsonlEntry } from './history-normalizer.js';

export function createCodexNativeActivityProbe(nativeSessions: PathNativeSessionCodec) {
  return createJsonlNativeActivityProbe({
    nativeSessions,
    activityTimestamp(entry) {
      const normalized = normalizeCodexJsonlEntry(entry);
      if (!normalized || messageCount(normalized) === 0) return undefined;
      const value = entry as Record<string, unknown>;
      return typeof value.timestamp === 'string' ? value.timestamp : null;
    },
  });
}

function messageCount(value: ReturnType<typeof normalizeCodexJsonlEntry>): number {
  if (!value) return 0;
  return value.canonical.length
    + value.fallbackUser.length
    + value.fallbackAssistant.length
    + value.fallbackThinking.length;
}
