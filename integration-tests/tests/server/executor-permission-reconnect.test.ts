import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessage, BashToolUseMessage } from '../../../common/chat-types.js';
import { ApiProviderEndpointResolver } from '../../../server/controller/api-providers/endpoint-resolver.js';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { ChatTransientFeedStore } from '../../../server/controller/chats/chat-transient-feed.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../../server/controller/agents/directory.js';
import { AgentEventBus } from '../../../server/controller/agents/event-bus.js';
import { IntegrationRegistry } from '../../../server/runtime/agents/integration-registry.js';
import { AgentRuntimeRouter } from '../../../server/controller/agents/runtime-router.js';
import { integrationFixture, linkOptions } from '../../../server/remote/__tests__/integration-fixture.js';
import { serveExecutionRuntime } from '../../../server/remote/server/executor-rpc-server.js';
import { ProducerRelay, type ProducerRelayOptions } from '../../../server/remote/server/producer-relay.js';
import type { RemoteExecutorClientOptions } from '../../../server/remote/client/executor-client.js';
import { ExecutorRpc } from '../../../server/remote/transport/rpc.js';
import { connectRemoteExecutor } from '../../../server/remote/__tests__/runtime-adapter.js';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { PermissionNotActionableError } from '../../../server/controller/ledger/errors.js';
import { DomainError } from '../../../server/common/domain-error.js';
import { interactiveDeadline } from '../../../server/common/interactive-deadline.js';
import { rejectionOf, throwingRejectionOf } from '../../support/promise-assertions.js';

const EXECUTOR = '22222222-2222-4222-8222-222222222222';
const CHAT = '1783725900000400';
const OCCURRENCE = '11111111-1111-4111-8111-111111111111';

type Dialer = 'controller' | 'worker';

async function withPendingPermission(
  dialer: Dialer,
  resumption: { readonly relay?: ProducerRelayOptions; readonly client?: RemoteExecutorClientOptions },
  respond: (decision: { readonly allow: boolean }) => Promise<void>,
  run: (context: Awaited<ReturnType<typeof pendingPermission>>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'garcon-permission-reconnect-'));
  const chats = new ChatRegistry(root);
  await chats.init();
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
  const controller = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'worker' });
  const native = integrationFixture(root, EXECUTOR);
  const relay = new ProducerRelay(resumption.relay);
  const serving: ReturnType<typeof serveExecutionRuntime>[] = [];
  worker.onSession(session => serving.push(serveExecutionRuntime(native.executor, new ExecutorRpc(session), relay)));
  const connected = connectRemoteExecutor(controller, undefined, resumption.client);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const remote = await connected;
  try {
    await run(await pendingPermission({ root, chats, ledger, controller, native, remote, serving, respond }));
  } finally {
    ledger.close();
    await remote.dispose();
    await worker.dispose();
    await Promise.all(serving.map(scope => scope.dispose()));
    relay.dispose();
    await native.executor.dispose();
    await chats.flush();
    await rm(root, { recursive: true, force: true });
  }
}

async function pendingPermission({ root, chats, ledger, controller, native, remote, serving, respond }: {
  readonly root: string;
  readonly chats: ChatRegistry;
  readonly ledger: TranscriptLedgerService;
  readonly controller: WebSocketLink;
  readonly native: ReturnType<typeof integrationFixture>;
  readonly remote: Awaited<ReturnType<typeof connectRemoteExecutor>>;
  readonly serving: readonly ReturnType<typeof serveExecutionRuntime>[];
  readonly respond: (decision: { readonly allow: boolean }) => Promise<void>;
}) {
  const feed = new ChatTransientFeedStore('synthetic-server');
  ledger.subscribe(event => { feed.apply(event); });
  ledger.subscribePermissionRetired(control => { feed.retirePermission(control); });
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
  remote.onAvailabilityChanged(value => {
    if (value === 'offline') router.executionSessionLost(EXECUTOR);
    if (value === 'ready') router.executionSessionResumed(EXECUTOR);
  });
  await router.startSession(CHAT, 'Synthetic permission input');
  const runId = ledger.activeRunId(CHAT)!;
  native.nativePublishers[0]!({ type: 'permission', runId,
    lifecycle: { kind: 'requested', permissionOccurrenceId: OCCURRENCE,
      requestedTool: new BashToolUseMessage('2026-09-23T00:00:00.000Z', 'synthetic-tool', 'pwd'), options: [] },
    decision: { permissionOccurrenceId: OCCURRENCE, respond },
  });
  await integration.execution.runningSessions();
  expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-requested')).toHaveLength(1);
  const control = { serverInstanceId: 'synthetic-server', chatId: CHAT, runId, permissionOccurrenceId: OCCURRENCE };
  expect(feed.validateAction(control).permissionOccurrenceId).toBe(OCCURRENCE);
  const restored = () => new Promise<void>(resolve => {
    const off = remote.onAvailabilityChanged(availability => { if (availability === 'ready') { off(); resolve(); } });
  });
  const disconnect = () => { controller.disconnect(); };
  return { integration, feed, router, runId, control, remote, controller, native, serving, restored, disconnect, ledger };
}

