import type { WaitCliCommand } from './args.js';
import { CliError } from './errors.js';
import { GarconHttpError } from './garcon-client.js';
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
  let receipt;
  try {
    receipt = await pollExistingTurnReceipt(
      client,
      command.chatId,
      command.turnId,
      signal,
      dependencies,
    );
  } catch (error) {
    if (
      error instanceof CliError
      && error.cause instanceof GarconHttpError
      && error.cause.errorCode === 'TURN_RECEIPT_NOT_FOUND'
    ) {
      throw new CliError(
        error.phase,
        `${error.message} in Garcon workspace "${command.workspace}"`,
        error.exitCode,
        { cause: error.cause },
      );
    }
    throw error;
  }

  if (command.json) {
    output.result(JSON.stringify(receipt, null, 2));
    requireCompletedTurnReceipt(receipt);
    return;
  }
  output.accepted(receipt);
  writeTerminalResult(receipt, output);
}
