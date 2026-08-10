import {
  AgentTranscriptIndexError,
  type AgentTranscriptIndexerModule,
} from '@garcon/server-agent-interface';

// A source whose load always fails the way an expired provider session does:
// retryable, and asking the host to refresh the source reference.
const fixtureFailureModule: AgentTranscriptIndexerModule = {
  integrationId: 'fixture-failing',
  apiVersion: 1,
  create() {
    return {
      async probe(source, signal) {
        signal.throwIfAborted();
        return { revision: typeof source.value.revision === 'string' ? source.value.revision : null };
      },
      load(request) {
        request.signal.throwIfAborted();
        throw new AgentTranscriptIndexError({
          kind: 'agent-transcript-index-failure',
          code: 'SOURCE_SESSION_EXPIRED',
          retryable: true,
          refreshSource: true,
        });
      },
      async close() {},
    };
  },
};

export default fixtureFailureModule;
