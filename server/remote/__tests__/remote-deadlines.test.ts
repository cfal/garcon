import { expect, spyOn, test } from 'bun:test';
import { createAgentResourceRef, type AgentIntegration } from '@garcon/server-agent-interface';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { remoteFixture, requestFor } from './integration-fixture.js';

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
  for (const timeoutMs of [undefined, 1000]) {
    test(`compaction uses only an explicit RPC deadline (${dialer} dials, timeout ${timeoutMs ?? 'none'})`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const fixture = await remoteFixture(dialer, (_controller, _worker, native) => {
        Object.assign(native.integration, {
          compaction: {
            async compact(request, options) {
              entered.resolve();
              await release.promise;
              return native.integration.execution.resume(request, options);
            },
          },
        } satisfies Pick<AgentIntegration, 'compaction'>);
        const abort = native.integration.execution.abort;
        native.integration.execution.abort = async (...args) => {
          const result = await abort(...args);
          aborted.resolve();
          return result;
        };
      });
      const timers = controlledTimeouts();
      try {
        const integration = await fixture.executor.getAgentIntegration('test');
        const request = { ...await requestFor(integration), agentSessionId: 'test-session', nativeSession: null };
        const result = integration.compaction!.compact(request, { timeoutMs }).catch((error: unknown) => error);
        await entered.promise;
        expect(timers.at(120_000)).toHaveLength(0);
        if (timeoutMs !== undefined) {
          expect(timers.at(timeoutMs)).toHaveLength(1);
          timers.at(timeoutMs)[0]![1].fire();
          expect(await result).toMatchObject({ outcome: 'unknown' });
          release.resolve();
          await aborted.promise;
          await integration.execution.runningSessions();
        } else {
          release.resolve();
          expect(await result).toMatchObject({ kind: 'execution' });
        }
      } finally {
        release.resolve();
        await fixture.dispose();
        timers.restore();
      }
    });
  }

  test(`offline asynchronous facades reject through catch (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const projects = await fixture.executor.getProjectService();
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
        const integration = await fixture.executor.getAgentIntegration('test');
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
}
