import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createJsonlNativeActivityProbe } from '@garcon/server-agent-common/native-session/jsonl-activity';
import { factoryStoredEventActivityTimestamp } from './history-loader.js';

export function createFactoryNativeActivityProbe(nativeSessions: PathNativeSessionCodec) {
  return createJsonlNativeActivityProbe({
    nativeSessions,
    activityTimestamp: factoryStoredEventActivityTimestamp,
  });
}
