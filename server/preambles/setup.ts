import type { AgentOwnershipJournal } from '../chats/agent-ownership-journal.js';
import type { IChatRegistry } from '../chats/store.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import type { TranscriptAdoptionService } from '../ledger/adoption.js';
import type { TranscriptLedgerService } from '../ledger/service.js';
import { ChatPreambleSelectionService } from './chat-selection-service.js';
import { PreambleProjectPathService } from './project-path-service.js';
import { PreambleService } from './service.js';
import { PreambleStore } from './store.js';

export async function initializePreambleService(workspaceDir: string): Promise<PreambleService> {
  const store = new PreambleStore(workspaceDir);
  await store.init();
  return new PreambleService({ store, projectPaths: new PreambleProjectPathService() });
}

// Builds the existing-chat selection service. Kept beside catalog setup so
// server.ts wiring stays within its architecture line budget.
export function initializeChatPreambleSelectionService(deps: {
  readonly preambles: PreambleService;
  readonly registry: Pick<
    IChatRegistry,
    'getChat' | 'updateChatPhased' | 'reconcileUnknownDurability'
  >;
  readonly adoption: Pick<TranscriptAdoptionService, 'ensure'>;
  readonly ledger: Pick<
    TranscriptLedgerService,
    | 'appendSelectionChangeNotice'
    | 'findSubmissionRow'
    | 'hasPreambleBoundaryProof'
  >;
  readonly ownershipJournal: Pick<AgentOwnershipJournal, 'hasPending'>;
  readonly chatMutationLock: KeyedPromiseLock;
  readonly selectionAdmissionLock: KeyedPromiseLock;
  readonly onSelectionCommitted: (chatId: string, revision: number) => void;
}): ChatPreambleSelectionService {
  return new ChatPreambleSelectionService(deps);
}
