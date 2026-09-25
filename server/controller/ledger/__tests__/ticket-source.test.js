import { afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TranscriptLedgerStore } from '../store.js';
import { TranscriptLedgerService } from '../service.js';
import { TranscriptViewReader } from '../view-reader.js';
import { TICKET_OUTCOME_QUERY_SQL } from '../ticket-outcome-query.js';
import { StaleTranscriptViewError } from '../errors.js';
import { TranscriptHistoryUnavailableError } from '../../chats/errors.js';

const CHAT = '1000000000000001';
const VIEW = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AT = '2026-01-01T00:00:00.000Z';
const source = { chatId: CHAT, transcriptViewId: VIEW, ordinal: 1 };
let directory, store, ledger, reader;
const adoption = { ensure() { throw new Error('Source lookup must not adopt'); } };
const notice = (requestOrdinal = 1, requestViewId = VIEW) => ({ kind: 'notice', at: AT,
  providerMeta: null, message: 'Synthetic ticket outcome', detail: {
    type: 'ticket-command-outcome', command: 'create', ref: 'synthetic', status: 'ok',
    ticketId: 'G-1', revision: 1, requestViewId, requestOrdinal,
  } });

beforeEach(() => {
  directory = mkdtempSync(join(homedir(), 'garcon-ticket-source-'));
  store = new TranscriptLedgerStore(directory);
  ledger = new TranscriptLedgerService(store);
  reader = new TranscriptViewReader(ledger, adoption);
});
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

test('finds only exact correlation, deterministically, without scanning or changing source facts', async () => {
  store.initializeCurrentView(CHAT, { viewId: VIEW, contentStartOrdinal: 1, rows: [
    { kind: 'notice', at: AT, providerMeta: null, message: 'Synthetic private request', detail: {
      type: 'ticket-command-request', command: { type: 'ticket', ref: 'synthetic',
        payload: { action: 'create', input: { title: 'Synthetic ticket' } } },
    } }, notice(1, OTHER), notice(2), notice(), notice(),
  ] });
  expect(await reader.resolveTicketSource(source)).toEqual({ kind: 'found', target: { ...source, ordinal: 4 } });
  expect(source.ordinal).toBe(1);
  expect(await reader.resolveTicketSource({ ...source, ordinal: 99 }))
    .toEqual({ kind: 'outcome-unavailable', chatId: CHAT });
  const db = new Database(join(directory, CHAT, 'ledger.sqlite'));
  try {
    const plan = db.query(`EXPLAIN QUERY PLAN ${TICKET_OUTCOME_QUERY_SQL}`).all(VIEW, VIEW, 1);
    expect(plan.map((row) => row.detail).join(' ')).toContain('USING INDEX transcript_ticket_outcome_correlation');
    expect(plan.map((row) => row.detail).join(' ')).not.toContain('SCAN transcript_rows');
  } finally { db.close(); }
});

test('migrates schema v1 transactionally on lazy open without rewriting row addresses', async () => {
  store.initializeCurrentView(CHAT, { viewId: VIEW, contentStartOrdinal: 1, rows: [notice()] });
  const original = store.currentRows(CHAT);
  store.closeChat(CHAT);
  const db = new Database(join(directory, CHAT, 'ledger.sqlite'));
  db.exec('DROP INDEX transcript_ticket_outcome_correlation; PRAGMA user_version = 1');
  db.close();
  expect(await reader.resolveTicketSource(source)).toEqual({ kind: 'found', target: source });
  expect(store.currentRows(CHAT)).toEqual(original);
  store.closeChat(CHAT);
  const migrated = new Database(join(directory, CHAT, 'ledger.sqlite'));
  try { expect(migrated.query('PRAGMA user_version').get().user_version).toBe(2); }
  finally { migrated.close(); }
  expect(await reader.resolveTicketSource(source)).toEqual({ kind: 'found', target: source });
});

test('never recovers old correlation from an imported replacement view', async () => {
  store.initializeCurrentView(CHAT, { viewId: VIEW, contentStartOrdinal: 1, rows: [notice()] });
  store.stageView(CHAT, { viewId: OTHER, contentStartOrdinal: 1, rows: [notice()] });
  store.replaceCurrentView(CHAT, VIEW, OTHER);
  const lookup = spyOn(store, 'ticketOutcomeOrdinal');
  try {
    expect(await reader.resolveTicketSource(source)).toEqual({ kind: 'transcript-reloaded', chatId: CHAT });
    expect(lookup).not.toHaveBeenCalled();
    expect(() => store.ticketOutcomeOrdinal(CHAT, VIEW, 1)).toThrow(StaleTranscriptViewError);
  } finally { lookup.mockRestore(); }
});

test('absent ledgers are not created, cancellation propagates, corruption is not missing', async () => {
  expect(await reader.resolveTicketSource(source)).toEqual({ kind: 'outcome-unavailable', chatId: CHAT });
  expect(existsSync(join(directory, CHAT))).toBe(false);
  const abort = new AbortController();
  abort.abort(new Error('Synthetic cancellation'));
  await expect(reader.resolveTicketSource(source, abort.signal)).rejects.toThrow('Synthetic cancellation');
  store.initializeCurrentView(CHAT, { viewId: VIEW, contentStartOrdinal: 1 });
  store.closeChat(CHAT);
  const db = new Database(join(directory, CHAT, 'ledger.sqlite'));
  db.exec('PRAGMA user_version = 999');
  db.close();
  await expect(reader.resolveTicketSource(source)).rejects.toBeInstanceOf(TranscriptHistoryUnavailableError);
});
