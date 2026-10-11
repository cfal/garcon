import { expect, it, mock } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.ts';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
import { TranscriptClearService } from '../clear.ts';
import { TranscriptReloadService } from '../reload.ts';
import { TranscriptLedgerService } from '../service.ts';
import { TranscriptLedgerStore } from '../store.ts';
import { LedgerFencedError } from '../errors.ts';
import { collectPreambleHistoryEvidence } from '../preamble-history.ts';
import { ledgerRowsToMessages } from '../presentation.ts';
import { MetadataIndex } from '../../chats/metadata-store.ts';
import { resolveChatTitle } from '../../chats/chat-title.ts';
import { createTranscriptEventFanout } from '../event-fanout.ts';
import { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.ts';
import { InMemoryChatExecutionControlRepository } from '../../chat-execution/chat-execution-control-repository.ts';
import { AgentCommandReplies } from '../../chats/agent-command-replies.ts';

const at = '2026-10-01T00:00:00.000Z';
const chatId = '1780000000000001';
const session = { agentSessionId: 'session-1', nativeSession: null, nativeSeedReceipt: null };
const boundary = { kind: 'new-chat', ownershipEpoch: 'owner-1' };

function userDraft(content) {
  return { kind: 'user-input', at, providerMeta: null, detail: {
    message: new UserMessage(at, content, undefined, { contentMode: 'literal' }), clientMessageId: content,
    attachments: [], steer: false, preambleBoundary: null, preamblePrefixReceipt: null,
  } };
}

async function withClear(run, { hasSession = true, frozenRows = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ledger-clear-'));
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(root));
  const entry = { agentId: 'test', agentOwnershipEpoch: 'owner-1', projectPath: '/workspace',
    pendingPreambleBoundary: null, ...session };
  ledger.initializeChat(chatId, [
    ...Array.from({ length: frozenRows }, () => ({ kind: 'provider-row', at,
      message: new AssistantMessage(at, 'x'.repeat(128 * 1024)), providerMeta: null })),
    ...(hasSession ? [{ kind: 'session', at, detail: session, providerMeta: null }] : []),
    { kind: 'provider-row', at, message: new AssistantMessage(at, 'Synthetic old answer'), providerMeta: null },
  ], frozenRows + 1);
  let lease = ledger.openProducer(chatId, 'test');
  const registry = { getChat: mock(() => entry), updateChat: (_id, patch) => Object.assign(entry, patch), flush: mock(async () => {}) };
  const execution = {
    reserveTranscriptSnapshot: mock(() => ({ chatId, reservationId: 'reservation-1' })),
    releaseTranscriptSnapshot: mock(async () => {}),
    readChatExecutionControl: mock(async () => ({ entries: [], controlEntries: [] })),
    withChatExecutionControl: mock(async (_id, operation) => operation(await execution.readChatExecutionControl())),
  };
  const options = { ledger, registry, execution, ownership: { hasPending: () => false },
    integrations: { get: mock(() => ({ literalExecution: { selectionLabel: 'Runtime', inputFormatByModel: {} } })) },
    adoption: { ensure: mock(async () => {}) },
    chatMutationLock: new KeyedPromiseLock(), reopenProducer: () => { lease = ledger.openProducer(chatId, 'test'); } };
  const clear = new TranscriptClearService(options);
  const request = () => { const head = ledger.highWatermark(chatId); return { chatId, transcriptViewId: head.viewId, lastOrdinal: head.ordinal, target: { kind: 'all' } }; };
  const native = [];
  const reload = new TranscriptReloadService({ ...options,
    integrations: { require: () => ({ descriptor: { id: 'test' }, settings: { parse: (value) => value, defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }) },
      nativeHistoryImport: { async *load() { yield native.map(message => ({ message })); } } }) },
    getCarryOverRevision: () => 'carry-v1:0',
  });
  try { await run({ ledger, root, clear, reload, request, registry, entry, execution, native, options, get lease() { return lease; } }); }
  finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
}

