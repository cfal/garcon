import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { CliError } from './errors.js';
import type { CliOutput } from './output.js';

export function requireCompletedTurnReceipt(
  receipt: AgentTurnReceipt,
): Extract<AgentTurnReceipt, { state: 'completed' }> {
  if (receipt.state === 'completed') {
    if (receipt.output.availability === 'unavailable') {
      const reason = receipt.output.reason === 'too-large'
        ? 'its result is too large for the CLI receipt'
        : receipt.output.reason === 'retention-pressure'
          ? 'server retention pressure prevented the CLI from retaining its result'
          : 'server recovery rebuilt the transcript outside this turn receipt';
      throw new CliError(
        'receipt polling',
        `the turn completed, but ${reason}; view the complete transcript in Garcon`,
        3,
      );
    }
    return receipt;
  }
  if (receipt.state === 'failed') {
    throw new CliError('receipt polling', `agent turn failed: ${receipt.error}`, 1);
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
    output.completed(completed.output.assistantMessages);
  }
}
