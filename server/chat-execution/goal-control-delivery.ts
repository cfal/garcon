import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import { DomainError, GoalControlDeliveryError } from '../lib/domain-error.ts';
import type { StoredChatExecutionControlState } from './control-state.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import { executionTurnIdentity } from './types.ts';
import type {
  AgentTurnRunnerPort,
  UserInputAdmissionOptions,
  QueueDrainOptionsResolver,
} from './types.ts';

interface GoalControlDeliveryOptions {
  turnRunner: AgentTurnRunnerPort;
  ownership: ExecutionOwnership;
  getDrainOptions: QueueDrainOptionsResolver;
  readControl(chatId: string): Promise<StoredChatExecutionControlState>;
  admitInput(
    chatId: string,
    content: string,
    options: UserInputAdmissionOptions,
  ): Promise<boolean>;
  discardPreparedInput(chatId: string, clientMessageId: string | null | undefined): void;
}

export class DuplicateGoalControlInputError extends Error {}

export class GoalControlDelivery {
  constructor(private readonly options: GoalControlDeliveryOptions) {}

  async deliver(
    chatId: string,
    content: string,
    options: RunAgentTurnOptions = {},
    afterPendingRegistered?: () => Promise<void>,
  ): Promise<boolean> {
    const supportsGoalControl = this.options.turnRunner.isChatRunning(chatId)
      && typeof this.options.turnRunner.submitGoalControl === 'function';
    const currentQueue = supportsGoalControl ? await this.options.readControl(chatId) : null;
    if (!supportsGoalControl || currentQueue?.entries.length !== 0 || currentQueue.pause !== null) {
      return false;
    }

    const activeOptions = { ...this.options.getDrainOptions(chatId), ...options };
    assertTurnIdentifiers(activeOptions);
    const activeAttempt = this.options.ownership.attempt(chatId);
    const predecessor = activeAttempt?.identity();
    const successor = executionTurnIdentity(activeOptions)!;
    let deliveryMayHaveStarted = false;
    let inputInserted = false;
    try {
      const handled = await this.options.turnRunner.submitGoalControl!(
        chatId,
        content,
        activeOptions,
        async (handoff) => {
          const validateOwner = () => {
            if (this.options.ownership.attempt(chatId) !== activeAttempt) {
              throw new Error(
                `Cannot hand off execution attempt for chat ${chatId} after its owner changed`,
              );
            }
          };
          validateOwner();
          const committedHandoff = activeAttempt && predecessor
            ? activeAttempt.handoffTurn(predecessor, successor, handoff)
            : handoff;
          committedHandoff.validate();
          inputInserted = await this.options.admitInput(chatId, content, activeOptions);
          if (!inputInserted) throw new DuplicateGoalControlInputError();
          await afterPendingRegistered?.();
          validateOwner();
          committedHandoff.validate();
          committedHandoff.commit();
          deliveryMayHaveStarted = true;
        },
      );
      if (!handled && deliveryMayHaveStarted) {
        throw new Error('Agent accepted goal control without handling it');
      }
      return handled;
    } catch (error) {
      if (error instanceof DuplicateGoalControlInputError) throw error;
      throw new GoalControlDeliveryError(error, deliveryMayHaveStarted);
    } finally {
      if (inputInserted) {
        this.options.discardPreparedInput(chatId, activeOptions.clientMessageId);
      }
    }
  }
}

function assertTurnIdentifiers(
  options: RunAgentTurnOptions,
): asserts options is RunAgentTurnOptions & Required<Pick<
  RunAgentTurnOptions,
  'clientRequestId' | 'clientMessageId' | 'turnId'
>> {
  if (!options.clientRequestId || !options.clientMessageId || !options.turnId) {
    throw new DomainError(
      'INTERNAL_ERROR',
      'Accepted input is missing command identifiers',
      500,
    );
  }
}
