import type { WaitCliCommand } from './args.js';
import type { CliOutput } from './output.js';
import {
  pollExistingTurnReceipt,
  type ReceiptClient,
  type ReceiptPollerDependencies,
} from './receipt-poller.js';
import { requireCompletedTurnReceipt, writeTerminalResult } from './terminal-receipt.js';

export async function runChatWait(
  command: WaitCliCommand,
  client: ReceiptClient,
  output: CliOutput,
  signal?: AbortSignal,
  dependencies: ReceiptPollerDependencies = {},
): Promise<void> {
  const receipt = await pollExistingTurnReceipt(
    client,
    command.chatId,
    command.turnId,
    signal,
    dependencies,
  );

  if (command.json) {
    output.result(JSON.stringify(receipt, null, 2));
    requireCompletedTurnReceipt(receipt);
    return;
  }
  output.accepted(receipt);
  writeTerminalResult(receipt, output);
}
