import { DomainError } from '../../common/domain-error.js';
import type { CommandErrorCode, SteerDeliveryOutcome } from '../../../common/chat-command-contracts.js';
import { cloneStoredChatExecutionControl, type StoredChatExecutionControlState } from './control-state.js';

export class QueueEntrySteerError extends DomainError {
  override readonly code: CommandErrorCode;
  readonly deliveryOutcome: SteerDeliveryOutcome;
  readonly control?: StoredChatExecutionControlState;

  constructor(
    code: CommandErrorCode,
    message: string,
    status: number,
    deliveryOutcome: SteerDeliveryOutcome,
    control?: StoredChatExecutionControlState,
    options?: ErrorOptions,
  ) {
    super(code, message, status, false, options);
    this.name = 'QueueEntrySteerError';
    this.code = code;
    this.deliveryOutcome = deliveryOutcome;
    this.control = control ? cloneStoredChatExecutionControl(control) : undefined;
  }
}
