import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSwitchMessage, AssistantMessage, BashToolUseMessage, UserMessage } from '../../../../common/chat-types.js';
import { LedgerFencedError, TranscriptSinkClosedError } from '../errors.js';
import { TranscriptLedgerService } from '../service.js';
import { TranscriptLedgerStore } from '../store.js';

const AT = '2026-11-23T00:00:00.000Z';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-observation-'));
  const request = mock(() => undefined);
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root), {
    now: () => AT, chatIdRequests: { request },
  });
  cleanup.push(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
  ledger.initializeChat('child');
  return { root, ledger, request, lease: ledger.openObservation('child') };
}

describe('passive observation acceptance', () => {
  it('[TLV5-OBSERVE.01-LEDGER-01] commits literal conversation before fanout without dispatch, input, or run facts', async () => {
    const { ledger, lease, request } = await fixture();
    const delivered = mock(() => undefined);
    ledger.subscribe(delivered);
    const markup = '<garcon-get-chat-id />';
    lease.publishRows([
      { message: new UserMessage(AT, 'Child input', undefined, { clientMessageId: 'submission', contentMode: 'literal' }) },
      { message: new AssistantMessage(AT, markup) },
      { message: new BashToolUseMessage(AT, 'tool', 'pwd') },
      { message: new AssistantMessage(AT, markup) },
    ]);
    expect(ledger.currentRows('child').map(row => row.kind)).toEqual(Array(4).fill('provider-row'));
    expect(delivered).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(ledger.resendCandidates('child')).toEqual([]);
    expect(ledger.isRunActive('child')).toBe(false);
    const messages = await ledger.conversationMessages('child');
    expect(messages[0]).toMatchObject({ type: 'user-message', content: 'Child input' });
    expect(messages[0]).toMatchObject({ metadata: undefined });
    expect(messages[1]).toMatchObject({ content: markup });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('snapshots provider data and strips actionable questions', async () => {
    const { ledger, lease } = await fixture();
    const message = new AssistantMessage(AT, 'Original', {
      id: 'set', questions: [{ id: 'question', prompt: 'Choose', options: [], allowFreeText: true }],
    });
    const providerMeta = { nativeId: 'original' };
    lease.publishRows([{ message, providerMeta }]);
    message.content = 'Mutated';
    providerMeta.nativeId = 'mutated';
    expect(ledger.currentRows('child')[0]).toMatchObject({
      message: { content: 'Original' }, providerMeta: { nativeId: 'original' },
    });
    expect(ledger.currentRows('child')[0]).toMatchObject({ message: { questions: undefined } });
  });

  it('drops invalid and control rows independently and coalesces gaps and statuses', async () => {
    const { ledger, lease } = await fixture();
    lease.publishRows([
      { message: new AgentSwitchMessage(AT, 'one', 'two') },
      { message: new AssistantMessage('', 'Invalid timestamp') },
      { message: new AssistantMessage(AT, 'Retained') },
    ]);
    lease.publishGap();
    lease.publishGap();
    lease.publishStatus('running');
    lease.publishStatus('running');
    lease.publishStatus('completed');
    expect(ledger.currentRows('child')).toMatchObject([
      { kind: 'provider-row', message: { content: 'Retained' } },
      { kind: 'notice', detail: { type: 'native-child-gap' } },
      { kind: 'notice', detail: { type: 'native-child-status', status: 'running' } },
      { kind: 'notice', detail: { type: 'native-child-status', status: 'completed' } },
    ]);
  });

  it('rejects competing writers and closes before deleted storage can reopen', async () => {
    const { ledger, lease, root } = await fixture();
    expect(() => ledger.openProducer('child', 'test')).toThrow();
    expect(() => ledger.openObservation('child')).toThrow();
    const closed = mock(() => undefined);
    lease.onClosed(closed);
    ledger.deleteChat('child');
    lease.close();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => lease.publishRows([{ message: new AssistantMessage(AT, 'Late') }])).toThrow(TranscriptSinkClosedError);
    expect(() => ledger.openObservation('child')).toThrow();
    expect(existsSync(path.join(root, 'child'))).toBe(false);
  });

  it('fences the captured view without appending to a replacement', async () => {
    const { ledger, lease } = await fixture();
    const old = ledger.currentView('child');
    const staged = await ledger.stageView('child', [], 1);
    ledger.replaceCurrentView('child', old!.viewId, staged.viewId);
    expect(() => lease.publishRows([{ message: new AssistantMessage(AT, 'Late') }])).toThrow(TranscriptSinkClosedError);
    expect(lease.closed).toBe(true);
    expect(ledger.currentRows('child')).toEqual([]);
  });

  it('contains genuine ledger failure to the child', async () => {
    const { ledger, lease, root } = await fixture();
    ledger.initializeChat('parent');
    const parent = ledger.openProducer('parent', 'test');
    ledger.beginRun('parent', 'parent-run');
    const db = new Database(path.join(root, 'child', 'ledger.sqlite'));
    db.exec("CREATE TRIGGER fail_write BEFORE INSERT ON transcript_rows BEGIN SELECT RAISE(FAIL, 'synthetic failure'); END");
    db.close();
    expect(() => lease.publishRows([{ message: new AssistantMessage(AT, 'Child') }])).toThrow(LedgerFencedError);
    expect(lease.closed).toBe(true);
    parent.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, 'Parent') }] });
    parent.sink.publish({ type: 'run-ended', runId: 'parent-run', outcome: 'finished' });
    expect(ledger.currentRows('parent').map(row => row.kind)).toEqual(['provider-row', 'run-ended']);
  });
});
