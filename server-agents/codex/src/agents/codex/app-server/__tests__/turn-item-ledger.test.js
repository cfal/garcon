import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  it('names the turn on items recovered after an interrupt', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-codex-ledger-'));
    const nativePath = path.join(directory, 'rollout.jsonl');
    try {
      await writeFile(nativePath, [
        JSON.stringify({
          timestamp: '2026-08-15T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell',
            call_id: 'call-1',
            arguments: JSON.stringify({ command: ['echo', 'interrupted'] }),
          },
        }),
      ].join('\n'));
      const emitted = [];
      const ledger = new CodexTurnItemLedger(LOGGER, (turnId, messages) => {
        emitted.push({ turnId, count: messages.length });
      });

      await ledger.reconcileInterrupted('turn-9', nativePath);

      expect(emitted.every((entry) => entry.turnId === 'turn-9')).toBeTrue();
      expect(emitted.length).toBeGreaterThan(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
