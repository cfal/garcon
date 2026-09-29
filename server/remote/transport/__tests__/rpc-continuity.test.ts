import { expect, test } from 'bun:test';
import type { AgentSingleQueryRequest, ExecutorAvailability } from '@garcon/server-agent-interface';
import type { RemoteExecutorClient } from '../../client/executor-client.js';
import { outgoingFault, remoteFixture } from '../../__tests__/integration-fixture.js';

type Fixture = Awaited<ReturnType<typeof remoteFixture>>;

function nextAvailability(executor: RemoteExecutorClient, value: ExecutorAvailability): Promise<void> {
  return new Promise((resolve) => {
    const off = executor.onAvailabilityChanged((next) => { if (next === value) { off(); resolve(); } });
  });
}

async function query(fixture: Fixture, signal = new AbortController().signal): Promise<string> {
  const integration = await fixture.executor.getAgentIntegration('test');
  return integration.singleQuery!.run({
    prompt: 'Synthetic query', model: 'test-model', thinkingMode: 'medium',
    settings: integration.settings.defaults(), endpoint: null, signal,
  });
}

// Closes the link as the first matching outgoing message is sent, so it never arrives.
function disconnectOn(fault: ReturnType<typeof outgoingFault>, matches: (encoded: string) => boolean) {
  fault.inject = (encoded) => {
    if (!matches(encoded)) return null;
    fault.inject = () => null;
    return 'disconnect';
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`the worker releases a journaled reply once the controller acknowledges it (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      expect(await query(fixture)).toBe('query result');
      expect(fixture.journal.size).toBe(1);
      const deadline = performance.now() + 5_000;
      while (fixture.journal.size > 0 && performance.now() < deadline) await Bun.sleep(10);
      expect(fixture.journal.size).toBe(0);
    } finally { await fixture.dispose(); }
  });

  test(`a reply lost with its session arrives on the replacement session without running the call again (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    try {
      disconnectOn(fault, (encoded) => encoded.includes('"type":"result"') && encoded.includes('query result'));
      const reconnected = nextAvailability(fixture.executor, 'reconnecting');

      expect(await query(fixture)).toBe('query result');
      await reconnected;
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a request the worker never received is sent again on the replacement session (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    try {
      disconnectOn(fault, (encoded) => encoded.includes('"method":"singleQuery.run"'));

      expect(await query(fixture)).toBe('query result');
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a call running when its session is lost finishes and answers on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<string>();
    try {
      const entered = Promise.withResolvers<AgentSingleQueryRequest>();
      fixture.generations[0]!.hooks.query = async (request) => { entered.resolve(request); return release.promise; };
      const answer = query(fixture);
      const request = await entered.promise;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;
      release.resolve('answer after the reconnect');

      expect(await answer).toBe('answer after the reconnect');
      expect(request.signal.aborted).toBe(false);
    } finally { release.resolve(''); await fixture.dispose(); }
  });

  test(`a call its caller abandons while parked is cancelled on the worker at the next reconcile (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<string>();
    try {
      const entered = Promise.withResolvers<AgentSingleQueryRequest>();
      fixture.generations[0]!.hooks.query = async (request) => { entered.resolve(request); return release.promise; };
      const caller = new AbortController();
      const answer = query(fixture, caller.signal).catch((error: unknown) => error);
      const request = await entered.promise;
      const holdReconnect = Promise.withResolvers<void>();
      const getInfo = fixture.generations[0]!.executor.getInfo;
      fixture.generations[0]!.executor.getInfo = async () => { await holdReconnect.promise; return getInfo(); };
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      caller.abort();
      expect(await answer).toMatchObject({ outcome: 'unknown' });
      expect(request.signal.aborted).toBe(false);

      holdReconnect.resolve();
      await ready;
      expect(request.signal.aborted).toBe(true);
    } finally { release.resolve(''); await fixture.dispose(); }
  });
}
