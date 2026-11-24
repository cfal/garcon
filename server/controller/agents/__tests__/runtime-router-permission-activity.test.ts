import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentCallError } from '@garcon/server-agent-interface';
import { BashToolUseMessage } from '../../../../common/chat-types.js';
import { ChatTransientFeedStore } from '../../chats/chat-transient-feed.js';
import { projectChatActivityStatus } from '../../chats/chat-activity-status.js';
import { ChatRegistry } from '../../chats/store.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import { TranscriptLedgerService, type PermissionActionabilityChange } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { PermissionNotActionableError } from '../../ledger/errors.js';
import { IntegrationRegistry } from '../../../runtime/agents/integration-registry.js';
import { integrationFixture } from '../../../remote/__tests__/integration-fixture.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../directory.js';
import { AgentEventBus } from '../event-bus.js';
import { AgentRuntimeRouter } from '../runtime-router.js';
import { interactiveDeadline } from '../../../common/interactive-deadline.js';
import { permissionFixture, permissionResponse } from './producer-fixture.js';

const AT = '2026-08-16T00:00:00.000Z';
const CHAT_ID = '1783725900000300';
const EXECUTOR_ID = 'local';
const OCCURRENCE_ID = '11111111-1111-4111-8111-111111111111';
const control = {
  serverInstanceId: 'server-1', chatId: CHAT_ID, runId: 'run-1', permissionOccurrenceId: OCCURRENCE_ID,
};

describe('permission response activity', () => {
  it('advertises working throughout a claimed response and never restores a completed control', async () => {
    await withPermission(async (fixture) => {
      const response = fixture.resolve();
      await fixture.started.promise;
      expect(fixture.activity()).toBe('working');
      expect(fixture.feed.currentSnapshot(CHAT_ID)?.rows).toHaveLength(1);
      expect(fixture.feed.validateAction(control).permissionOccurrenceId).toBe(OCCURRENCE_ID);
      await expect(fixture.resolve()).rejects.toBeInstanceOf(PermissionNotActionableError);
      fixture.release.resolve();
      await response;
      await Promise.resolve();
      expect(fixture.activity()).toBe('working');
      expect(fixture.feed.currentSnapshot(CHAT_ID)?.rows).toEqual([]);
      expect(fixture.ledger.currentRows(CHAT_ID).map(row => row.kind)).toEqual([
        'permission-requested', 'permission-resolved',
      ]);
      expect(fixture.actionabilityChanges()).toEqual(['claimed']);
    });
  });

  it('restores the exact live control only after definite non-dispatch', async () => {
    await withPermission(async (fixture) => {
      const original = fixture.feed.validateAction(control);
      const response = fixture.resolve();
      await fixture.started.promise;
      expect(fixture.activity()).toBe('working');
      fixture.release.reject(new AgentCallError('not-dispatched', 'Synthetic unavailable response'));
      await expect(response).rejects.toThrow('Synthetic unavailable response');
      expect(fixture.activity()).toBe('pending-user-action');
      expect(fixture.feed.validateAction(control)).toBe(original);
      expect(fixture.actionabilityChanges()).toEqual(['claimed', 'actionable']);
      expect(fixture.ledger.currentRows(CHAT_ID).map(row => row.kind)).toEqual(['permission-requested']);
      const retry = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.completePermissionResolution(retry, { allow: true });
      await Promise.resolve();
      expect(fixture.activity()).toBe('working');
    });
  });

  for (const failure of [
    new AgentCallError('unknown', 'Synthetic uncertain response'),
    new AgentCallError('rejected', 'Synthetic expired response'),
    new Error('Synthetic interrupted response'),
  ]) {
    it(`keeps a claimed control unavailable after ${failure.message}`, async () => {
      await withPermission(async (fixture) => {
        const response = fixture.resolve();
        await fixture.started.promise;
        expect(fixture.activity()).toBe('working');
        fixture.release.reject(failure);
        await expect(response).rejects.toBe(failure);
        await Promise.resolve();
        expect(fixture.activity()).toBe('working');
        expect(fixture.feed.currentSnapshot(CHAT_ID)?.rows).toEqual([]);
        await expect(fixture.resolve()).rejects.toBeInstanceOf(PermissionNotActionableError);
        expect(fixture.actionabilityChanges()).toEqual(['claimed']);
        expect(fixture.ledger.currentRows(CHAT_ID).map(row => row.kind)).toEqual(['permission-requested']);
      });
    });
  }

  it('does not revive a permission after its run ends during a definitely undispatched response', async () => {
    await withPermission(async (fixture) => {
      const response = fixture.resolve();
      await fixture.started.promise;
      fixture.ledger.interruptRun(CHAT_ID);
      fixture.release.reject(new AgentCallError('not-dispatched', 'Synthetic abandoned response'));
      await expect(response).rejects.toThrow('Synthetic abandoned response');
      await Promise.resolve();
      expect(fixture.feed.currentSnapshot(CHAT_ID)?.rows).toEqual([]);
      expect(fixture.activity()).toBeNull();
      expect(fixture.actionabilityChanges()).toEqual(['claimed']);
    });
  });

  it('releases actionability subscriptions on unsubscribe and ledger close', async () => {
    await withPermission(async (fixture) => {
      const listener = mock((_event: PermissionActionabilityChange) => undefined);
      const unsubscribe = fixture.ledger.subscribePermissionActionabilityChanged(listener);
      const first = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.abandonPermissionResolution(first);
      unsubscribe();
      const second = fixture.ledger.claimPermissionResolution(control);
      fixture.ledger.abandonPermissionResolution(second);
      expect(listener).toHaveBeenCalledTimes(2);
      const closeListener = mock((_event: PermissionActionabilityChange) => undefined);
      fixture.ledger.subscribePermissionActionabilityChanged(closeListener);
      fixture.ledger.close();
      fixture.ledger.abandonPermissionResolution(second);
      expect(closeListener).not.toHaveBeenCalled();
    });
  });
});

