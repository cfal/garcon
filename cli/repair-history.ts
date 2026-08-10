import type {
  RepairHistoryRequest,
  RepairHistoryResponse,
} from '@garcon/common/chat-history-repair';
import type { RepairHistoryCliCommand } from './args.js';
import type { CliOutput } from './output.js';

export interface RepairHistoryClient {
  repairHistory(
    request: RepairHistoryRequest,
    signal?: AbortSignal,
  ): Promise<RepairHistoryResponse>;
}

export async function repairChatHistory(
  command: RepairHistoryCliCommand,
  client: RepairHistoryClient,
  output: CliOutput,
  signal?: AbortSignal,
): Promise<void> {
  if (command.action === 'retry-abandoned') {
    const result = await client.repairHistory({ action: 'retry-abandoned-release' }, signal);
    if (result.action !== 'retry-abandoned-release') return;
    const lines = [`transfer releases retried: ${result.retried.length}`];
    if (result.unresolved.length === 0) {
      lines.push('unresolved releases: none');
    } else {
      lines.push(...result.unresolved.map((record) => (
        `unresolved release: ${record.chatId} (${record.agentId}): ${record.lastErrorCode ?? 'pending'}`
      )));
    }
    output.result(lines.join('\n'));
    return;
  }
  const result = await client.repairHistory({
    action: command.action,
    chatId: command.chatId,
    expectedCarryOverRevision: command.expectedCarryOverRevision,
    expectedAgentOwnershipEpoch: command.expectedAgentOwnershipEpoch,
  }, signal);
  if (result.action !== 'accept-native') return;
  output.result([
    `chat id: ${result.chatId}`,
    `history repair: ${result.receiptCleared ? 'receipt-cleared' : 'already-accepted'}`,
  ].join('\n'));
}
