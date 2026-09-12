import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { garconIssueResultContent, issueCommandOutcome } from '../../../common/garcon-issue-result.js';
import { TranscriptLedgerService } from '../service.js';
import { TranscriptLedgerStore } from '../store.js';
import { ledgerRowsToTranscriptMessages } from '../presentation.js';
import { importedDrafts, frozenDrafts } from '../imported-drafts.js';
import { projectFinalResponse } from '../final-response.js';
import { isLedgerPrivateGarconCommandRow } from '../garcon-command-request.js';

const CHAT = '1000000000000001';
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';
const CREATE = '<garcon-issue-create ref="create">{"title":"Synthetic issue"}</garcon-issue-create>';
const READ = '<garcon-issue-read issue-id="ISS-1" />';
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(request = () => {}) {
  const directory = mkdtempSync(join(homedir(), 'garcon-issue-ledger-'));
  const store = new TranscriptLedgerStore(directory);
  const ledger = new TranscriptLedgerService(store, { issueCommands: { request } });
  cleanups.push(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ledger };
}

describe('issue command ledger evidence', () => {
  test('commits exact private source evidence before dispatch and hides it through shared folds', () => {
    const calls = [];
    const { ledger, store } = fixture((source, command) => {
      const rows = ledger.currentRows(CHAT);
      expect(rows).toHaveLength(3);
      expect(rows[source.requestOrdinal - 1].detail.command).toEqual(command);
      calls.push(source);
    });
    const view = ledger.initializeChat(CHAT);
    const lease = ledger.openProducer(CHAT, 'synthetic');
    ledger.beginRun(CHAT, 'synthetic-run');
    lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, `${CREATE}\nVisible summary.\n${READ}`) }] });
    expect(calls.map((source) => source.requestOrdinal)).toEqual([2, 3]);
    expect(calls.every((source) => source.viewId === view.viewId && source.runId === 'synthetic-run')).toBe(true);
    const rows = ledger.currentRows(CHAT);
    expect(rows.slice(1).every(isLedgerPrivateGarconCommandRow)).toBe(true);
    expect(ledgerRowsToTranscriptMessages(rows)).toEqual([{ ordinal: 1, message: new AssistantMessage(AT, 'Visible summary.') }]);
    expect(ledger.conversationMessages(CHAT)).toEqual([new AssistantMessage(AT, 'Visible summary.')]);
    expect(JSON.stringify(rows)).not.toContain('synthetic-run');
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 3, at: AT });
    store.closeChat(CHAT);
    expect(ledger.currentRows(CHAT)).toEqual(rows);
    expect(projectFinalResponse({ type: 'text', text: `${CREATE}\nVisible summary.\n${READ}` }))
      .toEqual({ type: 'text', text: 'Visible summary.' });
    expect(calls).toHaveLength(2);
  });

  test('failed atomic append never dispatches an issue request', () => {
    const calls = [];
    const { ledger, store } = fixture((...args) => calls.push(args));
    ledger.initializeChat(CHAT);
    const lease = ledger.openProducer(CHAT, 'synthetic');
    const append = spyOn(store, 'append').mockImplementation(() => { throw new Error('Synthetic commit failure'); });
    try {
      expect(() => lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, CREATE) }] })).toThrow();
      expect(calls).toEqual([]);
    } finally { append.mockRestore(); }
  });

  test('imports requests and compact results without execution, preserving native evidence only on imports', () => {
    const calls = [];
    const { ledger, store } = fixture((...args) => calls.push(args));
    const view = ledger.initializeChat(CHAT);
    const result = { command: 'create', ref: 'create', issueId: 'ISS-1', requestViewId: view.viewId,
      requestOrdinal: 7, status: 'ok', data: { storeId: '33333333-3333-4333-8333-333333333333',
        issueId: 'ISS-1', revision: 1, status: 'open', collectionRevision: 1 } };
    const outcome = issueCommandOutcome(result);
    const drafts = importedDrafts([
      { message: new AssistantMessage(AT, CREATE), providerMeta: null },
      { message: new UserMessage(LATER, garconIssueResultContent(result)), providerMeta: null },
    ], () => AT);
    expect(drafts[0].detail.type).toBe('issue-command-request');
    expect(drafts[1].detail).toEqual({ ...outcome, title: 'Issue command', nativeResultInput: true });
    const staged = ledger.stageView(CHAT, drafts, 1);
    ledger.replaceCurrentView(CHAT, view.viewId, staged.viewId);
    store.closeChat(CHAT);
    const rendered = ledgerRowsToTranscriptMessages(ledger.currentRows(CHAT));
    expect(rendered).toHaveLength(1);
    expect(rendered[0].message.detail).toEqual(outcome);
    expect(JSON.stringify(rendered)).not.toContain('nativeResultInput');
    expect(JSON.stringify(rendered)).not.toContain('storeId');
    expect(ledger.conversationMessages(CHAT)).toEqual([]);
    expect(frozenDrafts(rendered.map(({ message }) => message))).toEqual([]);
    expect(calls).toEqual([]);
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 2, at: LATER });
    ledger.appendNotice(CHAT, staged.viewId, { at: '2026-01-01T01:00:00.000Z', title: 'Issue command',
      content: 'Local outcome.', detail: outcome });
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 2, at: LATER });
  });

  test('read results never persist descriptions or comments in imported notices', () => {
    const { ledger } = fixture();
    const view = ledger.initializeChat(CHAT);
    const version = { storeId: '33333333-3333-4333-8333-333333333333', collectionRevision: 1 };
    const result = { command: 'read', issueId: 'ISS-1', requestViewId: view.viewId, requestOrdinal: 1,
      status: 'ok', data: { ...version, issue: { id: 'ISS-1', number: 1, revision: 1,
        title: 'Synthetic hidden title', description: 'Synthetic hidden description', project: 'Synthetic hidden project',
        status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
        createdAt: AT, updatedAt: AT, createdBy: { kind: 'chat', chatId: CHAT, provenance: 'observed' } },
        links: [], comments: { ...version, items: [], nextBeforeSequence: null } } };
    const drafts = importedDrafts([{ message: new UserMessage(AT, garconIssueResultContent(result)), providerMeta: null }], () => AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('notice');
    expect(drafts[0].detail).toMatchObject({ command: 'read', status: 'ok', issueId: 'ISS-1', revision: 1 });
    expect(JSON.stringify(drafts)).not.toContain('Synthetic hidden');
  });
});
