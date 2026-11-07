import { ChatCommandSettlement } from '../commands/chat-command-settlement.js';
import type { CommandLedger } from '../commands/command-ledger.js';
import type { AcceptedExecutionCommand, PreScheduleFailure } from '../chat-execution/types.js';

export class AutomationCommandSettlement extends ChatCommandSettlement {
  constructor(private readonly reservations: CommandLedger) { super(reservations); }

  override async markPreScheduleFailure(command: AcceptedExecutionCommand, failure: PreScheduleFailure): Promise<void> {
    this.reservations.recordDispatchFailure(command.key, 'not-dispatched');
    await this.reservations.settleTerminal(command.key, 'failed', {
      errorCode: 'AUTOMATION_ADMISSION_FAILED',
      error: failure.error instanceof Error ? failure.error.message : String(failure.error),
      retainedPrivateTerminal: true,
    });
  }
}
