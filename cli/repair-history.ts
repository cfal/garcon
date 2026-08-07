import type {
  RepairHistoryAcceptNativeRequest,
  RepairHistoryAcceptNativeResponse,
} from '@garcon/common/chat-command-contracts';
import type { RepairHistoryCliCommand } from './args.js';
import type { CliOutput } from './output.js';

export interface RepairHistoryClient {
  repairHistory(
    request: RepairHistoryAcceptNativeRequest,
    signal?: AbortSignal,
  ): Promise<RepairHistoryAcceptNativeResponse>;
}

export async function repairChatHistory(
  command: RepairHistoryCliCommand,
  client: RepairHistoryClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  const result = await client.repairHistory({
    action: command.action,
    chatId: command.chatId,
    expectedCarryOverRevision: command.expectedCarryOverRevision,
    expectedAgentOwnershipEpoch: command.expectedAgentOwnershipEpoch,
  }, signal);
  output.result([
    `chat id: ${result.chatId}`,
    `history repair: ${result.receiptCleared ? 'receipt-cleared' : 'already-accepted'}`,
  ].join('\n'));
}