it('replaces visible history while retaining session identity and rejecting stale producers/retries', async () => {
  await withClear(async fixture => {
    const { ledger, clear, request, entry } = fixture;
    const oldLease = fixture.lease;
    const original = request();
    const before = { ...entry };
    const result = await clear.clear(original, new AbortController().signal);
    expect(result.transcriptViewId).not.toBe(original.transcriptViewId);
    expect(ledgerRowsToMessages(ledger.currentRows(chatId))).toEqual([]);
    expect(ledger.currentRows(chatId).map(row => row.kind)).toEqual(['session']);
    expect(ledger.currentSession(chatId).detail).toEqual(session);
    expect(entry).toEqual(before);
    expect(oldLease.closed).toBe(true);
    expect(fixture.lease.closed).toBe(false);
    fixture.lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic new answer') }] });
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW' });
    expect(ledgerRowsToMessages(ledger.currentRows(chatId)).map(message => message.content)).toEqual(['Synthetic new answer']);
    const reopened = new TranscriptLedgerService(new TranscriptLedgerStore(fixture.root));
    expect(reopened.currentSession(chatId).detail).toEqual(session);
    reopened.close();
  });
});

it('allows an empty replacement without a native session', async () => {
  await withClear(async ({ ledger, clear, request }) => {
    await clear.clear(request(), new AbortController().signal);
    expect(ledger.currentRows(chatId)).toEqual([]);
    expect(ledger.currentView(chatId).contentStartOrdinal).toBe(1);
  }, { hasSession: false });
});

