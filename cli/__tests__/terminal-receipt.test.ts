import { describe, expect, it } from 'bun:test';
import type { AgentTurnReceipt } from '@garcon/common/agent-turn-receipt';
import { requireCompletedTurnReceipt, writeTerminalResult } from '../terminal-receipt.js';
import { createCliOutput } from '../output.js';

describe('terminal receipt', () => {
  it('distinguishes an explicit empty final from a missing final', () => {
    const receipt: AgentTurnReceipt = { state: 'completed', chatId: '1785337200123456', turnId: 'turn-1',
      clientRequestId: 'request-1', acceptedAt: '2026-08-04T12:00:00.000Z',
      updatedAt: '2026-08-04T12:00:01.000Z', settledAt: '2026-08-04T12:00:01.000Z',
      output: { availability: 'available', completeness: 'complete', text: '' } };
    expect(requireCompletedTurnReceipt(receipt)).toBe(receipt);
    const chunks: string[] = [];
    writeTerminalResult(receipt, createCliOutput({ write: (chunk) => chunks.push(chunk) }));
    expect(chunks).toEqual([]);
    expect(() => requireCompletedTurnReceipt({ ...receipt,
      output: { availability: 'unavailable', reason: 'no-final-response' } }))
      .toThrow('the provider did not expose a final response');
  });
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
        availability: 'unavailable',
        reason: 'no-final-response',
      },
    };

    expect(() => requireCompletedTurnReceipt(receipt)).toThrow(
      'agent turn failed [CARRYOVER_COMPACTION_FAILED]: compaction failed',
    );
  });
});
