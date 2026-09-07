import type { AgentNativeActivityProbe } from '@garcon/server-agent-interface';
import type { PathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import type { AgentLogger } from '@garcon/server-agent-interface';
import {
  fetchOpenCodeStoredMessages,
  latestOpenCodeStoredActivityAt,
  type OpenCodeClientGetter,
} from './history-loader.js';

const TAIL_MESSAGE_LIMIT = 20;

export interface OpenCodeNativeActivityOptions {
  readonly nativeSessions: PathNativeSessionCodec;
  readonly withClient: <T>(operation: (getClient: OpenCodeClientGetter) => Promise<T>) => Promise<T>;
  readonly logger: AgentLogger;
}

export function createOpenCodeNativeActivityProbe(
  options: OpenCodeNativeActivityOptions,
): AgentNativeActivityProbe {
  return {
    async lastActivity(ref, signal) {
      signal.throwIfAborted();
      let agentSessionId: string | null;
      try {
        agentSessionId = options.nativeSessions.decode(ref).agentSessionId;
      } catch {
        return { kind: 'unavailable' };
      }
      if (!agentSessionId) return { kind: 'unavailable' };
      try {
        const lastEntryAt = await options.withClient(async (getClient) => {
          const messages = await fetchOpenCodeStoredMessages(agentSessionId, getClient, {
            signal,
            logger: options.logger,
            throwOnError: true,
            limit: TAIL_MESSAGE_LIMIT,
          });
          return latestOpenCodeStoredActivityAt(messages);
        });
        return lastEntryAt
          ? { kind: 'ready', value: { lastEntryAt } }
          : { kind: 'unavailable' };
      } catch {
        signal.throwIfAborted();
        return { kind: 'unavailable' };
      }
    },
  };
}