it.each([
  { ordinal: 3, hasLaterSession: true, expectedStart: 2, support: false },
  { ordinal: 5, hasLaterSession: true, expectedStart: 1, support: false },
  { ordinal: 5, hasLaterSession: false, expectedStart: 1, support: true },
])('retains raw suffix and the binding boundary for %j', async ({ ordinal, hasLaterSession, expectedStart, support }) => {
  await withClear(async ({ ledger, clear, request }) => {
    const drafts = [userDraft('Synthetic old input'), { kind: 'provider-row', at, message: new AssistantMessage(at, 'Old answer') },
      userDraft('Synthetic frozen input'), { kind: 'session', at, detail: session }, userDraft('Synthetic current input'),
      { kind: 'notice', at, message: 'Synthetic diagnostic', detail: { type: 'diagnostic' } },
      { kind: 'run-ended', at, outcome: 'finished', origin: 'provider', providerMeta: { synthetic: true } },
      ...(hasLaterSession ? [{ kind: 'session', at, detail: session }] : []),
    ];
    const staged = await ledger.stageView(chatId, drafts, 4);
    ledger.replaceCurrentView(chatId, ledger.currentView(chatId).viewId, staged.viewId);
    const original = ledger.currentRows(chatId);
    const target = { ...request(), target: { kind: 'before-message', ordinal } };
    await clear.clear(target, new AbortController().signal);
    const rows = ledger.currentRows(chatId);
    const payload = ({ viewId, ordinal, ...row }) => row;
    expect(rows.slice(support ? 1 : 0).map(payload)).toEqual(original.slice(ordinal - 1).map(payload));
    expect(rows.map(row => row.ordinal)).toEqual(rows.map((_row, index) => index + 1));
    expect(ledger.currentView(chatId).contentStartOrdinal).toBe(expectedStart);
    expect(ledger.currentSession(chatId).detail).toEqual(session);
    await expect(clear.clear(target, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW' });
  });
});

it('retains a sessionless frozen suffix without creating a native binding', async () => {
  await withClear(async ({ ledger, clear, request }) => {
    const staged = await ledger.stageView(chatId, [userDraft('First note'), userDraft('Second note')], 3);
    ledger.replaceCurrentView(chatId, ledger.currentView(chatId).viewId, staged.viewId);
    await clear.clear({ ...request(), target: { kind: 'before-message', ordinal: 2 } }, new AbortController().signal);
    expect(ledger.currentView(chatId).contentStartOrdinal).toBe(2);
    expect(ledger.currentSession(chatId)).toBeNull();
    expect(ledgerRowsToMessages(ledger.currentRows(chatId)).map(row => row.content)).toEqual(['Second note']);
  });
});

it('remaps retained typed correlations but leaves deleted sources and authored text unchanged', async () => {
  await withClear(async ({ ledger, clear, request }) => {
    const viewId = crypto.randomUUID();
    const oldSource = { requestViewId: viewId, requestOrdinal: 2 };
    const keptSource = { requestViewId: viewId, requestOrdinal: 3 };
    const schedule = { type: 'agent-schedule-outcome', ...keptSource, status: 'failed', reason: 'action-failed', nativeResultInput: true };
    const ticket = { type: 'ticket-command-outcome', ...keptSource, command: 'list', status: 'ok', nativeResultInput: true };
    const stale = { ...schedule, ...oldSource };
    const text = `Synthetic authored reference ${viewId}:2`;
    const staged = await ledger.stageView(chatId, [
      { kind: 'session', at, detail: session, providerMeta: null }, userDraft('Old input'), userDraft(text),
      ...[schedule, ticket, stale].map(detail => ({ kind: 'notice', at, message: 'Synthetic result', detail, providerMeta: { retained: true } })),
    ], 1, viewId);
    ledger.replaceCurrentView(chatId, ledger.currentView(chatId).viewId, staged.viewId);
    await clear.clear({ ...request(), target: { kind: 'before-message', ordinal: 3 } }, new AbortController().signal);
    const rows = ledger.currentRows(chatId);
    expect(rows[0].kind).toBe('session');
    expect(rows[1].detail.message.content).toBe(text);
    const replacement = ledger.currentView(chatId).viewId;
    expect(rows.slice(2).map(row => row.detail)).toEqual([
      { ...schedule, requestViewId: replacement, requestOrdinal: 2 },
      { ...ticket, requestViewId: replacement, requestOrdinal: 2 }, stale,
    ]);
    expect(rows.slice(2).every(row => row.providerMeta.retained)).toBe(true);
  });
});

it('cancels a paged retained-tail scan without replacing history or losing the producer', async () => {
  await withClear(async fixture => {
    const { ledger, clear, request } = fixture;
    const staged = await ledger.stageView(chatId, [
      { kind: 'session', at, detail: session },
      ...Array.from({ length: 600 }, (_, index) => userDraft(`Synthetic note ${index}`)),
    ], 1);
    ledger.replaceCurrentView(chatId, ledger.currentView(chatId).viewId, staged.viewId);
    const before = ledger.currentRows(chatId);
    const cancellation = new AbortController();
    const pages = ledger.rowPagesThrough.bind(ledger);
    ledger.rowPagesThrough = async function* (...args) {
      for await (const page of pages(...args)) {
        yield page;
        cancellation.abort(new Error('Synthetic cancellation'));
      }
    };
    await expect(clear.clear({ ...request(), target: { kind: 'before-message', ordinal: 3 } }, cancellation.signal))
      .rejects.toThrow('Synthetic cancellation');
    expect(ledger.currentRows(chatId)).toEqual(before);
    expect(fixture.lease.closed).toBe(false);
    expect(fixture.execution.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });
});

it.each([0, 1, 2, 99])('rejects a non-user or out-of-bounds partial-clear target %s without replacement', async ordinal => {
  await withClear(async fixture => {
    const original = fixture.request();
    await expect(fixture.clear.clear({ ...original, target: { kind: 'before-message', ordinal } }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(fixture.request()).toEqual(original);
    expect(fixture.lease.closed).toBe(false);
  });
});

it('partitions repeated preamble receipts without duplicating surviving input pairs', async () => {
  await withClear(async fixture => {
    const { ledger, clear, request } = fixture;
    for (const index of [1, 2]) {
      ledger.appendInputAndCompose({ chatId, viewId: ledger.currentView(chatId).viewId,
        message: new UserMessage(at, `Synthetic input ${index}`), attachments: [], clientMessageId: `input-${index}`,
        steer: false, preambleBoundary: boundary,
        preambles: [{ id: '3502b645-222b-49d2-ac39-1c91f9fb1174', title: 'Synthetic rules', content: 'Synthetic body',
          enabled: true, scope: { type: 'global' }, createdAt: at, updatedAt: at }],
      });
      ledger.beginRun(chatId, `run-${index}`);
      fixture.lease.sink.publish({ type: 'run-ended', runId: `run-${index}`, outcome: 'finished' });
    }
    const originalEvidence = collectPreambleHistoryEvidence(ledger.currentRows(chatId));
    for (let repeat = 0; repeat < 2; repeat++) {
      const selected = ledger.currentRows(chatId).find(row => row.kind === 'user-input' && row.detail.clientMessageId === 'input-2');
      await clear.clear({ ...request(), target: { kind: 'before-message', ordinal: selected.ordinal } }, new AbortController().signal);
      expect(collectPreambleHistoryEvidence(ledger.currentRows(chatId))).toEqual(originalEvidence);
      expect(ledgerRowsToMessages(ledger.currentRows(chatId)).map(row => row.content)).toEqual(['Preambles applied', 'Synthetic input 2']);
      expect(JSON.stringify(ledger.currentRows(chatId))).not.toContain('Synthetic input 1');
    }
    await clear.clear(request(), new AbortController().signal);
    expect(collectPreambleHistoryEvidence(ledger.currentRows(chatId))).toEqual(originalEvidence);
  });
});

it.each([null, { literalExecution: null }])('rejects unknown and conversational agents before reservation: %j', async integration => {
  await withClear(async fixture => {
    const { clear, request, options, ledger, entry } = fixture;
    entry.executorId = '11111111-1111-4111-8111-111111111111';
    options.integrations.get.mockReturnValue(integration);
    const original = request();
    const rows = ledger.currentRows(chatId);
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED', status: 422, retryable: false,
    });
    expect(options.integrations.get).toHaveBeenCalledWith(entry.agentId, entry.executorId);
    expect(options.execution.reserveTranscriptSnapshot).not.toHaveBeenCalled();
    expect(options.adoption.ensure).not.toHaveBeenCalled();
    expect(fixture.lease.closed).toBe(false);
    expect(request()).toEqual(original);
    expect(ledger.currentRows(chatId)).toEqual(rows);
  });
});

it('preserves opaque native identity, seed receipts, and an empty paused queue', async () => {
  await withClear(async fixture => {
    const { clear, request, ledger, execution } = fixture;
    const native = { ...session,
      nativeSession: { ownerId: 'test', schemaVersion: 1, value: { syntheticKey: ['opaque', 7] } },
      nativeSeedReceipt: { agentSessionId: session.agentSessionId, placement: 'user-prefix',
        format: 'v3-xml', codeUnitLength: 1, sha256: 'a'.repeat(64) },
    };
    fixture.lease.sink.publish({ type: 'session', session: native });
    const queue = { entries: [], controlEntries: [], pause: { id: 'pause-1', kind: 'manual' } };
    execution.readChatExecutionControl.mockResolvedValue(queue);
    await clear.clear(request(), new AbortController().signal);
    expect(ledger.currentSession(chatId).detail).toEqual(native);
    expect(await execution.readChatExecutionControl()).toBe(queue);
    expect(queue.pause).toEqual({ id: 'pause-1', kind: 'manual' });
  });
});

it.each(['Synthetic first new prompt', 'New Session'])('derives post-Clear previews from the first new input %s across restart', async content => {
  await withClear(async fixture => {
    const { ledger, root, registry, clear, request } = fixture;
    const chats = { ...registry, listChatIds: () => [chatId], onChatRemoved: () => {} };
    const transcripts = {
      getExistingTranscriptViewId: id => ledger.existingCurrentView(id)?.viewId ?? null,
      getExistingTranscriptPreview: mock(() => ({ preview: { firstMessage: '', lastMessage: '' } })),
    };
    const carryover = { revision: () => 'carry-v1:0' };
    const options = { metadataPath: join(root, 'chat-metadata.json') };
    let metadata = new MetadataIndex(chats, transcripts, carryover, options);
    metadata.addNewChatMetadata(chatId, 'Synthetic previous prompt');
    const tasks = [];
    const fanout = createTranscriptEventFanout({
      chatExists: () => true, schedule: (_id, task) => tasks.push(task), broadcast: () => {}, resendCandidates: () => [],
      updateMetadata: (id, viewId, messages) => metadata.updateFromAppendedMessages(id, viewId, messages),
      replaceMetadata: (id, viewId) => metadata.replaceFromTranscriptView(id, viewId, ledger.conversationMessagePages(id)),
    });
    const unsubscribe = ledger.subscribe(event => {
      if (event.type === 'view-replaced') metadata.invalidateTranscriptView(event.chatId);
      fanout(event);
    });
    const drain = async () => { while (tasks.length) await tasks.shift()(); };
    const restart = async () => {
      await metadata.close();
      await metadata.flush();
      metadata = new MetadataIndex(chats, transcripts, carryover, options);
      await metadata.init();
      await metadata.repair();
    };
    try {
      await clear.clear(request(), new AbortController().signal);
      await drain();
      expect(resolveChatTitle(null, metadata.getChatMetadata(chatId).firstMessage)).toBe('New Session');
      await restart();
      expect(metadata.getChatMetadata(chatId).firstMessage).toBe('');
      fixture.lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(at, 'Synthetic continuation') }] });
      await drain();
      fixture.lease.sink.publish({ type: 'rows', rows: [{ message: new UserMessage(at, content) }] });
      fixture.lease.sink.publish({ type: 'rows', rows: [{ message: new UserMessage(at, 'Synthetic later input') }] });
      await drain();
      expect(metadata.getChatMetadata(chatId).firstMessage).toBe(content);
      expect(resolveChatTitle(null, metadata.getChatMetadata(chatId).firstMessage)).toBe(content);
      await restart();
      expect(metadata.getChatMetadata(chatId)).toMatchObject({ firstMessage: content, lastMessage: 'Synthetic later input' });
      expect(transcripts.getExistingTranscriptPreview).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      await metadata.close();
      await metadata.flush();
    }
  });
});

