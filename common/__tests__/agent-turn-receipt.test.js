import { describe, expect, it } from 'bun:test';
import { parseAgentTurnReceipt } from '../agent-turn-receipt.js';

describe('agent turn receipt contract', () => {
  const base = {
    chatId: '1783725900000000',
    turnId: 'turn-1',
    acceptedAt: '2026-07-31T12:00:00.000Z',
  };

  it('parses pending and completed receipts', () => {
    expect(parseAgentTurnReceipt({ ...base, state: 'pending' })).toEqual({
      ...base,
      state: 'pending',
    });
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'completed',
      settledAt: '2026-07-31T12:01:00.000Z',
      output: {
        availability: 'available',
        completeness: 'complete',
        assistantMessages: ['done'],
      },
    })).toMatchObject({ state: 'completed', output: { assistantMessages: ['done'] } });
  });

  it('parses failed, interrupted, and unavailable output variants', () => {
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'failed',
      settledAt: '2026-07-31T12:01:00.000Z',
      error: 'provider failed',
      output: { availability: 'unavailable', reason: 'too-large' },
    })).toMatchObject({ state: 'failed', error: 'provider failed' });
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'interrupted',
      settledAt: '2026-07-31T12:01:00.000Z',
      reason: 'user-stop',
      output: {
        availability: 'available',
        completeness: 'best-effort',
        assistantMessages: [],
      },
    })).toMatchObject({ state: 'interrupted', reason: 'user-stop' });
  });
});
