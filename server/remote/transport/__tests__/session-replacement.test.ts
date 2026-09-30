import { expect, spyOn, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import { AgentCallError, AgentIntegrationError, type AgentProducerNotification, type ExecutorAvailability } from '@garcon/server-agent-interface';
import { RemoteExecutorClient } from '../../client/executor-client.js';
import {
  admissionFault, integrationFixture, isExecutionHandleReply, isProducerResumeReply, linkOptions, outgoingFault, outgoingHold,
  remoteFixture, requestFor,
} from '../../__tests__/integration-fixture.js';
import { connectRemoteExecutor } from '../../__tests__/runtime-adapter.js';
import { serveExecutionRuntime } from '../../server/executor-rpc-server.js';
import { ProducerRelay } from '../../server/producer-relay.js';
import { ExecutorRpc } from '../rpc.js';
import { WebSocketLink } from '../websocket-link.js';
import type { Logger } from '../../../common/log.js';

function nextAvailability(executor: RemoteExecutorClient, value: ExecutorAvailability) {
  const reached = Promise.withResolvers<void>();
  const off = executor.onAvailabilityChanged((next) => { if (next === value) { off(); reached.resolve(); } });
  return reached.promise;
}

function record(integration: Awaited<ReturnType<RemoteExecutorClient['getAgentIntegration']>>) {
  const events: string[] = [];
  integration.producers.subscribe(({ event }) => {
    events.push(event.type === 'rows' ? `rows:${(event.rows[0]!.message as AssistantMessage).content}` : event.type);
  });
  return events;
}

function availabilityLog(executor: RemoteExecutorClient) {
  const log: ExecutorAvailability[] = [];
  executor.onAvailabilityChanged((value) => log.push(value));
  return log;
}

type LaunchOutcome = Extract<AgentProducerNotification['event'], { readonly type: 'launch-settled' }>;

function launchOutcomes(integration: Awaited<ReturnType<RemoteExecutorClient['getAgentIntegration']>>) {
  const outcomes: LaunchOutcome[] = [];
  integration.producers.subscribe(({ event }) => { if (event.type === 'launch-settled') outcomes.push(event); });
  return outcomes;
}

function setupFailureLog() {
  const failures: unknown[] = [];
  const logger = {
    debug() {}, info() {}, error() {},
    warn(message: unknown, detail: unknown) { if (message === 'Executor session setup failed') failures.push(detail); },
  } satisfies Logger;
  return { failures, logger };
}

function warnings() {
  const entries: { readonly message: unknown; readonly detail: unknown }[] = [];
  const logger = {
    debug() {}, info() {}, error() {},
    warn(message: unknown, detail: unknown) { entries.push({ message, detail }); },
  } satisfies Logger;
  return { entries, logger };
}

// Rewrites a link's outgoing session messages, as a faulty peer build would send them.
function outgoingRewrite(link: WebSocketLink, rewrite: (encoded: string) => string) {
  link.onSession((session) => {
    const attach = session.attach.bind(session);
    session.attach = (socket) => attach({
      close: () => socket.close(),
      canSend: (bytes) => socket.canSend?.(bytes) !== false,
      send(encoded) { socket.send(rewrite(encoded)); },
    });
  });
}

// Fails the first outgoing message that matches, closing the link as it is sent.
function disconnectOn(fault: ReturnType<typeof outgoingFault>, matches: (encoded: string) => boolean) {
  fault.inject = (encoded) => {
    if (!matches(encoded)) return null;
    fault.inject = () => null;
    return 'disconnect';
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`a short disconnect resumes the binding and delivers gap output once (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      const events = record(integration);
      const publish = worker.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'before') }] });
      await integration.execution.runningSessions();
      const availability = availabilityLog(fixture.executor);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(fixture.executor.availability).toBe('reconnecting');
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:01Z', 'during') }] });
      await ready;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:02Z', 'after') }] });
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.runningSessions();

      expect(availability).toEqual(['reconnecting', 'ready']);
      expect(events).toEqual(['rows:before', 'rows:during', 'rows:after', 'run-ended']);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0, stop: 0 });
      await integration.producers.close(request.producerBinding);
    } finally { await fixture.dispose(); }
  });

  test(`output beyond the retention budget arrives as one gap before the newest rows (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { relay: { retainedBytes: 4_096 } });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const events = record(integration);
      const publish = fixture.generations[0]!.nativePublishers[0]!;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      for (let index = 0; index < 8; index += 1) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', `gap-${index}:${'x'.repeat(1_000)}`) }] });
      }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await ready;
      await integration.execution.runningSessions();

      expect(events[0]).toBe('publication-gap');
      expect(events.at(-1)).toBe('run-ended');
      const delivered = events.slice(1, -1).map((event) => event.split(':')[1]);
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.length).toBeLessThan(8);
      expect(delivered).toEqual(Array.from({ length: delivered.length }, (_, index) => `gap-${8 - delivered.length + index}`));
    } finally { await fixture.dispose(); }
  });

  test(`a backlog beyond the session queue replays through one session in order (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const delivered: number[] = [];
      const types: string[] = [];
      integration.producers.subscribe(({ event }) => {
        types.push(event.type);
        if (event.type === 'rows') delivered.push(Number((event.rows[0]!.message as AssistantMessage).content.split(':')[0]));
      });
      let sessions = 0;
      fixture.worker.onSession(() => { sessions += 1; });
      const publish = fixture.generations[0]!.nativePublishers[0]!;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      const count = 20_000;
      for (let index = 0; index < count; index += 1) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', `${index}:${'x'.repeat(900)}`) }] });
      }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await ready;
      const deadline = performance.now() + 30_000;
      while (types.at(-1) !== 'run-ended' && performance.now() < deadline) await Bun.sleep(20);

      expect(sessions).toBe(2);
      expect(types).not.toContain('publication-gap');
      expect(delivered).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(types.at(-1)).toBe('run-ended');
    } finally { await fixture.dispose(); }
  }, 60_000);

  test(`a start in flight during a short disconnect reports its handle through the resumed binding (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const worker = fixture.generations[0]!;
      worker.hooks.start = async () => { entered.resolve(); await release.promise; };
      const events = record(integration);
      const outcomes = launchOutcomes(integration);
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      await ready;
      await expect(integration.execution.start(await requestFor(integration))).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      release.resolve();
      await integration.execution.runningSessions();
      expect(events).toEqual(['session', 'launch-settled']);
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      await integration.execution.abort(outcomes[0]!.handle!);
      expect(worker.calls).toMatchObject({ start: 1, abort: 1, stop: 0 });
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`a start in flight when the link drops keeps running and reports its handle (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      const worker = fixture.generations[0]!;
      let cancelled = false;
      worker.hooks.start = async ({ admission }) => {
        admission.signal.addEventListener('abort', () => { cancelled = true; }, { once: true });
        entered.resolve();
        await release.promise;
      };
      const outcomes = launchOutcomes(integration);
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      await ready;
      release.resolve();
      const deadline = performance.now() + 10_000;
      while (outcomes.length === 0 && performance.now() < deadline) await Bun.sleep(5);

      expect(cancelled).toBe(false);
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      expect(worker.calls.start).toBe(1);
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`a start that fails after its session was lost reports its own failure (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const fail = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.start = async () => {
        entered.resolve();
        await fail.promise;
        throw new AgentIntegrationError('AUTH_REQUIRED', 'Synthetic sign-in required', false);
      };
      const outcomes = launchOutcomes(integration);
      const call = integration.execution.start(request).catch((error: unknown) => error);
      await entered.promise;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      await ready;
      fail.resolve();
      const deadline = performance.now() + 10_000;
      while (outcomes.length === 0 && performance.now() < deadline) await Bun.sleep(5);

      expect(outcomes).toEqual([{
        type: 'launch-settled', runId: request.runId, error: { code: 'AUTH_REQUIRED', message: 'Synthetic sign-in required' },
      }]);
    } finally { fail.resolve(); await fixture.dispose(); }
  });

  test(`a start whose reply was lost reports its handle once the binding resumes (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      disconnectOn(fault, isExecutionHandleReply);
      const ready = nextAvailability(fixture.executor, 'ready');
      expect(await integration.execution.start(request).catch((error: unknown) => error)).toMatchObject({ outcome: 'unknown' });
      await ready;
      await integration.execution.runningSessions();
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      await integration.execution.abort(outcomes[0]!.handle!);
      expect(fixture.generations[0]!.calls).toMatchObject({ start: 1, abort: 1 });
    } finally { await fixture.dispose(); }
  });

  test(`a start whose reply the worker could not deliver reports its handle on the live session (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof admissionFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = admissionFault(worker); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      const availability = availabilityLog(fixture.executor);
      fault.refuseNext(isExecutionHandleReply);
      expect(await integration.execution.start(request).catch((error: unknown) => error)).toMatchObject({
        outcome: 'unknown', message: "The executor's reply could not be delivered, so the outcome is unknown.",
      });
      await integration.execution.runningSessions();
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      expect(availability).toEqual([]);
      await integration.execution.abort(outcomes[0]!.handle!);
      expect(fixture.generations[0]!.calls).toMatchObject({ start: 1, abort: 1 });
    } finally { await fixture.dispose(); }
  });

  test(`a failed start whose error reply the worker could not deliver reports its failure (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof admissionFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = admissionFault(worker); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      fixture.generations[0]!.hooks.start = async () => { throw new Error('Synthetic start failure'); };
      fault.refuseNext((encoded) => encoded.includes('"type":"error"') && encoded.includes('Synthetic start failure'));
      expect(await integration.execution.start(request).catch((error: unknown) => error)).toMatchObject({ outcome: 'unknown' });
      await integration.execution.runningSessions();
      expect(outcomes).toEqual([{
        type: 'launch-settled', runId: request.runId, error: { code: 'PROVIDER_FAILURE', message: 'Synthetic start failure' },
      }]);
    } finally { await fixture.dispose(); }
  });

  test(`a cancelled start whose late reply the worker could not deliver reports its handle (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof admissionFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = admissionFault(worker); });
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      const entered = Promise.withResolvers<void>();
      const worker = fixture.generations[0]!;
      worker.hooks.start = async () => { entered.resolve(); await release.promise; };
      fault.refuseNext(isExecutionHandleReply);
      const cancel = new AbortController();
      const call = integration.execution.start(request, { signal: cancel.signal }).catch((error: unknown) => error);
      await entered.promise;
      cancel.abort();
      expect(await call).toMatchObject({ outcome: 'unknown' });
      release.resolve();
      await integration.execution.runningSessions();
      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      expect(worker.calls).toMatchObject({ start: 1, abort: 0 });
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`a start that fails with a nested unknown outcome fails definitely (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      fixture.generations[0]!.hooks.start = async () => {
        throw new AgentCallError('unknown', 'Synthetic nested call outcome is unknown');
      };
      expect(await integration.execution.start(request).catch((error: unknown) => error)).toMatchObject({
        outcome: 'rejected', message: 'Synthetic nested call outcome is unknown',
      });
      await integration.execution.runningSessions();
      expect(outcomes).toEqual([]);
    } finally { await fixture.dispose(); }
  });

  test(`a start lost after its binding closed leaves no cancellation for Stop to send (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      fixture.generations[0]!.hooks.start = async () => { entered.resolve(); await release.promise; };
      const admission = new AbortController();
      const launch = integration.execution.start(request, { signal: admission.signal }).catch((error: unknown) => error);
      await entered.promise;
      await integration.producers.close(request.producerBinding);
      const cancellations: string[] = [];
      fault.inject = (encoded) => {
        if (encoded.includes('"method":"producers.cancelLaunch"')) cancellations.push(encoded);
        return null;
      };
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      expect(await launch).toMatchObject({ outcome: 'unknown' });
      await ready;
      admission.abort();
      await integration.execution.runningSessions();

      expect(cancellations).toEqual([]);
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`a start request the worker never received is sent once more on the replacement session (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const outcomes = launchOutcomes(integration);
      disconnectOn(fault, (encoded) => encoded.includes('"method":"execution.start"'));
      const ready = nextAvailability(fixture.executor, 'ready');
      expect(await integration.execution.start(request).catch((error: unknown) => error)).toMatchObject({ outcome: 'unknown' });
      await ready;
      const deadline = performance.now() + 10_000;
      while (outcomes.length === 0 && performance.now() < deadline) await Bun.sleep(5);

      expect(outcomes).toEqual([{ type: 'launch-settled', runId: request.runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      expect(fixture.generations[0]!.calls.start).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`a relaunch settles on its own session when an earlier session's report is still waiting for its replay (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    let holdReplay = false;
    const fixture = await remoteFixture(dialer, (controller, worker) => {
      fault = outgoingFault(controller);
      // A refused producer frame stays retained, so the replay waits.
      worker.onSession((session) => {
        const offer = session.channel.offer.bind(session.channel);
        session.channel.offer = (payload) => !holdReplay && offer(payload);
      });
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const worker = fixture.generations[0]!;
      const request = await requestFor(integration);
      await integration.execution.start(request);
      worker.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.runningSessions();
      holdReplay = true;
      worker.nativePublishers[0]!({ type: 'session', session: { agentSessionId: 'test-session', nativeSession: null, nativeSeedReceipt: null } });
      const runId = crypto.randomUUID();
      const outcomes = launchOutcomes(integration);
      disconnectOn(fault, (encoded) => encoded.includes('"method":"execution.start"'));
      const secondReady = nextAvailability(fixture.executor, 'ready');
      await integration.execution.start({ ...request, runId }).catch(() => undefined);
      await secondReady;
      expect(outcomes).toEqual([]);
      expect(worker.calls.start).toBe(1);

      holdReplay = false;
      const thirdReady = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await thirdReady;
      const deadline = performance.now() + 10_000;
      while (outcomes.length === 0 && performance.now() < deadline) await Bun.sleep(5);
      await integration.execution.runningSessions();

      expect(outcomes).toEqual([{ type: 'launch-settled', runId, handle: expect.objectContaining({ kind: 'execution' }) }]);
      expect(worker.calls.start).toBe(2);
    } finally { await fixture.dispose(); }
  });

  test(`a start dispatched while a replay drains settles through its own reply (${dialer} dials)`, async () => {
    let path!: ReturnType<typeof outgoingHold>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { path = outgoingHold(worker); });
    const release = Promise.withResolvers<void>();
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const first = await requestFor(integration);
      await integration.execution.start(first);
      const types: string[] = [];
      integration.producers.subscribe(({ event }) => { types.push(event.type); });
      const rowsReceived = () => types.filter((type) => type === 'rows').length;
      const worker = fixture.generations[0]!;
      const publish = worker.nativePublishers[0]!;
      const ready = nextAvailability(fixture.executor, 'ready');
      // The replay tail after the resume reply stays on a stalled path until the new start reaches the worker.
      path.holdAfter(isProducerResumeReply);
      fixture.controller.disconnect(); fixture.worker.disconnect();
      // Beyond the producer share of the session queue, so the replay tail follows the resume reply.
      const count = 1_500;
      for (let index = 0; index < count; index += 1) {
        publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', `${index}:${'x'.repeat(9_000)}`) }] });
      }
      publish({ type: 'run-ended', runId: first.runId, outcome: 'finished' });
      await ready;
      let rowsAtStart = count;
      const started = Promise.withResolvers<void>();
      worker.hooks.start = async () => { rowsAtStart = rowsReceived(); started.resolve(); await release.promise; };
      const second = { ...first, runId: crypto.randomUUID() };
      const launch = integration.execution.start(second);
      await started.promise;
      await path.release();
      const deadline = performance.now() + 30_000;
      while (!types.includes('run-ended') && performance.now() < deadline) await Bun.sleep(5);
      await integration.execution.runningSessions();

      expect(rowsAtStart).toBeLessThan(count);
      expect(types).not.toContain('launch-settled');
      release.resolve();
      expect(await launch).toMatchObject({ kind: 'execution' });
      expect(worker.calls).toMatchObject({ start: 2, abort: 0 });
    } finally { release.resolve(); await fixture.dispose(); }
  }, 60_000);

  for (const [failure, thrown, reason] of [
    ['provider error', () => new AgentIntegrationError('UNAVAILABLE', 'Synthetic provider start failure', false), 'Synthetic provider start failure'],
    // A parse error's message can echo the payload it failed on, so neither the reply nor the log carries it.
    ['parse error', () => new SyntaxError('JSON Parse error: Unexpected identifier "SYNTHETIC_SENTINEL"'), 'Malformed data'],
  ] as const) {
    test(`a replacement session that cannot start its integrations logs the stage and a ${failure}'s reason (${dialer} dials)`, async () => {
      const log = setupFailureLog();
      const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { client: { logger: log.logger } });
      try {
        const worker = fixture.generations[0]!;
        worker.hooks.initialize = async () => {
          worker.hooks.initialize = async () => {};
          throw thrown();
        };
        const ready = nextAvailability(fixture.executor, 'ready');
        fixture.controller.disconnect(); fixture.worker.disconnect();
        await ready;

        expect(log.failures).toEqual([
          { executorId: linkOptions.executorId, stage: 'start-integrations', reason },
        ]);
      } finally { await fixture.dispose(); }
    });
  }

  test(`a replacement session lost while resuming logs its own reason, not the lost call (${dialer} dials)`, async () => {
    const log = setupFailureLog();
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (controller) => { fault = outgoingFault(controller); }, undefined, undefined, {
      client: { logger: log.logger },
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      await integration.execution.start(await requestFor(integration));
      disconnectOn(fault, (encoded) => encoded.includes('"method":"producers.resume"'));
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;

      expect(log.failures).toEqual([
        { executorId: linkOptions.executorId, stage: 'resume-bindings', reason: 'Executor connection lost' },
      ]);
    } finally { await fixture.dispose(); }
  });

  test(`a resume report the controller cannot read fails only its binding (${dialer} dials)`, async () => {
    const log = warnings();
    let corrupt = false;
    const fixture = await remoteFixture(dialer, (_controller, worker) => {
      outgoingRewrite(worker, (encoded) => (
        corrupt && encoded.startsWith('{"type":"result"') && encoded.includes('"resumed"')
          ? encoded.replace('"kind":"execution"', '"kind":"synthetic-unreadable"') : encoded
      ));
    }, undefined, undefined, { client: { logger: log.logger } });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      // The running turn's launch record carries a handle that the rewrite makes unreadable.
      const running = await requestFor(integration);
      await integration.execution.start(running);
      const idle = await requestFor(integration);
      const failures: [string, AgentProducerNotification['event']][] = [];
      const closes: Promise<void>[] = [];
      // Closes a failed binding as the transcript route does, while the replacement session installs.
      integration.producers.subscribe(({ binding, event }) => {
        if (event.type !== 'publication-failed') return;
        failures.push([binding.id, event]);
        closes.push(integration.producers.close(binding));
      });
      let sessions = 0;
      fixture.worker.onSession(() => { sessions += 1; });
      corrupt = true;
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;

      expect(failures).toEqual([[running.producerBinding.id, { type: 'publication-failed', error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'An event from the executor could not be read, so this turn\'s outcome is unknown. Native history may contain additional output.',
      } }]]);
      expect(sessions).toBe(2);
      expect(log.entries.filter(({ message }) => message === 'Executor producer resume report could not be read')).toEqual([{
        message: 'Executor producer resume report could not be read',
        detail: { integrationId: 'test', bindingId: running.producerBinding.id },
      }]);
      // The failed binding closed through the installing session, stopping its turn, and the other resumed.
      await Promise.all(closes);
      expect(fixture.generations[0]!.calls.abort).toBe(1);
      await integration.producers.close(idle.producerBinding);
    } finally { await fixture.dispose(); }
  });

  test(`a binding the worker released fails its run and fences later output (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, { relay: { graceMs: 1 } });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const worker = fixture.generations[0]!;
      const events = record(integration);
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await Bun.sleep(5);
      await ready;
      await integration.execution.runningSessions();
      expect(events).toEqual(['publication-failed']);

      const publish = worker.nativePublishers[0]!;
      publish({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'detached output') }] });
      await integration.execution.runningSessions();
      expect(events).toEqual(['publication-failed']);
      const next = await requestFor(integration);
      await expect(integration.execution.start(next)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
      const running = spyOn(worker.integration.execution, 'runningSessions').mockResolvedValue([
        { agentSessionId: 'test-session', status: null, startedAt: null },
      ]);
      try {
        const reader = integration.nativeHistoryImport!.load({
          chat: { chatId: 'test-chat', agentId: 'test', agentSessionId: 'test-session', projectPath: '/test-project',
            model: 'test-model', nativeSession: null, carryOverRevision: '0', nativeSeedReceipt: null, settings: integration.settings.defaults() },
          signal: new AbortController().signal,
        })[Symbol.asyncIterator]();
        await expect(reader.next()).rejects.toMatchObject({ code: 'SESSION_BUSY' });
        expect(worker.calls.import).toBe(0);
      } finally { running.mockRestore(); }
      publish({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.start(next);
      expect(worker.calls.start).toBe(2);
    } finally { await fixture.dispose(); }
  });

  test(`the controller abandons bindings once its reconnect grace expires (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer, undefined, undefined, undefined, {
      relay: { graceMs: 50 }, client: { reconnectGraceMs: 1 },
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const events = record(integration);
      const availability = availabilityLog(fixture.executor);
      const native = fixture.generations[0]!.integration.producers;
      const detached = Promise.withResolvers<void>();
      const detach = native.detach.bind(native);
      native.detach = (binding) => { detach(binding); detached.resolve(); };
      const ready = nextAvailability(fixture.executor, 'ready');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      await ready;
      fixture.generations[0]!.nativePublishers[0]!({
        type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'abandoned') }],
      });
      await integration.execution.runningSessions();

      expect(availability).toEqual(['reconnecting', 'offline', 'ready']);
      expect(events).toEqual([]);
      // Once the worker's own grace expires too, it no longer holds the binding.
      await detached.promise;
      await expect(integration.producers.close(request.producerBinding)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
    } finally { await fixture.dispose(); }
  });
}

