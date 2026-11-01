import { expect, test } from 'bun:test';
import { createAgentResourceRef, type AgentIntegration } from '@garcon/server-agent-interface';
import { DeferredExecutionAborts } from '../../controller/agents/deferred-execution-aborts.js';
import { TestWebSocketLink } from './test-session-transport.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';
import { connectRemoteExecutor, servePairedRuntime } from './runtime-adapter.js';
import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';

test('connector recreation cannot deliver a deferred Stop to the same surviving worker through new continuity', async () => {
  const native = integrationFixture();
  const worker = new TestWebSocketLink({ ...linkOptions, role: 'worker' });
  const first = new TestWebSocketLink({ ...linkOptions, role: 'controller' });
  const second = new TestWebSocketLink({ ...linkOptions, role: 'controller' });
  const relay = new ProducerRelay();
  const journal = new RpcReplyJournal();
  const scopes: ReturnType<typeof servePairedRuntime>[] = [];
  worker.onSession(transport => scopes.push(servePairedRuntime(worker, transport, native.executor, relay, journal)));
  const address = worker.listen();
  let current: AgentIntegration | null = null;
  let ready = false;
  const aborts = new DeferredExecutionAborts({ get: () => current, isReady: () => ready });
  try {
    const connecting = connectRemoteExecutor(first);
    first.dial(address);
    const client = await connecting;
    const origin = current = await client.runtime.getAgentIntegration('test');
    const continuity = first.current!.continuity;
    aborts.request('synthetic-chat', origin, createAgentResourceRef(origin.producers.scope, 'execution'), 'test Stop');
    await client.dispose();
    current = null;
    aborts.lost(linkOptions.executorId);

    const reconnecting = connectRemoteExecutor(second);
    second.dial(address);
    const replacement = await reconnecting;
    try {
      current = await replacement.runtime.getAgentIntegration('test');
      ready = true;
      expect(current.producers.scope.instanceId).toBe(origin.producers.scope.instanceId);
      expect(second.current!.continuity.workerRuntimeId).toBe(continuity.workerRuntimeId);
      expect(second.current!.continuity.controllerRuntimeId).not.toBe(continuity.controllerRuntimeId);
      aborts.resumed(linkOptions.executorId);
      aborts.resumed(linkOptions.executorId);
      await expect(origin.execution.runningSessions()).rejects.toMatchObject({ code: 'STALE_RESOURCE', outcome: 'not-dispatched' });
      expect(native.calls.abort).toBe(0);
    } finally { await replacement.dispose(); }
  } finally {
    await first.dispose(); await second.dispose(); await worker.dispose();
    for (const scope of scopes) await scope.dispose();
    relay.dispose(); journal.dispose(); await native.executor.dispose();
  }
});
