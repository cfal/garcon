import type { TurnEventMetadata } from '../agents/event-bus.js';
import type { WorkingDirectorySettlement, WorkingDirectorySettlementPort } from '../projects/working-directory-settlement.js';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.js';
import type { ExecutionOwnership } from './execution-ownership.js';
import type { QueueExecutionAttempt } from './execution-attempt.js';

interface TerminalSettlementDependencies {
  ownership: ExecutionOwnership;
  control: ChatExecutionControlOperations;
  workingDirectory?: WorkingDirectorySettlementPort;
  executionPolicy(chatId: string): 'conversation' | 'literal';
  retire(chatId: string, attempt: QueueExecutionAttempt): void;
  checkIdle(chatId: string): Promise<void>;
}

export async function settleAgentTurn(
  deps: TerminalSettlementDependencies, chatId: string, turn: TurnEventMetadata | undefined, outcome: 'finished' | 'failed',
): Promise<WorkingDirectorySettlement> {
  const attempt = deps.ownership.attempt(chatId);
  if (!attempt?.matches(turn)) {
    await deps.checkIdle(chatId);
    return { kind: 'settled' };
  }
  const isCurrent = () => deps.ownership.isCurrentAttempt(chatId, attempt);
  let settlement: WorkingDirectorySettlement = { kind: 'settled' };
  try {
    if (turn && deps.workingDirectory) settlement = await deps.workingDirectory.settle(chatId, turn, isCurrent);
  } catch (error) {
    settlement = { kind: 'failed', message: `Command completion could not be synchronized: ${String(error)}` };
  }
  if (!isCurrent()) return settlement;
  if (outcome === 'failed' || settlement.kind === 'failed') {
    if (attempt.entryId) await deps.control.pauseAfterFailure(chatId, { kind: 'queued-turn-failed', entryId: attempt.entryId });
    else if ((deps.executionPolicy(chatId) === 'literal' || settlement.kind === 'failed') && turn?.turnId) {
      await deps.control.pauseAfterFailure(chatId, { kind: 'turn-failed', turnId: turn.turnId });
    }
  }
  if (isCurrent()) deps.retire(chatId, attempt);
  return settlement;
}
