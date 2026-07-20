import type { AgentTranscriptIndexerModule } from '@garcon/server-agent-interface';
import {
  parseFileIndexSource,
  probeFileIndexSource,
  createCompleteJsonlSnapshot,
  sourceFailure,
  yieldBoundedMessageBatches,
} from '@garcon/server-agent-common/search/index-source-helpers';
import { loadFactoryChatMessages } from './agents/factory/history-loader.js';

const moduleDefinition: AgentTranscriptIndexerModule = {
  integrationId: 'factory',
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
          let messages: Awaited<ReturnType<typeof loadFactoryChatMessages>>;
          try {
            messages = await loadFactoryChatMessages(snapshot.path, undefined, { throwOnError: true });
          } catch {
            throw sourceFailure('SOURCE_RECORD_INVALID', false);
          }
          yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
        } finally {
          await snapshot.remove();
        }
      },
      async close() {},
    };
  },
};

export default moduleDefinition;
