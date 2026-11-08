import { describe, expect, it, mock } from 'bun:test';
import { AssistantMessage, BashToolUseMessage, EnterPlanModeToolUseMessage, UserMessage, WaitToolUseMessage } from '../../../../common/chat-types.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { transcriptViewId } from '../contracts.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';

const at = '2026-08-12T00:00:00.000Z';

describe('transcript event fanout', () => {
  it('does not publish imported plan entries from initialization, adoption seeding or Reload as live commits', async () => {
    const root = await mkdtemp(path.join(homedir(), 'tmp', 'plan-import-fanout-'));
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(root, 'ledger')));
    const sent = [], scheduled = [];
    const fanout = createTranscriptEventFanout({ serverInstanceId: 'server', chatExists: () => true,
      schedule: (_chat, task) => scheduled.push(Promise.resolve().then(task)), broadcast: message => sent.push(message),
      updateMetadata: () => {}, replaceMetadata: async () => {}, planRevision: () => 1, auxiliaryRevision: () => 0 });
    const unsubscribe = ledger.subscribe(fanout);
    const imported = [{ kind: 'provider-row', at, message: new EnterPlanModeToolUseMessage(at, 'historical-plan'), providerMeta: null }];
    try {
      ledger.initializeChat('initialized', imported);
      const view = await ledger.seedChat('seeded', imported, 1);
      const staged = await ledger.stageView('seeded', imported, 1);
      ledger.replaceCurrentView('seeded', view.viewId, staged.viewId);
      await Promise.resolve();
      await Promise.all(scheduled); fanout.flushAll();
      expect(sent.map(message => message.type)).toEqual(['chat-transcript-replaced']);
      ledger.openProducer('seeded', 'synthetic').sink.publish({ type: 'rows', rows: [
        { message: new EnterPlanModeToolUseMessage(at, 'live-plan') },
      ] });
      await Promise.resolve();
      await Promise.all(scheduled); fanout.flushAll();
      expect(sent.at(-1)).toMatchObject({ type: 'chat-transcript-head-updated', transcriptViewId: staged.viewId, livePlanEnterOrdinal: 2 });
    } finally { unsubscribe(); fanout.forget('initialized'); fanout.forget('seeded'); ledger.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('preserves live plan provenance and announceable categories through coalescing and terminal flush', () => {
    const sent = [];
    const fanout = createTranscriptEventFanout({ serverInstanceId: 'server', chatExists: () => true,
      schedule: (_chat, task) => task(), broadcast: message => sent.push(message),
      updateMetadata: () => {}, replaceMetadata: async () => {}, planRevision: () => 1, auxiliaryRevision: () => 0 });
    const messages = [new EnterPlanModeToolUseMessage(at, 'plan'), new BashToolUseMessage(at, 'tool', 'private command'),
      new WaitToolUseMessage(at, 'wait', 'execution'), new AssistantMessage(at, 'Synthetic response')];
    for (const [index, message] of messages.entries()) fanout({ type: 'rows', chatId: 'chat', viewId: 'view',
      rows: [{ kind: 'provider-row', ordinal: index + 1, at, message, providerMeta: null }] });
    expect(sent).toHaveLength(0);
    fanout({ type: 'run-ended', chatId: 'chat', viewId: 'view', runId: 'run',
      row: { kind: 'run-ended', ordinal: 5, at, outcome: 'finished', origin: 'provider', providerMeta: null } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sourceHead: 5, livePlanEnterOrdinal: 1,
      announcementOrdinals: { bash: 2, exec: 0, assistant: 4 } });
    expect(JSON.stringify(sent[0])).not.toContain('private command');
    expect(JSON.stringify(sent[0]).length).toBeLessThan(1024);
    fanout.forget('chat');
  });
  it('schedules committed rows before broadcasting their view-qualified append', () => {
    const tasks = [];
    const broadcast = mock(() => undefined);
    const updateMetadata = mock(() => undefined);
    const fanout = createTranscriptEventFanout({
      serverInstanceId: 'server-1',
      chatExists: () => true,
      schedule: (_chatId, task) => tasks.push(task),
      broadcast,
      updateMetadata,
      replaceMetadata: mock(() => undefined),
      planRevision: () => 0,
      auxiliaryRevision: () => 0,
    });
    const viewId = transcriptViewId('view-1');

    fanout({
      type: 'rows',
      chatId: 'chat-1',
      viewId,
      rows: [{
        kind: 'provider-row',
        ordinal: 2,
        at,
        message: new AssistantMessage(at, 'answer'),
        providerMeta: null,
      }],
    });

    expect(broadcast).not.toHaveBeenCalled();
    tasks[0]();
    expect(broadcast).not.toHaveBeenCalled();
    fanout.flush('chat-1');
    expect(updateMetadata).toHaveBeenCalledWith('chat-1', 'view-1', [
      expect.objectContaining({ content: 'answer' }),
    ]);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat-transcript-head-updated',
      chatId: 'chat-1',
      transcriptViewId: viewId,
      sourceHead: 2,
      preview: { ordinal: 2, text: 'answer', timestamp: at },
      responseClassOrdinals: expect.objectContaining({ assistant: 2 }),
    }));
  });

  it('broadcasts lifecycle-only commits without inventing rendered messages', () => {
    const broadcast = mock(() => undefined);
    const updateMetadata = mock(() => undefined);
    const fanout = createTranscriptEventFanout({
      serverInstanceId: 'server-1',
      chatExists: () => true,
      schedule: (_chatId, task) => task(),
      broadcast,
      updateMetadata,
      replaceMetadata: mock(() => undefined),
      planRevision: () => 0,
      auxiliaryRevision: () => 0,
    });

    fanout({
      type: 'run-ended',
      chatId: 'chat-1',
      viewId: transcriptViewId('view-1'),
      runId: 'run-1',
      row: {
        kind: 'run-ended',
        ordinal: 1,
        at,
        outcome: 'finished',
        origin: 'provider',
        providerMeta: null,
      },
    });

    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chat-transcript-head-updated', sourceHead: 1, preview: null, presentedActivityAt: null,
    }));
    expect(updateMetadata).not.toHaveBeenCalled();
  });

  it('acknowledges inputs exactly while coalescing bounded head facts', () => {
    const sent = [], tasks = [];
    const fanout = createTranscriptEventFanout({ serverInstanceId: 'server', chatExists: () => true,
      schedule: (_chat, task) => tasks.push(task), broadcast: message => sent.push(message),
      updateMetadata: () => {}, replaceMetadata: async () => {}, planRevision: () => 4, auxiliaryRevision: () => 17 });
    for (let ordinal = 1; ordinal <= 100; ordinal++) fanout({ type: 'rows', chatId: 'chat', viewId: 'view',
      rows: [{ kind: 'user-input', ordinal, at, detail: { clientMessageId: `input-${ordinal}`,
        message: new UserMessage(at, 'x'.repeat(10000)), attachments: [], steer: false } }] });
    for (const task of tasks) task();
    expect(sent).toHaveLength(100);
    expect(sent.every(event => event.type === 'chat-input-committed')).toBe(true);
    fanout.flushAll();
    expect(sent).toHaveLength(101);
    expect(sent[100]).toMatchObject({ sourceHead: 100, planRevision: 4, auxiliaryRevision: 17 });
    expect(JSON.stringify(sent[100]).length).toBeLessThan(1024);
    expect(sent[100]).not.toHaveProperty('messages');
  });

  it.each([
    ['increasing timestamps', [at, '2026-08-12T00:00:01.000Z'], '2026-08-12T00:00:01.000Z'],
    ['decreasing timestamps', ['2026-08-12T00:00:01.000Z', at], '2026-08-12T00:00:01.000Z'],
    ['equal timestamps', [at, at], at],
    ['private rows around a public row', [null, at, null], at],
    ['only private rows', [null, null], null],
  ])('retains the latest presented activity across %s', (_name, timestamps, expected) => {
    const broadcast = mock(() => undefined);
    const fanout = createTranscriptEventFanout({
      serverInstanceId: 'server-1', chatExists: () => true,
      schedule: (_chatId, task) => task(), broadcast,
      updateMetadata: () => {}, replaceMetadata: async () => {},
      planRevision: () => 0, auxiliaryRevision: () => 0,
    });
    try {
      for (const [index, timestamp] of timestamps.entries()) {
        const row = timestamp === null
          ? { kind: 'notice', message: 'Synthetic private notice', detail: { type: 'chat-id-request' } }
          : { kind: 'provider-row', message: new AssistantMessage(timestamp, 'Synthetic response') };
        fanout({ type: 'rows', chatId: 'chat-1', viewId: transcriptViewId('view-1'),
          rows: [{ ...row, ordinal: index + 1, at, providerMeta: null }] });
      }
      expect(broadcast).not.toHaveBeenCalled();
      fanout.flushAll();
      expect(broadcast).toHaveBeenCalledTimes(1);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
        sourceHead: timestamps.length,
        presentedActivityAt: expected,
      }));
    } finally {
      fanout.forget('chat-1');
    }
  });
});
