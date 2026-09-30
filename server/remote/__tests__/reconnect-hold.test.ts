import { expect, spyOn, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentProducerNotification, ExecutorAvailability } from '@garcon/server-agent-interface';
import type { RemoteExecutorClient } from '../client/executor-client.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { EXECUTOR_DISCONNECTED_BEFORE_START } from '../../common/executor-disconnect.js';
import { readBefore } from '../../common/interactive-deadline.js';
import { integrationFixture, outgoingFault, outgoingHold, remoteFixture, requestFor } from './integration-fixture.js';

function nextAvailability(executor: RemoteExecutorClient, expected: ExecutorAvailability): Promise<void> {
  return new Promise((resolve) => {
    const off = executor.onAvailabilityChanged((value) => { if (value === expected) { off(); resolve(); } });
  });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Timed out waiting for the executor');
    await Bun.sleep(5);
  }
}

// Holds the worker's next session back from installing until released.
function holdNextInstall(worker: ReturnType<typeof integrationFixture>): () => void {
  const release = Promise.withResolvers<void>();
  const getInfo = worker.executor.getInfo;
  worker.executor.getInfo = async () => {
    worker.executor.getInfo = getInfo;
    await release.promise;
    return getInfo();
  };
  return () => release.resolve();
}

// The deadlines the controller sent a method with.
function sentDeadlines(calls: ReturnType<typeof spyOn<ExecutorRpc, 'call'>>, method: string) {
  return calls.mock.calls.filter(([, sent]) => sent === method).map(([, , , options]) => options?.timeoutMs);
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`calls made while the executor reconnects complete on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const projects = await fixture.executor.getProjectService();
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const inspected = projects.inspect({ projectPath: '/test-project' });
      const running = integration.execution.runningSessions();
      const queried = integration.singleQuery!.run({
        prompt: 'Synthetic query', model: 'test-model', thinkingMode: 'medium',
        settings: integration.settings.defaults(), endpoint: null, signal: new AbortController().signal,
      });

      expect(await running).toEqual([]);
      expect(await queried).toBe('query result');
      await expect(inspected).resolves.toBeDefined();
      expect(fixture.executor.availability).toBe('ready');
      expect(fixture.generations[0]!.calls.query).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`held calls stop at their signal, their deadline, and the reconnect grace (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { client: { reconnectGraceMs: 500 } });
    try {
      const projects = await fixture.executor.getProjectService();
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      // Without its worker link, neither dial direction can reconnect.
      await fixture.worker.dispose();
      await reconnecting;
      const aborted = new AbortController();
      const cancelled = projects.inspect({ projectPath: '/test-project' }, { signal: aborted.signal }).catch((error: unknown) => error);
      const expired = projects.inspect({ projectPath: '/test-project' }, { timeoutMs: 50 }).catch((error: unknown) => error);
      const abandoned = projects.inspect({ projectPath: '/test-project' }).catch((error: unknown) => error);
      aborted.abort();

      expect(await cancelled).toMatchObject({ outcome: 'not-dispatched', message: 'The request was cancelled while the executor reconnected.' });
      expect(await expired).toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      expect(await abandoned).toMatchObject({ outcome: 'not-dispatched', message: 'Executor is offline' });
      expect(fixture.executor.availability).toBe('offline');
      await expect(fixture.executor.getProjectService()).rejects.toMatchObject({ outcome: 'not-dispatched' });
    } finally { await fixture.dispose(); }
  });

  test(`a binding closed while the executor reconnects closes on the replacement session and stops its turn (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      // The replacement session installs only once the close waits for it.
      const release = holdNextInstall(worker);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const closing = integration.producers.close(request.producerBinding);
      release();
      await closing;

      expect(fixture.executor.availability).toBe('ready');
      expect(worker.calls.abort).toBe(1);
      // The close waits for the executor for as long as it may hold the binding.
      expect(sentDeadlines(calls, 'producers.close')).toEqual([null]);
    } finally { calls.mockRestore(); await fixture.dispose(); }
  });

  test(`a close lost as it is sent is sent again after the reconnect and stops its turn once (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      fault.inject = (encoded) => {
        if (!encoded.includes('"method":"producers.close"')) return null;
        fault.inject = () => null;
        return 'disconnect';
      };
      await integration.producers.close(request.producerBinding);

      expect(worker.calls.abort).toBe(1);
      // Sent on the live session that held the binding, without a deadline.
      expect(sentDeadlines(calls, 'producers.close')).toEqual([null]);
      // The chat is free for a new binding.
      await integration.execution.start(await requestFor(integration));
      expect(worker.calls.start).toBe(2);
    } finally { calls.mockRestore(); await fixture.dispose(); }
  });

  test(`a close whose reply is lost resolves after the reconnect without closing again (${dialer} dials)`, async () => {
    let controllerFault!: ReturnType<typeof outgoingFault>;
    let workerFault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller, worker) => {
      controllerFault = outgoingFault(controller);
      workerFault = outgoingFault(worker);
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const closes: string[] = [];
      controllerFault.inject = (encoded) => {
        if (encoded.includes('"method":"producers.close"')) closes.push(JSON.parse(encoded).id);
        return null;
      };
      workerFault.inject = (encoded) => {
        if (closes.length === 0 || !encoded.startsWith('{"type":"result"') || !encoded.includes(`"id":"${closes[0]}"`)) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      await integration.producers.close(request.producerBinding);

      expect(closes).toHaveLength(1);
      expect(fixture.generations[0]!.calls.abort).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a Stop for a launch whose call was lost waits for the reconnect and cancels its admission (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const calls = spyOn(ExecutorRpc.prototype, 'call');
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const worker = fixture.generations[0]!;
      const admission = Promise.withResolvers<AbortSignal>();
      worker.hooks.start = async ({ admission: { signal } }) => {
        admission.resolve(signal);
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('Synthetic cancelled admission');
      };
      const stop = new AbortController();
      const launch = integration.execution.start(request, { signal: stop.signal }).catch((error: unknown) => error);
      const admitting = await admission.promise;
      const release = holdNextInstall(worker);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      expect(await launch).toMatchObject({ outcome: 'unknown' });
      await reconnecting;
      stop.abort();
      release();
      await until(() => admitting.aborted);

      expect(sentDeadlines(calls, 'producers.cancelLaunch')).toEqual([null]);
    } finally { calls.mockRestore(); await fixture.dispose(); }
  });

  test(`a dispatch deadline bounds only the wait for a reconnecting executor (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const projects = await fixture.executor.getProjectService();
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      await fixture.worker.dispose();
      await reconnecting;
      const expired = projects.inspect({ projectPath: '/test-project' }, { dispatchDeadline: performance.now() - 1 });
      const waited = projects.inspect({ projectPath: '/test-project' }, { dispatchDeadline: performance.now() + 50 });
      let held = false;
      void projects.inspect({ projectPath: '/test-project' }, { timeoutMs: 5_000 }).catch(() => undefined).finally(() => { held = true; });

      const timedOut = { outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' };
      await expect(expired).rejects.toMatchObject(timedOut);
      await expect(waited).rejects.toMatchObject(timedOut);
      // A call without one keeps waiting within its own deadline.
      expect(held).toBe(false);
    } finally { await fixture.dispose(); }
  });

  test(`a read sent after waiting most of its deadline for a reconnect still gets its grace to answer (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const projects = await fixture.executor.getProjectService();
      const worker = fixture.generations[0]!;
      const native = await worker.executor.getProjectService();
      const inspect = native.inspect.bind(native);
      spyOn(native, 'inspect').mockImplementation(async (...args) => {
        await Bun.sleep(3_500);
        return inspect(...args);
      });
      const release = holdNextInstall(worker);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const inspected = projects.inspect({ projectPath: '/test-project' }, readBefore(performance.now() + 6_000));
      await Bun.sleep(3_500);
      release();

      await expect(inspected).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  }, 20_000);

  test(`a sent call whose session is lost stops waiting for a replacement at its dispatch deadline (${dialer} dials)`, async () => {
    let controllerFault!: ReturnType<typeof outgoingFault>;
    let workerFault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller, worker) => {
      controllerFault = outgoingFault(controller);
      workerFault = outgoingFault(worker);
    });
    try {
      const projects = await fixture.executor.getProjectService();
      const release = holdNextInstall(fixture.generations[0]!);
      const inspections: string[] = [];
      controllerFault.inject = (encoded) => {
        if (encoded.includes('"method":"projects.inspect"')) inspections.push(JSON.parse(encoded).id);
        return null;
      };
      // Loses the session with both replies unsent, so both calls are parked.
      workerFault.inject = (encoded) => {
        if (inspections.length < 2 || !encoded.startsWith('{"type":"result"')) return null;
        workerFault.inject = () => null;
        return 'disconnect';
      };
      const held = projects.inspect({ projectPath: '/test-project' }, { timeoutMs: 10_000 });
      const bounded = projects.inspect({ projectPath: '/test-project' }, { timeoutMs: 10_000, dispatchDeadline: performance.now() + 200 });

      await expect(bounded).rejects.toMatchObject({
        outcome: 'unknown', message: 'The executor did not reconnect in time, so the outcome is unknown.',
      });
      release();
      // A call without one waits for the replacement session and gets its reply.
      await expect(held).resolves.toBeDefined();
    } finally { await fixture.dispose(); }
  });

  test(`a lost call stops at its dispatch deadline while the replacement session reconciles it, and is never sent (${dialer} dials)`, async () => {
    let lost = false;
    let applied = 0;
    let hold!: ReturnType<typeof outgoingHold>;
    const fixture = await remoteFixture(dialer, (controller, worker, native) => {
      Object.assign(native.integration, { sessionConfiguration: { async apply() { applied += 1; } } });
      hold = outgoingHold(worker);
      const fault = outgoingFault(controller);
      fault.inject = (encoded) => {
        const frame = JSON.parse(encoded);
        if (frame.type !== 'request') return null;
        // Loses the session as the change is sent, so the worker never receives it.
        if (!lost && frame.method === 'sessionConfiguration.apply') {
          lost = true;
          return 'disconnect';
        }
        // Holds the replacement worker's replies after this one, so reconciliation stalls.
        if (lost && frame.method === 'lifecycle.start') hold.holdAfter((reply) => JSON.parse(reply).id === frame.id);
        return null;
      };
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const configuration = {
        model: 'test-model', permissionMode: 'default' as const, thinkingMode: 'medium' as const,
        settings: integration.settings.defaults(), endpoint: null,
      };
      const change = integration.sessionConfiguration!.apply('test-session', configuration, configuration, {
        dispatchDeadline: performance.now() + 500,
      });

      await expect(change).rejects.toMatchObject({
        outcome: 'unknown', message: 'The executor did not reconnect in time, so the outcome is unknown.',
      });
      const ready = nextAvailability(fixture.executor, 'ready');
      await hold.release();
      await ready;
      await integration.execution.runningSessions();
      expect(applied).toBe(0);
    } finally {
      await hold.release();
      await fixture.dispose();
    }
  });

  test(`a launch still waiting for the executor at its dispatch deadline fails and is never sent (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const worker = fixture.generations[0]!;
      const release = holdNextInstall(worker);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;

      await expect(integration.execution.start(request, { dispatchDeadline: performance.now() + 50 }))
        .rejects.toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      const ready = nextAvailability(fixture.executor, 'ready');
      release();
      await ready;
      await integration.execution.runningSessions();
      expect(worker.calls.start).toBe(0);
    } finally { await fixture.dispose(); }
  });

  test(`a launch sent before its dispatch deadline is not cut off at it (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const worker = fixture.generations[0]!;
      const dispatchDeadline = performance.now() + 1_000;
      worker.hooks.start = async () => { await Bun.sleep(Math.max(0, dispatchDeadline - performance.now()) + 50); };
      const release = holdNextInstall(worker);
      const reconnecting = nextAvailability(fixture.executor, 'reconnecting');
      fixture.controller.disconnect();
      await reconnecting;
      const launch = integration.execution.start(request, { dispatchDeadline });
      release();

      await expect(launch).resolves.toBeDefined();
      expect(performance.now()).toBeGreaterThan(dispatchDeadline);
      expect(worker.calls.start).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a call whose session retires before it is sent is not sent again past its dispatch deadline (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const projects = await fixture.executor.getProjectService();
      const native = await fixture.generations[0]!.executor.getProjectService();
      const inspect = spyOn(native, 'inspect');
      const inspected = projects.inspect({ projectPath: '/test-project' }, { dispatchDeadline: performance.now() });
      fixture.controller.disconnect();

      await expect(inspected).rejects.toMatchObject({ outcome: 'not-dispatched', message: 'The executor did not reconnect in time.' });
      expect(inspect).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  test(`a Stop whose cancel is lost with the session cancels the launch's admission after the reconnect (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes: AgentProducerNotification['event'][] = [];
      integration.producers.subscribe(({ event }) => { if (event.type === 'launch-settled') outcomes.push(event); });
      const worker = fixture.generations[0]!;
      const admission = Promise.withResolvers<AbortSignal>();
      worker.hooks.start = async ({ admission: { signal } }) => {
        admission.resolve(signal);
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('Synthetic cancelled admission');
      };
      const stop = new AbortController();
      const launch = integration.execution.start(request, { signal: stop.signal }).catch((error: unknown) => error);
      const admitting = await admission.promise;
      let cancelFrames = 0;
      fault.inject = (encoded) => {
        if (!encoded.startsWith('{"type":"cancel"')) return null;
        cancelFrames += 1;
        fault.inject = () => null;
        return 'disconnect';
      };
      const ready = nextAvailability(fixture.executor, 'ready');
      stop.abort();
      expect(await launch).toMatchObject({ outcome: 'unknown' });
      await ready;
      await until(() => admitting.aborted);
      await until(() => outcomes.length > 0);

      expect(cancelFrames).toBe(1);
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, error: EXECUTOR_DISCONNECTED_BEFORE_START }]);
      expect(worker.calls.abort).toBe(0);
    } finally { await fixture.dispose(); }
  });

  test(`a launch whose session retires before it is sent starts once on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const events: AgentProducerNotification['event'][] = [];
      integration.producers.subscribe(({ event }) => { events.push(event); });
      const worker = fixture.generations[0]!;
      const started = integration.execution.start(request).catch((error: unknown) => error);
      // The launch already holds the session it is about to send on.
      fixture.controller.disconnect();

      expect(await started).toMatchObject({ kind: 'execution' });
      expect(worker.calls.start).toBe(1);
      worker.nativePublishers[0]!({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'Synthetic reply') }] });
      worker.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.runningSessions();
      expect(events.map((event) => event.type)).toEqual(['session', 'rows', 'run-ended']);
    } finally { await fixture.dispose(); }
  });

  test(`a call pinned to another worker instance fails as not dispatched without being sent (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const projects = await fixture.executor.getProjectService();
      const native = await fixture.generations[0]!.executor.getProjectService();
      const inspect = spyOn(native, 'inspect');
      const pinned = { timeoutMs: 5_000, instanceId: crypto.randomUUID() };

      await expect(projects.inspect({ projectPath: '/test-project' }, pinned))
        .rejects.toMatchObject({ outcome: 'not-dispatched', message: 'The executor restarted before the request was sent.' });
      expect(inspect).not.toHaveBeenCalled();
    } finally { await fixture.dispose(); }
  });

  test(`a call whose session retires before it is sent is sent once on the replacement session (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const projects = await fixture.executor.getProjectService();
      const native = await fixture.generations[0]!.executor.getProjectService();
      const inspect = spyOn(native, 'inspect');
      const inspected = projects.inspect({ projectPath: '/test-project' });
      // The call already holds the session it is about to send on.
      fixture.controller.disconnect();

      await expect(inspected).resolves.toBeDefined();
      expect(inspect).toHaveBeenCalledTimes(1);
    } finally { await fixture.dispose(); }
  });
}
