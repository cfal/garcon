import type {
  AgentTranscriptIndexSourceRef,
  AgentTranscriptIndexerModule,
} from '@garcon/server-agent-interface';
import {
  sourceFailure,
  yieldBoundedMessageBatches,
} from '@garcon/server-agent-common/search/index-source-helpers';
import {
  convertOpenCodeStoredMessages,
  fetchOpenCodeStoredMessages,
} from './agents/opencode/history-loader.js';
import {
  createOpenCodeRequestScope,
  hasOpenCodeResultError,
  isOpenCodeNotFoundResult,
  withOpenCodeRequestScope,
} from './agents/opencode/sdk-result.js';

function parseSource(source: AgentTranscriptIndexSourceRef) {
  const baseUrl = source.value.baseUrl;
  const sessionId = source.value.sessionId;
  const directory = source.value.directory;
  if (source.ownerId !== 'opencode'
      || source.schemaVersion !== 1
      || typeof baseUrl !== 'string'
      || typeof sessionId !== 'string'
      || typeof directory !== 'string') {
    throw sourceFailure('SOURCE_DESCRIPTOR_INVALID', false);
  }
  return { baseUrl, sessionId, directory };
}

const moduleDefinition: AgentTranscriptIndexerModule = {
  integrationId: 'opencode',
  apiVersion: 1,
  create() {
    const clients = new Map<string, any>();
    const clientFor = async (baseUrl: string) => {
      let client = clients.get(baseUrl);
      if (!client) {
        const { createOpencodeClient } = await import('@opencode-ai/sdk/v2');
        client = createOpencodeClient({ baseUrl });
        clients.set(baseUrl, client);
      }
      return client;
    };
    return {
      async probe(sourceRef, signal) {
        signal.throwIfAborted();
        const source = parseSource(sourceRef);
        try {
          const client = await clientFor(source.baseUrl);
          const scoped = createOpenCodeRequestScope(source.directory);
          let result = await client.session.get(
            withOpenCodeRequestScope({ sessionID: source.sessionId }, scoped),
            { signal },
          );
          if (scoped.directory && isOpenCodeNotFoundResult(result)) {
            result = await client.session.get({ sessionID: source.sessionId }, { signal });
          }
          if (isOpenCodeNotFoundResult(result)) {
            throw sourceFailure('SOURCE_NOT_FOUND', true);
          }
          if (hasOpenCodeResultError(result) || !result.data) {
            throw sourceFailure('SOURCE_ENDPOINT_UNAVAILABLE', true, true);
          }
          const updated = result.data.time?.updated;
          return { revision: updated === undefined ? null : `opencode-v1:${String(updated)}` };
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof Error && error.name === 'AgentTranscriptIndexError') throw error;
          throw sourceFailure('SOURCE_ENDPOINT_UNAVAILABLE', true, true);
        }
      },
      async *load(request) {
        request.signal.throwIfAborted();
        const source = parseSource(request.source);
        let stored: Awaited<ReturnType<typeof fetchOpenCodeStoredMessages>>;
        try {
          const client = await clientFor(source.baseUrl);
          stored = await fetchOpenCodeStoredMessages(
            source.sessionId,
            async () => client,
            {
              directory: source.directory,
              signal: request.signal,
              throwOnError: true,
            },
          );
        } catch (error) {
          request.signal.throwIfAborted();
          if (error instanceof Error && error.name === 'AgentTranscriptIndexError') throw error;
          throw sourceFailure('SOURCE_ENDPOINT_UNAVAILABLE', true, true);
        }
        let messages: ReturnType<typeof convertOpenCodeStoredMessages>;
        try {
          messages = convertOpenCodeStoredMessages(stored);
        } catch {
          throw sourceFailure('SOURCE_RECORD_INVALID', false);
        }
        yield* yieldBoundedMessageBatches(messages, request.limits, request.signal);
      },
      async close() {
        clients.clear();
      },
    };
  },
};

export default moduleDefinition;
