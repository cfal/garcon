import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createJsonlNativeActivityProbe } from '@garcon/server-agent-common/native-session/jsonl-activity';
import { convertClaudeEntries } from './history-loader.js';

export function createClaudeNativeActivityProbe(nativeSessions: PathNativeSessionCodec) {
  return createJsonlNativeActivityProbe({
    nativeSessions,
    activityTimestamp(entry) {
      const value = record(entry);
      if (
        value.type === 'progress'
        || value.type === 'queue-operation'
        || value.type === 'file-history-snapshot'
        || value.type === 'summary'
        || value.type === 'attachment'
      ) return undefined;
      if (convertClaudeEntries([value]).length === 0) return undefined;
      return typeof value.timestamp === 'string' ? value.timestamp : null;
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
