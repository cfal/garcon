import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEndpointSelection } from '../../../common/agent-execution.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import type { AgentRuntimeEvent } from '../../../server-agents/common/src/execution/runtime-events.js';
import { resolveAgentEndpoint } from '../../../server-agents/common/src/execution/resolve-endpoint.js';
import { AgentCallError, type AgentHost } from '../../../server-agents/interface/src/index.js';
import { ApiProviderEndpointResolver } from '../../../server/controller/api-providers/endpoint-resolver.js';
import { ChatRegistry } from '../../../server/controller/chats/store.js';
import { AgentDirectory, type ExecutionIntegrationDirectory } from '../../../server/controller/agents/directory.js';
import { AgentEventBus } from '../../../server/controller/agents/event-bus.js';
import { IntegrationHostFactory } from '../../../server/runtime/agents/integration-host.js';
import { IntegrationRegistry } from '../../../server/runtime/agents/integration-registry.js';
import { AgentRuntimeRouter } from '../../../server/controller/agents/runtime-router.js';
import {
  admissionFault, integrationFixture, isExecutionHandleReply, isProducerResumeReply, linkOptions, outgoingFault, outgoingHold,
} from '../../../server/remote/__tests__/integration-fixture.js';
import { serveExecutionRuntime } from '../../../server/remote/server/executor-rpc-server.js';
import { ProducerRelay } from '../../../server/remote/server/producer-relay.js';
import { ExecutorRpc } from '../../../server/remote/transport/rpc.js';
import { connectRemoteExecutor } from '../../../server/remote/__tests__/runtime-adapter.js';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { DomainError } from '../../../server/common/domain-error.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START } from '../../../server/common/executor-disconnect.js';

const EXECUTOR = '33333333-3333-4333-8333-333333333333';
const CHAT = '1783725900000500';
const SYNTHETIC_CREDENTIAL = { kind: 'token', value: 'synthetic-credential' };
const CREDENTIALED_ENDPOINT = {
  apiProviderId: 'synthetic-provider',
  endpointId: 'synthetic-endpoint',
  providerLabel: 'Synthetic provider',
  protocol: 'openai-compatible',
  baseUrl: 'https://example.test',
  model: 'synthetic-model',
  isLocal: false,
  capabilities: { chatCompletions: false, responses: true },
  headers: {},
  credential: { kind: 'api-provider-endpoint', apiProviderId: 'synthetic-provider', endpointId: 'synthetic-endpoint', revision: 1 },
} satisfies AgentEndpointSelection;

type Dialer = 'controller' | 'worker';

type RemoteRouterContext = Awaited<ReturnType<typeof remoteRouter>> & {
  readonly ledger: TranscriptLedgerService;
  readonly native: ReturnType<typeof integrationFixture>;
  readonly controller: WebSocketLink;
  readonly workerFault: ReturnType<typeof outgoingFault>;
  readonly workerPath: ReturnType<typeof outgoingHold>;
  readonly workerAdmission: ReturnType<typeof admissionFault>;
  readonly controllerAdmission: ReturnType<typeof admissionFault>;
  readonly credentialHost: AgentHost;
};

// Runs one chat's turns through the real runtime router against a worker over
// real links, so a lost start reply crosses the same boundaries as production.
async function withRemoteRouter(dialer: Dialer, run: (context: RemoteRouterContext) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-launch-reconnect-'));
  const chats = new ChatRegistry(root);
  await chats.init();
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
  const controller = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'worker' });
  const workerFault = outgoingFault(worker);
  const workerPath = outgoingHold(worker);
  const workerAdmission = admissionFault(worker);
  const controllerAdmission = admissionFault(controller);
  const native = integrationFixture(root, EXECUTOR);
  const relay = new ProducerRelay();
  const serving: ReturnType<typeof serveExecutionRuntime>[] = [];
  let workerRpc: ExecutorRpc | null = null;
  worker.onSession(session => {
    workerRpc = new ExecutorRpc(session);
    serving.push(serveExecutionRuntime(native.executor, workerRpc, relay));
  });
  // Reads credentials from the controller over the current session, as the worker process does.
  const credentialHost = new IntegrationHostFactory({
    workspaceDir: root,
    executorId: EXECUTOR,
    resolveCredential: ({ agentId, reference, signal }) => {
      const rpc = workerRpc;
      if (!rpc) throw new AgentCallError('not-dispatched', 'Executor controller is disconnected');
      return rpc.call(agentId, 'credentials.resolve', { reference }, { signal });
    },
  }).forAgent('test');
  // Serves those reads, as the controller's executor manager does.
  const connected = connectRemoteExecutor(controller, rpc => rpc.handle(async call => {
    if (call.method !== 'credentials.resolve') throw new AgentCallError('rejected', 'Operation is not permitted on the controller');
    return SYNTHETIC_CREDENTIAL;
  }));
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const remote = await connected;
  try {
    const routed = await remoteRouter({ root, chats, ledger, remote });
    await run({ ...routed, ledger, native, controller, workerFault, workerPath, workerAdmission, controllerAdmission, credentialHost });
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

async function remoteRouter({ root, chats, ledger, remote }: {
  readonly root: string;
  readonly chats: ChatRegistry;
  readonly ledger: TranscriptLedgerService;
  readonly remote: Awaited<ReturnType<typeof connectRemoteExecutor>>;
}) {
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
  // The agent registry forwards ledger terminals to the event bus, which releases the tracked turn.
  const events = new AgentEventBus();
  ledger.subscribe(event => {
    if (event.type === 'run-ended') return events.publishRunEnded(event.chatId, event.runId, event.row);
  });
  const router = new AgentRuntimeRouter({
    registry: chats, directory, ledger, adoption, events,
    endpointResolver: new ApiProviderEndpointResolver(() => [], () => []),
    getCarryOverRevision: () => '', createCarriedContext: async () => ({ kind: 'no-history' }),
    hasPendingOwnershipTransfer: () => false, resolveFileMentions: async prompt => prompt,
  });
  remote.onAvailabilityChanged(value => {
    if (value === 'offline') router.executionSessionLost(EXECUTOR);
    if (value === 'ready') router.executionSessionResumed(EXECUTOR);
  });
  const restored = () => new Promise<void>(resolve => {
    const off = remote.onAvailabilityChanged(availability => { if (availability === 'ready') { off(); resolve(); } });
  });
  return { router, integration, restored };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Condition not reached');
    await Bun.sleep(5);
  }
}

