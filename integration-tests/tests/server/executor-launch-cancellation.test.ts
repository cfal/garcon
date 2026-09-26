import { expect, test } from 'bun:test';
import type { AgentEstablishedSession, AgentIntegration } from '../../../server-agents/interface/src/index.js';
import { remoteFixture, requestFor } from '../../../server/remote/__tests__/integration-fixture.js';
import type { ExecutorRpcMethods } from '../../../server/remote/transport/rpc-protocol.js';
import type { WebSocketLink } from '../../../server/remote/transport/websocket-link.js';
import { createAgentProjectPathUpdates } from '../../../server-agents/common/src/execution/project-path-adapter.js';
import { createAgentProducerAdapter } from '../../../server-agents/common/src/execution/producer-adapter.js';
import type { AgentRuntimeExecution } from '../../../server-agents/common/src/execution/runtime-events.js';
import { withTimeout } from '../../support/deferred.js';

function holdResult(worker: WebSocketLink, method: keyof ExecutorRpcMethods) {
  const held = Promise.withResolvers<() => void>();
  worker.onSession((session) => {
    let id: string | undefined;
    let intercepted = false;
    session.onMessage((encoded) => {
      const frame = JSON.parse(encoded);
      if (!intercepted && frame.type === 'request' && frame.method === method) id = frame.id;
    });
    const send = session.send.bind(session);
    session.send = (encoded) => {
      const frame = JSON.parse(encoded);
      if (frame.type === 'result' && frame.id === id) {
        intercepted = true;
        held.resolve(() => send(encoded));
        id = undefined;
      } else send(encoded);
    };
  });
  return held.promise;
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`Stop cancels a resumed native turn before markStarted after the RPC returns (${dialer} dials)`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed = Promise.withResolvers<boolean>();
    let started = false;
    const runtime: AgentRuntimeExecution = {
      async start() { throw new Error('Unexpected new-session launch'); },
      async resume(request) {
        entered.resolve();
        await release.promise;
        observed.resolve(request.admission.signal.aborted);
        request.admission.signal.throwIfAborted();
        await request.admission.markStarted();
        started = true;
      },
      async abort() { return false; },
      runningSessions() { return []; },
    };
    const fixture = await remoteFixture(dialer, (_controller, _worker, native) => {
      const adapter = createAgentProducerAdapter(runtime, {
        scope: native.scope, logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      Object.assign(native.integration, { execution: adapter.execution, producers: adapter.producers,
        permissions: adapter.permissions } satisfies Pick<AgentIntegration, 'execution' | 'producers' | 'permissions'>);
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const admission = new AbortController();
      const handle = await integration.execution.resume({
        ...request, agentSessionId: 'synthetic-session', nativeSession: null,
      }, { signal: admission.signal });
      await entered.promise;
      admission.abort();
      await integration.execution.abort(handle);
      release.resolve();
      expect(await withTimeout(observed.promise, 1000, () => 'Resume did not settle')).toBe(true);
      await integration.execution.runningSessions();
      expect(started).toBe(false);
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`cancelling during native path preparation still returns its rollback resource (${dialer} dials)`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rolledBack = Promise.withResolvers<void>();
    let rollbacks = 0;
    let effects = 0;
    const fixture = await remoteFixture(dialer, (_controller, _worker, native) => {
      Object.assign(native.integration, {
        projectPathUpdates: createAgentProjectPathUpdates(native.scope, async (request) => {
          entered.resolve();
          await release.promise;
          effects++;
          request.signal.throwIfAborted();
          return { async commit() {}, async rollback() { rollbacks++; rolledBack.resolve(); } };
        }),
      } satisfies Pick<AgentIntegration, 'projectPathUpdates'>);
    });
    const cancellation = new AbortController();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const input = { nextProjectPath: '/synthetic-destination', chat: {
        chatId: request.chatId, projectPath: request.projectPath, agentId: 'test', model: request.model,
        agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null,
        carryOverRevision: 'synthetic-revision', settings: request.settings,
      } };
      const result = integration.projectPathUpdates!.prepare(input, { signal: cancellation.signal }).catch((error: unknown) => error);
      await entered.promise;
      cancellation.abort();
      expect(await result).toMatchObject({ outcome: 'unknown' });
      // The round trip fences the cancel before the native side effect completes.
      await integration.execution.runningSessions();
      release.resolve();
      await withTimeout(rolledBack.promise, 1000, () => 'Cancelled native preparation lost its rollback');
      expect(effects).toBe(1);
      expect(rollbacks).toBe(1);
      const replacement = await integration.projectPathUpdates!.prepare(input);
      expect(replacement).not.toBeNull();
      await integration.projectPathUpdates!.rollback(replacement!.preparation);
      expect(rollbacks).toBe(2);
    } finally { cancellation.abort(); release.resolve(); await fixture.dispose(); }
  });

  test(`cancelled path preparations roll back before a new path decision (${dialer} dials)`, async () => {
    const rolledBack = Promise.withResolvers<void>();
    let held: Promise<() => void>;
    let rollbacks = 0;
    let commits = 0;
    const fixture = await remoteFixture(dialer, (_controller, worker, native) => {
      held = holdResult(worker, 'projectPathUpdates.prepare');
      Object.assign(native.integration, {
        projectPathUpdates: createAgentProjectPathUpdates(native.scope, async () => ({
          async commit() { commits++; },
          async rollback() { rollbacks++; rolledBack.resolve(); },
        })),
      } satisfies Pick<AgentIntegration, 'projectPathUpdates'>);
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const input = { nextProjectPath: '/synthetic-destination', chat: {
        chatId: request.chatId, projectPath: request.projectPath, agentId: 'test', model: request.model,
        agentSessionId: 'synthetic-session', nativeSession: null, nativeSeedReceipt: null,
        carryOverRevision: 'synthetic-revision', settings: request.settings,
      } };
      const cancellation = new AbortController();
      const result = integration.projectPathUpdates!.prepare(input, { signal: cancellation.signal }).catch((error: unknown) => error);
      const release = await held!;
      await integration.execution.runningSessions();
      cancellation.abort();
      expect(await result).toMatchObject({ outcome: 'unknown' });
      expect(rollbacks).toBe(0);
      release();
      await rolledBack.promise;
      await integration.execution.runningSessions();
      expect(rollbacks).toBe(1);
      const replacement = await integration.projectPathUpdates!.prepare(input);
      expect(replacement).not.toBeNull();
      await integration.projectPathUpdates!.rollback(replacement!.preparation);
      expect(rollbacks).toBe(2);
      expect(commits).toBe(0);
    } finally { await fixture.dispose(); }
  });

  for (const method of ['execution.start', 'execution.resume', 'compaction.compact'] as const) {
    test(`Stop aborts the eventual ${method} handle when its reply is in transit (${dialer} dials)`, async () => {
      const aborted = Promise.withResolvers<void>();
      let held: Promise<() => void>;
      const fixture = await remoteFixture(dialer, (_controller, worker, native) => {
        held = holdResult(worker, method);
        const abort = native.integration.execution.abort;
        native.integration.execution.abort = async (...args) => {
          const result = await abort(...args);
          aborted.resolve();
          return result;
        };
        Object.assign(native.integration, {
          compaction: { compact: native.integration.execution.resume },
        } satisfies Pick<AgentIntegration, 'compaction'>);
      });
      try {
        const integration = await fixture.executor.getAgentIntegration('test');
        const request = { ...await requestFor(integration), agentSessionId: 'test-session', nativeSession: null };
        const cancellation = new AbortController();
        const launch = method === 'execution.start' ? integration.execution.start
          : method === 'execution.resume' ? integration.execution.resume : integration.compaction!.compact;
        const result = launch(request, { signal: cancellation.signal }).catch((error: unknown) => error);
        const release = await held!;
        // The barrier lets the worker retire the launch request before Stop sends cancel.
        await integration.execution.runningSessions();
        cancellation.abort();
        expect(await result).toMatchObject({ outcome: 'unknown' });
        expect(fixture.generations[0]!.calls.abort).toBe(0);
        release();
        await aborted.promise;
        await integration.execution.runningSessions();
        expect(fixture.generations[0]!.calls.abort).toBe(1);
        expect(fixture.generations[0]!.calls.start + fixture.generations[0]!.calls.resume).toBe(1);
        expect(fixture.executor.availability).toBe('ready');
      } finally { await fixture.dispose(); }
    });
  }

  test(`cancelled native forks discard their late materialized session (${dialer} dials)`, async () => {
    const discarded = Promise.withResolvers<AgentEstablishedSession>();
    const session: AgentEstablishedSession = { agentSessionId: 'synthetic-fork', nativeSession: null, nativeSeedReceipt: null };
    let held: Promise<() => void>;
    let forks = 0;
    const fixture = await remoteFixture(dialer, (_controller, worker, native) => {
      held = holdResult(worker, 'forking.fork');
      Object.assign(native.integration, {
        forking: {
          async fork() { forks++; return { kind: 'materialized', session }; },
          async discard(value) { discarded.resolve(value); },
        },
      } satisfies Pick<AgentIntegration, 'forking'>);
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const cancellation = new AbortController();
      const result = integration.forking!.fork({
        ...request, signal: cancellation.signal, providerMeta: null,
        source: {
          chatId: 'source-chat', agentId: 'test', projectPath: request.projectPath, model: request.model,
          agentSessionId: 'source-session', nativeSession: null, nativeSeedReceipt: null,
          carryOverRevision: 'synthetic-revision', settings: request.settings,
        },
      }).catch((error: unknown) => error);
      const release = await held!;
      await integration.execution.runningSessions();
      cancellation.abort();
      expect(await result).toMatchObject({ outcome: 'unknown' });
      release();
      expect(await discarded.promise).toEqual(session);
      await integration.execution.runningSessions();
      expect(forks).toBe(1);
    } finally { await fixture.dispose(); }
  });
}
