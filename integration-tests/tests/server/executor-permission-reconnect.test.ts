import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashToolUseMessage } from '../../../common/chat-types.js';
import { ApiProviderEndpointResolver } from '../../../server/controller/api-providers/endpoint-resolver.js';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { ChatTransientFeedStore } from '../../../server/controller/chats/chat-transient-feed.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../../server/controller/agents/directory.js';
import { AgentEventBus } from '../../../server/controller/agents/event-bus.js';
import { IntegrationRegistry } from '../../../server/runtime/agents/integration-registry.js';
import { AgentRuntimeRouter } from '../../../server/controller/agents/runtime-router.js';
import { integrationFixture, linkOptions } from '../../../server/remote/__tests__/integration-fixture.js';
import { serveExecutionRuntime } from '../../../server/remote/server/executor-rpc-server.js';
import { ExecutorRpc } from '../../../server/remote/transport/rpc.js';
import { RemoteExecutorClient } from '../../../server/remote/client/executor-client.js';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { PermissionNotActionableError } from '../../../server/controller/ledger/errors.js';
import { DomainError } from '../../../server/common/domain-error.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const CHAT = '1783725900000400';
const OCCURRENCE = '11111111-1111-4111-8111-111111111111';

for (const [dialer, scenario] of [
  ['controller', 'disconnect'], ['worker', 'disconnect'],
  ['controller', 'uncertain response'], ['worker', 'uncertain response'],
] as const) {
  test(`${scenario} retires permission actionability without recording success (${dialer} dials)`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'garcon-permission-reconnect-'));
    const chats = new ChatRegistry(root);
    await chats.init();
    const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
    const feed = new ChatTransientFeedStore('synthetic-server');
    ledger.subscribe(event => { feed.apply(event); });
    ledger.subscribePermissionRetired(control => { feed.retirePermission(control); });
    const controller = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'controller' });
    const worker = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'worker' });
    const native = integrationFixture(root, EXECUTOR);
    const serving: ReturnType<typeof serveExecutionRuntime>[] = [];
    worker.onSession(session => serving.push(serveExecutionRuntime(native.executor, new ExecutorRpc(session))));
    const connected = RemoteExecutorClient.connect(controller);
    if (dialer === 'controller') controller.dial(worker.listen());
    else worker.dial(controller.listen());
    const remote = await connected;
    try {
      const integration = await remote.getAgentIntegration('test');
      const integrations = new IntegrationRegistry({ instances: [integration] });
      const executors = {
        isReady: () => remote.availability === 'ready',
        integrationsFor() { return integrations; },
        knownIntegration: ({ agentId }) => integrations.get(agentId),
        requireIntegration({ agentId }) {
          if (remote.availability !== 'ready') {
            throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
          }
          return integrations.require(agentId);
        },
      } satisfies ExecutionIntegrationDirectory;
      const directory = new AgentDirectory(new IntegrationRegistry({ instances: [] }), executors);
      const adoption = new TranscriptAdoptionService({
        ledger, registry: chats, integrations: directory, getCarryOverRevision: () => '', loadFrozenPrefix: async () => [],
      });
      chats.addChat({ id: CHAT, executorId: EXECUTOR, agentId: 'test', model: 'synthetic-model', projectPath: root,
        parentChat: null, preambleSelection: { revision: 0, orderedPreambleIds: [] } });
      ledger.initializeChat(CHAT);
      const router = new AgentRuntimeRouter({
        registry: chats, directory, ledger, adoption, events: new AgentEventBus(),
        endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
        getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
        hasPendingOwnershipTransfer: () => false, resolveFileMentions: async prompt => prompt,
      });
      remote.onAvailabilityChanged(value => { if (value === 'offline') router.executionSessionLost(EXECUTOR); });
      await router.startSession(CHAT, 'Synthetic permission input');
      const runId = ledger.activeRunId(CHAT)!;
      const decisions: boolean[] = [];
      native.nativePublishers[0]!({ type: 'permission', runId,
        lifecycle: { kind: 'requested', permissionOccurrenceId: OCCURRENCE,
          requestedTool: new BashToolUseMessage('2026-09-23T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [] },
        decision: { permissionOccurrenceId: OCCURRENCE, async respond(decision) {
          decisions.push(decision.allow);
          if (scenario === 'uncertain response') throw new Error('Synthetic uncertain permission response');
        } },
      });
      await integration.execution.runningSessions();
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-requested')).toHaveLength(1);
      const original = controller.current;
      const control = { serverInstanceId: 'synthetic-server', chatId: CHAT, runId, permissionOccurrenceId: OCCURRENCE };
      expect(feed.validateAction(control).permissionOccurrenceId).toBe(OCCURRENCE);
      if (scenario === 'uncertain response') {
        await expect(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control))
          .rejects.toThrow('Synthetic uncertain permission response');
        expect(controller.current).toBe(original);
        expect(remote.availability).toBe('ready');
        expect(ledger.isRunActive(CHAT, runId)).toBe(true);
        expect(feed.currentSnapshot(CHAT)?.rows).toEqual([]);
        await expect(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control))
          .rejects.toBeInstanceOf(PermissionNotActionableError);
        expect(decisions).toEqual([true]);
        expect(ledger.currentRows(CHAT).filter(row => row.kind.startsWith('permission-')).map(row => row.kind))
          .toEqual(['permission-requested']);
        native.nativePublishers[0]!({ type: 'permission', runId,
          lifecycle: { kind: 'cancelled', permissionOccurrenceId: OCCURRENCE, reason: null },
        });
        await integration.execution.runningSessions();
        expect(ledger.currentRows(CHAT).filter(row => row.kind.startsWith('permission-')).map(row => row.kind))
          .toEqual(['permission-requested', 'permission-cancelled']);
        return;
      }
      const restored = Promise.withResolvers<void>();
      remote.onAvailabilityChanged(availability => { if (availability === 'ready') restored.resolve(); });
      controller.disconnect();
      worker.disconnect();
      expect(remote.availability).toBe('offline');
      await restored.promise;
      expect(controller.current).not.toBe(original);
      expect(serving).toHaveLength(2);
      await expect(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control)).rejects.toBeInstanceOf(PermissionNotActionableError);
      expect(decisions).toEqual([false]);
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-resolved')).toHaveLength(0);
      expect(ledger.currentRows(CHAT).find(row => row.kind === 'run-ended')).toMatchObject({
        outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('Reload from native history') },
      });
    } finally {
      ledger.close();
      await remote.dispose();
      await worker.dispose();
      await Promise.all(serving.map(scope => scope.dispose()));
      await native.executor.dispose();
      await chats.flush();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
}