it('rejects persisted previews from a cleared view before startup repair or later appends', async () => {
  await withClear(async fixture => {
    const { ledger, root, clear, request, registry } = fixture;
    const metadataPath = join(root, 'chat-metadata.json');
    const chats = { ...registry, listChatIds: () => [chatId], onChatRemoved: () => {} };
    const transcripts = {
      getExistingTranscriptViewId: id => ledger.existingCurrentView(id)?.viewId ?? null,
      getExistingTranscriptPreview: () => {
        const preview = ledger.existingPreview(chatId);
        return { preview: { firstMessage: preview?.first.content ?? '', lastMessage: preview?.last.content ?? '' } };
      },
    };
    const carryover = { revision: () => 'carry-v1:0' };
    const before = new MetadataIndex(chats, transcripts, carryover, { metadataPath });
    before.addNewChatMetadata(chatId, 'Synthetic cleared preview');
    await before.flush();
    await before.close();
    const persisted = await readFile(metadataPath, 'utf8');
    const previousViewId = ledger.currentView(chatId).viewId;
    await clear.clear(request(), new AbortController().signal);
    expect(await readFile(metadataPath, 'utf8')).toBe(persisted);

    const restarted = new MetadataIndex(chats, transcripts, carryover, { metadataPath });
    try {
      await restarted.init();
      expect(restarted.getChatMetadata(chatId)).toBeNull();
      await restarted.repair();
      expect(restarted.getChatMetadata(chatId)).toMatchObject({
        firstMessage: '', lastMessage: '',
        transcriptViewId: ledger.currentView(chatId).viewId,
      });
      restarted.updateFromAppendedMessages(chatId, previousViewId, [new UserMessage(at, 'Synthetic retired append')]);
      expect(restarted.getChatMetadata(chatId).lastMessage).toBe('');
      const message = new UserMessage(at, 'Synthetic new prompt');
      fixture.lease.sink.publish({ type: 'rows', rows: [{ message }] });
      restarted.updateFromAppendedMessages(chatId, ledger.currentView(chatId).viewId, [message]);
      expect(JSON.stringify(restarted.listAllChatMetadata().get(chatId))).not.toContain('Synthetic cleared preview');
      await restarted.repair();
      await restarted.flush();
      expect(await readFile(metadataPath, 'utf8')).not.toContain('Synthetic cleared preview');
    } finally {
      await restarted.close();
      await restarted.flush();
    }
  });
});

