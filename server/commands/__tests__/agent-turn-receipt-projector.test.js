import { describe, expect, it } from 'bun:test';
import { projectAgentTurnReceipt } from '../agent-turn-receipt-projector.js';

function record(overrides = {}) {
  return {
    key: 'agent-run:chat-1:req-1',
    commandType: 'agent-run',
    chatId: 'chat-1',
    clientRequestId: 'req-1',
    payloadHash: 'hash',
    payload: {},
    status: 'scheduled',
    acceptedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T12:00:00.000Z',
    turnId: 'turn-1',
    assistantMessages: [],
    assistantBytes: 0,
    turnResultAvailability: 'available',
    ...overrides,
  };
}

describe('agent turn receipt projection', () => {
  it('keeps terminal ledger state pending until the public barrier', () => {
    expect(projectAgentTurnReceipt(record({ status: 'finished' }))).toEqual({
      kind: 'found',
      receipt: {
        chatId: 'chat-1',
        turnId: 'turn-1',
        clientRequestId: 'req-1',
        acceptedAt: '2026-07-31T12:00:00.000Z',
        updatedAt: '2026-07-31T12:00:00.000Z',
        state: 'pending',
      },
    });
  });

  it('projects complete, failed, interrupted, and expired results', () => {
    const publicTerminalAt = '2026-07-31T12:01:00.000Z';
    expect(projectAgentTurnReceipt(record({
      status: 'finished',
      publicTerminalAt,
      assistantMessages: ['done'],
    }))).toMatchObject({
      kind: 'found',
      receipt: { state: 'completed', output: { completeness: 'complete', assistantMessages: ['done'] } },
    });
    expect(projectAgentTurnReceipt(record({
      status: 'failed',
      publicTerminalAt,
      error: 'provider failed',
    }))).toMatchObject({
      kind: 'found',
      receipt: { state: 'failed', error: 'provider failed', output: { completeness: 'best-effort' } },
    });
    expect(projectAgentTurnReceipt(record({
      status: 'finished',
      publicTerminalAt,
      interruptionReason: 'user-stop',
    }))).toMatchObject({
      kind: 'found',
      receipt: { state: 'interrupted', reason: 'user-stop' },
    });
    expect(projectAgentTurnReceipt(record({ turnResultAvailability: 'expired' })))
      .toEqual({ kind: 'expired' });
  });

  it('does not expose truncated output after the per-turn limit', () => {
    expect(projectAgentTurnReceipt(record({
      status: 'finished',
      publicTerminalAt: '2026-07-31T12:01:00.000Z',
      turnResultAvailability: 'too-large',
      assistantMessages: undefined,
    }))).toMatchObject({
      receipt: { output: { availability: 'unavailable', reason: 'too-large' } },
    });
  });

  it('projects aggregate retention pressure distinctly', () => {
    expect(projectAgentTurnReceipt(record({
      status: 'finished',
      publicTerminalAt: '2026-07-31T12:01:00.000Z',
      turnResultAvailability: 'retention-pressure',
    }))).toMatchObject({
      kind: 'found',
      receipt: { output: { availability: 'unavailable', reason: 'retention-pressure' } },
    });
  });

  it('does not claim complete output after native recovery', () => {
    expect(projectAgentTurnReceipt(record({
      status: 'finished',
      publicTerminalAt: '2026-07-31T12:01:00.000Z',
      turnResultAvailability: 'recovery',
    }))).toMatchObject({
      kind: 'found',
      receipt: { output: { availability: 'unavailable', reason: 'recovery' } },
    });
  });
});
