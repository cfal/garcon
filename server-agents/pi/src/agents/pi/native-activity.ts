import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createJsonlNativeActivityProbe } from '@garcon/server-agent-common/native-session/jsonl-activity';
import { convertPiMessage } from './message-converter.js';

export function createPiNativeActivityProbe(nativeSessions: PathNativeSessionCodec) {
  return createJsonlNativeActivityProbe({
    nativeSessions,
    activityTimestamp(entry) {
      const value = record(entry);
      if (value.type !== 'message' || convertPiMessage(value.message).length === 0) {
        return undefined;
      }
      return typeof value.timestamp === 'string' ? value.timestamp : null;
    },
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