it.each(['entries', 'controlEntries'])('rejects queued %s without deleting history', async key => {
  await withClear(async ({ clear, request, execution, ledger }) => {
    execution.readChatExecutionControl.mockImplementation(async () => ({ entries: [], controlEntries: [], [key]: [{ id: 'queued' }] }));
    const original = request();
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
    expect(ledger.currentView(chatId).viewId).toBe(original.transcriptViewId);
    expect(execution.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });
});

it('rejects execution ownership and stale confirmation watermarks', async () => {
  await withClear(async ({ clear, request, execution, ledger }) => {
    const original = request();
    await expect(clear.clear({ ...original, lastOrdinal: 0 }, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW' });
    execution.reserveTranscriptSnapshot.mockImplementation(() => { throw new Error('busy'); });
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
    expect(ledger.currentView(chatId).viewId).toBe(original.transcriptViewId);
  });
});

it('rejects Clear when a production background reply queues after its initial emptiness check', async () => {
  await withClear(async fixture => {
    const { ledger, registry, request } = fixture;
    const dispatched = Promise.withResolvers();
    const runAgentTurn = mock(async () => { dispatched.resolve(); });
    const execution = new ChatExecutionCoordinator({
      runAgentTurn, captureSteerTarget: () => null,
      steerInput: async () => ({ kind: 'declined' }), abortSession: async () => false, isChatRunning: () => false,
    }, {
      admitInput: async () => ({ inserted: true }), hasMatchingInput: async () => false,
      admitQueuedInput: () => ({ inserted: true }), discardPreparedInput: () => {},
    }, () => ({ model: 'test-model', permissionMode: 'default', thinkingMode: 'none' }),
    () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
      projectAdmission: { assertAvailable: async () => {} }, attachmentAdmission: { assertSupported: () => {} },
      unsettledQueueReceiptKeys: () => new Set(), appendControlReceipt: () => {},
      isControlInputViewCurrent: (_id, viewId) => viewId === ledger.currentView(chatId)?.viewId,
    });
    const chatMutationLock = new KeyedPromiseLock();
    const replies = new AgentCommandReplies({ registry, notices: ledger, execution, chatMutationLock });
    const clear = new TranscriptClearService({ ledger, registry, execution, chatMutationLock,
      ownership: { hasPending: () => false },
      integrations: fixture.options.integrations,
      adoption: { ensure: async () => {} }, reopenProducer: () => ledger.openProducer(chatId, 'test') });
    const source = { chatId, viewId: ledger.currentView(chatId).viewId, requestOrdinal: 1 };
    const detail = { type: 'agent-schedule-outcome', requestViewId: source.viewId, requestOrdinal: 1,
      status: 'failed', reason: 'action-failed' };
    replies.record(source, detail);
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    registry.flush.mockImplementation(async () => { entered.resolve(); await resume.promise; });
    try {
      const original = request();
      const clearing = clear.clear(original, new AbortController().signal);
      await entered.promise;
      await replies.deliver(source, detail, new AbortController().signal);
      expect((await execution.readChatExecutionControl(chatId)).controlEntries).toHaveLength(1);
      resume.resolve();
      await expect(clearing).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
      expect(request()).toEqual(original);
      await dispatched.promise;
      expect(runAgentTurn).toHaveBeenCalledTimes(1);
    } finally {
      resume.resolve();
      execution.beginShutdown();
      replies.shutdown();
    }
  });
});

it('rejects pending ownership before adoption, reservation or producer closure', async () => {
  await withClear(async fixture => {
    const { options, request, clear, ledger } = fixture;
    options.ownership.hasPending = () => true;
    const original = request();
    const rows = ledger.currentRows(chatId);
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({ code: 'OWNERSHIP_TRANSFER_PENDING' });
    expect(request()).toEqual(original);
    expect(ledger.currentRows(chatId)).toEqual(rows);
    expect(fixture.lease.closed).toBe(false);
    expect(options.adoption.ensure).not.toHaveBeenCalled();
    expect(options.execution.reserveTranscriptSnapshot).not.toHaveBeenCalled();
  });
});

it.each(['before-request', 'while-waiting'])('rejects deletion %s without reopening its ledger', async timing => {
  await withClear(async ({ clear, options, registry, request, ledger }) => {
    const original = request();
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const locked = options.chatMutationLock.runExclusive(`chat:${chatId}`, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    if (timing === 'before-request') registry.getChat.mockReturnValue(null);
    const clearing = clear.clear(original, new AbortController().signal);
    registry.getChat.mockReturnValue(null);
    ledger.deleteChat(chatId);
    release.resolve();
    await locked;
    await expect(clearing).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 });
    expect(options.adoption.ensure).not.toHaveBeenCalled();
    expect(options.execution.reserveTranscriptSnapshot).not.toHaveBeenCalled();
    expect(ledger.existingCurrentView(chatId)).toBeNull();
  });
});

it.each(['reopen', 'release'])('reports an unknown result for %s failure after promotion', async failure => {
  await withClear(async ({ options, clear, request, ledger, execution }) => {
    const original = request();
    const discard = mock(ledger.discardStagingView.bind(ledger));
    ledger.discardStagingView = discard;
    if (failure === 'reopen') options.reopenProducer = () => { throw new Error('injected reopen failure'); };
    else execution.releaseTranscriptSnapshot.mockImplementation(async () => { throw new Error('injected release failure'); });
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN', retryable: false,
    });
    expect(request().transcriptViewId).not.toBe(original.transcriptViewId);
    expect(ledgerRowsToMessages(ledger.currentRows(chatId))).toEqual([]);
    expect(execution.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
  });
});

