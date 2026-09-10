import type { ForkedNativeHistoryReaderDep } from '../commands/command-support.js';
import type { CarryOverTranscriptStore } from '../chats/carryover-transcript-store.js';
import { importNativeHistoryDrafts } from '../ledger/native-history-seed.js';
import type { AgentInstanceDirectory } from './instance-directory.js';

// Reads the forked session's own history so the target feed matches the session
// it resumes from; answers null when the provider offers no import, which keeps
// the frozen projection.
export function createForkNativeHistoryReader(deps: {
  readonly instances: Pick<AgentInstanceDirectory, 'nativeHistoryImportFor'>;
  readonly carryOver: Pick<CarryOverTranscriptStore, 'revision'>;
}): ForkedNativeHistoryReaderDep {
  return async ({ targetChatId, sourceSession, fork, signal, preambleEvidence }) => {
    signal.throwIfAborted();
    const nativeHistoryImport = deps.instances.nativeHistoryImportFor(sourceSession);
    if (!nativeHistoryImport) return null;
    return importNativeHistoryDrafts({
      chatId: targetChatId,
      entry: sourceSession,
      nativeHistoryImport,
      session: fork,
      // The fork target starts with no carryover of its own; its history is the
      // session it resumes from.
      carryOverRevision: deps.carryOver.revision([]),
      signal,
      now: () => new Date().toISOString(),
      preambleEvidence,
    });
  };
}
