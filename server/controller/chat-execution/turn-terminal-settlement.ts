import type { TurnEventMetadata } from '../agents/event-bus.js';
import type { WorkingDirectorySettlement, WorkingDirectorySettlementPort } from '../projects/working-directory-settlement.js';
import type { ChatExecutionControlOperations } from './chat-execution-control-operations.js';
import type { ExecutionOwnership } from './execution-ownership.js';
import type { QueueExecutionAttempt } from './execution-attempt.js';
import type { ChatStopOutcome } from '../../../common/chat-types.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('queue');

interface TerminalSettlementDependencies {
  ownership: ExecutionOwnership;
  control: ChatExecutionControlOperations;
  workingDirectory?: WorkingDirectorySettlementPort;
  executionPolicy(chatId: string): 'conversation' | 'literal';
  retire(chatId: string, attempt: QueueExecutionAttempt): void;
  checkIdle(chatId: string): Promise<void>;
}

export async function interruptAgentTurn(
  deps: Pick<TerminalSettlementDependencies, 'ownership'> & {
    abortSession(chatId: string): Promise<boolean>;
    retire(chatId: string, attempt: QueueExecutionAttempt, reason: Error): void;
  },
  chatId: string,
): Promise<ChatStopOutcome> {
  try {
    const attempt = deps.ownership.attempt(chatId);
    if (attempt?.hasTerminalCommit) return 'already-idle';
    const interruption = new Error('Turn interrupted by the user');
    if (attempt) deps.ownership.abortAdmission(chatId, interruption);
    const acknowledged = await deps.abortSession(chatId);
    if (!acknowledged && !attempt) return 'already-idle';
    if (attempt && deps.ownership.isCurrentAttempt(chatId, attempt)) deps.retire(chatId, attempt, interruption);
    return 'interrupt-requested';
  } catch (error) {
    logger.warn('queue: provider interrupt failed', {
      chatId,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return 'failed';
  }
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
