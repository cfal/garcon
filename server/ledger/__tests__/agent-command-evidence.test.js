import { describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { garconCommandResultContent } from '../../../common/garcon-command-results.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { TranscriptLedgerService } from '../service.ts';
import { importedDrafts, frozenDrafts } from '../imported-drafts.ts';
import { ledgerRowsToTranscriptMessages } from '../presentation.ts';

const CHAT = '1000000000000000';
const AT = '2030-01-01T00:00:00.000Z';
const LATER = '2030-01-01T01:00:00.000Z';
const START = '<garcon-start-agent agent="codex" model="example">Inspect.</garcon-start-agent>';
const SCHEDULE = '<garcon-schedule every="5m" />';

async function withLedger(run, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-command-evidence-'));
  const store = new TranscriptLedgerStore(root);
  const ledger = new TranscriptLedgerService(store, options);
  try { await run({ ledger, store }); }
  finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
}

describe('agent command durable evidence', () => {
  it('commits mixed visible/private drafts before dispatch with each actual request ordinal', async () => {
    const calls = [];
    const starts = mock((source, command) => calls.push({ source, command }));
    const schedules = mock((source, command) => calls.push({ source, command }));
    await withLedger(async ({ ledger, store }) => {
      const view = ledger.initializeChat(CHAT);
      const lease = ledger.openProducer(CHAT, 'test');
      ledger.beginRun(CHAT, 'run-1');
      starts.mockImplementation((source, command) => {
        expect(ledger.currentRows(CHAT)).toHaveLength(5);
        calls.push({ source, command });
      });
      lease.sink.publish({ type: 'rows', rows: [
        { message: new AssistantMessage(AT, `${START}\nRetained\n${SCHEDULE}`) },
        { message: new AssistantMessage(AT, `${SCHEDULE}\n${START}`) },
      ] });
      expect(calls.map(({ source }) => source.requestOrdinal)).toEqual([2, 3, 4, 5]);
      expect(calls.every(({ source }) => source.viewId === view.viewId && source.chatId === CHAT && source.runId === 'run-1')).toBe(true);
      expect(ledgerRowsToTranscriptMessages(ledger.currentRows(CHAT))).toEqual([
        { ordinal: 1, message: new AssistantMessage(AT, 'Retained') },
      ]);
      store.closeChat(CHAT);
      expect(ledger.currentRows(CHAT)).toHaveLength(5);
    }, { agentStarts: { request: starts }, agentSchedules: { request: schedules } });
  });

  it('does not invoke either action when the atomic append fails', async () => {
    const request = mock(() => undefined);
    await withLedger(async ({ ledger, store }) => {
      ledger.initializeChat(CHAT);
      const lease = ledger.openProducer(CHAT, 'test');
      const append = spyOn(store, 'append').mockImplementation(() => { throw new Error('commit failed'); });
      try {
        expect(() => lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, `${START}\n${SCHEDULE}`) }] })).toThrow();
        expect(request).not.toHaveBeenCalled();
      } finally { append.mockRestore(); }
    }, { agentStarts: { request }, agentSchedules: { request } });
  });

  it('imports requests without actions and preserves historical correlation when ordinals shift', async () => {
    const request = mock(() => undefined);
    await withLedger(async ({ ledger }) => {
      const old = ledger.initializeChat(CHAT);
      const lease = ledger.openProducer(CHAT, 'test');
      ledger.appendNotice(CHAT, old.viewId, { at: AT, title: 'Local notice', content: 'Local-only notice', detail: {} });
      lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, `${START}\n${SCHEDULE}`) }] });
      expect(request).toHaveBeenCalledTimes(2);
      request.mockClear();
      const results = [
        { type: 'agent-start-outcome', requestViewId: old.viewId, requestOrdinal: 2, status: 'created', chatId: '2000000000000000' },
        { type: 'agent-schedule-outcome', requestViewId: old.viewId, requestOrdinal: 3, status: 'failed', reason: 'limit-reached' },
      ];
      const native = [new AssistantMessage(AT, `${START}\n${SCHEDULE}`),
        ...results.map((result) => new UserMessage(LATER, garconCommandResultContent(result))),
        new UserMessage(LATER, '<garcon-schedule-action />')];
      const drafts = importedDrafts(native.map((message) => ({ message, providerMeta: null })), () => AT);
      expect(drafts[2]).toMatchObject({ at: LATER, detail: { ...results[0], nativeResultInput: true } });
      const staged = ledger.stageView(CHAT, drafts, 1);
      ledger.replaceCurrentView(CHAT, old.viewId, staged.viewId);
      const rows = ledger.currentRows(CHAT);
      expect(rows.slice(0, 2).map((row) => row.ordinal)).toEqual([1, 2]);
      const rendered = ledgerRowsToTranscriptMessages(rows);
      expect(rendered.slice(0, 2).map((row) => row.message.detail)).toEqual(results);
      expect(rendered[2].message).toEqual(native.at(-1));
      expect(JSON.stringify(rendered)).not.toContain('nativeResultInput');
      expect(frozenDrafts(rendered.slice(0, 2).map((row) => row.message))).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    }, { agentStarts: { request }, agentSchedules: { request } });
  });

  it.each(['agent-start-outcome', 'agent-schedule-outcome'])('counts only imported %s results as native evidence', async (type) => {
    await withLedger(async ({ ledger, store }) => {
      const view = ledger.initializeChat(CHAT, [{ kind: 'provider-row', at: AT, message: new AssistantMessage(AT, 'Response'), providerMeta: null }]);
      const detail = { type, requestViewId: view.viewId, requestOrdinal: 1, status: 'failed', reason: 'action-failed' };
      for (const flag of [undefined, false, 'true', 1]) {
        ledger.appendNotice(CHAT, view.viewId, { at: LATER, title: 'Outcome', content: 'Outcome', detail: { ...detail, ...(flag === undefined ? {} : { nativeResultInput: flag }) } });
        expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 1, at: AT });
      }
      store.append(CHAT, view.viewId, importedDrafts([{ message: new UserMessage(LATER, garconCommandResultContent(detail)), providerMeta: null }], () => AT));
      expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 6, at: LATER });
      ledger.appendNotice(CHAT, view.viewId, { at: '2030-01-01T03:00:00.000Z', title: 'Outcome', content: 'Newer local outcome', detail });
      store.closeChat(CHAT);
      expect(ledger.nativeActivityState(CHAT).providerWatermark).toEqual({ ordinal: 6, at: LATER });
    });
  });
});
