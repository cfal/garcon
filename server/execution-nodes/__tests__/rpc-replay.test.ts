import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { outgoingFault, remoteFixture, requestFor } from './integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`lost receipt and result replay dispatch one mutation (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      let dropped = false;
      fault.inject = (encoded) => {
        if (!dropped && JSON.parse(encoded).kind === 'receipt') { dropped = true; return 'drop'; }
        return null;
      };
      fixture.generations[0]!.hooks.start = async () => {
        fixture.worker.disconnect(); fixture.controller.disconnect();
      };
      const events: string[] = [];
      integration.producers.subscribe(({ event }) => events.push(event.type));
      const handle = await integration.execution.start(request);
      expect(handle.instanceId).toBe(request.producerBinding.instanceId);
      expect(dropped).toBe(true);
      expect(events).toEqual(['session']);
      expect(fixture.generations).toHaveLength(1);
      expect(fixture.generations[0]!.calls.start).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`repeated partial replay preserves rows before terminal (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      let disconnects = 0;
      fault.inject = (encoded) => {
        const packet = JSON.parse(encoded);
        if (packet.kind !== 'message') return null;
        const frame = JSON.parse(packet.body);
        if (frame.type === 'producer' && frame.notification.event.rows?.[0]?.message.content === 'second' && disconnects < 2) {
          disconnects++;
          return 'disconnect';
        }
        return null;
      };
      const events: string[] = [];
      const terminal = Promise.withResolvers<void>();
      integration.producers.subscribe(({ event }) => {
        if (event.type === 'rows') events.push(event.rows[0]!.message.type === 'assistant-message' ? event.rows[0]!.message.content : 'invalid');
        if (event.type === 'run-ended') { events.push('terminal'); terminal.resolve(); }
      });
      const publish = fixture.generations[0]!.nativePublishers[0]!;
      for (const text of ['first', 'second', 'third']) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', text) }] });
      }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await terminal.promise;
      expect(disconnects).toBe(2);
      expect(events).toEqual(['first', 'second', 'third', 'terminal']);
      expect(fixture.generations).toHaveLength(1);
    } finally { await fixture.dispose(); }
  });

  test(`malformed error retires the RPC instead of stranding a pending call (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.start = async () => { entered.resolve(); await release.promise; };
      let requestId = '';
      fixture.worker.current!.onMessage((encoded) => {
        const frame = JSON.parse(encoded);
        if (frame.method === 'execution.start') requestId = frame.id;
      });
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      fixture.worker.current!.send(JSON.stringify({ type: 'error', id: requestId, error: { outcome: 'unknown' } }));
      expect(await call).toMatchObject({ outcome: 'unknown' });
      release.resolve();
    } finally { await fixture.dispose(); }
  });
}