it.each(['fenced-discard', 'discard', 'reopen', 'release'])(
  'preserves cleanup order and error precedence through %s failure before promotion', async failure => {
    await withClear(async fixture => {
      const { clear, request, ledger, execution, options } = fixture;
      const original = request();
      const calls = [];
      const operationError = new Error('Synthetic cutover failure');
      const discardError = failure === 'fenced-discard'
        ? new LedgerFencedError(chatId)
        : new Error('Synthetic discard failure');
      const reopenError = new Error('Synthetic reopen failure');
      const releaseError = new Error('Synthetic release failure');
      const discard = ledger.discardStagingView.bind(ledger);
      const reopen = options.reopenProducer;
      execution.withChatExecutionControl.mockImplementation(async () => {
        calls.push('cutover');
        throw operationError;
      });
      ledger.discardStagingView = async (...args) => {
        calls.push('discard');
        await discard(...args);
        throw discardError;
      };
      options.reopenProducer = id => {
        calls.push('reopen');
        reopen(id);
        if (failure === 'reopen' || failure === 'release') throw reopenError;
      };
      execution.releaseTranscriptSnapshot.mockImplementation(async () => {
        calls.push('release');
        if (failure === 'release') throw releaseError;
      });
      let expectedError = discardError;
      if (failure === 'fenced-discard') expectedError = operationError;
      if (failure === 'reopen') expectedError = reopenError;
      if (failure === 'release') expectedError = releaseError;

      await expect(clear.clear(original, new AbortController().signal)).rejects.toBe(expectedError);
      expect(calls).toEqual(['cutover', 'discard', 'reopen', 'release']);
      expect(request()).toEqual(original);
      expect(fixture.lease.closed).toBe(false);
    });
  },
);

