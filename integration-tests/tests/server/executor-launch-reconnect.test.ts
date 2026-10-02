import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEndpointSelection } from '../../../common/agent-execution.js';
import { AssistantMessage } from '../../../common/chat-types.js';
import type { AgentRuntimeEvent } from '../../../server-agents/common/src/execution/runtime-events.js';
import { resolveAgentEndpoint } from '../../../server-agents/common/src/execution/resolve-endpoint.js';
import {
  AgentCallError, AgentIntegrationError, type AgentHost, type ExecutorAvailability,
} from '../../../server-agents/interface/src/index.js';
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
import { ProducerRelay } from '../../../server/remote/server/producer-relay.js';
import { RpcReplyJournal } from '../../../server/remote/transport/rpc-journal.js';
import type { ExecutorRpc } from '../../../server/remote/transport/rpc.js';
import { connectRemoteExecutor, servePairedRuntime } from '../../../server/remote/__tests__/runtime-adapter.js';
import { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.js';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.js';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.js';
import { DomainError } from '../../../server/common/domain-error.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START } from '../../../server/common/executor-disconnect.js';
import { rejectionOf } from '../../support/promise-assertions.js';

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
  readonly remote: Awaited<ReturnType<typeof connectRemoteExecutor>>;
  readonly controllerFault: ReturnType<typeof outgoingFault>;
  readonly workerFault: ReturnType<typeof outgoingFault>;
  readonly workerPath: ReturnType<typeof outgoingHold>;
  readonly workerAdmission: ReturnType<typeof admissionFault>;
  readonly controllerAdmission: ReturnType<typeof admissionFault>;
  readonly credentialHost: AgentHost;
};

