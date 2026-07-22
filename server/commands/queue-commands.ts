import crypto from 'crypto';
import type {
  ActiveInputCommandRequest,
  ActiveInputCommandResponse,
  QueueEntryCommandResponse,
  QueueEntryCreateCommandRequest,
  QueueEntryDeleteCommandRequest,
  QueueEntryDeleteResponse,
  QueueEntryMoveCommandRequest,
  QueueEntryReplaceCommandRequest,
  QueueMutationResponse,
} from '../../common/chat-command-contracts.js';
import { QueueEntryMutationError } from '../chat-execution/chat-execution-coordinator.js';
import { toClientChatExecutionControlState } from '../chat-execution/control-state.ts';
import type { CommandLedgerRecord } from './command-ledger.js';
import {
  CommandSupport,
  CommandValidationError,
  commandResultFromRecord,
  type QueueMutationInput,
  type ScheduledExistingChatInput,
  type ScheduledExistingChatOutcome,
} from './command-support.js';

export class QueueCommands {
  constructor(private readonly support: CommandSupport) {}

  private get deps() {
    return this.support.deps;
  }

  async submitQueueEntryCreate(input: QueueEntryCreateCommandRequest): Promise<QueueEntryCommandResponse> {
    this.support.requireChat(input.chatId);
    this.support.assertContent(input.content);
    return this.support.withChatMutationLock(input.chatId, () => this.submitQueueEntryCreateLocked(input));
  }

