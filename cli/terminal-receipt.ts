import type { AgentTurnOutputUnavailable, AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';

function unavailableResultReason(reason: AgentTurnOutputUnavailable['reason']): string {
  switch (reason) {
    case 'no-final-response':
      return 'the provider did not expose a final response';
    case 'too-large':
      return 'its result is too large for the CLI receipt';
    default:
      return 'server retention pressure prevented the CLI from retaining its result';
  }
}

export function requireCompletedTurnReceipt(
  receipt: AgentTurnReceipt,
): Extract<AgentTurnReceipt, { state: 'completed' }> {
  if (receipt.state === 'completed') {
    if (receipt.output.availability === 'unavailable') {
      const reason = unavailableResultReason(receipt.output.reason);
      throw new CliError(
        'receipt polling',
        `the turn completed, but ${reason}; view the complete transcript in Garcon`,
        3,
      );
    }
    return receipt;
  }
  if (receipt.state === 'failed') {
    throw new CliError(
      'receipt polling',
      `agent turn failed [${receipt.errorCode}]: ${receipt.error}`,
      1,
    );
  }
  if (receipt.state === 'interrupted') {
    const reason = receipt.reason === 'chat-deleted' ? 'the chat was deleted' : 'the turn was stopped';
    throw new CliError('receipt polling', `agent turn interrupted: ${reason}`, 4);
  }
  throw new CliError('receipt polling', 'turn receipt unexpectedly remained pending', 3);
}

export function writeTerminalResult(receipt: AgentTurnReceipt, output: CliOutput): void {
  const completed = requireCompletedTurnReceipt(receipt);
  if (completed.output.availability === 'available') {
    output.completed(completed.output.text);
  }
}
