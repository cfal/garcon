import { expect, test } from 'bun:test';
import type { AgentNativeFork, AgentNativeForkRequest } from '@garcon/server-agent-interface';
import { integrationFixture, linkOptions } from './integration-fixture.js';
import { connectRemoteExecutor, servePairedRuntime } from './runtime-adapter.js';
import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';
import { WebSocketLink } from '../transport/websocket-link.js';

function nativeFixture() {
  const native = integrationFixture();
  const calls = { fork: 0, discard: 0 };
  const session = { agentSessionId: 'synthetic-fork', nativeSession: null, nativeSeedReceipt: null };
  Object.assign(native.integration, { forking: {
    async fork() { calls.fork++; return { kind: 'materialized', session }; },
    async discard() { calls.discard++; },
  } satisfies AgentNativeFork });
  return { ...native, forkCalls: calls, session };
}

async function fixture(dialer: 'controller' | 'worker') {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const original = nativeFixture();
  let current = original;
  const relay = new ProducerRelay();
  const journal = new RpcReplyJournal();
  const servings: ReturnType<typeof servePairedRuntime>[] = [];
  worker.onSession(transport => servings.push(servePairedRuntime(worker, transport, current.executor, relay, journal)));
  const connected = connectRemoteExecutor(controller);
  if (dialer === 'controller') controller.dial(worker.listen());
  else worker.dial(controller.listen());
  const executor = await connected;
  const integration = await executor.getAgentIntegration('test');
  const source = { chatId: 'source', agentId: 'test', agentSessionId: 'synthetic-source', nativeSession: null,
    nativeSeedReceipt: null, projectPath: '/test-project', model: 'test-model', carryOverRevision: '', settings: integration.settings.defaults() };
  const signal = new AbortController().signal;
  const request: AgentNativeForkRequest = { chatId: 'fork', source, signal, providerMeta: null,
    projectPath: source.projectPath, model: source.model, settings: source.settings,
    permissionMode: 'default', thinkingMode: 'medium', endpoint: null };
  return {
    controller, worker, executor, integration, original, request,
    historyRequest: { chat: { ...source, chatId: 'fork', agentSessionId: original.session.agentSessionId }, signal },
    async replace(restart: boolean) {
      if (restart) current = nativeFixture();
      const ready = Promise.withResolvers<void>();
      const off = executor.onAvailabilityChanged(value => { if (value === 'ready') ready.resolve(); });
      controller.disconnect(); worker.disconnect();
      await ready.promise;
      off();
      return current;
    },
    async dispose() {
      await executor.dispose(); await worker.dispose();
      for (const serving of servings) await serving.dispose();
      relay.dispose(); journal.dispose();
    },
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  for (const restart of [false, true]) {
    test(`fork cleanup after lost seed import stays on its instance: restart=${restart} (${dialer} dials)`, async () => {
      const f = await fixture(dialer);
      try {
        const scope = { ...f.integration.producers.scope };
        const options = { expectedScope: scope };
        const fork = await f.integration.forking!.fork(f.request, options);
        expect(fork.kind).toBe('materialized');
        const entered = Promise.withResolvers<void>();
        f.original.hooks.history = async function* (signal) {
          entered.resolve();
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          signal.throwIfAborted();
          yield [];
        };
        const seed = f.integration.nativeHistoryImport!.load(f.historyRequest, options)[Symbol.asyncIterator]();
        const reading = seed.next().catch((error: unknown) => error);
        await entered.promise;
        f.controller.bulk!.close();
        expect(await reading).toMatchObject({ outcome: 'unknown' });
        expect(f.executor.availability).toBe('ready');
        const replacement = await f.replace(restart);
        if (restart) {
          await expect(f.integration.forking!.discard(f.original.session, f.request.signal, options)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
          const staleSeed = f.integration.nativeHistoryImport!.load(f.historyRequest, options)[Symbol.asyncIterator]();
          await expect(staleSeed.next()).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
          expect(replacement.forkCalls.discard).toBe(0);
          expect(replacement.calls.import).toBe(0);
        } else {
          await f.integration.forking!.discard(f.original.session, f.request.signal, options);
          expect(f.original.forkCalls.discard).toBe(1);
        }
        expect(f.original.forkCalls.fork).toBe(1);
      } finally { await f.dispose(); }
    });
  }

  test(`fork admission and all expected-scope fields reject a different owner (${dialer} dials)`, async () => {
    const f = await fixture(dialer);
    try {
      const scope = { ...f.integration.producers.scope };
      for (const key of ['executorId', 'integrationId', 'instanceId'] as const) {
        await expect(f.integration.forking!.fork(f.request, { expectedScope: { ...scope, [key]: 'different' } }))
          .rejects.toMatchObject({ outcome: 'not-dispatched', code: 'STALE_RESOURCE' });
      }
      const replacing = f.replace(true);
      const fork = f.integration.forking!.fork(f.request, { expectedScope: scope }).catch((error: unknown) => error);
      const replacement = await replacing;
      expect(await fork).toMatchObject({ outcome: 'not-dispatched' });
      expect(replacement.forkCalls.fork).toBe(0);
      expect(f.original.forkCalls.fork).toBe(0);
    } finally { await f.dispose(); }
  });
}
