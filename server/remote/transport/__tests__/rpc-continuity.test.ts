import { expect, test } from 'bun:test';
import type { AgentSingleQueryRequest, ExecutorAvailability } from '@garcon/server-agent-interface';
import type { RemoteExecutorClient } from '../../client/executor-client.js';
import { integrationFixture, linkOptions, outgoingFault, remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';
import { connectRemoteExecutor, servePairedRuntime } from '../../__tests__/runtime-adapter.js';
import { serveExecutionRuntime } from '../../server/executor-rpc-server.js';
import { ProducerRelay } from '../../server/producer-relay.js';
import { RpcReplyJournal } from '../rpc-journal.js';
import { WebSocketLink } from '../websocket-link.js';

function nextAvailability(executor: RemoteExecutorClient, value: ExecutorAvailability): Promise<void> {
  return new Promise((resolve) => {
    const off = executor.onAvailabilityChanged((next) => { if (next === value) { off(); resolve(); } });
  });
}

async function query(executor: RemoteExecutorClient, signal = new AbortController().signal): Promise<string> {
  const integration = await executor.getAgentIntegration('test');
  return integration.singleQuery!.run({
    prompt: 'Synthetic query', model: 'test-model', thinkingMode: 'medium',
    settings: integration.settings.defaults(), endpoint: null, signal,
  });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Condition not reached');
    await Bun.sleep(5);
  }
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
      expect(await query(fixture.executor)).toBe('query result');
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

      expect(await query(fixture.executor)).toBe('query result');
      await reconnected;
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a request the worker never received is sent again on the replacement session (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    try {
      disconnectOn(fault, (encoded) => encoded.includes('"method":"singleQuery.run"'));

      expect(await query(fixture.executor)).toBe('query result');
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a call running when its session is lost finishes and answers on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<string>();
    try {
      const entered = Promise.withResolvers<AgentSingleQueryRequest>();
      fixture.generations[0]!.hooks.query = async (request) => { entered.resolve(request); return release.promise; };
      const answer = query(fixture.executor);
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
      const answer = query(fixture.executor, caller.signal).catch((error: unknown) => error);
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

  test(`a replacement session installs while its worker runs a full budget of abandoned calls, and cancels them (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      let cancelled = 0;
      fixture.generations[0]!.hooks.query = (request) => new Promise((_, reject) => {
        request.signal.addEventListener('abort', () => {
          cancelled += 1;
          reject(new Error('Synthetic cancelled query'));
        }, { once: true });
      });
      const caller = new AbortController();
      const answers = Array.from({ length: 256 }, () => query(fixture.executor, caller.signal).catch((error: unknown) => error));
      await until(() => fixture.journal.running === 256);
      const releaseReconnect = holdNextReconnect(fixture.generations[0]!);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await reconnecting;
      caller.abort();
      for (const answer of await Promise.all(answers)) expect(answer).toMatchObject({ outcome: 'unknown' });
      releaseReconnect();

      await ready;
      await until(() => cancelled === 256);
      expect(fixture.journal.running).toBe(0);
    } finally { await fixture.dispose(); }
  });

  test(`calls a replacement session adopts do not keep it from installing (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<string>();
    try {
      // A binding the replacement session must resume.
      await requestFor(await fixture.executor.getAgentIntegration('test'));
      let entered = 0;
      fixture.generations[0]!.hooks.query = async () => { entered += 1; return release.promise; };
      const answers = Array.from({ length: 255 }, () => query(fixture.executor));
      await until(() => entered === 255);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();

      await ready;
      release.resolve('answer after the reconnect');
      expect(new Set(await Promise.all(answers))).toEqual(new Set(['answer after the reconnect']));
    } finally { release.resolve(''); await fixture.dispose(); }
  });

  test(`a parked call survives a replacement session lost while it reconciles (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    const release = Promise.withResolvers<string>();
    try {
      const entered = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.query = async () => { entered.resolve(); return release.promise; };
      const answer = query(fixture.executor);
      await entered.promise;
      let reconciles = 0;
      fault.inject = (encoded) => {
        if (!encoded.includes('"method":"calls.reconcile"')) return null;
        reconciles += 1;
        return reconciles === 1 ? 'disconnect' : null;
      };
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;
      release.resolve('answer after two reconnects');

      expect(await answer).toBe('answer after two reconnects');
      expect(reconciles).toBe(2);
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { release.resolve(''); await fixture.dispose(); }
  });

  test(`disposing the executor settles a parked call as unknown and a held call as not dispatched (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<string>();
    const releaseReconnect = holdNextReconnect(fixture.generations[0]!);
    try {
      const entered = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.query = async () => { entered.resolve(); return release.promise; };
      const parked = query(fixture.executor).catch((error: unknown) => error);
      await entered.promise;
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await reconnecting;
      const held = query(fixture.executor).catch((error: unknown) => error);
      await fixture.executor.dispose();

      expect(await parked).toMatchObject({ outcome: 'unknown' });
      expect(await held).toMatchObject({ outcome: 'not-dispatched' });
    } finally { releaseReconnect(); release.resolve(''); await fixture.dispose(); }
  });

  test(`a restarted worker leaves a parked call unknown and a held call not dispatched (${dialer} dials)`, async () => {
    const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
    const [first, second] = [integrationFixture(), integrationFixture()];
    const release = Promise.withResolvers<string>();
    const entered = Promise.withResolvers<void>();
    first.hooks.query = async () => { entered.resolve(); return release.promise; };
    const workers: { link: WebSocketLink; relay: ProducerRelay; journal: RpcReplyJournal }[] = [];
    const serving: ReturnType<typeof serveExecutionRuntime>[] = [];
    // Each worker process has its own instance, relay, and journal.
    const startWorker = (native: ReturnType<typeof integrationFixture>) => {
      const worker = { link: new WebSocketLink({ ...linkOptions, role: 'worker' }), relay: new ProducerRelay(), journal: new RpcReplyJournal() };
      worker.link.onSession((session) => serving.push(servePairedRuntime(worker.link, session, native.executor, worker.relay, worker.journal)));
      workers.push(worker);
      return worker.link;
    };
    const firstWorker = startWorker(first);
    const connected = connectRemoteExecutor(controller);
    const workerUrl = dialer === 'controller' ? firstWorker.listen() : '';
    const controllerUrl = dialer === 'worker' ? controller.listen() : '';
    if (dialer === 'controller') controller.dial(workerUrl);
    else firstWorker.dial(controllerUrl);
    const executor = await connected;
    try {
      const parked = query(executor).catch((error: unknown) => error);
      await entered.promise;
      const reconnecting = nextAvailability(executor, 'reconnecting');
      const offline = nextAvailability(executor, 'offline');
      const ready = nextAvailability(executor, 'ready');
      await firstWorker.dispose();
      await reconnecting;
      const held = query(executor).catch((error: unknown) => error);
      const secondWorker = startWorker(second);
      if (dialer === 'controller') secondWorker.listen(Number(new URL(workerUrl).port));
      else secondWorker.dial(controllerUrl);
      await offline;
      await ready;

      expect(await parked).toMatchObject({ outcome: 'unknown' });
      expect(await held).toMatchObject({ outcome: 'not-dispatched' });
      expect(second.calls.query).toBe(0);
      expect(await query(executor)).toBe('query result');
    } finally {
      release.resolve('');
      await executor.dispose();
      for (const worker of workers) {
        await worker.link.dispose();
        worker.relay.dispose();
        worker.journal.dispose();
      }
      await Promise.all(serving.map((scope) => scope.dispose()));
      await first.executor.dispose();
      await second.executor.dispose();
    }
  }, 30_000);
}