  async submitQueueEntryReplace(input: QueueEntryReplaceCommandRequest): Promise<QueueEntryCommandResponse> {
    this.support.requireChat(input.chatId);
    this.support.assertContent(input.content);
    if (!input.entryId.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', 'entryId is required');
    }
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new CommandValidationError('VALIDATION_FAILED', 'expectedRevision must be a positive integer');
    }
    return this.support.withChatMutationLock(input.chatId, async () => {
      const content = input.content;
      const entryId = input.entryId.trim();
      const ledger = await this.deps.ledger.accept({
        commandType: 'queue-entry-replace',
        chatId: input.chatId,
        clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
        payload: {
          chatId: input.chatId,
          entryId,
          content,
          expectedRevision: input.expectedRevision,
        },
        entryId,
      });
      this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
      if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
        await this.throwRecordedQueueMutationFailure(ledger.record);
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          entryId: ledger.record.entryId ?? entryId,
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const result = await this.deps.queue.replaceAccepted({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          entryId,
        },
        content,
        expectedRevision: input.expectedRevision,
        settlement: this.support.settlement,
      });
      return {
        ...commandResultFromRecord(
          ledger.record,
          recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
        ),
        entryId,
        control: toClientChatExecutionControlState(result.control),
      };
    });
  }

  async submitQueueEntryDelete(input: QueueEntryDeleteCommandRequest): Promise<QueueEntryDeleteResponse> {
    this.support.requireChat(input.chatId);
    if (!input.entryId.trim()) {
      throw new CommandValidationError('VALIDATION_FAILED', 'entryId is required');
    }
    return this.support.withChatMutationLock(input.chatId, async () => {
      const entryId = input.entryId.trim();
      const ledger = await this.deps.ledger.accept({
        commandType: 'queue-entry-delete',
        chatId: input.chatId,
        clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
        payload: { chatId: input.chatId, entryId },
        entryId,
      });
      this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
      if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
        await this.throwRecordedQueueMutationFailure(ledger.record);
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          entryId: ledger.record.entryId ?? entryId,
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const result = await this.deps.queue.deleteAccepted({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          entryId,
        },
        settlement: this.support.settlement,
      });
      return {
        ...commandResultFromRecord(
          ledger.record,
          recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
        ),
        entryId,
        control: toClientChatExecutionControlState(result.control),
      };
    });
  }

  async submitQueueEntryMove(
    input: QueueEntryMoveCommandRequest,
  ): Promise<QueueEntryCommandResponse> {
    this.support.requireChat(input.chatId);
    const entryId = input.entryId.trim();
    const targetEntryId = input.targetEntryId.trim();
    if (!entryId || !targetEntryId || entryId === targetEntryId) {
      throw new CommandValidationError(
        'VALIDATION_FAILED',
        'entryId and a different targetEntryId are required',
      );
    }
    if (input.placement !== 'before' && input.placement !== 'after') {
      throw new CommandValidationError('VALIDATION_FAILED', 'placement must be before or after');
    }
    if (
      !Number.isSafeInteger(input.expectedReorderRevision)
      || input.expectedReorderRevision < 0
      || !Number.isSafeInteger(input.expectedSourceRevision)
      || input.expectedSourceRevision < 1
      || !Number.isSafeInteger(input.expectedTargetRevision)
      || input.expectedTargetRevision < 1
    ) {
      throw new CommandValidationError('VALIDATION_FAILED', 'Move revisions are invalid');
    }

    return this.support.withChatMutationLock(input.chatId, async () => {
      const ledger = await this.deps.ledger.accept({
        commandType: 'queue-entry-move',
        chatId: input.chatId,
        clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
        payload: {
          chatId: input.chatId,
          entryId,
          targetEntryId,
          placement: input.placement,
          expectedReorderRevision: input.expectedReorderRevision,
          expectedSourceRevision: input.expectedSourceRevision,
          expectedTargetRevision: input.expectedTargetRevision,
        },
        entryId,
      });
      this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      const recoveringAcceptedCommand = ledger.kind === 'duplicate'
        && ledger.record.status === 'accepted';
      if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
        await this.throwRecordedQueueMutationFailure(ledger.record);
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          entryId: ledger.record.entryId ?? entryId,
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const result = await this.deps.queue.moveAccepted({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          entryId,
        },
        targetEntryId,
        placement: input.placement,
        expectedReorderRevision: input.expectedReorderRevision,
        expectedSourceRevision: input.expectedSourceRevision,
        expectedTargetRevision: input.expectedTargetRevision,
        settlement: this.support.settlement,
      });
      return {
        ...commandResultFromRecord(
          ledger.record,
          recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
        ),
        entryId,
        control: toClientChatExecutionControlState(result.control),
      };
    });
  }

  async submitActiveInput(input: ActiveInputCommandRequest): Promise<ActiveInputCommandResponse> {
    this.support.requireChat(input.chatId);
    this.support.assertContent(input.content);
    return this.support.withChatMutationLock(input.chatId, async () => {
      const content = input.content;
      const preparedEntryId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const ledger = await this.deps.ledger.accept({
        commandType: 'active-input',
        chatId: input.chatId,
        clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
        payload: { chatId: input.chatId, content },
        entryId: preparedEntryId,
        turnId,
      });
      this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
      if (ledger.kind === 'duplicate') {
        if (ledger.record.status === 'failed') {
          this.support.throwRecordedExecutionFailure(ledger.record);
        }
        if (ledger.record.status === 'accepted') {
          const outcome = await this.deps.queue.recoverAcceptedActiveInput({
            command: {
              key: ledger.record.key,
              chatId: input.chatId,
              clientRequestId: ledger.record.clientRequestId,
              turnId: ledger.record.turnId ?? turnId,
              entryId: ledger.record.entryId ?? preparedEntryId,
            },
            content,
            settlement: this.support.settlement,
          });
          return {
            ...commandResultFromRecord(ledger.record, 'duplicate'),
            delivery: outcome.delivery,
            ...(outcome.entryId ? { entryId: outcome.entryId } : {}),
            control: toClientChatExecutionControlState(outcome.control),
          };
        }
        return {
          ...commandResultFromRecord(ledger.record, 'duplicate'),
          delivery: ledger.record.entryId ? 'queued' : 'active',
          ...(ledger.record.entryId ? { entryId: ledger.record.entryId } : {}),
          control: toClientChatExecutionControlState(
            await this.deps.queue.readChatExecutionControl(input.chatId),
          ),
        };
      }

      const outcome = await this.deps.queue.deliverAcceptedActiveInput({
        command: {
          key: ledger.record.key,
          chatId: input.chatId,
          clientRequestId: ledger.record.clientRequestId,
          turnId: ledger.record.turnId ?? turnId,
          entryId: ledger.record.entryId ?? preparedEntryId,
        },
        content,
        settlement: this.support.settlement,
      });
      return {
        ...commandResultFromRecord(ledger.record),
        delivery: outcome.delivery,
        ...(outcome.entryId ? { entryId: outcome.entryId } : {}),
        control: toClientChatExecutionControlState(outcome.control),
      };
    });
  }

  async submitScheduledExistingChat(input: ScheduledExistingChatInput): Promise<ScheduledExistingChatOutcome> {
    const chatId = input.chatId.trim();
    const command = input.command.trim();
    this.support.assertContent(command);
    return this.support.withChatMutationLock(chatId, async () => {
      const session = this.deps.chats.getChat(chatId);
      if (!session) {
        throw new CommandValidationError('SESSION_NOT_FOUND', 'Session not found', 404);
      }
      const busy = this.deps.agents.isAgentSessionRunning(session.agentId, session.agentSessionId)
        || this.deps.queue.isChatExecutionReserved(chatId);
      const control = await this.deps.queue.readChatExecutionControl(chatId);
      const queueBlocksDirectRun = control.entries.length > 0
        || control.pause !== null;
      if ((busy || queueBlocksDirectRun) && input.busyBehavior === 'skip') {
        return { type: 'skipped-busy', chatId };
      }
      if (busy || queueBlocksDirectRun) {
        const result = await this.submitQueueEntryCreateLocked({
          chatId,
          content: command,
          clientRequestId: input.clientRequestId,
        });
        return { type: 'queued', chatId, entryId: result.entryId };
      }
      await this.support.submitHttpRun({
        chatId,
        command,
        clientRequestId: input.clientRequestId,
        clientMessageId: input.clientMessageId,
        options: {},
      });
      return { type: 'sent', chatId };
    });
  }

  async mutateQueue(input: QueueMutationInput): Promise<QueueMutationResponse> {
    this.support.requireChat(input.chatId);
    return this.support.withChatMutationLock(input.chatId, () => this.mutateQueueLocked(input));
  }

  private async submitQueueEntryCreateLocked(
    input: QueueEntryCreateCommandRequest,
  ): Promise<QueueEntryCommandResponse> {
    const content = input.content;
    const preparedEntryId = crypto.randomUUID();
    const ledger = await this.deps.ledger.accept({
      commandType: 'queue-entry-create',
      chatId: input.chatId,
      clientRequestId: this.support.requireClientRequestId(input.clientRequestId),
      payload: { chatId: input.chatId, content },
      entryId: preparedEntryId,
    });
    this.support.throwOnConflict(ledger, 'clientRequestId was reused with different payload');
    const recoveringAcceptedCommand = ledger.kind === 'duplicate' && ledger.record.status === 'accepted';
    if (ledger.kind === 'duplicate' && !recoveringAcceptedCommand) {
      return {
        ...commandResultFromRecord(ledger.record, 'duplicate'),
        entryId: ledger.record.entryId ?? preparedEntryId,
        control: toClientChatExecutionControlState(
          await this.deps.queue.readChatExecutionControl(input.chatId),
        ),
      };
    }

    const result = await this.deps.queue.enqueueAccepted({
      command: {
        key: ledger.record.key,
        chatId: input.chatId,
        clientRequestId: ledger.record.clientRequestId,
        entryId: ledger.record.entryId ?? preparedEntryId,
      },
      content,
      settlement: this.support.settlement,
    });
    return {
      ...commandResultFromRecord(
        ledger.record,
        recoveringAcceptedCommand || result.duplicate ? 'duplicate' : 'accepted',
      ),
      entryId: result.entryId,
      control: toClientChatExecutionControlState(result.control),
    };
  }

  private async mutateQueueLocked(input: QueueMutationInput): Promise<QueueMutationResponse> {
    let queue;
    if (input.action === 'clear') {
      queue = await this.deps.queue.clearChatQueue(input.chatId);
    } else if (input.action === 'pause') {
      queue = await this.deps.queue.pauseChatQueue(input.chatId);
    } else {
      if (!input.pauseId) {
        throw new CommandValidationError('VALIDATION_FAILED', 'pauseId is required', 400);
      }
      queue = await this.deps.queue.resumeAndDrain(input.chatId, input.pauseId);
    }
    return {
      success: true,
      chatId: input.chatId,
      control: toClientChatExecutionControlState(queue),
    };
  }

  private async throwRecordedQueueMutationFailure(record: CommandLedgerRecord): Promise<void> {
    if (record.status !== 'rejected') return;
    if (
      record.errorCode !== 'QUEUE_ENTRY_NOT_FOUND'
      && record.errorCode !== 'QUEUE_ENTRY_ALREADY_SENT'
      && record.errorCode !== 'QUEUE_ENTRY_REVISION_CONFLICT'
      && record.errorCode !== 'QUEUE_ENTRY_REORDER_CONFLICT'
    ) {
      return;
    }

    throw new QueueEntryMutationError(
      record.errorCode,
      record.error ?? 'The queued message could not be changed',
      await this.deps.queue.readChatExecutionControl(record.chatId),
    );
  }
}
