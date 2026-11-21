import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolResultMessage, UserMessage } from '../../../../common/chat-types.js';
import type { JsonValue } from '../../../../common/json.js';
import { LedgerActivityWorker } from '../activity-worker.js';
import type { LedgerRowDraft } from '../contracts.js';
import { LedgerFencedError, UNDECODABLE_LEDGER_ROW } from '../errors.js';
import { TranscriptLedgerStore } from '../store.js';
import { readLedgerRunOutcome } from '../activity-query.js';
import { withPromiseTimeout } from '../../../common/promise-timeout.js';

let directory: string;
let store: TranscriptLedgerStore;
const at = '2026-01-01T00:00:00Z';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ledger-activity-'));
  store = new TranscriptLedgerStore(directory);
});

afterEach(async () => {
  store.close();
  await rm(directory, { recursive: true, force: true });
});

test.each([
  {
    name: 'tool result', expected: 'failed',
    row: (nested: JsonValue): LedgerRowDraft => ({
      kind: 'provider-row', at, message: new ToolResultMessage(at, 'tool-1', { nested }, false),
    }),
  },
  {
    name: 'imported input', expected: null,
    row: (nested: JsonValue): LedgerRowDraft => ({
      kind: 'provider-row', at, message: new UserMessage(at, 'Synthetic input'), providerMeta: { nested },
    }),
  },
  {
    name: 'terminal', expected: 'finished',
    row: (nested: JsonValue): LedgerRowDraft => ({
      kind: 'run-ended', at, outcome: 'finished', origin: 'provider', providerMeta: { nested },
    }),
  },
])('reads valid JSON beyond SQLite depth limits: $name', async ({ row, expected }) => {
  let nested: JsonValue = 'Synthetic leaf';
  for (let depth = 0; depth < 1_100; depth++) nested = [nested];
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome: 'failed', origin: 'provider' },
    row(nested),
  ] });
  expect(store.currentRows('chat')).toHaveLength(2);
  expect(await store.lastRunOutcome('chat', view.viewId)).toBe(expected);
  expect(store.currentRows('chat')).toHaveLength(2);
  store.append('chat', view.viewId, [{ kind: 'run-ended', at, outcome: 'finished', origin: 'provider' }]);
  expect(await store.lastRunOutcome('chat', view.viewId)).toBe('finished');
});

test('waits for a real SQLite lock before reading the outcome', async () => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1 });
  store.append('chat', view.viewId, [{ kind: 'run-ended', at, outcome: 'finished', origin: 'provider' }]);
  store.close();
  const databasePath = join(directory, 'chat', 'ledger.sqlite');
  const locker = Bun.spawn([process.execPath, '--eval', `
    import { Database } from 'bun:sqlite';
    const db = new Database(${JSON.stringify(databasePath)});
    try {
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      db.query('SELECT count(*) FROM transcript_rows').get();
      console.log('locked');
      await Bun.stdin.text();
      await Bun.sleep(400);
      db.exec('COMMIT');
    } finally { db.close(); }
  `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const ready = locker.stdout.getReader();
  try {
    const signal = await withPromiseTimeout(ready.read(), 5_000, 'exclusive SQLite lock');
    expect(signal.done).toBe(false);
    const probe = new Database(databasePath, { readonly: true, create: false });
    try {
      expect(() => probe.query('SELECT count(*) FROM transcript_rows').get()).toThrow('database is locked');
    } finally {
      probe.close();
    }
    void locker.stdin.end();
    expect(readLedgerRunOutcome({ kind: 'read-run-outcome', databasePath, viewId: view.viewId, beforeOrdinal: 2 }))
      .toBe('finished');
  } finally {
    void locker.stdin.end();
    expect(await locker.exited).toBe(0);
    expect(await new Response(locker.stderr).text()).toBe('');
    ready.releaseLock();
  }
});

test.each([
  'SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY', 'SQLITE_LOCKED', 'SQLITE_CANTOPEN',
  'SQLITE_IOERR', 'SQLITE_NOMEM', 'SQLITE_INTERRUPT', 'SQLITE_ERROR',
])('keeps the primary ledger readable and writable after worker %s', async code => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1 });
  const failure = Object.assign(new Error('Synthetic secondary reader failure'), { code });
  const read = spyOn(LedgerActivityWorker.prototype, 'read').mockRejectedValue(failure);
  try {
    await expect(store.lastRunOutcome('chat', view.viewId)).rejects.toBe(failure);
    expect(store.currentRows('chat')).toEqual([]);
    store.append('chat', view.viewId, [{ kind: 'run-ended', at, outcome: 'finished', origin: 'provider' }]);
  } finally {
    read.mockRestore();
  }
  expect(await store.lastRunOutcome('chat', view.viewId)).toBe('finished');
  expect(store.currentRows('chat')).toHaveLength(1);
});

test.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX', 'SQLITE_NOTADB', UNDECODABLE_LEDGER_ROW])(
  'retains the primary ledger fence for worker %s', async code => {
    const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1 });
    const failure = Object.assign(new Error('Synthetic corrupt storage'), { code });
    const read = spyOn(LedgerActivityWorker.prototype, 'read').mockRejectedValue(failure);
    try {
      await expect(store.lastRunOutcome('chat', view.viewId)).rejects.toBeInstanceOf(LedgerFencedError);
      expect(() => store.currentRows('chat')).toThrow(LedgerFencedError);
      expect(() => store.append('chat', view.viewId, [
        { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
      ])).toThrow(LedgerFencedError);
    } finally {
      read.mockRestore();
    }
  },
);
