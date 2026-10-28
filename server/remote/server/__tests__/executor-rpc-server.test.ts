import { WorkerSessionTransport } from '../../__tests__/test-session-transport.js';
import { RPC_V1 } from '@garcon/common/executor-contracts';
import { expect, spyOn, test } from 'bun:test';
import { createAgentResourceRef } from '@garcon/server-agent-interface';
import { integrationFixture } from '../../__tests__/integration-fixture.js';
import { ExecutorRpc } from '../../transport/rpc.js';
import { TestSessionTransport as SessionTransport } from '../../__tests__/test-session-transport.js';
import { serveExecutionRuntime } from '../executor-rpc-server.js';
import { ProducerRelay } from '../producer-relay.js';
import { PRODUCER_BINDING_CODEC_V1 } from '../../transport/producer-protocol.js';

function linkedRpcs() {
  const controller = new SessionTransport('test', 'worker', () => {});
  const worker = new WorkerSessionTransport('test', 'controller', () => {});
  const toWorker = controller.attach({ send: (body) => toController.receive(body), close() {} });
  const toController = worker.attach({ send: (body) => toWorker.receive(body), close() {} });
  return {
    client: new ExecutorRpc(controller),
    service: new ExecutorRpc(worker),
    close() { controller.close(); worker.close(); },
  };
}

test('producers.resume rejects acknowledgements that are not sequence numbers', async () => {
  const fixture = integrationFixture();
  const { client, service, close } = linkedRpcs();
  const relay = new ProducerRelay();
  const serving = serveExecutionRuntime(fixture.executor, service, relay);
  try {
    await serving.ready;
    const binding = createAgentResourceRef(fixture.scope, 'producer');
    for (const acknowledgedSeq of [undefined, -1, 1.5, '3']) {
      const request = { bindings: [{ binding, acknowledgedSeq }] } as never;
      await expect(client.call('test', RPC_V1['producers.resume'], request)).rejects.toMatchObject({
        outcome: 'not-dispatched', message: 'Invalid executor request',
      });
    }
    await expect(client.call('test', RPC_V1['producers.resume'], { bindings: [{ binding, acknowledgedSeq: 0 }] }))
      .resolves.toEqual({ resumed: [] });
  } finally {
    await serving.dispose();
    relay.dispose();
    close();
    await fixture.executor.dispose();
  }
});

test('close, cancel and resume refuse an incompatible binding before changing it', async () => {
  const fixture = integrationFixture();
  const { client, service, close } = linkedRpcs();
  const relay = new ProducerRelay();
  const serving = serveExecutionRuntime(fixture.executor, service, relay);
  const session = { protocol: service.transport.protocol, offer: () => true };
  const resource = { ...PRODUCER_BINDING_CODEC_V1.resource, version: 2 };
  const binding = createAgentResourceRef(fixture.scope, 'producer');
  const closeBinding = spyOn(fixture.integration.producers, 'close');
  const cancel = spyOn(relay, 'cancelLaunch');
  const resume = spyOn(relay, 'resume');
  try {
    await serving.ready;
    await fixture.integration.producers.bind({ binding, chatId: 'synthetic-chat' });
    relay.bind(session, fixture.integration, binding, { ...PRODUCER_BINDING_CODEC_V1, resource });
    for (const pending of [
      () => client.call('test', RPC_V1['producers.close'], binding),
      () => client.call('test', RPC_V1['producers.cancelLaunch'], { binding, runId: 'synthetic-run' }),
      () => client.call('test', RPC_V1['producers.resume'], { bindings: [{ binding, acknowledgedSeq: 0 }] }),
    ]) await expect(pending()).rejects.toMatchObject({ code: 'STALE_RESOURCE', outcome: 'not-dispatched' });
    expect(closeBinding).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(relay.owns(session, fixture.integration, binding)).toBe(true);
    expect(service.transport.connected).toBe(true);
  } finally {
    closeBinding.mockRestore(); cancel.mockRestore(); resume.mockRestore();
    await serving.dispose(); relay.dispose(); close(); await fixture.executor.dispose();
  }
});
