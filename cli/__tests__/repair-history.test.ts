import { describe, expect, mock, test } from 'bun:test';
import { repairChatHistory } from '../repair-history.js';

const CHAT_ID = '1783725900000200';

describe('repairChatHistory', () => {
  test('submits both fences and prints the durable outcome', async () => {
    const repairHistory = mock(async () => ({
      success: true as const,
      action: 'accept-native' as const,
      chatId: CHAT_ID,
      receiptCleared: true,
    }));
    const result = mock(() => undefined);

    await repairChatHistory({
      kind: 'repair-history',
      action: 'accept-native',
      workspace: 'default',
      configDir: '/tmp/garcon',
      chatId: CHAT_ID,
      expectedCarryOverRevision: 'carry-v5:abc123',
      expectedAgentOwnershipEpoch: 'epoch-1',
    }, { repairHistory }, {
      accepted: mock(() => undefined),
      completed: mock(() => undefined),
      result,
      sent: mock(() => undefined),
      stopped: mock(() => undefined),
      diagnostic: mock(() => undefined),
    });

    expect(repairHistory).toHaveBeenCalledWith({
      action: 'accept-native',
      chatId: CHAT_ID,
      expectedCarryOverRevision: 'carry-v5:abc123',
      expectedAgentOwnershipEpoch: 'epoch-1',
    }, undefined);
    expect(result).toHaveBeenCalledWith(
      `chat id: ${CHAT_ID}\nhistory repair: receipt-cleared`,
    );
  });
});