interface PermissionFixture {
  readonly ledger: TranscriptLedgerService;
  readonly feed: ChatTransientFeedStore;
  readonly started: PromiseWithResolvers<void>;
  readonly release: PromiseWithResolvers<void>;
  activity(): ReturnType<typeof projectChatActivityStatus>;
  actionabilityChanges(): PermissionActionabilityChange['actionability'][];
  resolve(): Promise<unknown>;
}

async function withPermission(check: (fixture: PermissionFixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-permission-activity-'));
  const chats = new ChatRegistry(root);
  await chats.init();
  const ledger = new TranscriptLedgerService(
    new TranscriptLedgerStore(path.join(root, 'ledger')), { serverInstanceId: 'server-1' },
  );
  const feed = new ChatTransientFeedStore('server-1');
  const actionability = mock((event: PermissionActionabilityChange) => feed.applyPermissionActionability(event));
  ledger.subscribe(event => { feed.apply(event); });
  ledger.subscribePermissionRetired(retired => { feed.retirePermission(retired); });
  ledger.subscribePermissionActionabilityChanged(actionability);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider = integrationFixture(root, EXECUTOR_ID);
  const integration = {
    ...provider.integration,
    permissions: permissionFixture(new Map([[OCCURRENCE_ID, async () => {
      started.resolve();
      await release.promise;
    }]])),
  };
  const integrations = new IntegrationRegistry({ instances: [integration] });
  const executors = {
    isReady: () => true,
    integrationsFor: () => integrations,
    knownIntegration: ({ agentId }) => integrations.get(agentId) ?? null,
    requireIntegration: ({ agentId }) => integrations.require(agentId),
  } satisfies ExecutionIntegrationDirectory;
  const directory = new AgentDirectory(executors);
  try {
    chats.addChat({
      id: CHAT_ID, executorId: EXECUTOR_ID, agentId: 'test', model: 'synthetic-model', projectPath: root,
      parentChatId: null, lineage: null, preambleSelection: { revision: 0, orderedPreambleIds: [] },
    });
    ledger.initializeChat(CHAT_ID);
    const producer = ledger.openProducer(CHAT_ID, 'test');
    ledger.beginRun(CHAT_ID, 'run-1');
    producer.sink.publish({
      type: 'permission', runId: 'run-1',
      lifecycle: {
        kind: 'requested', permissionOccurrenceId: OCCURRENCE_ID,
        requestedTool: new BashToolUseMessage(AT, 'tool-1', 'pwd'), options: [],
      },
      decision: { permissionOccurrenceId: OCCURRENCE_ID, response: permissionResponse(OCCURRENCE_ID) },
    });
    await Promise.resolve();
    const router = new AgentRuntimeRouter({
      registry: chats, directory, ledger, events: new AgentEventBus(),
      adoption: new TranscriptAdoptionService({
        ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
      }),
      endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
      getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
      hasPendingOwnershipTransfer: () => false,
      resolveFileMentions: async command => command,
    });
    const activity = () => projectChatActivityStatus({
      processingPhase: ledger.isRunActive(CHAT_ID, 'run-1') ? 'running' : null,
      pendingUserAction: feed.hasPendingUserAction(CHAT_ID),
      lastRunOutcome: null,
    });
    expect(activity()).toBe('pending-user-action');
    await check({
      ledger, feed, started, release, activity,
      actionabilityChanges: () => actionability.mock.calls.map(([event]) => event.actionability),
      resolve: () => router.resolvePermission(CHAT_ID, OCCURRENCE_ID, { allow: true }, control, interactiveDeadline()),
    });
  } finally {
    ledger.close();
    await chats.flush();
    await rm(root, { recursive: true, force: true });
  }
}
