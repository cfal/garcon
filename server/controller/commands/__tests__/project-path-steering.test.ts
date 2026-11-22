import { expect, mock, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSteerResult } from '@garcon/server-agent-interface';
import { KeyedPromiseLock } from '../../../common/keyed-lock.ts';
import { ChatExecutionCoordinator } from '../../chat-execution/chat-execution-coordinator.ts';
import { InMemoryChatExecutionControlRepository } from '../../chat-execution/chat-execution-control-repository.ts';
import type { ChatExecutionCoordinatorOptions } from '../../chat-execution/types.ts';
import { ChatRegistry } from '../../chats/store.ts';
import { CommandLedger } from '../command-ledger.ts';
import { CommandSupport, type ChatCommandServiceDeps } from '../command-support.ts';
import { SessionCommands } from '../session-commands.ts';

const chatId = '1700000000000001';

function unused(): never {
  throw new Error('Unexpected dependency in project-path test');
}

async function fixture(options: {
  admitInput?: ConstructorParameters<typeof ChatExecutionCoordinator>[1]['admitInput'];
  resolveSteerContent?: ChatExecutionCoordinatorOptions['resolveSteerContent'];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'project-path-steering-'));
  const chats = new ChatRegistry(directory);
  await chats.init();
  chats.addChat({
    id: chatId, agentId: 'pi', model: 'test-model', projectPath: '/repo',
    agentOwnershipEpoch: 'epoch', parentChatId: null, lineage: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] },
  });
  const persist = spyOn(chats, 'updateProjectPath');
  const prepare = mock(async () => {});
  const activateTranscript = mock(async () => 'view');
  const providerStarted = Promise.withResolvers<void>();
  const providerReply = Promise.withResolvers<AgentSteerResult>();
  const admitInput = mock(options.admitInput ?? (async () => ({ inserted: true })));
  const queue = new ChatExecutionCoordinator({
    runAgentTurn: unused,
    captureSteerTarget: async () => ({
      kind: 'steer-target', id: 'target', executorId: 'local', instanceId: 'runtime', integrationId: 'pi',
    }),
    steerInput: async (_id, _content, _options, _target, prepareDelivery) => {
      await prepareDelivery();
      providerStarted.resolve();
      return providerReply.promise;
    },
    abortSession: async () => true,
    isChatRunning: () => false,
  }, {
    admitInput, hasMatchingInput: () => false, admitQueuedInput: unused, discardPreparedInput() {},
  }, () => ({}), id => chats.hasChat(id), new InMemoryChatExecutionControlRepository('instance'), {
    selectionAdmissionLock: new KeyedPromiseLock(), canDispatch: () => false,
    projectAdmission: { assertAvailable: async () => {} }, attachmentAdmission: { assertSupported() {} },
    isControlInputViewCurrent: () => true, resolveSteerContent: options.resolveSteerContent,
  });
  const discard = spyOn(queue, 'discardPendingChatInput');
  const deps = {
    chats, queue, ledger: new CommandLedger(), chatMutationLock: new KeyedPromiseLock(),
    inspectProject: async projectPath => ({ kind: 'available', effectiveProjectKey: projectPath }),
    agents: {
      assertExecutorReady() {}, supportsUpdateProjectPath: () => true,
      isAgentSessionRunning: () => false, currentTranscriptViewId: activateTranscript,
      requiresNativePathForProjectPathUpdate: () => false, resolveNativeSession: async () => null,
      prepareProjectPathUpdate: prepare, publishSessionFact: unused,
      hasAgent: unused, executionPolicy: unused, assertAgentAvailable: unused,
      supportsImages: unused, fileAttachmentAdmission: unused, modelSupportsImages: unused,
      startSession: unused, resolvePermission: unused, getAgentAuthStatusMap: unused,
      getAgentReadinessMap: unused, getAgentCatalogEntries: unused,
      assertExecutionModeSelectionSupported: unused, validateConfiguration: unused,
      normalizeThinkingModeForAgent: unused, runSingleQuery: unused, supportsFork: unused,
      supportsForkAtMessage: unused, supportsForkWhileRunning: unused, steeringSupport: unused,
      forkAgentSession: unused, discardForkedAgentSession: unused, compactSession: unused,
    },
    get settings() { return unused(); },
    get recentTitleIcons() { return unused(); },
    get metadata() { return unused(); },
    get fileMentions() { return unused(); },
    get transcripts() { return unused(); },
    get chatListProjector() { return unused(); },
    get ownership() { return unused(); },
    get handoffs() { return unused(); },
    get transientFeeds() { return unused(); },
    get preambles() { return unused(); },
    get chatTags() { return unused(); },
    createForkedChat: unused, readForkedNativeHistory: unused,
  } satisfies ChatCommandServiceDeps;
  const commands = new SessionCommands(new CommandSupport(deps));
  return {
    queue, admitInput, providerStarted, providerReply, prepare, persist, discard, activateTranscript,
    updatePath: () => commands.updateProjectPath({
      chatId, expectedExecutorId: 'local', expectedAgentOwnershipEpoch: 'epoch',
      expectedProjectPath: '/repo', projectPath: '/next-repo',
    }),
    enqueue: () => queue.enqueueAcceptedSteer({
      command: { key: 'steer-command', chatId, entryId: 'steer-entry', clientRequestId: 'steer-request' },
      content: 'Synthetic guidance', clientMessageId: 'steer-input', transcriptViewId: 'view',
      settlement: {
        settleQueueMutation: async () => {}, settleSteerFailure: async (_command, error) => { throw error; },
        markScheduled: unused, markPreScheduleFailure: unused, settleQueueMutationFailure: unused,
        settleSteerSuccess: unused, settleOperationFailure: unused, settleDuplicateInput: unused,
      },
    }),
    async cleanup() {
      providerReply.resolve({ kind: 'accepted' });
      await queue.waitForDispatches();
      await chats.flush();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test.each(['admission', 'provider'] as const)(
  'project-path update preserves a reserved steer after Stop during %s settlement', async stage => {
    const admissionStarted = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<{ inserted: boolean }>();
    const f = await fixture({ admitInput: async () => {
      admissionStarted.resolve();
      return admission.promise;
    } });
    try {
      f.queue.reserveDirectTurn(chatId, { turnId: 'turn', clientRequestId: 'request' });
      await f.enqueue();
      await admissionStarted.promise;
      if (stage === 'provider') {
        admission.resolve({ inserted: true });
        await f.providerStarted.promise;
      }
      await f.queue.stopActiveTurn(chatId);
      expect(f.queue.ownsExecution(chatId)).toBe(false);
      const before = await f.queue.readChatExecutionControl(chatId);
      expect(before.entries[0]).toMatchObject({ id: 'steer-entry', status: 'steering' });
      expect(before.recentlyDispatched).toEqual([]);
      await expect(f.updatePath()).rejects.toMatchObject({ code: 'CHAT_NOT_IDLE', status: 409, retryable: true });
      expect(f.activateTranscript).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.persist).not.toHaveBeenCalled();
      expect(f.discard).not.toHaveBeenCalled();
      expect(await f.queue.readChatExecutionControl(chatId)).toEqual(before);
      expect(f.queue.ownsExecution(chatId)).toBe(false);

      admission.resolve({ inserted: true });
      f.providerReply.resolve({ kind: 'accepted' });
      await f.queue.waitForDispatches();
      await expect(f.updatePath()).resolves.toMatchObject({ success: true });
      expect((await f.queue.readChatExecutionControl(chatId)).recentlyDispatched)
        .toEqual([expect.objectContaining({ entryId: 'steer-entry' })]);
    } finally {
      admission.resolve({ inserted: true });
      await f.cleanup();
    }
  },
);

test('project-path update still discards unreserved queued guidance', async () => {
  const f = await fixture();
  try {
    await f.enqueue();
    await expect(f.updatePath()).resolves.toMatchObject({ success: true });
    expect(f.admitInput).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.persist).toHaveBeenCalledTimes(1);
    expect(f.discard).toHaveBeenCalledWith(chatId);
    expect((await f.queue.readChatExecutionControl(chatId)).entries).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('a captured steer cannot admit after the project-path snapshot reservation', async () => {
  const contentStarted = Promise.withResolvers<void>();
  const content = Promise.withResolvers<string>();
  const snapshotHeld = Promise.withResolvers<void>();
  const activation = Promise.withResolvers<string>();
  const f = await fixture({ resolveSteerContent: async () => {
    contentStarted.resolve();
    return content.promise;
  } });
  let updating: Promise<unknown> | undefined;
  try {
    f.queue.reserveDirectTurn(chatId, { turnId: 'turn', clientRequestId: 'request' });
    await f.enqueue();
    await contentStarted.promise;
    await f.queue.interruptActiveTurn(chatId);
    f.activateTranscript.mockImplementation(async () => {
      snapshotHeld.resolve();
      return activation.promise;
    });
    updating = f.updatePath();
    await snapshotHeld.promise;
    content.resolve('Synthetic guidance');
    await f.queue.waitForDispatches();
    expect(f.admitInput).not.toHaveBeenCalled();
    expect((await f.queue.readChatExecutionControl(chatId)).entries[0]?.status).toBe('queued');
    activation.resolve('view');
    await expect(updating).resolves.toMatchObject({ success: true });
    expect((await f.queue.readChatExecutionControl(chatId)).entries).toEqual([]);
  } finally {
    content.resolve('Synthetic guidance');
    activation.resolve('view');
    try {
      await updating;
    } finally {
      await f.cleanup();
    }
  }
});
