import type { CommandErrorCode } from '../../common/chat-command-contracts.js';
import type { StoredChatExecutionControlState } from '../chat-execution/control-state.ts';
import { CommandValidationError } from './command-validation-error.js';
import { DomainError } from './domain-error.js';

export class CommandExecutionControlError extends CommandValidationError {
  constructor(
    code: CommandErrorCode,
    message: string,
    status: number,
    retryable: boolean,
    readonly control: StoredChatExecutionControlState,
  ) {
    super(code, message, status, retryable);
    this.name = 'CommandExecutionControlError';
  }
}

export async function withCurrentExecutionControl(input: {
  readonly chatId: string;
  readonly error: unknown;
  readonly handoff: boolean;
  readonly readControl: (chatId: string) => Promise<StoredChatExecutionControlState>;
}): Promise<unknown> {
  if (input.error instanceof CommandExecutionControlError) return input.error;
  if (!(input.error instanceof DomainError) || input.error.code !== 'SESSION_BUSY') {
    return input.error;
  }

  let control: StoredChatExecutionControlState;
  try {
    control = await input.readControl(input.chatId);
  } catch {
    return input.error;
  }
  return new CommandExecutionControlError(
    input.handoff ? 'AGENT_HANDOFF_REQUIRES_IDLE' : 'SESSION_BUSY',
    input.handoff
      ? 'Agent handoff requires an idle chat with an empty queue.'
      : input.error.message,
    input.error.status,
    input.error.retryable,
    control,
  );
}