it('reports the release failure as unknown when reopening also fails after promotion', async () => {
  await withClear(async ({ clear, request, ledger, execution, options }) => {
    const original = request();
    const calls = [];
    const releaseError = new Error('Synthetic release failure');
    const discard = mock(ledger.discardStagingView.bind(ledger));
    ledger.discardStagingView = discard;
    options.reopenProducer = () => {
      calls.push('reopen');
      throw new Error('Synthetic reopen failure');
    };
    execution.releaseTranscriptSnapshot.mockImplementation(async () => {
      calls.push('release');
      throw releaseError;
    });

    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({
      code: 'TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN', cause: releaseError,
    });
    expect(calls).toEqual(['reopen', 'release']);
    expect(request().transcriptViewId).not.toBe(original.transcriptViewId);
    expect(discard).not.toHaveBeenCalled();
  });
});

it('skips frozen history and never buffers the transcript while collecting receipts', async () => {
  await withClear(async ({ clear, ledger, request }) => {
    const pages = ledger.rowPagesThrough.bind(ledger);
    ledger.rowsThrough = () => { throw new Error('unbounded transcript read'); };
    const seen = [];
    ledger.rowPagesThrough = async function* (...args) {
      for await (const page of pages(...args)) { seen.push(...page.map(row => row.ordinal)); yield page; }
    };
    await clear.clear(request(), new AbortController().signal);
    expect(seen).toEqual([65, 66]);
  }, { frozenRows: 64 });
});

