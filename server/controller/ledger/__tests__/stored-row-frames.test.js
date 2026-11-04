import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../../common/chat-types.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { transcriptViewId } from '../contracts.ts';
import { LedgerBulkOperationAbandonedError, LedgerFencedError, StaleTranscriptViewError, UNDECODABLE_LEDGER_ROW } from '../errors.ts';

const at = '2026-01-01T00:00:00.000Z';
let root, store, watermark;
const row = (content = 'Synthetic response') => ({ kind: 'provider-row', at, message: new AssistantMessage(at, content) });

beforeEach(() => {
  const scratch = path.join(homedir(), 'tmp');
  mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(path.join(scratch, 'display-source-'));
  store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
  const view = store.initializeCurrentView('source', { contentStartOrdinal: 1, rows: Array.from({ length: 600 }, () => row()) });
  watermark = { viewId: view.viewId, ordinal: 600 };
});

afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

test('streams bounded undecoded frames with consumer backpressure and resumes from a frontier', async () => {
  const sizes = [];
  const ordinals = [];
  await store.withStoredRowFrames('source', watermark, 257, async frames => {
    for await (const frame of frames) {
      sizes.push(frame.length);
      ordinals.push(...frame.map(row => row.ordinal));
      expect(frame[0]).toHaveProperty('payload_json');
      expect(frame[0]).not.toHaveProperty('message');
      await Promise.resolve();
    }
  });
  expect(sizes).toEqual([256, 88]);
  expect(ordinals).toEqual(Array.from({ length: 344 }, (_, i) => i + 257));
  let framesRead = 0;
  await store.withStoredRowFrames('source', watermark, 1, async frames => {
    for await (const frame of frames) { framesRead += 1; expect(frame).toHaveLength(256); break; }
  });
  expect(framesRead).toBe(1);
});

test('revalidates the view even when a consumer exits after its first frame', async () => {
  const staged = await store.stageView('source', { viewId: transcriptViewId('replacement'), contentStartOrdinal: 1, rows: [] });
  await expect(store.withStoredRowFrames('source', watermark, 1, async frames => {
    for await (const _frame of frames) { store.replaceCurrentView('source', watermark.viewId, staged.viewId); break; }
  })).rejects.toBeInstanceOf(StaleTranscriptViewError);
});

test('deleted chats are not recreated by a late frame or point-read completion', async () => {
  await expect(store.withStoredRowsByOrdinals('source', watermark, [1], async () => {
    store.deleteChat('source');
  })).rejects.toBeInstanceOf(LedgerBulkOperationAbandonedError);
  expect(existsSync(path.join(root, 'source'))).toBe(false);
});

test('worker decode failures fence only the still-current source, not derived failures', async () => {
  const derived = new Error('Synthetic derived failure');
  await expect(store.withStoredRowFrames('source', watermark, 1, async () => { throw derived; })).rejects.toBe(derived);
  expect(store.currentView('source').viewId).toBe(watermark.viewId);
  const decode = Object.assign(new Error('Synthetic undecodable row'), { code: UNDECODABLE_LEDGER_ROW });
  await expect(store.withStoredRowsByOrdinals('source', watermark, [1], async () => { throw decode; })).rejects.toThrow();
  expect(() => store.currentView('source')).toThrow(LedgerFencedError);
});

test('captures the recovered head before ordinal regrowth and retains it across LRU eviction', () => {
  store.close();
  const db = new Database(path.join(root, 'source', 'ledger.sqlite'));
  db.run('DELETE FROM transcript_rows WHERE ordinal > 300');
  db.close();
  store = new TranscriptLedgerStore(root, { connectionCacheSize: 1 });
  expect(store.recoveredHead('source')).toEqual({ ...watermark, ordinal: 300 });
  store.append('source', watermark.viewId, [row('Replacement content')]);
  store.initializeCurrentView('other', { contentStartOrdinal: 1, rows: [] });
  expect(store.recoveredHead('source')).toEqual({ ...watermark, ordinal: 300 });
  expect(store.storedRowsByOrdinals('source', { ...watermark, ordinal: 301 }, [301])[0].payload_json).toContain('Replacement content');
});

test('validates bounded point addresses before touching the source', () => {
  expect(() => store.storedRowsByOrdinals('source', watermark, Array(201).fill(1))).toThrow(TypeError);
  expect(() => store.storedRowsByOrdinals('source', watermark, [601])).toThrow(TypeError);
  expect(store.storedRowsByOrdinals('source', watermark, [2, 2, 1]).map(row => row.ordinal)).toEqual([2, 1]);
});