function runEnd(ledger: TranscriptLedgerService) {
  return ledger.currentRows(CHAT).find(row => row.kind === 'run-ended');
}

function runEnds(ledger: TranscriptLedgerService) {
  return ledger.currentRows(CHAT).flatMap(row => row.kind === 'run-ended' ? [{ outcome: row.outcome, origin: row.origin }] : []);
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`a start cancelled by a disconnect fails its turn once the executor reconnects (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controller, restored }) => {
      const entered = Promise.withResolvers<void>();
      native.hooks.start = async ({ admission }) => {
        entered.resolve();
        await new Promise<never>((_, reject) => admission.signal.addEventListener('abort', () => {
          reject(new Error('Synthetic cancelled admission'));
        }, { once: true }));
      };
      const reconnected = restored();
      const turn = router.startSession(CHAT, 'Synthetic input');
      await entered.promise;
      controller.disconnect();
      await turn;
      expect(router.isChatRunning(CHAT)).toBe(true);

      await reconnected;
      await until(() => !router.isChatRunning(CHAT));
      expect(runEnd(ledger)).toMatchObject({ outcome: 'failed', origin: 'core', error: EXECUTOR_DISCONNECTED_BEFORE_START });
    });
  }, 30_000);

  test(`a Stop sent while a start reply was lost reaches the worker after it reconnects (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, restored, workerFault }) => {
      workerFault.inject = (encoded) => {
        if (!isExecutionHandleReply(encoded)) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      const reconnected = restored();
      await router.startSession(CHAT, 'Synthetic input');
      expect(router.isChatRunning(CHAT)).toBe(true);
      await router.abortSession(CHAT);
      expect(native.calls.abort).toBe(0);

      await reconnected;
      await until(() => native.calls.abort === 1);
      expect(runEnd(ledger)).toMatchObject({ outcome: 'interrupted', origin: 'core' });
    });
  }, 30_000);

  test(`a start whose reply was lost keeps running and stops after the executor reconnects (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, native, restored, workerFault }) => {
      workerFault.inject = (encoded) => {
        if (!isExecutionHandleReply(encoded)) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      const reconnected = restored();
      await router.startSession(CHAT, 'Synthetic input');
      await reconnected;
      expect(router.isChatRunning(CHAT)).toBe(true);

      // The resumed binding has already reported the handle, so Stop reaches the turn directly.
      await router.abortSession(CHAT);
      await until(() => native.calls.abort === 1);
      expect(router.isChatRunning(CHAT)).toBe(false);
    });
  }, 30_000);

  test(`a start whose reply the worker could not deliver keeps running and Stop reaches it (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, integration, workerAdmission }) => {
      workerAdmission.refuseNext(isExecutionHandleReply);
      await router.startSession(CHAT, 'Synthetic input');
      await integration.execution.runningSessions();
      expect(router.isChatRunning(CHAT)).toBe(true);

      await router.abortSession(CHAT);
      await until(() => native.calls.abort === 1);
      expect(runEnd(ledger)).toMatchObject({ outcome: 'interrupted', origin: 'core' });
    });
  }, 30_000);

  test(`a start that fails with a nested unknown outcome fails its turn (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native }) => {
      native.hooks.start = async () => {
        throw new AgentCallError('unknown', 'Synthetic nested call outcome is unknown');
      };
      await expect(router.startSession(CHAT, 'Synthetic input')).rejects.toMatchObject({ outcome: 'rejected' });

      expect(router.isChatRunning(CHAT)).toBe(false);
      expect(runEnd(ledger)).toMatchObject({
        outcome: 'failed', origin: 'core', error: { message: 'Synthetic nested call outcome is unknown' },
      });
    });
  }, 30_000);

  test(`a start whose credential read the controller could not answer fails its turn and can be retried (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controllerAdmission, credentialHost }) => {
      native.hooks.start = async ({ admission }) => {
        await resolveAgentEndpoint(credentialHost, CREDENTIALED_ENDPOINT, admission.signal);
      };
      const unreadable = 'Provider credential could not be read from the controller. Try again.';
      controllerAdmission.refuseNext(encoded => encoded.includes('"type":"result"') && encoded.includes(SYNTHETIC_CREDENTIAL.value));
      await expect(router.startSession(CHAT, 'Synthetic input')).rejects.toMatchObject({ outcome: 'rejected', message: unreadable });

      expect(router.isChatRunning(CHAT)).toBe(false);
      expect(runEnd(ledger)).toMatchObject({ outcome: 'failed', origin: 'core', error: { message: unreadable } });
      await router.startSession(CHAT, 'Synthetic retry');
      expect(router.isChatRunning(CHAT)).toBe(true);
      expect(native.calls.start).toBe(2);
    });
  }, 30_000);

  test(`a turn started while a replay drains keeps running until its own reply arrives (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, integration, controller, restored, workerPath }) => {
      let rowsReceived = 0;
      integration.producers.subscribe(({ event }) => { if (event.type === 'rows') rowsReceived += 1; });
      await router.startSession(CHAT, 'Synthetic first input');
      const publish = native.nativePublishers[0]!;
      const reconnected = restored();
      // The replay tail after the resume reply stays on a stalled path until the new turn's start reaches the worker.
      workerPath.holdAfter(isProducerResumeReply);
      controller.disconnect();
      // Beyond the producer share of the session queue, so the replay tail follows the resume reply.
      const count = 1_500;
      for (let index = 0; index < count; index += 1) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', `${index}:${'x'.repeat(9_000)}`) }] });
      }
      await reconnected;

      await router.abortSession(CHAT);
      const release = Promise.withResolvers<void>();
      let rowsAtStart = count;
      native.hooks.start = async () => { rowsAtStart = rowsReceived; await release.promise; };
      const turn = router.startSession(CHAT, 'Synthetic second input');
      try {
        await until(() => native.calls.start === 2);
        await workerPath.release();
        await until(() => rowsReceived === count);
        await integration.execution.runningSessions();

        expect(rowsAtStart).toBeLessThan(count);
        expect(router.isChatRunning(CHAT)).toBe(true);
        expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
      } finally { release.resolve(); }
      await turn;
      await router.abortSession(CHAT);
      await until(() => native.calls.abort === 2);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }, { outcome: 'interrupted', origin: 'core' }]);
    });
  }, 60_000);

  test(`a permission request the controller cannot read fails the turn as an unknown outcome and stops it (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native }) => {
      await router.startSession(CHAT, 'Synthetic input');
      const permissionOccurrenceId = crypto.randomUUID();
      // A tool message type this controller cannot parse, as a worker from a mismatched or faulty build would send.
      native.nativePublishers[0]!({
        type: 'permission', runId: ledger.activeRunId(CHAT)!,
        lifecycle: {
          kind: 'requested', permissionOccurrenceId, options: [],
          requestedTool: { type: 'synthetic-unknown-tool', timestamp: '2026-01-01T00:00:00Z' },
        },
        decision: { permissionOccurrenceId, respond: async () => {} },
      } as unknown as AgentRuntimeEvent);
      await until(() => runEnd(ledger) !== undefined && native.calls.abort > 0);

      expect(runEnd(ledger)).toMatchObject({
        outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('could not be read') },
      });
      expect(ledger.currentRows(CHAT).some(row => row.kind === 'permission-requested')).toBe(false);
      expect(router.isChatRunning(CHAT)).toBe(false);
    });
  }, 30_000);

  test(`a launch outcome the controller cannot read during a reconnect fails the turn and stops it (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controller, restored }) => {
      await router.startSession(CHAT, 'Synthetic input');
      const reconnected = restored();
      controller.disconnect();
      native.nativePublishers[0]!({ type: 'launch-settled', runId: 42 } as unknown as AgentRuntimeEvent);
      await reconnected;
      await until(() => runEnd(ledger) !== undefined && native.calls.abort > 0);

      expect(runEnd(ledger)).toMatchObject({
        outcome: 'failed', error: { code: 'OUTCOME_UNKNOWN', message: expect.stringContaining('could not be read') },
      });
      expect(router.isChatRunning(CHAT)).toBe(false);
    });
  }, 30_000);
}
