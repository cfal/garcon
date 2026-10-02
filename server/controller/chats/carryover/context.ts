import type { ChatMessage } from '@garcon/common/chat-types';
import { effectiveExecutorId } from '../../../../common/executors.js';
import type {
  AgentChatEntry
} from '../../agents/session-types.js';
import type { TranscriptViewId } from '../../ledger/contracts.js';
import type { CarryOverCompactionService } from './compaction.js';
import { type CarryOverOutcome } from './outcome.js';
import type { PreparedCarryoverStore } from './prepared-store.js';


export interface CreateCarriedContextInput {
  readonly onCompactionStarted?: () => void;
  readonly chatId: string;
  readonly entry: AgentChatEntry;
  readonly messages: readonly ChatMessage[];
  readonly transcriptViewId: TranscriptViewId;
  readonly destinationPrompt: string;
  readonly clientRequestId: string | null;
  readonly signal?: AbortSignal;
}

export async function createCarriedContext(
  input: CreateCarriedContextInput,
  preparedCarryover: PreparedCarryoverStore,
  compaction: Pick<CarryOverCompactionService, 'planFor'> | null,
): Promise<CarryOverOutcome> {
  const prepared = preparedCarryover.take({
    chatId: input.chatId,
    transcriptViewId: input.transcriptViewId,
    targetAgentId: input.entry.agentId,
    targetExecutorId: effectiveExecutorId(input.entry.executorId),
    targetOwnershipEpoch: input.entry.agentOwnershipEpoch,
    clientRequestId: input.clientRequestId,
  });
  if (prepared) return prepared;
  if (!compaction) throw new Error('Carryover compaction is not initialized');
  return compaction.planFor({
    operation: 'fresh-start',
    onCompactionStarted: input.onCompactionStarted,
    chatId: input.chatId,
    messages: input.messages,
    destination: {
      agentId: input.entry.agentId,
      model: input.entry.model ?? '',
      prompt: input.destinationPrompt,
    },
    signal: input.signal,
  });
}
