import { describe, expect, it } from 'bun:test';
import { CodexTurnItemLedger } from '../turn-item-ledger.ts';

const LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

// Every emission names the Codex turn that produced it. Without that name the run tracker has
// nothing to route by, and content from a replaced generation would follow whichever operation
// happened to be current instead.
describe('CodexTurnItemLedger provenance', () => {
  it('names the turn on live item output', () => {
    const emitted = [];
    const ledger = new CodexTurnItemLedger(LOGGER, (turnId, messages) => {
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