// Runs one chat's turns through the real runtime router against a worker over
// real links, so a lost start reply crosses the same boundaries as production.
async function withRemoteRouter(
  dialer: Dialer,
  run: (context: RemoteRouterContext) => Promise<void>,
  options: { readonly reconnectGraceMs?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'garcon-launch-reconnect-'));
  const chats = new ChatRegistry(root);
  await chats.init();
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(join(root, 'ledger')), { serverInstanceId: 'synthetic-server' });
  const controller = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, executorId: EXECUTOR, role: 'worker' });
  const controllerFault = outgoingFault(controller);
  const workerFault = outgoingFault(worker);
  const workerPath = outgoingHold(worker);
  const workerAdmission = admissionFault(worker);
  const controllerAdmission = admissionFault(controller);
  const native = integrationFixture(root, EXECUTOR);
  const relay = new ProducerRelay();
  const journal = new RpcReplyJournal();
  const serving: ReturnType<typeof servePairedRuntime>[] = [];
  let workerRpc: ExecutorRpc | null = null;
  worker.onSession(session => {
    const scope = servePairedRuntime(worker, session, native.executor, relay, journal);
    workerRpc = scope.connection.primary;
    serving.push(scope);
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
  }), options);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const remote = await connected;
  try {
    const routed = await remoteRouter({ root, chats, ledger, remote });
    await run({
      ...routed, ledger, native, controller, remote, controllerFault, workerFault, workerPath, workerAdmission, controllerAdmission,
      credentialHost,
    });
  } finally {
    ledger.close();
    await remote.dispose();
    await worker.dispose();
    await Promise.all(serving.map(scope => scope.dispose()));
    relay.dispose();
    journal.dispose();
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
  // As the executor manager does, lookups succeed while the executor reconnects.
  const executors = {
    isReady: () => remote.availability === 'ready',
    integrationsFor() { return integrations; },
    knownIntegration: ({ agentId }) => integrations.get(agentId),
    requireIntegration({ agentId }) {
      if (remote.availability !== 'ready' && remote.availability !== 'reconnecting') {
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

function availability(remote: Awaited<ReturnType<typeof connectRemoteExecutor>>, expected: ExecutorAvailability): Promise<void> {
  return new Promise(resolve => {
    const off = remote.onAvailabilityChanged(value => { if (value === expected) { off(); resolve(); } });
  });
}

// Keeps the executor reconnecting until released: the next worker session
// describes itself only then.
function holdNextReconnect(native: ReturnType<typeof integrationFixture>): () => void {
  const release = Promise.withResolvers<void>();
  const getInfo = native.executor.getInfo;
  native.executor.getInfo = async () => {
    native.executor.getInfo = getInfo;
    await release.promise;
    return getInfo();
  };
  return () => release.resolve();
}

// A round trip on the current session, after which earlier requests have reached the worker.
async function integrationRoundTrip(remote: Awaited<ReturnType<typeof connectRemoteExecutor>>): Promise<void> {
  await (await remote.getAgentIntegration('test')).execution.runningSessions();
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
  test(`a Stop on a live link whose start reply is then lost stops the turn once after the reconnect (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, remote, restored, workerFault }) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // The native runtime finishes admission despite the cancellation.
      native.hooks.start = async () => { entered.resolve(); await release.promise; };
      const admission = new AbortController();
      const turn = router.startSession(CHAT, 'Synthetic input', {
        executionAdmission: { signal: admission.signal, markStarted: async () => {} },
      }).then(() => null, (error: unknown) => error);
      await entered.promise;
      // The execution coordinator's Stop aborts admission, then the session.
      admission.abort(new Error('Synthetic stop'));
      await router.abortSession(CHAT);
      await turn;
      workerFault.inject = (encoded) => {
        if (!isExecutionHandleReply(encoded)) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      const reconnected = restored();
      release.resolve();
      await reconnected;
      await until(() => native.calls.abort > 0);
      // Any second abort would have reached the worker before this round trip returns.
      await integrationRoundTrip(remote);

      expect(native.calls.abort).toBe(1);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
    });
  }, 30_000);

  test(`a start that fails on its own after its session was lost fails its turn with that failure (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controller, restored }) => {
      const entered = Promise.withResolvers<void>();
      const fail = Promise.withResolvers<void>();
      native.hooks.start = async () => {
        entered.resolve();
        await fail.promise;
        throw new AgentIntegrationError('AUTH_REQUIRED', 'Synthetic sign-in required', false);
      };
      const turn = router.startSession(CHAT, 'Synthetic input');
      await entered.promise;
      const reconnected = restored();
      controller.disconnect();
      await reconnected;
      await turn;
      fail.resolve();
      await until(() => runEnd(ledger) !== undefined);

      expect(runEnds(ledger)).toEqual([{ outcome: 'failed', origin: 'core' }]);
      expect(runEnd(ledger)).toMatchObject({ error: { code: 'AUTH_REQUIRED', message: 'Synthetic sign-in required' } });
    });
  }, 30_000);

  test(`a start in flight when the link drops keeps running, and Stop reaches it after the reconnect (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controller, restored }) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      native.hooks.start = async () => { entered.resolve(); await release.promise; };
      const reconnected = restored();
      const turn = router.startSession(CHAT, 'Synthetic input');
      await entered.promise;
      controller.disconnect();
      await turn;
      expect(router.isChatRunning(CHAT)).toBe(true);

      await reconnected;
      release.resolve();
      await router.abortSession(CHAT);
      await until(() => native.calls.abort === 1);
      expect(native.calls.start).toBe(1);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
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
      expect(await rejectionOf(router.startSession(CHAT, 'Synthetic input'))).toMatchObject({ outcome: 'rejected' });

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
      expect(await rejectionOf(router.startSession(CHAT, 'Synthetic input'))).toMatchObject({ outcome: 'rejected', message: unreadable });

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

  test(`a link lost as a turn binds its producer retries with a fresh binding and starts once (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, native, controllerFault }) => {
      const bindings: string[] = [];
      controllerFault.inject = (encoded) => {
        if (!encoded.includes('"method":"producers.bind"')) return null;
        bindings.push(JSON.parse(encoded).request.binding.id);
        return bindings.length === 1 ? 'disconnect' : null;
      };
      await router.startSession(CHAT, 'Synthetic input');

      expect(native.calls.start).toBe(1);
      expect(router.isChatRunning(CHAT)).toBe(true);
      expect(bindings).toHaveLength(2);
      expect(bindings[1]).not.toBe(bindings[0]);
    });
  }, 30_000);

  test(`a turn admitted while the executor reconnects starts once it is ready (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, native, remote, controller }) => {
      const release = holdNextReconnect(native);
      const reconnecting = availability(remote, 'reconnecting');
      controller.disconnect();
      await reconnecting;
      const turn = router.startSession(CHAT, 'Synthetic input');
      await until(() => router.isChatRunning(CHAT));
      expect(native.calls.start).toBe(0);

      release();
      await turn;
      expect(native.calls.start).toBe(1);
      expect(router.isChatRunning(CHAT)).toBe(true);
    });
  }, 30_000);

  test(`Stop cancels a turn held for a reconnecting executor without starting it (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, integration, remote, controller }) => {
      const release = holdNextReconnect(native);
      const reconnecting = availability(remote, 'reconnecting');
      controller.disconnect();
      await reconnecting;
      const admission = new AbortController();
      const turn = router.startSession(CHAT, 'Synthetic input', {
        executionAdmission: { signal: admission.signal, markStarted: async () => {} },
      }).then(() => null, (error: unknown) => error);
      await until(() => router.isChatRunning(CHAT));
      // The execution coordinator's Stop aborts admission, then the session.
      admission.abort(new Error('Synthetic stop'));
      await router.abortSession(CHAT);
      expect(await turn).toBeInstanceOf(Error);

      const ready = availability(remote, 'ready');
      release();
      await ready;
      await integration.execution.runningSessions();
      expect(native.calls.start).toBe(0);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
    });
  }, 30_000);

  test(`a turn held past the reconnect grace fails before it starts, not with an unknown outcome (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, remote, controller }) => {
      const release = holdNextReconnect(native);
      try {
        const reconnecting = availability(remote, 'reconnecting');
        controller.disconnect();
        await reconnecting;
        const failure = await router.startSession(CHAT, 'Synthetic input').then(() => null, (error: unknown) => error);

        expect(failure).toMatchObject({ outcome: 'not-dispatched' });
        expect(native.calls.start).toBe(0);
        expect(runEnds(ledger)).toEqual([{ outcome: 'failed', origin: 'core' }]);
        expect(runEnd(ledger)).toMatchObject({ error: EXECUTOR_DISCONNECTED_BEFORE_START });
      } finally { release(); }
    }, { reconnectGraceMs: 300 });
  }, 30_000);

  // A new chat start holds its chat lock through dispatch, so it waits for a
  // reconnecting executor only until its dispatch deadline.
  test(`a start still waiting for the executor at its dispatch deadline fails before it starts (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, integration, remote, controller }) => {
      const release = holdNextReconnect(native);
      const reconnecting = availability(remote, 'reconnecting');
      controller.disconnect();
      await reconnecting;
      const failure = await router.startSession(CHAT, 'Synthetic input', { dispatchDeadline: performance.now() + 200 })
        .then(() => null, (error: unknown) => error);

      expect(failure).toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      expect(runEnds(ledger)).toEqual([{ outcome: 'failed', origin: 'core' }]);
      const ready = availability(remote, 'ready');
      release();
      await ready;
      await integration.execution.runningSessions();
      expect(native.calls.start).toBe(0);
    });
  }, 30_000);

  test(`a start whose executor reconnects before its dispatch deadline runs once (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, remote, controller }) => {
      const release = holdNextReconnect(native);
      const reconnecting = availability(remote, 'reconnecting');
      controller.disconnect();
      await reconnecting;
      const turn = router.startSession(CHAT, 'Synthetic input', { dispatchDeadline: performance.now() + 10_000 });
      await until(() => router.isChatRunning(CHAT));
      release();
      await turn;

      expect(native.calls.start).toBe(1);
      expect(runEnds(ledger)).toEqual([]);
    });
  }, 30_000);

  test(`a start lost as it is sent runs once after the executor reconnects, and Stop reaches it (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controllerFault, restored }) => {
      let sent = 0;
      controllerFault.inject = (encoded) => {
        if (!encoded.includes('"method":"execution.start"')) return null;
        sent += 1;
        return sent === 1 ? 'disconnect' : null;
      };
      const reconnected = restored();
      await router.startSession(CHAT, 'Synthetic input');
      expect(router.isChatRunning(CHAT)).toBe(true);

      await reconnected;
      await until(() => native.calls.start === 1);
      await router.abortSession(CHAT);
      await until(() => native.calls.abort === 1);
      expect(sent).toBe(2);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
    });
  }, 30_000);

  test(`a start the worker received is not sent again when its failure reply is lost (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, workerFault, restored }) => {
      native.hooks.start = async () => { throw new Error('Synthetic start failure'); };
      workerFault.inject = (encoded) => {
        if (!encoded.includes('"type":"error"') || !encoded.includes('Synthetic start failure')) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      const reconnected = restored();
      await router.startSession(CHAT, 'Synthetic input');
      expect(router.isChatRunning(CHAT)).toBe(true);

      await reconnected;
      await until(() => !router.isChatRunning(CHAT));
      expect(native.calls.start).toBe(1);
      expect(runEnd(ledger)).toMatchObject({ outcome: 'failed', origin: 'core', error: EXECUTOR_DISCONNECTED_BEFORE_START });
    });
  }, 30_000);

  test(`a start whose relaunch is lost as well fails before it starts (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, controllerFault }) => {
      let sent = 0;
      controllerFault.inject = (encoded) => {
        if (!encoded.includes('"method":"execution.start"')) return null;
        sent += 1;
        return 'disconnect';
      };
      await router.startSession(CHAT, 'Synthetic input');

      await until(() => !router.isChatRunning(CHAT));
      expect(sent).toBe(2);
      expect(native.calls.start).toBe(0);
      expect(runEnd(ledger)).toMatchObject({ outcome: 'failed', origin: 'core', error: EXECUTOR_DISCONNECTED_BEFORE_START });
    });
  }, 30_000);

  for (const stopAt of ['during the gap', 'after the reconnect'] as const) {
    test(`Stop ${stopAt} cancels a start still in native admission whose call was lost (${dialer} dials)`, async () => {
      await withRemoteRouter(dialer, async ({ router, ledger, native, remote, controller }) => {
        const entered = Promise.withResolvers<AbortSignal>();
        const release = Promise.withResolvers<void>();
        let submitted = false;
        native.hooks.start = async ({ admission }) => {
          entered.resolve(admission.signal);
          await release.promise;
          admission.signal.throwIfAborted();
          submitted = true;
        };
        try {
          const admission = new AbortController();
          const turn = router.startSession(CHAT, 'Synthetic input', {
            executionAdmission: { signal: admission.signal, markStarted: async () => {} },
          });
          const nativeAdmission = await entered.promise;
          const releaseReconnect = holdNextReconnect(native);
          const ready = availability(remote, 'ready');
          controller.disconnect();
          await turn;
          expect(router.isChatRunning(CHAT)).toBe(true);
          if (stopAt === 'after the reconnect') {
            releaseReconnect();
            await ready;
          }
          // The execution coordinator's Stop aborts admission, then the session.
          admission.abort(new Error('Synthetic stop'));
          await router.abortSession(CHAT);
          releaseReconnect();
          await ready;

          await until(() => nativeAdmission.aborted);
          release.resolve();
          await integrationRoundTrip(remote);
          expect(submitted).toBe(false);
          expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
        } finally { release.resolve(); }
      });
    }, 30_000);
  }

  test(`a new turn cancels an earlier start still in admission whose call was lost (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, native, controller, restored }) => {
      const admissions: AbortSignal[] = [];
      const release = Promise.withResolvers<void>();
      native.hooks.start = async ({ admission }) => {
        admissions.push(admission.signal);
        if (admissions.length === 1) await release.promise;
      };
      try {
        const reconnected = restored();
        const first = router.startSession(CHAT, 'Synthetic first input');
        await until(() => admissions.length === 1);
        controller.disconnect();
        await first;
        await reconnected;
        // Without an admission signal, Stop cannot name the lost start to the worker.
        await router.abortSession(CHAT);
        await router.startSession(CHAT, 'Synthetic second input');

        expect(admissions).toHaveLength(2);
        expect(admissions[0]!.aborted).toBe(true);
        expect(admissions[1]!.aborted).toBe(false);
        expect(router.isChatRunning(CHAT)).toBe(true);
      } finally { release.resolve(); }
    });
  }, 30_000);

  test(`Stop during the gap suppresses the relaunch of a start the worker never received (${dialer} dials)`, async () => {
    await withRemoteRouter(dialer, async ({ router, ledger, native, remote, controllerFault }) => {
      let sent = 0;
      const releaseReconnect = holdNextReconnect(native);
      controllerFault.inject = (encoded) => {
        if (!encoded.includes('"method":"execution.start"')) return null;
        sent += 1;
        return sent === 1 ? 'disconnect' : null;
      };
      const admission = new AbortController();
      await router.startSession(CHAT, 'Synthetic input', {
        executionAdmission: { signal: admission.signal, markStarted: async () => {} },
      });
      admission.abort(new Error('Synthetic stop'));
      await router.abortSession(CHAT);
      const ready = availability(remote, 'ready');
      releaseReconnect();
      await ready;
      await integrationRoundTrip(remote);

      expect(sent).toBe(1);
      expect(native.calls.start).toBe(0);
      expect(runEnds(ledger)).toEqual([{ outcome: 'interrupted', origin: 'core' }]);
    });
  }, 30_000);
}
