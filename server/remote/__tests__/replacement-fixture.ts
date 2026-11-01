import { TestWebSocketLink as WebSocketLink } from './test-session-transport.js';
import { type ExecutionRuntimeApi, type ExecutorAvailability } from '@garcon/server-agent-interface';
import { RemoteExecutorClient, type RemoteExecutorClientOptions } from '../client/executor-client.js';
import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';

import { linkOptions } from './integration-fixture.js';
import { servePairedRuntime } from './runtime-adapter.js';

export function nextAvailability(client: Pick<RemoteExecutorClient, 'onAvailabilityChanged'>, expected: ExecutorAvailability) {
  return new Promise<void>(resolve => {
    const off = client.onAvailabilityChanged(value => { if (value === expected) { off(); resolve(); } });
  });
}

export function replacementFixture(dialer: 'controller' | 'worker', options: RemoteExecutorClientOptions = {}) {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const errors: string[] = [];
  const client = new RemoteExecutorClient(linkOptions.executorId, controller, undefined, message => errors.push(message), options);
  const controllerUrl = dialer === 'worker' ? controller.listen() : null;
  let worker: WebSocketLink | null = null;
  let port = 0;
  const cleanups: (() => void | Promise<void>)[] = [];

  return {
    controller, client, errors,
    get worker() { return worker!; },
    async install(runtime: ExecutionRuntimeApi, runtimeId?: string) {
      const first = port === 0;
      await worker?.dispose();
      const link = new WebSocketLink({ ...linkOptions, role: 'worker', runtimeId });
      worker = link;
      const relay = new ProducerRelay();
      const journal = new RpcReplyJournal();
      cleanups.push(() => { relay.dispose(); journal.dispose(); });
      link.onSession(transport => {
        const serving = servePairedRuntime(link, transport, runtime, relay, journal);
        cleanups.push(() => serving.dispose());
      });
      if (controllerUrl) link.dial(controllerUrl);
      else {
        const url = link.listen(port);
        port = Number(new URL(url).port);
        if (first) controller.dial(url);
      }
    },
    async dispose() {
      await client.dispose();
      await worker?.dispose();
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}
