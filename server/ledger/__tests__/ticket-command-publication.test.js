import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { garconTicketResultContent, ticketCommandOutcome } from '../../../common/garcon-ticket-result.js';
import { ticketCommandNoticeText } from '../../../common/ticket-command-notice.js';
import { TranscriptLedgerService } from '../service.js';
import { TranscriptLedgerStore } from '../store.js';
import { ledgerRowsToTranscriptMessages } from '../presentation.js';
import { importedDrafts, frozenDrafts } from '../imported-drafts.js';
import { projectFinalResponse } from '../final-response.js';
import { isLedgerPrivateGarconCommandRow } from '../garcon-command-request.js';
import { garconCommandRejectionContent, TICKET_COMMAND_REJECTION_GUIDANCE } from '../../../common/garcon-command-rejection.js';

const CHAT = '1000000000000001';
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:01:00.000Z';
const CREATE = '<garcon-ticket-create ref="create">{"title":"Synthetic ticket"}</garcon-ticket-create>';
const READ = '<garcon-ticket-read ticket-id="G-1" />';
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(request = () => {}, reject = () => {}) {
  const directory = mkdtempSync(join(homedir(), 'garcon-ticket-ledger-'));
  const store = new TranscriptLedgerStore(directory);
  const ledger = new TranscriptLedgerService(store, { ticketCommands: { request }, commandRejections: { reject } });
  cleanups.push(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ledger };
}

