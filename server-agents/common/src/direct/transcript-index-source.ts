import type { AgentTranscriptIndexerModule } from '@garcon/server-agent-interface';
import {
  parseFileIndexSource,
  probeFileIndexSource,
  createCompleteJsonlSnapshot,
  yieldBoundedMessageBatches,
} from '../search/index-source-helpers.js';
import { loadDirectCompatibleChatMessagesFromPath } from './history-loader.js';

export function createDirectTranscriptIndexerModule(
  integrationId: string,
): AgentTranscriptIndexerModule {
  return {
    integrationId,
    apiVersion: 1,
    create(host) {
      return {
        probe: (source, signal) => probeFileIndexSource(source, host.agentId, signal),
        async *load(request) {
          request.signal.throwIfAborted();
          const { nativePath } = parseFileIndexSource(request.source, host.agentId);
          const snapshot = await createCompleteJsonlSnapshot({
            nativePath,
            scratchDirectory: request.scratchDirectory,
            maxRecordBytes: request.limits.maxRecordBytes,
            signal: request.signal,
          });
          try {
            const messages = await loadDirectCompatibleChatMessagesFromPath(snapshot.path);
            yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
          } finally {
            await snapshot.remove();
          }
        },
        async close() {},
      };
    },
  };
}