test('a restarted worker cannot resume bindings, so the controller reports them lost first', async () => {
  const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const generations: ReturnType<typeof integrationFixture>[] = [];
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  worker.onSession((transport) => {
    const fixture = integrationFixture();
    generations.push(fixture);
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport), new ProducerRelay()));
  });
  const connected = connectRemoteExecutor(controller);
  controller.dial(worker.listen());
  const executor = await connected;
  try {
    const integration = await executor.getAgentIntegration('test');
    await integration.execution.start(await requestFor(integration));
    const availability = availabilityLog(executor);
    const ready = nextAvailability(executor, 'ready');
    controller.disconnect(); worker.disconnect();
    await ready;

    expect(availability).toEqual(['reconnecting', 'offline', 'ready']);
    expect(generations).toHaveLength(2);
    expect(integration.producers.scope.instanceId).toBe(generations[1]!.scope.instanceId);
  } finally {
    await executor.dispose();
    await worker.dispose();
    await Promise.all(scopes.map((scope) => scope.dispose()));
    for (const generation of generations) await generation.executor.dispose();
  }
});

test('bindings a restarted controller cannot resume expire after the short grace', async () => {
  const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
  const fixture = integrationFixture();
  const relay = new ProducerRelay({ supersededGraceMs: 20 });
  const scopes: ReturnType<typeof serveExecutionRuntime>[] = [];
  worker.onSession((transport) => {
    scopes.push(serveExecutionRuntime(fixture.executor, new ExecutorRpc(transport), relay));
  });
  const url = worker.listen();
  const crashed = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const restarted = new WebSocketLink({ ...linkOptions, role: 'controller' });
  const executors: RemoteExecutorClient[] = [];
  const detach = spyOn(fixture.integration.producers, 'detach');
  try {
    const first = connectRemoteExecutor(crashed);
    crashed.dial(url);
    executors.push(await first);
    const integration = await executors[0]!.getAgentIntegration('test');
    const request = await requestFor(integration);
    await integration.execution.start(request);
    await crashed.dispose();

    const second = connectRemoteExecutor(restarted);
    restarted.dial(url);
    executors.push(await second);
    await Bun.sleep(50);

    expect(detach).toHaveBeenCalledWith(request.producerBinding);
  } finally {
    for (const executor of executors) await executor.dispose();
    await worker.dispose();
    await Promise.all(scopes.map((scope) => scope.dispose()));
    relay.dispose();
    await fixture.executor.dispose();
  }
});