function permissionRows(ledger: TranscriptLedgerService): string[] {
  return ledger.currentRows(CHAT).filter(row => row.kind.startsWith('permission-')).map(row => row.kind);
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`an uncertain response retires permission actionability without recording success (${dialer} dials)`, async () => {
    const decisions: boolean[] = [];
    await withPendingPermission(dialer, {}, async (decision) => {
      decisions.push(decision.allow);
      throw new Error('Synthetic uncertain permission response');
    }, async ({ router, control, remote, controller, ledger, feed, runId, native, integration }) => {
      const original = controller.current;
      expect(await throwingRejectionOf(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline()))).toThrow('Synthetic uncertain permission response');
      expect(controller.current).toBe(original);
      expect(remote.availability).toBe('ready');
      expect(ledger.isRunActive(CHAT, runId)).toBe(true);
      expect(feed.currentSnapshot(CHAT)?.rows).toEqual([]);
      expect(await rejectionOf(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline()))).toBeInstanceOf(PermissionNotActionableError);
      expect(decisions).toEqual([true]);
      expect(permissionRows(ledger)).toEqual(['permission-requested']);
      native.nativePublishers[0]!({ type: 'permission', runId,
        lifecycle: { kind: 'cancelled', permissionOccurrenceId: OCCURRENCE, reason: null },
      });
      await integration.execution.runningSessions();
      expect(permissionRows(ledger)).toEqual(['permission-requested', 'permission-cancelled']);
    });
  }, 30_000);

  test(`a short disconnect keeps the permission pending and delivers the later answer once (${dialer} dials)`, async () => {
    const decisions: boolean[] = [];
    await withPendingPermission(dialer, {}, async (decision) => {
      decisions.push(decision.allow);
    }, async ({ router, control, remote, controller, ledger, feed, runId, serving, restored, disconnect }) => {
      const original = controller.current;
      const reconnected = restored();
      disconnect();
      expect(remote.availability).toBe('reconnecting');
      // A decision cannot reach the worker yet; it stays actionable instead of being consumed.
      expect(await rejectionOf(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline()))).toMatchObject({ code: 'EXECUTOR_UNAVAILABLE' });
      expect(feed.validateAction(control).permissionOccurrenceId).toBe(OCCURRENCE);
      await reconnected;
      expect(controller.current).not.toBe(original);
      expect(serving).toHaveLength(2);
      expect(ledger.isRunActive(CHAT, runId)).toBe(true);

      await router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline());
      expect(decisions).toEqual([true]);
      expect(permissionRows(ledger)).toEqual(['permission-requested', 'permission-resolved']);
      expect(await rejectionOf(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline()))).toBeInstanceOf(PermissionNotActionableError);
      expect(decisions).toEqual([true]);
    });
  }, 30_000);

  test(`output produced during a short disconnect reaches the transcript once (${dialer} dials)`, async () => {
    await withPendingPermission(dialer, {}, async () => {}, async ({ ledger, native, serving, restored, disconnect, integration }) => {
      const reconnected = restored();
      disconnect();
      native.nativePublishers[0]!({ type: 'rows', rows: [{
        message: new AssistantMessage('2026-09-23T00:00:01.000Z', 'Synthetic output during the gap'),
      }] });
      await reconnected;
      await integration.execution.runningSessions();

      expect(ledger.currentRows(CHAT).flatMap(row => (
        row.kind === 'provider-row' && row.message.type === 'assistant-message' ? [row.message.content] : []
      ))).toEqual(['Synthetic output during the gap']);
      expect(serving).toHaveLength(2);
    });
  }, 30_000);

  test(`output the controller cannot decode during a short disconnect becomes one notice without another reconnect (${dialer} dials)`, async () => {
    await withPendingPermission(dialer, {}, async () => {}, async ({ ledger, native, serving, restored, disconnect, integration }) => {
      const reconnected = restored();
      disconnect();
      const publish = native.nativePublishers[0]!;
      // A message type this controller cannot parse, as a worker from a mismatched or faulty build would send.
      for (let batch = 0; batch < 2; batch += 1) {
        publish({ type: 'rows', rows: [{
          message: { type: 'synthetic-unknown-message', timestamp: '2026-09-23T00:00:01.000Z' } as unknown as AssistantMessage,
        }] });
      }
      publish({ type: 'rows', rows: [{
        message: new AssistantMessage('2026-09-23T00:00:02.000Z', 'Synthetic output after the undecodable event'),
      }] });
      await reconnected;
      await integration.execution.runningSessions();

      expect(ledger.currentRows(CHAT).flatMap(row => (
        row.kind === 'provider-row' && row.message.type === 'assistant-message' ? [row.message.content] : []
      ))).toEqual(['Synthetic output after the undecodable event']);
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'notice')).toEqual([
        expect.objectContaining({ message: expect.stringContaining('Reload from native history') }),
      ]);
      expect(serving).toHaveLength(2);
    });
  }, 30_000);

  test(`an expired reconnect grace denies the permission and fails the run as disconnected (${dialer} dials)`, async () => {
    const decisions: boolean[] = [];
    await withPendingPermission(dialer, { relay: { graceMs: 1 }, client: { reconnectGraceMs: 1 } }, async (decision) => {
      decisions.push(decision.allow);
    }, async ({ router, control, ledger, restored, disconnect }) => {
      const reconnected = restored();
      disconnect();
      await reconnected;
      await Bun.sleep(10);

      expect(await rejectionOf(router.resolvePermission(CHAT, OCCURRENCE, { allow: true }, control, interactiveDeadline()))).toBeInstanceOf(PermissionNotActionableError);
      expect(decisions).toEqual([false]);
      expect(ledger.currentRows(CHAT).filter(row => row.kind === 'permission-resolved')).toHaveLength(0);
      expect(ledger.currentRows(CHAT).find(row => row.kind === 'run-ended')).toMatchObject({
        outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('Reload from native history') },
      });
    });
  }, 30_000);
}
