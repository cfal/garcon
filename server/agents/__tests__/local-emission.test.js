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

      let retired = 0;
      source.signal.addEventListener('abort', () => {
        retired++;
        expect(source.closed).toBe(true);
        expect(() => output.emit({ type: 'rows', rows: [{ message }] })).toThrow('closed');
      });
      source.close();
      source.close();
      expect(retired).toBe(1);
      expect(source.signal.aborted).toBe(true);
      const next = ledger.openProducer('chat-1', 'test');
      const replacement = localEmissionSink(next.sink);
      expect(next.signal.aborted).toBe(false);
      expect(() => output.emit({ type: 'rows', rows: [{ message }] })).toThrow('closed');
      expect(ledger.currentRows('chat-1')).toHaveLength(1);
      replacement.emit({ type: 'rows', rows: [{ message }] });
      expect(ledger.currentRows('chat-1').map((row) => row.ordinal)).toEqual([1, 2]);
      ledger.close();
      expect(next.signal.aborted).toBe(true);
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('producer lifetime spans run termination and ends on view replacement or deletion', async () => {
    const directory = await mkdtemp(join(homedir(), 'garcon-producer-lifetime-'));
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory));
    try {
      ledger.initializeChat('chat-1');
      const source = ledger.openProducer('chat-1', 'test');
      ledger.beginRun('chat-1', 'synthetic-run');
      source.sink.publish({ type: 'run-ended', runId: 'synthetic-run', outcome: 'finished' });
      expect(source.signal.aborted).toBe(false);
      source.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-09-09T00:00:00.000Z', 'synthetic late answer') }] });
      expect(ledger.currentRows('chat-1')).toHaveLength(2);
      const current = ledger.currentView('chat-1');
      const staging = ledger.stageView('chat-1', [], 1);
      ledger.replaceCurrentView('chat-1', current.viewId, staging.viewId);
      expect(source.signal.aborted).toBe(true);
      const next = ledger.openProducer('chat-1', 'test');
      expect(next.signal).not.toBe(source.signal);
      expect(next.signal.aborted).toBe(false);
      ledger.deleteChat('chat-1');
      expect(next.signal.aborted).toBe(true);
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

  test.each(['producer', 'replacement', 'deletion', 'shutdown'])('close notification cannot re-enter producer creation during %s', async (transition) => {
    const directory = await mkdtemp(join(homedir(), 'garcon-producer-retirement-'));
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(directory));
    try {
      const current = ledger.initializeChat('chat-1');
      const source = ledger.openProducer('chat-1', 'test');
      let rejected = false;
      source.signal.addEventListener('abort', () => {
        try { ledger.openProducer('chat-1', 'test'); }
        catch { rejected = true; }
      }, { once: true });
      if (transition === 'replacement') {
        const staging = ledger.stageView('chat-1', [], 1);
        ledger.replaceCurrentView('chat-1', current.viewId, staging.viewId);
      } else if (transition === 'deletion') ledger.deleteChat('chat-1');
      else if (transition === 'shutdown') ledger.close();
      else source.close();
      expect(rejected).toBe(true);
      if (transition === 'producer' || transition === 'replacement') {
        expect(ledger.openProducer('chat-1', 'test').closed).toBe(false);
      }
    } finally {
      ledger.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
