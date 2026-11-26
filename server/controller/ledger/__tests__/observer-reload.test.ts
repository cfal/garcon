import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentIntegrationError, type AgentNativeChildObservation } from '@garcon/server-agent-interface';
import { AssistantMessage, UserMessage } from '../../../../common/chat-types.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { KeyedPromiseLock } from '../../../common/keyed-lock.js';
import { DomainError } from '../../../common/domain-error.js';
import { ChatRegistry } from '../../chats/store.js';
import { emptyStoredChatExecutionControl } from '../../chat-execution/control-state.js';
import { TranscriptAdoptionService } from '../adoption.js';
import { TranscriptLedgerService } from '../service.js';
import { TranscriptLedgerStore } from '../store.js';
import { createChatReloader } from '../reload-chat.js';
import { TranscriptViewReader } from '../view-reader.js';
import { ObserverReloadService, type ObserverReloadOptions } from '../observer-reload.js';
import { LedgerFencedError } from '../errors.js';

const ROOT = '1783725900000100';
const CHILD = '1783725900000101';
const AT = '2026-11-23T00:00:00.000Z';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'observer-reload-'));
  const registry = new ChatRegistry(directory);
  await registry.init();
  registry.addChat({ id: ROOT, agentId: 'test', agentSessionId: 'root', agentOwnershipEpoch: 'epoch',
    model: 'model', projectPath: '/synthetic', parentChatId: null, lineage: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] } });
  registry.addChat({ id: CHILD, agentId: 'test', model: 'model', projectPath: '/synthetic',
    parentChatId: ROOT, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
    nativeObservation: { kind: 'native-child', sourceChatId: ROOT, sourceOwnershipEpoch: 'epoch',
      sourceAgentSessionId: 'root', child: { ownerId: 'test', schemaVersion: 1, key: 'child', value: {} },
      parentKey: null, reportedModel: null } });
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(directory, 'ledgers')));
  ledger.initializeChat(ROOT);
  const original = ledger.initializeChat(CHILD);
  const writer = ledger.openObservation(CHILD);
  writer.publishRows([{ message: new AssistantMessage(AT, 'Live-only content') }]);
  const provider = integrationFixture(directory, 'local');
  const loadHistory = mock<AgentNativeChildObservation['loadHistory']>(async function* (_request, options) {
    expect(options?.expectedScope).toEqual(provider.integration.producers.scope);
    yield [{ message: new UserMessage(AT, 'Native input') }, { message: new AssistantMessage(AT, '<garcon-get-chat-id />') }];
  });
  provider.integration.nativeChildObservation = { loadHistory };
  const reserved = new Set<string>();
  const reserveTranscriptSnapshot = mock((chatId: string) => {
    if (reserved.has(chatId)) throw new DomainError('SESSION_BUSY', 'Busy', 409, true);
    reserved.add(chatId);
    return { chatId, reservationId: chatId };
  });
  const releaseTranscriptSnapshot = mock(async (reservation: { chatId: string }) => { reserved.delete(reservation.chatId); });
  const retireChat = mock(() => writer.close());
  const options = {
    registry, ledger, integrations: { require: () => provider.integration },
    observers: { capture: () => writer.closed ? null : writer, retireChat },
    execution: { reserveTranscriptSnapshot, releaseTranscriptSnapshot },
    chatMutationLock: new KeyedPromiseLock(), now: () => AT,
  } satisfies ObserverReloadOptions;
  const service = new ObserverReloadService(options);
  cleanups.push(async () => { ledger.close(); await registry.flush(); await provider.executor.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { registry, ledger, writer, original, provider, loadHistory, reserved, reserveTranscriptSnapshot,
    releaseTranscriptSnapshot, retireChat, options, service };
}

test('[TLV5-OBSERVE.02-RELOAD-01] manual child Reload replaces with inert history and retires capture only after promotion', async () => {
  const f = await fixture();
  const promote = spyOn(f.ledger, 'replaceCurrentView');
  const replacement = await f.service.reload(CHILD);
  expect(replacement.viewId).not.toBe(f.original.viewId);
  expect(replacement.contentStartOrdinal).toBe(1);
  expect(f.ledger.currentRows(CHILD).map(row => row.kind)).toEqual(['provider-row', 'provider-row', 'notice']);
  expect(await f.ledger.conversationMessages(CHILD)).toMatchObject([{ content: 'Native input' }, { content: '<garcon-get-chat-id />' }]);
  expect(f.ledger.currentSession(CHILD)).toBeNull();
  expect(f.writer.closed).toBe(true);
  expect(promote.mock.invocationCallOrder[0]!).toBeLessThan(f.retireChat.mock.invocationCallOrder[0]!);
  expect(f.reserveTranscriptSnapshot.mock.calls.map(([id]) => id)).toEqual([ROOT, CHILD]);
  expect(f.releaseTranscriptSnapshot.mock.calls.map(([reservation]) => reservation.chatId)).toEqual([CHILD, ROOT]);
  expect(f.reserved.size).toBe(0);
  await f.service.reload(CHILD);
  expect(f.ledger.currentRows(CHILD)).toHaveLength(3);
});

test.each(['owner', 'native'] as const)('busy %s refuses Reload without ending capture', async source => {
  const f = await fixture();
  if (source === 'owner') f.reserved.add(ROOT);
  else f.loadHistory.mockImplementation(async function* () { throw new AgentIntegrationError('SESSION_BUSY', 'Native writer is active', true); });
  await expect(f.service.reload(CHILD)).rejects.toMatchObject({ code: 'CHAT_RUNNING' });
  expect(f.writer.closed).toBe(false);
  expect(f.ledger.currentView(CHILD)).toEqual(f.original);
});

test.each(['handoff', 'deletion'] as const)('old child history does not reserve a source after %s', async change => {
  const f = await fixture();
  if (change === 'handoff') f.registry.updateChat(ROOT, { agentOwnershipEpoch: 'replacement', agentSessionId: 'other' });
  else f.registry.removeChat(ROOT);
  await f.service.reload(CHILD);
  expect(f.reserveTranscriptSnapshot.mock.calls.map(([id]) => id)).toEqual([CHILD]);
});

test('holds the matching owner lock while the exact provider source is read', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  f.loadHistory.mockImplementation(async function* () { entered.resolve(); await finish.promise; yield []; });
  const reload = f.service.reload(CHILD);
  await entered.promise;
  expect(f.reserved.has(ROOT)).toBe(true);
  let admitted = false;
  const queued = f.options.chatMutationLock.runExclusive(`chat:${ROOT}`, async () => { admitted = true; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  finish.resolve();
  await reload;
  await queued;
  expect(admitted).toBe(true);
});

test.each(['read', 'cancel', 'late-row', 'detach', 'promotion'] as const)('definite %s failure preserves the current view', async failure => {
  const f = await fixture();
  const cancellation = new AbortController();
  const discard = spyOn(f.ledger, 'discardStagingView');
  f.loadHistory.mockImplementation(async function* () {
    if (failure === 'read') throw new Error('Synthetic history failure');
    yield [{ message: new AssistantMessage(AT, 'Native') }];
    if (failure === 'cancel') cancellation.abort(new Error('Cancelled'));
    if (failure === 'late-row') f.writer.publishRows([{ message: new AssistantMessage(AT, 'Late live row') }]);
    if (failure === 'detach') f.writer.close();
  });
  if (failure === 'promotion') spyOn(f.ledger, 'replaceCurrentView').mockImplementation(() => { throw new Error('Definite promotion refusal'); });
  await expect(f.service.reload(CHILD, { signal: cancellation.signal })).rejects.toThrow();
  expect(f.ledger.currentView(CHILD)).toEqual(f.original);
  expect(f.writer.closed).toBe(failure === 'detach');
  expect(f.reserved.size).toBe(0);
  if (failure === 'late-row' || failure === 'detach' || failure === 'promotion') expect(discard).toHaveBeenCalledTimes(1);
});

test('cancellation after saving begins cannot report a confirmed replacement as cancelled', async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  const view = await f.service.reload(CHILD, { signal: cancellation.signal,
    onProgress: update => { if (update.phase === 'saving') cancellation.abort(); } });
  expect(view.viewId).not.toBe(f.original.viewId);
  expect(f.writer.closed).toBe(true);
});

test('uncertain promotion fences only child capture and retains potentially current staging', async () => {
  const f = await fixture();
  const discard = spyOn(f.ledger, 'discardStagingView');
  spyOn(f.ledger, 'replaceCurrentView').mockImplementation(() => { throw new LedgerFencedError(CHILD); });
  await expect(f.service.reload(CHILD)).rejects.toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN', retryable: false });
  expect(f.writer.closed).toBe(true);
  expect(discard).not.toHaveBeenCalled();
  expect(f.ledger.currentRows(ROOT)).toEqual([]);
  expect(f.provider.calls.abort).toBe(0);
});

test('a confirmed swap after a promotion exception still ends capture', async () => {
  const f = await fixture();
  const replace = f.ledger.replaceCurrentView.bind(f.ledger);
  spyOn(f.ledger, 'replaceCurrentView').mockImplementation((...args) => {
    replace(...args);
    throw new Error('Reply lost after commit');
  });
  const view = await f.service.reload(CHILD);
  expect(view.viewId).not.toBe(f.original.viewId);
  expect(f.writer.closed).toBe(true);
  expect(f.ledger.currentView(CHILD)).toEqual(view);
});

test('source ownership changes while waiting for locks refuse the captured attempt', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = f.options.chatMutationLock.runExclusive(`chat:${ROOT}`, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const reload = f.service.reload(CHILD);
  f.registry.updateChat(ROOT, { agentOwnershipEpoch: 'replacement' });
  release.resolve();
  await expect(reload).rejects.toMatchObject({ code: 'HISTORY_LOAD_FAILED' });
  await held;
  expect(f.loadHistory).not.toHaveBeenCalled();
  expect(f.writer.closed).toBe(false);
});

test('release failure after cutover reports an unknown outcome rather than a safe retry', async () => {
  const f = await fixture();
  f.releaseTranscriptSnapshot.mockImplementation(async ({ chatId }) => { f.reserved.delete(chatId); throw new Error('Release failed'); });
  await expect(f.service.reload(CHILD)).rejects.toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN', retryable: false });
  expect(f.writer.closed).toBe(true);
  expect(f.ledger.currentView(CHILD)?.viewId).not.toBe(f.original.viewId);
  expect(f.reserved.size).toBe(0);
});

test.each(['read', 'busy', 'uncertain-promotion'] as const)('release failure preserves the original %s failure', async failure => {
  const f = await fixture();
  const original = new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', 'Synthetic history unavailable', false);
  if (failure === 'read') f.loadHistory.mockImplementation(async function* () { throw original; });
  if (failure === 'busy') f.loadHistory.mockImplementation(async function* () {
    throw new AgentIntegrationError('SESSION_BUSY', 'Synthetic busy source', true);
  });
  if (failure === 'uncertain-promotion') spyOn(f.ledger, 'replaceCurrentView').mockImplementation(() => {
    throw new LedgerFencedError(CHILD);
  });
  f.releaseTranscriptSnapshot.mockImplementation(async ({ chatId }) => {
    f.reserved.delete(chatId);
    throw new Error('Synthetic release failure');
  });
  const reload = f.service.reload(CHILD);
  if (failure === 'read') await expect(reload).rejects.toBe(original);
  else await expect(reload).rejects.toMatchObject({
    code: failure === 'busy' ? 'CHAT_RUNNING' : 'RELOAD_OUTCOME_UNKNOWN',
    retryable: failure === 'busy',
  });
  expect(f.ledger.currentView(CHILD)).toEqual(f.original);
  expect(f.writer.closed).toBe(failure === 'uncertain-promotion');
  expect(f.reserved.size).toBe(0);
});

test.each(['success', 'failure', 'replacement'] as const)('Reload reply pins the promoted view on page %s', async outcome => {
  const f = await fixture();
  const getCarryOverRevision = () => 'carry-v1:0';
  const adoption = new TranscriptAdoptionService({
    ...f.options, getCarryOverRevision, loadFrozenPrefix: async () => [],
  });
  const reader = new TranscriptViewReader(f.ledger, adoption);
  const page = reader.page.bind(reader);
  let promotedViewId = f.original.viewId;
  const readPage = spyOn(reader, 'page').mockImplementation(async (...args) => {
    promotedViewId = f.ledger.currentView(CHILD)!.viewId;
    expect(args).toEqual([CHILD, 100, undefined, promotedViewId]);
    if (outcome === 'failure') throw new Error('Synthetic page failure');
    if (outcome === 'replacement') {
      const next = await f.ledger.stageView(CHILD, [], 1);
      f.ledger.replaceCurrentView(CHILD, promotedViewId, next.viewId);
    }
    return page(...args);
  });
  const reload = createChatReloader({
    ...f.options, adoption, reader, getCarryOverRevision, reopenProducer: () => {},
    execution: { ...f.options.execution, readChatExecutionControl: async () => emptyStoredChatExecutionControl('synthetic-server') },
  });
  if (outcome === 'success') {
    const result = await reload(CHILD, {});
    expect(result.transcriptViewId).toBe(promotedViewId);
    expect(result.transcriptViewId).not.toBe(f.original.viewId);
  } else {
    await expect(reload(CHILD, {})).rejects.toMatchObject({ code: 'RELOAD_OUTCOME_UNKNOWN', retryable: false });
  }
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(f.loadHistory).toHaveBeenCalledTimes(1);
  expect(f.writer.closed).toBe(true);
});
