import type { RunAgentTurnOptions } from '../agents/session-types.ts';
import { DomainError, GoalControlDeliveryError } from '../lib/domain-error.ts';
import type { StoredChatExecutionControlState } from './control-state.ts';
import type { ExecutionOwnership } from './execution-ownership.ts';
import { executionTurnIdentity } from './types.ts';
import type {
  AgentTurnRunnerPort,
  PendingInputsPort,
  PendingUserInputRegistrationOptions,
  QueueDrainOptionsResolver,
} from './types.ts';

interface GoalControlDeliveryOptions {
  turnRunner: AgentTurnRunnerPort;
  pendingInputs: PendingInputsPort;
  ownership: ExecutionOwnership;
  getDrainOptions: QueueDrainOptionsResolver;
  readControl(chatId: string): Promise<StoredChatExecutionControlState>;
  registerPending(
    chatId: string,
    content: string,
    options: PendingUserInputRegistrationOptions,
  ): Promise<void>;
}

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
    let pendingRegistered = false;
    let deliveryMayHaveStarted = false;
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
          await this.options.registerPending(chatId, content, activeOptions);
          pendingRegistered = true;
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
      if (deliveryMayHaveStarted) {
        this.options.pendingInputs.markUnconfirmed(chatId, activeOptions.clientRequestId);
      } else if (pendingRegistered) {
        this.options.pendingInputs.markFailed(chatId, activeOptions.clientRequestId);
      }
      throw new GoalControlDeliveryError(error, deliveryMayHaveStarted);
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
