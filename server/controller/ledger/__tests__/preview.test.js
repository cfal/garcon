import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, ErrorMessage, UserMessage } from '../../../../common/chat-types.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { TranscriptLedgerService } from '../service.ts';

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

it('does not search beyond an empty bounded edge or materialize an absent ledger', async () => {
  const rows = Array.from({ length: 64 }, () => ({ kind: 'notice', at, message: 'notice', detail: {} }));
  rows.push(provider(new AssistantMessage(at, 'outside head budget')));
  store.initializeCurrentView('chat', { rows, contentStartOrdinal: 1 });
  expect(ledger.existingPreview('chat')).toBeNull();
  expect(ledger.existingPreview('missing')).toBeNull();
  await expect(stat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
});
