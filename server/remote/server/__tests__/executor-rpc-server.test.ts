import { expect, test } from 'bun:test';
import { createAgentResourceRef } from '@garcon/server-agent-interface';
import { integrationFixture } from '../../__tests__/integration-fixture.js';
import { ExecutorRpc } from '../../transport/rpc.js';
import { SessionTransport } from '../../transport/session-transport.js';
import { serveExecutionRuntime } from '../executor-rpc-server.js';
import { ProducerRelay } from '../producer-relay.js';

function linkedRpcs() {
  const controller = new SessionTransport('test', 'worker', () => {});
  const worker = new SessionTransport('test', 'controller', () => {});
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
      await expect(client.call('test', 'producers.resume', request)).rejects.toMatchObject({
        outcome: 'rejected', message: 'Invalid producer resume request',
      });
    }
    await expect(client.call('test', 'producers.resume', { bindings: [{ binding, acknowledgedSeq: 0 }] }))
      .resolves.toEqual({ resumed: [] });
  } finally {
    await serving.dispose();
    relay.dispose();
    close();
    await fixture.executor.dispose();
  }
});
