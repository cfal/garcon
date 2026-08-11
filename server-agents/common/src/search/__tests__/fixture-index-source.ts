import { parseChatMessages } from '@garcon/common/chat-types';
import type {
  AgentTranscriptIndexEntryV4,
  AgentTranscriptIndexerModuleV4,
} from '@garcon/server-agent-interface';

const fixtureModule: AgentTranscriptIndexerModuleV4 = {
  integrationId: 'fixture',
  apiVersion: 2,
  create() {
    return {
      async open(request) {
        request.signal.throwIfAborted();
        const messages = parseChatMessages(request.source.value.messages);
        const entries = messages.map((message, index): AgentTranscriptIndexEntryV4 => ({
          ordinal: index + 1,
          entry: {
            id: `fixture-entry-${index + 1}` as AgentTranscriptIndexEntryV4['entry']['id'],
            lifetime: 'durable',
            source: {
              namespace: 'fixture',
              itemId: `item-${index + 1}`,
              subrowId: 'message',
            },
            provenance: null,
            message,
          },
        }));
        const checkpoint = request.source.checkpoint;
        if (request.previous
            && request.previous.contentEpoch === checkpoint.contentEpoch
            && request.previous.durableCount === checkpoint.durableCount
            && request.previous.durableRevision === checkpoint.durableRevision) {
          return { kind: 'unchanged' as const, checkpoint };
        }
        if (request.previous
            && request.previous.contentEpoch === checkpoint.contentEpoch
            && request.previous.durableCount <= checkpoint.durableCount) {
          return {
            kind: 'append' as const,
            previous: request.previous,
            checkpoint,
            batches: batches(entries.slice(request.previous.durableCount), request.maxEntriesPerBatch),
          };
        }
        return {
          kind: 'snapshot' as const,
          checkpoint,
          batches: batches(entries, request.maxEntriesPerBatch),
        };
      },
      async close() {},
    };
  },
};

async function* batches(
  entries: readonly AgentTranscriptIndexEntryV4[],
  limit: number,
): AsyncIterable<readonly AgentTranscriptIndexEntryV4[]> {
  for (let index = 0; index < entries.length; index += limit) {
    yield entries.slice(index, index + limit);
  }
}

export default fixtureModule;