it('does not scan receipt evidence without a session', async () => {
  await withClear(async ({ clear, ledger, request }) => {
    ledger.rowPagesThrough = () => { throw new Error('unexpected scan'); };
    await clear.clear(request(), new AbortController().signal);
    expect(ledger.currentRows(chatId)).toEqual([]);
  }, { hasSession: false });
});

it('aborts a paged receipt scan without replacing history and reopens publication', async () => {
  await withClear(async fixture => {
    const { clear, ledger, request } = fixture;
    const original = request();
    const controller = new AbortController();
    const pages = ledger.rowPagesThrough.bind(ledger);
    ledger.rowPagesThrough = async function* (...args) {
      for await (const page of pages(...args)) { yield page; controller.abort(); }
    };
    await expect(clear.clear(original, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request()).toEqual(original);
    expect(fixture.lease.closed).toBe(false);
  });
});

it.each(['flush', 'stage'])('preserves history and reopens publication after %s failure', async failure => {
  await withClear(async fixture => {
    const { clear, request, registry, ledger, execution } = fixture;
    const original = request();
    if (failure === 'flush') registry.flush.mockImplementation(async () => { throw new Error('injected failure'); });
    else ledger.stageView = async () => { throw new Error('injected failure'); };
    await expect(clear.clear(original, new AbortController().signal)).rejects.toThrow('injected failure');
    expect(request()).toEqual(original);
    expect(fixture.lease.closed).toBe(false);
    expect(execution.releaseTranscriptSnapshot).toHaveBeenCalledTimes(1);
  });
});

it('fences a core append during staging before replacement', async () => {
  await withClear(async ({ clear, request, registry, ledger }) => {
    const original = request();
    registry.flush.mockImplementation(async () => {
      ledger.appendNotice(chatId, ledger.currentView(chatId).viewId, { content: 'Synthetic newer notice' });
    });
    await expect(clear.clear(original, new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_TRANSCRIPT_VIEW' });
    expect(ledger.currentView(chatId).viewId).toBe(original.transcriptViewId);
    expect(ledgerRowsToMessages(ledger.currentRows(chatId)).at(-1).content).toBe('Synthetic newer notice');
  });
});

it('retains only preamble sanitation evidence across repeated clears, session facts and Reload', async () => {
  await withClear(async fixture => {
    const { ledger, clear, reload, request, entry, registry, native } = fixture;
    entry.pendingPreambleBoundary = boundary;
    const input = ledger.appendInputAndCompose({ chatId, viewId: ledger.currentView(chatId).viewId,
      message: new UserMessage(at, 'Synthetic visible input'), attachments: [], clientMessageId: 'input-1',
      steer: false, preambleBoundary: boundary,
      preambles: [{ id: '3502b645-222b-49d2-ac39-1c91f9fb1174', title: 'Synthetic rules', content: 'Synthetic private body',
        enabled: true, scope: { type: 'global' }, createdAt: at, updatedAt: at }],
    });
    ledger.beginRun(chatId, 'run-1');
    fixture.lease.sink.publish({ type: 'run-ended', runId: 'run-1', outcome: 'finished' });
    const evidence = collectPreambleHistoryEvidence(ledger.currentRows(chatId));
    await clear.clear(request(), new AbortController().signal);
    expect(entry.pendingPreambleBoundary).toBeNull();
    expect(registry.flush).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ledger.currentRows(chatId))).not.toContain('Synthetic visible input');
    expect(JSON.stringify(ledger.currentRows(chatId))).not.toContain('Synthetic private body');
    fixture.lease.sink.publish({ type: 'session', session });
    await clear.clear(request(), new AbortController().signal);
    expect(collectPreambleHistoryEvidence(ledger.currentRows(chatId))).toEqual(evidence);
    await expect(reload.reload(chatId)).rejects.toMatchObject({ code: 'HISTORY_LOAD_FAILED' });
    native.push(new UserMessage(at, input.providerPrefix + 'Synthetic visible input'));
    await reload.reload(chatId);
    expect(ledger.currentSession(chatId).providerMeta).toBeNull();
    expect(ledgerRowsToMessages(ledger.currentRows(chatId)).map(message => message.content))
      .toEqual(['Preambles applied', 'Synthetic visible input']);
    await reload.reload(chatId);
    expect(collectPreambleHistoryEvidence(ledger.currentRows(chatId))).toHaveLength(1);
  });
});
