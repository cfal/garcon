import { describe, expect, it } from 'bun:test';
import { CodexTurnItemLedger } from '../turn-item-ledger.ts';

describe('CodexTurnItemLedger provenance', () => {
  it('names the turn on live item output', () => {
    const emitted = [];
    const ledger = new CodexTurnItemLedger((turnId, messages) => {
      emitted.push({ turnId, count: messages.length });
    });

    ledger.emit('turn-1', {
      id: 'item-1',
      type: 'agentMessage',
      text: 'hello',
    });

    expect(emitted).toEqual([{ turnId: 'turn-1', count: 1 }]);
  });

});
