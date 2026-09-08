import { describe, expect, test, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { garconCommandResultContent } from '../../../common/garcon-command-results.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptAdoptionService } from '../../../server/ledger/adoption.js';
import { TranscriptReloadService } from '../../../server/ledger/reload.js';
import { NativeTranscriptActivityService } from '../../../server/ledger/native-activity.js';
import { ChatExecutionCoordinator } from '../../../server/chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../../server/chat-execution/chat-execution-control-repository.js';
import { KeyedPromiseLock } from '../../../server/lib/keyed-lock.js';
import { ChatRegistry } from '../../../server/chats/store.js';
import { ledgerRowsToTranscriptMessages } from '../../../server/ledger/presentation.js';

const CHAT = '1111111111111111';
const AT = '2030-01-01T00:00:00.000Z';
const RESULT_AT = '2030-01-01T00:01:00.000Z';
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function withReload(run) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-command-reload-'));
  const registry = new ChatRegistry(root);
  const store = new TranscriptLedgerStore(join(root, 'transcripts'));
  const request = mock(() => {});
  const ledger = new TranscriptLedgerService(store, { agentStarts: { request }, agentResumes: { request }, agentSchedules: { request } });
  const nativeSession = { ownerId: 'test', schemaVersion: 1, value: { id: 'synthetic-native' } };
  await registry.init();
  registry.addChat({ id: CHAT, agentId: 'test', agentOwnershipEpoch: 'synthetic-epoch',
    nativeSession, nativeSeedReceipt: null, agentSessionId: 'synthetic-session', projectPath: root,
    model: 'synthetic-model', permissionMode: 'default', thinkingMode: 'none', tags: [],
    agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChat: null,
  });
  await registry.flush();
  const view = ledger.initializeChat(CHAT, [{ kind: 'session', at: AT, providerMeta: null,
    detail: { agentSessionId: 'synthetic-session', nativeSession, nativeSeedReceipt: null } }]);
  const lease = ledger.openProducer(CHAT, 'test');
  const dispatched = [];
  const turnRunner = {
    runAgentTurn: async (_chatId, content, options) => {
      dispatched.push(content);
      await execution.onAgentTurnTerminal(CHAT, { turnId: options.turnId });
    },
    captureSteerTarget: () => null,
    isChatRunning: () => false,
    abortSession: async () => false,
  };
  const appendReceipt = mock((chatId, entry) => {
    if (entry.receipt !== null) ledger.appendNotice(chatId, entry.transcriptViewId, { ...entry.receipt, at: entry.createdAt });
  });
  const execution = new ChatExecutionCoordinator(root, turnRunner, {
    admitInput: async () => ({ inserted: true }), hasMatchingInput: async () => false,
    admitQueuedInput: () => ({ inserted: true }), discardPreparedInput: () => {},
  }, () => ({}), (id) => registry.hasChat(id), new InMemoryChatExecutionControlRepository('test-server'), {
    projectAdmission: { assertAvailable: async () => {} },
    appendControlReceipt: appendReceipt,
    isControlInputViewCurrent: (chatId, viewId) => registry.getChat(chatId) !== null && ledger.existingCurrentView(chatId)?.viewId === viewId,
  });
  const integration = {
    descriptor: { id: 'test' }, settings: { parse: (value) => value },
    nativeHistoryImport: { async *load() { yield [{ message: new AssistantMessage(AT, 'Imported reply.') }]; } },
    nativeActivity: { lastActivity: async () => ({ kind: 'ready', value: { lastEntryAt: RESULT_AT } }) },
  };
  const integrations = { get: () => integration, require: () => integration };
  const adoption = new TranscriptAdoptionService({ ledger, registry, integrations,
    getCarryOverRevision: () => 'synthetic-carry', loadFrozenPrefix: async () => [] });
  const reload = new TranscriptReloadService({ ledger, registry, integrations, adoption, execution,
    getCarryOverRevision: () => 'synthetic-carry', chatMutationLock: new KeyedPromiseLock(),
    reopenProducer: () => { ledger.openProducer(CHAT, 'test'); } });
  try { await run({ ledger, store, registry, view, lease, execution, reload, integration, integrations, request, dispatched, appendReceipt }); }
  finally {
    execution.beginShutdown();
    await execution.waitForDispatches();
    await registry.flush();
    ledger.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe('agent command reply reload boundaries', () => {
  for (const receipt of [null, { title: 'Synthetic receipt', content: 'Received message.', detail: { type: 'inter-agent-message-received', fromChatId: null } }]) {
    test(`drops an old-view control enqueued after reload's empty-queue check (${receipt === null ? 'null' : 'received'} receipt)`, async () => {
      await withReload(async ({ ledger, view, execution, reload, integration, dispatched, appendReceipt }) => {
        const importing = deferred(); const release = deferred();
        integration.nativeHistoryImport.load = async function* () {
          importing.resolve(); await release.promise;
          yield [{ message: new AssistantMessage(AT, 'Imported reply.') }];
        };
        const reloading = reload.reload(CHAT);
        await importing.promise;
        expect((await execution.readChatExecutionControl(CHAT)).controlEntries).toEqual([]);
        await execution.deliverServerControlInput(CHAT, {
          content: 'Old view result.', transcriptViewId: view.viewId, createdAt: AT, receipt,
        }, new AbortController().signal);
        const drained = once(execution, 'chat-idle');
        release.resolve();
        const replacement = await reloading;
        await drained;
        expect(replacement.viewId).not.toBe(view.viewId);
        expect((await execution.readChatExecutionControl(CHAT)).controlEntries).toEqual([]);
        expect(dispatched).toEqual([]);
        expect(appendReceipt).not.toHaveBeenCalled();
        expect(JSON.stringify(ledger.currentRows(CHAT))).not.toContain('Old view result.');
        const currentDrained = once(execution, 'chat-idle');
        await execution.deliverServerControlInput(CHAT, {
          content: 'Current view result.', transcriptViewId: replacement.viewId, createdAt: AT, receipt: null,
        }, new AbortController().signal);
        await currentDrained;
        expect(dispatched).toEqual(['Current view result.']);
      });
    });
  }

  test('reload preserves original request addresses and trailing result native evidence without redispatch', async () => {
    await withReload(async ({ ledger, store, registry, view, lease, reload, integration, integrations, request }) => {
      const command = '<garcon-start-agent ref="task" agent="test" model="synthetic-model">Task.</garcon-start-agent>\n<garcon-schedule every="5m" />\n<garcon-resume-agent ref="followup" chat-id="2222222222222222">Follow up.</garcon-resume-agent>';
      ledger.appendNotice(CHAT, view.viewId, { title: 'Local-only', content: 'Local-only notice.', detail: {}, at: AT });
      lease.sink.publish({ type: 'rows', rows: [{ message: new AssistantMessage(AT, command) }] });
      expect(request).toHaveBeenCalledTimes(3);
      request.mockClear();
      const outcomes = [
        { type: 'agent-start-outcome', ref: 'task', async: false, status: 'completed', chatId: '2222222222222222', requestViewId: view.viewId, requestOrdinal: 3,
          output: { availability: 'available', completeness: 'complete', text: 'Synthetic start answer with A & B.' } },
        { type: 'agent-schedule-outcome', status: 'failed', reason: 'limit-reached', requestViewId: view.viewId, requestOrdinal: 4 },
        { type: 'agent-resume-outcome', ref: 'followup', async: false, status: 'completed', chatId: '2222222222222222', requestViewId: view.viewId, requestOrdinal: 5,
          output: { availability: 'available', completeness: 'best-effort', text: 'Synthetic resumed answer with <text>.' } },
      ];
      for (const trailing of outcomes) {
        integration.nativeHistoryImport.load = async function* () {
          yield [{ message: new AssistantMessage(AT, command) },
            ...outcomes.filter((item) => item !== trailing).map((item) => ({ message: new UserMessage(AT, garconCommandResultContent(item)) })),
            { message: new UserMessage(RESULT_AT, garconCommandResultContent(trailing)) }];
        };
        const replaced = await reload.reload(CHAT);
        const rows = ledger.currentRows(CHAT);
        expect(rows.filter((row) => row.kind === 'notice' && row.detail.type.endsWith('-request')).map((row) => row.ordinal)).toEqual([2, 3, 4]);
        const notices = ledgerRowsToTranscriptMessages(rows);
        expect(notices.map(({ message }) => message.detail)).toEqual(expect.arrayContaining(outcomes));
        expect(notices.map(({ message }) => [message.detail.type, message.title])).toEqual(expect.arrayContaining([
          ['agent-start-outcome', 'Start agent'],
          ['agent-resume-outcome', 'Resume agent'],
          ['agent-schedule-outcome', 'Schedule prompt'],
        ]));
        expect(notices.every(({ message }) => message.detail.requestViewId === view.viewId)).toBe(true);
        expect(JSON.stringify(notices)).not.toContain('nativeResultInput');
        store.closeChat(CHAT);
        expect(ledger.nativeActivityState(CHAT).providerWatermark.at).toBe(RESULT_AT);
        const warnings = [];
        let completed = deferred();
        const activity = new NativeTranscriptActivityService({ ledger, registry, integrations,
          ownsExecution: () => false, notifyOperationalNotice: (...args) => warnings.push(args),
          scheduleTimeout: () => ({ cancel: () => completed.resolve() }) });
        integration.nativeActivity.lastActivity = async () => ({ kind: 'ready', value: { lastEntryAt: RESULT_AT } });
        activity.requestCheck(CHAT, 'activation'); await completed.promise;
        expect(warnings).toEqual([]);
        ledger.appendNotice(CHAT, replaced.viewId, { title: 'Local result', content: 'Local result.', detail: trailing, at: '2030-01-01T00:03:00.000Z' });
        completed = deferred();
        integration.nativeActivity.lastActivity = async () => ({ kind: 'ready', value: { lastEntryAt: '2030-01-01T00:02:00.000Z' } });
        activity.requestCheck(CHAT, 'activation'); await completed.promise;
        expect(warnings).toHaveLength(1);
      }
      expect(request).not.toHaveBeenCalled();
    });
  });
});
