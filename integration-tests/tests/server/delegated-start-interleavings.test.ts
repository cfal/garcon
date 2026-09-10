import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatId } from '../../../common/chat-id.js';
import { AgentStartController } from '../../../server/chats/agent-start-controller.js';
import { AgentStartProgress } from '../../../server/chats/agent-start-progress.js';
import type { ChatRegistryEntry } from '../../../server/chats/store.js';
import { ChatExecutionCoordinator } from '../../../server/chat-execution/chat-execution-coordinator.js';
import { InMemoryChatExecutionControlRepository } from '../../../server/chat-execution/chat-execution-control-repository.js';
import { CommandLedger } from '../../../server/commands/command-ledger.js';
import { ChatCommandSettlement } from '../../../server/commands/chat-command-settlement.js';
import { TranscriptLedgerService } from '../../../server/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/ledger/store.js';
import { KeyedPromiseLock } from '../../../server/lib/keyed-lock.js';

const PARENT = '9000000000000000';
const CHILD = parseChatId('1000000000000000');
const TURN = 'synthetic-startup-turn';
const AT = '2030-01-01T00:00:00.000Z';

describe('delegated startup admission interleavings', () => {
  let directory: string;
  let store: TranscriptLedgerStore;
  let transcripts: TranscriptLedgerService;
  let execution: ChatExecutionCoordinator;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'delegated-start-interleavings-'));
    store = new TranscriptLedgerStore(directory);
    transcripts = new TranscriptLedgerService(store);
    transcripts.initializeChat(PARENT);
    transcripts.initializeChat(CHILD);
    execution = new ChatExecutionCoordinator(directory, {
      runAgentTurn: async (chatId, _command, options) => { transcripts.beginRun(chatId, options.turnId); },
      captureSteerTarget: () => null,
      steerInput: async () => { throw new Error('Unexpected steer'); },
      submitGoalControl: async () => false,
      abortSession: async (chatId) => transcripts.interruptRun(chatId) !== null,
      isChatRunning: (chatId) => transcripts.isRunActive(chatId),
    }, {
      admitInput: async (chatId, content, options) => {
        const result = transcripts.appendInputAndCompose({ chatId,
          viewId: transcripts.currentView(chatId)!.viewId,
          message: content, attachments: [],
          clientMessageId: options.clientMessageId ?? null, steer: false });
        return { inserted: result.inserted };
      },
      hasMatchingInput: () => false, admitQueuedInput: () => ({ inserted: true }),
      discardPreparedInput: (chatId, messageId) => transcripts.discardPreparedInput(chatId, messageId),
    }, () => ({}), () => true, new InMemoryChatExecutionControlRepository('synthetic-server'), {
      projectAdmission: { assertAvailable: async () => {} }, isControlInputViewCurrent: () => true,
    });
  });
  afterEach(async () => {
    await execution.waitForDispatches();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('releases accepted child work after the parent SQLite ledger becomes read-fenced', async () => {
    const parent: ChatRegistryEntry = {
      agentId: 'test', model: 'test', permissionMode: 'default', thinkingMode: 'none',
      projectPath: directory, tags: [], agentSettingsById: {}, agentOwnershipEpoch: 'synthetic-epoch',
      nativeSession: null, agentSessionId: null, nativeSeedReceipt: null, carryOverSegments: [],
      carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
      preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChat: null,
    };
    const turns = new CommandLedger();
    const wait = spyOn(turns, 'waitForTurnTerminal');
    const lock = new KeyedPromiseLock();
    const gate = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const dispatch = mock(() => {});
    const deliver = mock(async () => 'queued' as const);
    let locksReleased = false;
    const runExclusiveMany = lock.runExclusiveMany.bind(lock);
    lock.runExclusiveMany = async <T>(keys: readonly string[], operation: () => Promise<T>) => {
      const result = await runExclusiveMany(keys, operation);
      locksReleased = true;
      return result;
    };
    const controller = new AgentStartController({
      registry: { getChat: () => parent }, notices: transcripts,
      execution: { deliverServerControlInput: deliver }, turns,
      chatMutationLock: lock, isEnabled: () => true, chatIds: { allocate: () => CHILD },
      settings: { getExecutionDefaults: () => ({ global: {
        permissionMode: 'default', thinkingMode: 'none', agentSettingsById: {},
      }, byAgent: {} }) },
      selection: {
        catalog: async () => ({ catalog: { agents: [], apiProviders: [] } }),
        resolve: () => ({ agentId: 'test', model: 'test', permissionMode: 'default', thinkingMode: 'none',
          apiProviderId: null, modelEndpointId: null, modelProtocol: null,
          agentSettings: { ownerId: 'test', schemaVersion: 1, values: {} } }),
      },
      commands: { submitAgentCommandStartLocked: async (input) => {
        const { record } = await turns.accept({ commandType: 'chat-start', chatId: CHILD,
          turnId: TURN, clientRequestId: input.clientRequestId, payload: {} });
        await execution.scheduleDirectInput({
          command: { key: record.key, chatId: CHILD, clientRequestId: input.clientRequestId, turnId: TURN },
          content: input.command, options: { commandType: 'chat-start', turnId: TURN,
            clientRequestId: input.clientRequestId, clientMessageId: input.clientMessageId },
          settlement: new ChatCommandSettlement(turns),
          dispatch: async (admission) => {
            await gate.promise;
            admission.signal.throwIfAborted();
            expect(locksReleased).toBe(true);
            expect(wait).toHaveBeenCalledTimes(1);
            dispatch();
            await admission.markStarted();
          },
        });
        const database = new Database(join(directory, PARENT, 'ledger.sqlite'));
        database.exec('DROP TABLE transcript_rows');
        database.close();
        expect(() => transcripts.currentRows(PARENT)).toThrow();
        admitted.resolve();
        return { turnId: TURN, status: 'accepted', start: gate.resolve };
      } },
    });
    try {
      controller.request({ chatId: PARENT, viewId: transcripts.currentView(PARENT)!.viewId,
        requestOrdinal: 1, runId: 'synthetic-parent-turn', at: AT }, {
        type: 'start-agent', ref: 'task', async: false, fork: false, title: 'Synthetic task',
        agentId: 'test', model: 'test', providerId: null, reasoningEffort: null, prompt: 'Synthetic task.',
      });
      await admitted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(transcripts.currentRows(CHILD)).toMatchObject([{ kind: 'user-input' }]);
      expect(await turns.getTurnRecord(CHILD, TURN)).toMatchObject({ turnId: TURN, status: 'scheduled' });
    } finally {
      controller.shutdown();
      gate.resolve();
      await execution.waitForDispatches();
      await execution.stopActiveTurn(CHILD);
    }
  });

  test.each(['stopActiveTurn', 'interruptActiveTurn'] as const)(
    '%s preserves startup failure committed before its notification', async (method) => {
      const reservation = execution.reserveDirectTurn(CHILD, { turnId: TURN });
      const progress = new AgentStartProgress(transcripts, CHILD, TURN, reservation.executionAdmission.signal);
      const producer = transcripts.openProducer(CHILD, 'test');
      try {
        await execution.runReservedTurn(reservation, 'Synthetic task.', { turnId: TURN });
        progress.report('starting-agent');
        producer.sink.publish({ type: 'run-ended', runId: TURN, outcome: 'failed' });
        expect(transcripts.currentRows(CHILD).at(-1)).toMatchObject({ kind: 'run-ended', outcome: 'failed' });
        await execution[method](CHILD);
        expect(transcripts.currentRows(CHILD).filter((row) => row.kind === 'notice').map((row) => row.detail.phase))
          .toEqual(['starting-agent', 'failed']);
        expect(reservation.executionAdmission.signal.aborted).toBe(true);
      } finally {
        progress.dispose();
        producer.close();
        await execution.stopActiveTurn(CHILD);
      }
    },
  );
});
