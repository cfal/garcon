import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, BashToolUseMessage, ErrorMessage, UserMessage } from '../../../../common/chat-types.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { TranscriptLedgerService } from '../service.ts';
import { LedgerActivityWorker } from '../activity-worker.ts';
import { LedgerFencedError } from '../errors.ts';

const at = '2026-01-01T00:00:00.000Z';
let root, store, ledger;
const provider = (message) => ({ kind: 'provider-row', at, message });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ledger-preview-'));
  store = new TranscriptLedgerStore(root);
  ledger = new TranscriptLedgerService(store, { serverInstanceId: 'preview-test' });
});
afterEach(async () => {
  ledger.close();
  await rm(root, { recursive: true, force: true });
});

it.each(['finished', 'failed', 'interrupted'])('repairs %s activity through the read-only Worker', async (outcome) => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome, origin: 'provider' },
    ...Array.from({ length: 300 }, () => provider(new AssistantMessage(at, 'Generic output'))),
  ] });
  store.close();
  const fullRead = spyOn(store, 'currentRows').mockImplementation(() => { throw new Error('Full read'); });
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  expect(await ledger.lastRunOutcome('chat', view.viewId)).toBe(outcome);
  clearTimeout(timer);
  expect(timerRan).toBe(true);
  expect(fullRead).not.toHaveBeenCalled();
});

it.each([[64, 1024 * 1024], [1, 32 * 1024 * 1024]])('keeps controller timers responsive with %s provider rows of %s bytes', async (count, bytes) => {
  const content = 'x'.repeat(bytes);
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
    ...Array.from({ length: count }, () => provider(new AssistantMessage(at, content))),
  ] });
  const timer = Promise.withResolvers();
  const started = performance.now();
  setTimeout(() => timer.resolve(performance.now() - started), 0);
  const outcome = store.lastRunOutcome('chat', view.viewId);
  expect(await timer.promise).toBeLessThan(50);
  expect(await outcome).toBe('finished');
});

it('keeps activity reads at their captured high watermark', async () => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
  ] });
  const outcome = store.lastRunOutcome('chat', view.viewId);
  store.append('chat', view.viewId, [provider(new UserMessage(at, 'New generic input'))]);
  expect(await outcome).toBe('finished');
  expect(await store.lastRunOutcome('chat', view.viewId)).toBeNull();
});

it('rejects a read retired by view replacement or ledger close', async () => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
  ] });
  const staged = await store.stageView('chat', { viewId: 'new-view', contentStartOrdinal: 1, rows: [] });
  const oldOutcome = store.lastRunOutcome('chat', view.viewId).catch(error => error);
  store.replaceCurrentView('chat', view.viewId, staged.viewId);
  expect(await oldOutcome).toBeInstanceOf(Error);
  const pending = store.lastRunOutcome('chat', staged.viewId).catch(error => error);
  store.close();
  expect(await pending).toBeInstanceOf(Error);
});

it.each(['close-chat', 'delete-chat'])('fences %s across an activity Worker await without reopening storage', async operation => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [] });
  const pending = Promise.withResolvers();
  const read = spyOn(LedgerActivityWorker.prototype, 'read').mockImplementation(() => pending.promise);
  try {
    const outcome = store.lastRunOutcome('chat', view.viewId).catch(error => error);
    if (operation === 'delete-chat') store.deleteChat('chat');
    else store.closeChat('chat');
    pending.resolve('finished');
    expect(await outcome).toBeInstanceOf(Error);
    if (operation === 'delete-chat') {
      expect(await stat(path.join(root, 'chat')).catch(() => null)).toBeNull();
    }
  } finally {
    read.mockRestore();
  }
});

it.each(['malformed-json', 'invalid-outcome'])('fences genuine Worker query failure: %s', async failure => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    failure === 'malformed-json' ? provider(new AssistantMessage(at, 'Generic output'))
      : { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
  ] });
  store.close();
  const db = new Database(path.join(root, 'chat', 'ledger.sqlite'));
  try {
    db.query('UPDATE transcript_rows SET payload_json = ? WHERE ordinal = 1').run(
      failure === 'malformed-json' ? 'invalid'
        : JSON.stringify({ providerMeta: null, value: { outcome: 'invalid', origin: 'provider' } }),
    );
  } finally {
    db.close();
  }
  expect(await store.lastRunOutcome('chat', view.viewId).catch(error => error)).toBeInstanceOf(LedgerFencedError);
  expect(() => store.currentRows('chat')).toThrow(LedgerFencedError);
  expect(() => store.append('chat', view.viewId, [provider(new AssistantMessage(at, 'Generic next output'))]))
    .toThrow(LedgerFencedError);
});

it.each(['closed', 'capacity', 'worker-crash'])('does not fence healthy storage for %s activity work', async failure => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [] });
  const rejected = Object.assign(new Error(`Synthetic ${failure}`),
    failure === 'capacity' ? { code: 'TRANSCRIPT_WORK_BUSY' } : {});
  const read = spyOn(LedgerActivityWorker.prototype, 'read').mockRejectedValue(rejected);
  try {
    expect(await store.lastRunOutcome('chat', view.viewId).catch(error => error)).toBe(rejected);
    expect(store.currentRows('chat')).toEqual([]);
    store.append('chat', view.viewId, [provider(new AssistantMessage(at, 'Generic next output'))]);
    expect(store.currentRows('chat')).toHaveLength(1);
  } finally {
    read.mockRestore();
  }
});

