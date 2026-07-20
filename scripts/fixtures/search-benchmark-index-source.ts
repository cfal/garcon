import { UserMessage } from '@garcon/common/chat-types';
import type { AgentTranscriptIndexerModule } from '@garcon/server-agent-interface';

const timestamp = '2026-01-01T00:00:00.000Z';
const integrationId = new URL(import.meta.url).searchParams.get('agentId') ?? 'benchmark';

const benchmarkModule: AgentTranscriptIndexerModule = {
  integrationId,
  apiVersion: 1,
  create() {
    return {
      async probe(source, signal) {
        signal.throwIfAborted();
        return { revision: String(source.value.revision ?? '') };
      },
      async *load(request) {
        const chatIndex = Number(request.source.value.chatIndex);
        const count = Number(request.source.value.messagesPerChat);
        const batchDelayMs = Number(request.source.value.batchDelayMs ?? 0);
        let batch = [];
        for (let messageIndex = 0; messageIndex < count; messageIndex += 1) {
          request.signal.throwIfAborted();
          batch.push(new UserMessage(timestamp, [
            'synthetic commonterm transcript content',
            chatIndex % 997 === 0 ? 'rareterm' : '',
            messageIndex % 31 === 0 ? 'quoted phrase' : '',
            messageIndex % 47 === 0 ? 'recherche' : '',
            `chat${chatIndex} message${messageIndex}`,
          ].filter(Boolean).join(' ')));
          if (batch.length >= request.limits.maxMessagesPerBatch) {
            yield batch;
            batch = [];
            await Bun.sleep(batchDelayMs);
          }
        }
        if (batch.length > 0) {
          yield batch;
          await Bun.sleep(batchDelayMs);
        }
      },
      async close() {},
    };
  },
};

export default benchmarkModule;
