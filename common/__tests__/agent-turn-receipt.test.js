import { describe, expect, it } from 'bun:test';
import { parseAgentTurnReceipt } from '../agent-turn-receipt.js';

describe('agent turn receipt contract', () => {
  const base = {
    chatId: '1783725900000000',
    turnId: 'turn-1',
    clientRequestId: 'request-1',
    acceptedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:01.000Z',
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
        text: 'done',
      },
    })).toMatchObject({ state: 'completed', output: { text: 'done' } });
  });

  it('parses failed, interrupted, and unavailable output variants', () => {
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'failed',
      settledAt: '2026-07-31T12:01:00.000Z',
      error: 'provider failed',
      errorCode: 'INTERNAL_ERROR',
      output: { availability: 'unavailable', reason: 'no-final-response' },
    })).toMatchObject({
      state: 'failed',
      error: 'provider failed',
      errorCode: 'INTERNAL_ERROR',
    });
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'completed',
      settledAt: '2026-07-31T12:01:00.000Z',
      output: { availability: 'unavailable', reason: 'retention-pressure' },
    })).toMatchObject({
      state: 'completed',
      output: { availability: 'unavailable', reason: 'retention-pressure' },
    });
    expect(parseAgentTurnReceipt({
      ...base,
      state: 'interrupted',
      settledAt: '2026-07-31T12:01:00.000Z',
      reason: 'user-stop',
      output: {
        availability: 'unavailable',
        reason: 'no-final-response',
      },
    })).toMatchObject({ state: 'interrupted', reason: 'user-stop' });
  });

  it('requires every receipt correlation field', () => {
    const { clientRequestId: _omitted, ...missingClientRequestId } = base;
    expect(() => parseAgentTurnReceipt({ ...missingClientRequestId, state: 'pending' }))
      .toThrow('clientRequestId');
  });

  it('preserves explicit empty finals and rejects legacy or unsuccessful text output', () => {
    const receipt = { ...base, state: 'completed', settledAt: base.updatedAt,
      output: { availability: 'available', completeness: 'complete', text: '' } };
    expect(parseAgentTurnReceipt(receipt).output.text).toBe('');
    expect(() => parseAgentTurnReceipt({ ...receipt,
      output: { availability: 'available', completeness: 'complete', assistantMessages: ['old'] } })).toThrow('text');
    expect(() => parseAgentTurnReceipt({ ...receipt, state: 'failed', error: 'failed', errorCode: 'INTERNAL_ERROR' }))
      .toThrow('unsuccessful turns');
    expect(() => parseAgentTurnReceipt({ ...receipt, state: 'interrupted', reason: 'user-stop' }))
      .toThrow('unsuccessful turns');
  });
});