it('does not carry a terminal result over newer accepted input', async () => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome: 'failed', origin: 'provider' },
    { kind: 'user-input', at, detail: {
      message: new UserMessage(at, 'New input'), attachments: [], clientMessageId: null, steer: false,
    } },
  ] });
  expect(await ledger.lastRunOutcome('chat', view.viewId)).toBeNull();
});

it.each(['finished', 'failed'])('clears %s activity for a newer provider user message on cold repair', async (outcome) => {
  const view = store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    { kind: 'run-ended', at, outcome, origin: 'provider' },
    provider(new UserMessage(at, 'Generic follow-up input')),
    provider(new AssistantMessage(at, 'Generic partial output')),
  ] });
  store.close();
  expect(await ledger.lastRunOutcome('chat', view.viewId)).toBeNull();
});

it('reads only bounded head/tail candidates, not the full ledger or intervening payloads', () => {
  const rows = Array.from({ length: 200 }, (_, i) => provider(new AssistantMessage(at, `response-${i}`)));
  rows[0] = provider(new UserMessage(at, 'first input'));
  const view = store.initializeCurrentView('chat', { rows, contentStartOrdinal: 1 });
  store.close();
  const db = new Database(path.join(root, 'chat', 'ledger.sqlite'));
  // Invalid middle data makes any accidental full-history decode fail.
  db.query("UPDATE transcript_rows SET payload_json = 'invalid' WHERE ordinal = 100").run();
  db.close();
  const readAll = spyOn(store, 'currentRows').mockImplementation(() => { throw new Error('Full read'); });
  const edges = store.previewEdges('chat', view.viewId);
  expect(edges.head).toHaveLength(32);
  expect(edges.tail).toHaveLength(32);
  expect(edges.tail[0].ordinal).toBe(169);
  expect(ledger.existingPreview('chat')).toMatchObject({
    first: { content: 'first input' }, last: { content: 'response-199' },
  });
  expect(readAll).not.toHaveBeenCalled();
});

it('skips oversized payloads, provider errors, and presentation-only rows', () => {
  const rows = [
    { kind: 'notice', at, message: 'not a preview', detail: {} },
    provider(new UserMessage(at, 'question')),
    provider(new AssistantMessage(at, 'answer')),
    provider(new AssistantMessage(at, 'x'.repeat(1024 * 1024))),
    provider(new ErrorMessage(at, 'not conversational')),
    { kind: 'run-ended', at, outcome: 'finished', origin: 'provider' },
  ];
  store.initializeCurrentView('chat', { rows, contentStartOrdinal: 1 });
  expect(ledger.existingPreview('chat')).toMatchObject({
    first: { content: 'question' }, last: { content: 'answer' },
  });
});

it('falls back to the first conversational row when the head has no user input', () => {
  store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    provider(new ErrorMessage(at, 'not conversational')),
    provider(new AssistantMessage(at, 'first answer')),
    provider(new AssistantMessage(at, 'last answer')),
    { kind: 'notice', at, message: 'not a preview', detail: {} },
  ] });
  expect(ledger.existingPreview('chat')).toMatchObject({
    first: { content: 'first answer' }, last: { content: 'last answer' },
  });
});

it('leaves previews absent when the tail has no conversational row', () => {
  const tail = Array.from({ length: 32 }, () => ({ kind: 'notice', at, message: 'notice', detail: {} }));
  store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    provider(new UserMessage(at, 'first input')), ...tail,
  ] });
  expect(ledger.existingPreview('chat')).toBeNull();
});

it.each([
  ['user-input', false], ['user-input', true], ['provider-row', false], ['provider-row', true],
])('defers repair past an oversized %s, later input=%p', (kind, laterInput) => {
  const message = new UserMessage(at, 'Original input', ['x'.repeat(1024 * 1024)]);
  const input = kind === 'provider-row' ? provider(message) : {
    kind, at, detail: { message, attachments: [], clientMessageId: null, steer: false },
  };
  store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [
    input, provider(new BashToolUseMessage(at, 'tool', 'pwd')),
    ...(laterInput ? [provider(new UserMessage(at, 'Later input'))] : []),
    provider(new AssistantMessage(at, 'answer')),
  ] });
  expect(ledger.existingPreview('chat')).toBeNull();
  expect(ledger.currentRows('chat')).toHaveLength(laterInput ? 4 : 3);
});

it('repairs on platform SQLite without octet_length and leaves the ledger writable', () => {
  store.initializeCurrentView('chat', { contentStartOrdinal: 1, rows: [provider(new UserMessage(at, 'question'))] });
  const originalQuery = Database.prototype.query;
  const query = spyOn(Database.prototype, 'query').mockImplementation(function(sql, ...args) {
    if (sql.includes('octet_length')) throw new Error('no such function: octet_length');
    return originalQuery.call(this, sql, ...args);
  });
  try {
    expect(ledger.existingPreview('chat').first.content).toBe('question');
    ledger.openProducer('chat', 'test').sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'answer') }] });
    expect(ledger.currentRows('chat')).toHaveLength(2);
  } finally {
    query.mockRestore();
  }
});

it('does not search beyond an empty bounded edge or materialize an absent ledger', async () => {
  const rows = Array.from({ length: 64 }, () => ({ kind: 'notice', at, message: 'notice', detail: {} }));
  rows.push(provider(new AssistantMessage(at, 'outside head budget')));
  store.initializeCurrentView('chat', { rows, contentStartOrdinal: 1 });
  expect(ledger.existingPreview('chat')).toBeNull();
  expect(ledger.existingPreview('missing')).toBeNull();
  await expect(stat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});