describe('ticket command ledger evidence', () => {
  test('commits malformed text and notices before one grouped rejection per assistant message', () => {
    const calls = [];
    const { ledger, store } = fixture(() => { throw new Error('Rejected command executed'); }, (source, issues) => {
      const rows = ledger.currentRows(CHAT);
      expect(rows[source.noticeOrdinal - 1].kind).toBe('notice');
      expect(rows[0].message.content).toBe(malformed);
      expect(rows.filter((row) => row.kind === 'notice')).toHaveLength(2);
      calls.push({ source, issues });
    });
    const malformed = '<garcon-ticket-create>{}</garcon-ticket-create>\nSummary.\n<garcon-ticket-read />';
    const view = ledger.initializeChat(CHAT);
    const lease = ledger.openProducer(CHAT, 'synthetic');
    lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, malformed) }] });
    expect(calls).toEqual([{ source: { chatId: CHAT, viewId: view.viewId, noticeOrdinal: 2 }, issues: [
      { command: 'ticket-create', reason: 'malformed', edge: 'leading' },
      { command: 'ticket-read', reason: 'malformed', edge: 'trailing' },
    ] }]);
    store.closeChat(CHAT);
    expect(ledger.currentRows(CHAT)).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

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

  test('failed atomic append never dispatches a ticket request', () => {
    const calls = [];
    const { ledger, store } = fixture((...args) => calls.push(args), (...args) => calls.push(args));
    ledger.initializeChat(CHAT);
    const lease = ledger.openProducer(CHAT, 'synthetic');
    const append = spyOn(store, 'append').mockImplementation(() => { throw new Error('Synthetic commit failure'); });
    try {
      expect(() => lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, `${CREATE}\n<garcon-ticket-read />`) }] })).toThrow();
      expect(calls).toEqual([]);
    } finally { append.mockRestore(); }
  });

  test('keeps valid dispatch independent of rejection and excludes other command families and examples', () => {
    const calls = [];
    const { ledger } = fixture((source) => calls.push(['request', source.requestOrdinal]),
      (source, issues) => calls.push(['rejection', source.noticeOrdinal, issues]));
    ledger.initializeChat(CHAT);
    const lease = ledger.openProducer(CHAT, 'synthetic');
    const malformed = '<garcon-ticket-read />';
    lease.sink.publish({ type: 'rows', rows: [
      { message: new AssistantMessage(AT, `${CREATE}\n${malformed}`) },
      { message: new AssistantMessage(AT, '<garcon-start-agent />') },
      { message: new AssistantMessage(AT, `\`\`\`xml\n${malformed}\n\`\`\``) },
      { message: new UserMessage(AT, malformed) },
      { message: new AssistantMessage(AT, malformed) },
    ] });
    expect(calls).toEqual([
      ['request', 2],
      ['rejection', 3, [{ command: 'ticket-read', reason: 'malformed', edge: 'leading' }]],
      ['rejection', 9, [{ command: 'ticket-read', reason: 'malformed', edge: 'leading' }]],
    ]);
  });

  test('imports exact rejection feedback as private native evidence, never user conversation or new work', () => {
    const calls = [];
    const { ledger, store } = fixture((...args) => calls.push(args), (...args) => calls.push(args));
    const view = ledger.initializeChat(CHAT);
    const malformed = '<garcon-ticket-create>{}</garcon-ticket-create>';
    const feedback = garconCommandRejectionContent({
      issues: [{ command: 'ticket-create', reason: 'malformed', edge: 'leading' }],
      message: TICKET_COMMAND_REJECTION_GUIDANCE,
    });
    const drafts = importedDrafts([
      { message: new AssistantMessage(AT, malformed), providerMeta: null },
      { message: new UserMessage(LATER, feedback), providerMeta: null },
    ], () => AT);
    expect(drafts.map((draft) => draft.kind)).toEqual(['provider-row', 'notice']);
    expect(drafts[0].message.content).toBe(malformed);
    expect(drafts[1].detail.type).toBe('garcon-command-rejection-input');
    const staged = ledger.stageView(CHAT, drafts, 1);
    ledger.replaceCurrentView(CHAT, view.viewId, staged.viewId);
    store.closeChat(CHAT);
    const rows = ledger.currentRows(CHAT);
    const rendered = ledgerRowsToTranscriptMessages(rows);
    expect(rendered[1].message.content).toBe('Garcon could not parse a ticket-create command.');
    expect(rendered[1].message.detail).toBeUndefined();
    expect(JSON.stringify(rendered)).not.toContain('garcon-command-rejection-input');
    expect(ledger.conversationMessages(CHAT)).toEqual([new AssistantMessage(AT, malformed)]);
    expect(frozenDrafts(rendered.map(({ message }) => message)).map((draft) => draft.kind)).toEqual(['provider-row']);
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 2, at: LATER });
    expect(calls).toEqual([]);
    for (const content of [`Prose.\n${feedback}`, `${feedback}\nProse.`, '<garcon-command-rejected>invalid</garcon-command-rejected>']) {
      expect(importedDrafts([{ message: new UserMessage(AT, content), providerMeta: null }], () => AT)[0].kind).toBe('user-input');
    }
  });

  test('imports requests and compact results without execution, preserving native evidence only on imports', () => {
    const calls = [];
    const { ledger, store } = fixture((...args) => calls.push(args));
    const view = ledger.initializeChat(CHAT);
    const result = { command: 'create', ref: 'create', ticketId: 'G-1', requestViewId: view.viewId,
      requestOrdinal: 7, status: 'ok', data: { storeId: '33333333-3333-4333-8333-333333333333',
        ticketId: 'G-1', revision: 1, status: 'open', collectionRevision: 1 } };
    const outcome = ticketCommandOutcome(result);
    const drafts = importedDrafts([
      { message: new AssistantMessage(AT, CREATE), providerMeta: null },
      { message: new UserMessage(LATER, garconTicketResultContent(result)), providerMeta: null },
    ], () => AT);
    expect(drafts[0].detail.type).toBe('ticket-command-request');
    expect(drafts[1].detail).toEqual({ ...outcome, nativeResultInput: true });
    expect(drafts[1].message).toBe('Created ticket G-1');
    const staged = ledger.stageView(CHAT, drafts, 1);
    ledger.replaceCurrentView(CHAT, view.viewId, staged.viewId);
    store.closeChat(CHAT);
    const rendered = ledgerRowsToTranscriptMessages(ledger.currentRows(CHAT));
    expect(rendered).toHaveLength(1);
    expect(rendered[0].message.detail).toEqual(outcome);
    expect(rendered[0].message.title).toBeUndefined();
    expect(JSON.stringify(rendered)).not.toContain('nativeResultInput');
    expect(JSON.stringify(rendered)).not.toContain('storeId');
    expect(ledger.conversationMessages(CHAT)).toEqual([]);
    expect(frozenDrafts(rendered.map(({ message }) => message))).toEqual([]);
    expect(calls).toEqual([]);
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 2, at: LATER });
    ledger.appendNotice(CHAT, staged.viewId, { at: '2026-01-01T01:00:00.000Z',
      content: 'Local outcome.', detail: outcome });
    expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 2, at: LATER });
  });

  test('live and imported outcomes retain the same safe filter and relationship context', () => {
    const { ledger } = fixture();
    const view = ledger.initializeChat(CHAT);
    for (const [command, context] of [
      ['list', { filters: { project: 'Synthetic `[group]`', priority: 1 } }],
      ['link', { link: { kind: 'blocks', targetId: 'G-2' } }],
    ]) {
      const result = { command, context, ref: 'synthetic', requestViewId: view.viewId, requestOrdinal: 1,
        ...(command === 'list' ? {} : { ticketId: 'G-1' }), status: 'error',
        errorCode: 'TICKET_COMMANDS_DISABLED', message: 'Synthetic failure.' };
      const detail = ticketCommandOutcome(result);
      ledger.appendNotice(CHAT, view.viewId, { at: AT, detail, content: ticketCommandNoticeText(detail) });
      const drafts = importedDrafts([{ message: new UserMessage(AT, garconTicketResultContent(result)), providerMeta: null }], () => AT);
      expect(drafts[0].detail).toEqual({ ...detail, nativeResultInput: true });
      const live = ledgerRowsToTranscriptMessages(ledger.currentRows(CHAT)).at(-1).message;
      expect(live.detail.context).toEqual(context);
      expect(live.content).toBe(drafts[0].message);
      expect(live.title).toBeUndefined();
    }
  });

  test('read results never persist descriptions or comments in imported notices', () => {
    const { ledger } = fixture();
    const view = ledger.initializeChat(CHAT);
    const version = { storeId: '33333333-3333-4333-8333-333333333333', collectionRevision: 1 };
    const result = { command: 'read', ticketId: 'G-1', requestViewId: view.viewId, requestOrdinal: 1,
      status: 'ok', data: { ...version, ticket: { id: 'G-1', number: 1, revision: 1,
        title: 'Synthetic hidden title', description: 'Synthetic hidden description', project: 'Synthetic hidden project',
        status: 'open', resolution: null, priority: 2, labels: [], assignee: null, parentId: null,
        createdAt: AT, updatedAt: AT, createdBy: { kind: 'chat', chatId: CHAT, provenance: 'observed' } },
        links: [], comments: { ...version, items: [], nextBeforeSequence: null } } };
    const drafts = importedDrafts([{ message: new UserMessage(AT, garconTicketResultContent(result)), providerMeta: null }], () => AT);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].kind).toBe('notice');
    expect(drafts[0].detail).toMatchObject({ command: 'read', status: 'ok', ticketId: 'G-1', revision: 1 });
    expect(JSON.stringify(drafts)).not.toContain('Synthetic hidden');
  });
});
