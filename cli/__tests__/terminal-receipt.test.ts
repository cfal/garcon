import { describe, expect, it } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { requireCompletedTurnReceipt } from '../terminal-receipt.js';

describe('terminal receipt', () => {
  it('includes the structured code when a turn fails', () => {
    const receipt: AgentTurnReceipt = {
      state: 'failed',
      chatId: '1785337200123456',
      turnId: 'turn-1',
      clientRequestId: 'request-1',
      acceptedAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:01.000Z',
      settledAt: '2026-08-04T12:00:01.000Z',
      error: 'compaction failed',
      errorCode: 'CARRYOVER_COMPACTION_FAILED',
      output: {
        availability: 'available',
        completeness: 'best-effort',
        assistantMessages: [],
      },
    };

    expect(() => requireCompletedTurnReceipt(receipt)).toThrow(
      'agent turn failed [CARRYOVER_COMPACTION_FAILED]: compaction failed',
    );
  });
});
