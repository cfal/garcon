import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage } from '../../../common/chat-types.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { localEmissionSink } from '../local-emission.js';

describe('standalone provider emission', () => {
  test('commits inline and retains its captured sink across replacement', async () => {
    const directory = await mkdtemp(join(homedir(), 'garcon-local-emission-'));
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory));
    try {
      ledger.initializeChat('chat-1');
      const source = ledger.openProducer('chat-1', 'test');
      const output = localEmissionSink(source.sink);
      const message = new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic answer');
      expect(Object.isFrozen(output)).toBe(true);
      expect(Object.keys(output)).toEqual(['emit']);
      expect(output.emit({ type: 'rows', rows: [{ message }] })).toBeUndefined();
      expect(ledger.currentRows('chat-1')).toMatchObject([{ ordinal: 1, message: { content: 'synthetic answer' } }]);

      source.close();
      const replacement = localEmissionSink(ledger.openProducer('chat-1', 'test').sink);
      expect(() => output.emit({ type: 'rows', rows: [{ message }] })).toThrow('closed');
      expect(ledger.currentRows('chat-1')).toHaveLength(1);
      replacement.emit({ type: 'rows', rows: [{ message }] });
      expect(ledger.currentRows('chat-1').map((row) => row.ordinal)).toEqual([1, 2]);
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('propagates synchronous acceptance failure without retaining or retrying an event', () => {
    let calls = 0;
    const failure = new Error('synthetic ledger failure');
    const output = localEmissionSink({ publish() { calls += 1; throw failure; } });
    expect(() => output.emit({ type: 'rows', rows: [] })).toThrow(failure);
    expect(calls).toBe(1);
  });
});
