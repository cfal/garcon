import {
  AgentTranscriptIndexError,
  type AgentTranscriptIndexerModuleV4,
} from '@garcon/server-agent-interface';

const fixtureFailureModule: AgentTranscriptIndexerModuleV4 = {
  integrationId: 'fixture-failing',
  apiVersion: 2,
  create() {
    return {
      async open(request) {
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
