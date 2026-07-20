import { parseChatMessages } from '@garcon/common/chat-types';
import type { AgentTranscriptIndexerModule } from '@garcon/server-agent-interface';
import { yieldBoundedMessageBatches } from '../index-source-helpers.js';

const fixtureModule: AgentTranscriptIndexerModule = {
  integrationId: 'fixture',
  apiVersion: 1,
  create() {
    return {
      async probe(source, signal) {
        signal.throwIfAborted();
        return { revision: typeof source.value.revision === 'string' ? source.value.revision : null };
      },
      async *load(request) {
        const messages = parseChatMessages(request.source.value.messages);
        yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
      },
      async close() {},
    };
  },
};

export default fixtureModule;
