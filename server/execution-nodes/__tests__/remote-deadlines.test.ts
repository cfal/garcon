import { expect, spyOn, test } from 'bun:test';
import { createAgentResourceRef } from '@garcon/server-agent-interface';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { WebSocketLink } from '../websocket-link.js';
import { linkOptions, outgoingFault, remoteFixture } from './integration-fixture.js';

function controlledTimeouts() {
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map<ReturnType<typeof setTimeout>, { delay: number; fire(): void }>();
  const waiting = new Map<number, (timer: { fire(): void }) => void>();
  const schedule = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay = 0, ...args) => {
    const timer = set(() => {}, 60_000);
    timer.unref();
    pending.set(timer, { delay, fire() { pending.delete(timer); clear(timer); callback(...args); } });
    waiting.get(delay)?.(pending.get(timer)!);
    waiting.delete(delay);
    return timer;
  });
  const cancel = spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
    if (timer) pending.delete(timer);
    clear(timer);
  });
  return {
    pending,
    at: (delay: number) => [...pending].filter(([, entry]) => entry.delay === delay),
    next: (delay: number) => new Promise<{ fire(): void }>((resolve) => {
      const timer = [...pending.values()].find((entry) => entry.delay === delay);
      if (timer) resolve(timer);
      else waiting.set(delay, resolve);
    }),
    restore() {
      schedule.mockRestore(); cancel.mockRestore();
      for (const timer of pending.keys()) clear(timer);
    },
  };
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`stalled replay retires the session before automatic redial (${dialer} dials)`, async () => {
    let fault!: ReturnType<typeof outgoingFault>;
    const fixture = await remoteFixture(dialer, (_controller, worker) => { fault = outgoingFault(worker); });
    const timers = controlledTimeouts();
    const availability: string[] = [];
    fixture.node.onAvailabilityChanged((value) => availability.push(value));
    const replayStarted = Promise.withResolvers<void>();
    fixture.worker.current!.onAvailability((connected) => { if (connected) replayStarted.resolve(); });
    const original = fixture.controller.current!;
    try {
      fault.inject = (encoded) => JSON.parse(encoded).kind === 'receipt' ? 'drop' : null;
      fixture.controller.disconnect(); fixture.worker.disconnect();
      (await timers.next(100)).fire();
      await replayStarted.promise;
      expect(fixture.controller.current).toBe(original);
      expect(timers.at(30_000)).toHaveLength(1);
      timers.at(30_000)[0]![1].fire();
      expect(fixture.node.availability).toBe('offline');
      expect(fixture.controller.current).toBeNull();
      expect(original.channel.attached).toBe(false);

      const replaced = Promise.withResolvers<void>();
      fixture.node.onAvailabilityChanged((value) => { if (value === 'ready') replaced.resolve(); });
      fault.inject = () => null;
      (await timers.next(100)).fire();
      await replaced.promise;
      expect(fixture.controller.current).not.toBe(original);
      expect(availability).toEqual(['reconnecting', 'offline', 'ready']);
    } finally { await fixture.dispose(); timers.restore(); }
  });

  test(`offline asynchronous facades reject through catch (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.node.getAgentIntegration('test');
      const projects = await fixture.node.getProjectService();
      const binding = createAgentResourceRef(integration.producers.scope, 'producer');
      fixture.controller.disconnect(); fixture.worker.disconnect();
      for (const operation of [
        () => integration.execution.runningSessions(),
        () => integration.producers.close(binding),
        () => projects.inspect({ projectPath: '/project' }),
        () => projects.resolveFileMentions({ projectPath: '/project', command: '@file' }),
      ]) {
        expect(await operation().catch((error: unknown) => error)).toMatchObject({ outcome: 'not-dispatched' });
      }
    } finally { await fixture.dispose(); }
  });

  for (const outcome of ['result', 'timeout'] as const) {
    test(`single query preserves its provider ${outcome} after setup (${dialer} dials)`, async () => {
      const fixture = await remoteFixture(dialer);
      const timers = controlledTimeouts();
      const setup = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = Promise.withResolvers<void>();
      const result = Promise.withResolvers<string>();
      try {
        const integration = await fixture.node.getAgentIntegration('test');
        const worker = fixture.generations[0]!;
        worker.hooks.query = async (request) => {
          expect(request.timeoutMs).toBe(1000);
          entered.resolve();
          await setup.promise;
          return withSingleQueryControl(request, async () => { running.resolve(); return result.promise; });
        };
        const query = integration.singleQuery!.run({
          prompt: 'query', model: 'model', thinkingMode: 'medium', settings: integration.settings.defaults(),
          endpoint: null, signal: new AbortController().signal, timeoutMs: 1000,
        }).catch((error: unknown) => error);
        await entered.promise;
        expect(timers.at(1000)).toHaveLength(0);
        expect(timers.at(31_000)).toHaveLength(1);
        setup.resolve();
        await running.promise;
        if (outcome === 'result') result.resolve('completed');
        else timers.at(1000)[0]![1].fire();
        if (outcome === 'result') expect(await query).toBe('completed');
        else {
          const error = await query;
          expect(error).toMatchObject({ code: 'TIMEOUT', retryable: true });
          expect(error).not.toHaveProperty('outcome');
        }
        expect(worker.calls.query).toBe(1);
      } finally {
        setup.resolve(); result.resolve('cleanup');
        await fixture.dispose(); timers.restore();
      }
    });
  }

  for (const finish of ['ready', 'stalled'] as const) {
    test(`authenticated replay has a progress-refreshed inactivity deadline (${dialer}, ${finish})`, async () => {
      const timers = controlledTimeouts();
      const controller = new WebSocketLink({ ...linkOptions, role: 'controller' });
      const worker = new WebSocketLink({ ...linkOptions, role: 'worker' });
      const observed = Promise.withResolvers<void>();
      const messages: string[] = [];
      let receipt: (() => void) | undefined;
      worker.onSession((session) => {
        const attach = session.attach.bind(session);
        session.attach = (socket, received) => attach({
          close: () => socket.close(),
          send(encoded) {
            if (JSON.parse(encoded).kind === 'receipt') receipt = () => socket.send(encoded);
            else socket.send(encoded);
          },
        }, received);
      });
      controller.onSession((session) => {
        session.onMessage((message) => messages.push(message));
        const attach = session.attach.bind(session);
        session.attach = (socket, received) => {
          const hooks = attach(socket, received);
          return {
            ...hooks,
            receive(encoded) { hooks.receive(encoded); observed.resolve(); },
          };
        };
      });
      try {
        if (dialer === 'controller') controller.dial(worker.listen());
        else worker.dial(controller.listen());
        const sending = await worker.ready;
        expect(timers.at(5000)).toHaveLength(0);
        const initial = timers.at(30_000);
        expect(initial).toHaveLength(1);
        sending.send('replayed');
        await observed.promise;
        expect(timers.pending.has(initial[0]![0])).toBe(false);
        expect(timers.at(30_000)).toHaveLength(1);
        expect(messages).toEqual([]);
        if (finish === 'ready') {
          receipt!();
          await controller.ready;
          expect(messages).toEqual(['replayed']);
          expect(timers.at(30_000)).toHaveLength(0);
        } else {
          const session = controller.current!;
          timers.at(30_000)[0]![1].fire();
          expect(session.channel.attached).toBe(false);
          expect(controller.current).toBeNull();
          expect(messages).toEqual([]);
        }
      } finally { await controller.dispose(); await worker.dispose(); timers.restore(); }
    });
  }
}
