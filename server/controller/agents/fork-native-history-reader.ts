import type { ForkedNativeHistoryReaderDep } from '../commands/command-support.js';
import type { CarryOverTranscriptStore } from '../chats/carryover/transcript-store.js';
import { importNativeHistoryDrafts } from '../ledger/native-history-seed.js';
import type { AgentDirectory } from './directory.js';
import { assertAgentResourceScope } from '@garcon/server-agent-interface';

// Reads the forked session's own history so the target feed matches the session
// it resumes from; answers null when the provider offers no import, which keeps
// the frozen projection.
export function createForkNativeHistoryReader(deps: {
  readonly integrations: Pick<AgentDirectory, 'require'>;
  readonly carryOver: Pick<CarryOverTranscriptStore, 'revision'>;
}): ForkedNativeHistoryReaderDep {
  return async ({ targetChatId, sourceSession, fork, signal, preambleEvidence }) => {
    const integration = deps.integrations.require(fork.scope.integrationId, fork.scope.executorId);
    assertAgentResourceScope(integration.producers.scope, fork.scope);
    if (!integration?.nativeHistoryImport) return null;
    const history = integration.nativeHistoryImport;
    return importNativeHistoryDrafts({
      chatId: targetChatId,
      entry: sourceSession,
      integration,
      nativeHistoryImport: { load: (request) => history.load(request, { expectedScope: fork.scope }) },
      session: fork.session,
      // The fork target starts with no carryover of its own; its history is the
      // session it resumes from.
      carryOverRevision: deps.carryOver.revision([]),
      signal,
      now: () => new Date().toISOString(),
      preambleEvidence,
    });
  };
}
