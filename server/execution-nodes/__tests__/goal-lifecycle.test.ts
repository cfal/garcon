import { expect, spyOn, test } from 'bun:test';
import { BashToolUseMessage } from '@garcon/common/chat-types';
import type { AgentProducerNotification } from '@garcon/server-agent-interface';
import { integrationFixture, remoteFixture, requestFor } from './integration-fixture.js';

for (const backend of ['local', 'controller', 'worker'] as const) {
  async function setup() {
    const remote = backend === 'local' ? null : await remoteFixture(backend);
    const native = remote?.generations[0] ?? integrationFixture();
    const integration = remote ? await remote.node.getAgentIntegration('test') : native.integration;
    const request = await requestFor(integration);
    const handle = await integration.execution.start(request);
    const goal = { ...request, runId: 'successor', expectedRunId: request.runId, agentSessionId: 'test-session', nativeSession: null };
    return { native, integration, request, handle, goal, dispose: async () => { await remote?.dispose(); } };
  }

  test(`prepared goal keeps exact abort authority; Stop blocks later activation (${backend})`, async () => {
    const fixture = await setup();
    try {
      const preparation = await fixture.integration.goals!.prepareControl(fixture.goal);
      expect(preparation!.handle).toEqual(fixture.handle);
      expect(await fixture.integration.execution.abort(preparation!.handle)).toBe(true);
      await expect(fixture.integration.goals!.deliverControl(preparation!.preparation)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(fixture.native.calls).toMatchObject({ abort: 1, goal: 0 });
    } finally { await fixture.dispose(); }
  });

  test(`delivery rejection retains abort authority and projects late terminal to successor (${backend})`, async () => {
    const fixture = await setup();
    try {
      fixture.native.hooks.goal = async () => { throw new Error('test delivery rejected'); };
      const preparation = await fixture.integration.goals!.prepareControl(fixture.goal);
      await expect(fixture.integration.goals!.deliverControl(preparation!.preparation)).rejects.toThrow('test delivery rejected');
      expect(await fixture.integration.execution.abort(preparation!.handle)).toBe(true);
      const terminal = Promise.withResolvers<AgentProducerNotification>();
      fixture.integration.producers.subscribe((event) => { if (event.event.type === 'run-ended') terminal.resolve(event); });
      fixture.native.nativePublishers[0]!({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
      expect((await terminal.promise).event).toMatchObject({ runId: 'successor', outcome: 'failed' });
    } finally { await fixture.dispose(); }
  });

  test(`goal handoff redirects permission and defers terminal until delivery settles (${backend})`, async () => {
    const fixture = await setup();
    const release = Promise.withResolvers<void>();
    try {
      const entered = Promise.withResolvers<void>();
      fixture.native.hooks.goal = async () => { entered.resolve(); await release.promise; };
      const events: AgentProducerNotification[] = [];
      const terminal = Promise.withResolvers<void>();
      fixture.integration.producers.subscribe((event) => { events.push(event); if (event.event.type === 'run-ended') terminal.resolve(); });
      const preparation = await fixture.integration.goals!.prepareControl(fixture.goal);
      const delivered = fixture.integration.goals!.deliverControl(preparation!.preparation);
      await entered.promise;
      const publish = fixture.native.nativePublishers[0]!;
      publish({
        type: 'permission', runId: fixture.request.runId,
        lifecycle: { kind: 'requested', permissionOccurrenceId: 'occurrence', requestedTool: new BashToolUseMessage('2026-01-01T00:00:00Z', 'tool', 'pwd'), options: [] },
        decision: { permissionOccurrenceId: 'occurrence', async respond() {} },
      });
      publish({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
      await fixture.integration.execution.runningSessions();
      expect(events.map(({ event }) => event.type)).toEqual(['permission']);
      expect(events[0]!.event).toMatchObject({ runId: 'successor' });
      release.resolve();
      await delivered;
      await terminal.promise;
      expect(events[1]!.event).toMatchObject({ type: 'run-ended', runId: 'successor', outcome: 'finished' });
    } finally { release.resolve(); await fixture.dispose(); }
  });

  test(`cancel before handoff leaves predecessor terminal and handle unchanged (${backend})`, async () => {
    const fixture = await setup();
    try {
      const preparation = await fixture.integration.goals!.prepareControl(fixture.goal);
      await fixture.integration.goals!.cancelControl(preparation!.preparation);
      expect(await fixture.integration.execution.abort(fixture.handle)).toBe(true);
      const events: AgentProducerNotification[] = [];
      fixture.integration.producers.subscribe((event) => events.push(event));
      fixture.native.nativePublishers[0]!({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
      await fixture.integration.execution.runningSessions();
      expect(events.map(({ event }) => event)).toEqual([{ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' }]);
    } finally { await fixture.dispose(); }
  });

  test(`expired preparation releases delivery but retains terminal and abort authority (${backend})`, async () => {
    const fixture = await setup();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const expirations: (() => void)[] = [];
    const set = globalThis.setTimeout;
    const clock = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const timer = set(callback, delay, ...args);
      if (delay === 30_000) {
        timers.push(timer);
        expirations.push(() => callback(...args));
      }
      return timer;
    });
    try {
      const preparation = await fixture.integration.goals!.prepareControl(fixture.goal);
      expect(expirations).toHaveLength(1);
      expirations[0]!();
      await expect(fixture.integration.goals!.deliverControl(preparation!.preparation)).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(await fixture.integration.execution.abort(preparation!.handle)).toBe(true);
      expect(fixture.native.calls.goal).toBe(0);
      const events: AgentProducerNotification[] = [];
      fixture.integration.producers.subscribe((event) => events.push(event));
      fixture.native.nativePublishers[0]!({ type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' });
      await fixture.integration.execution.runningSessions();
      expect(events.map(({ event }) => event)).toMatchObject([
        { type: 'run-ended', runId: fixture.request.runId, outcome: 'finished' },
        { type: 'run-ended', runId: 'successor', outcome: 'failed' },
      ]);
    } finally {
      clock.mockRestore();
      for (const timer of timers) clearTimeout(timer);
      await fixture.dispose();
    }
  });

  test(`expiry releases the slot for a later preparation on the same predecessor (${backend})`, async () => {
    const fixture = await setup();
    let expire = () => { throw new Error('Missing preparation timer'); };
    const set = globalThis.setTimeout;
    const clock = spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      const timer = set(callback, delay, ...args);
      if (delay === 30_000) expire = () => { clearTimeout(timer); callback(...args); };
      return timer;
    });
    try {
      await fixture.integration.goals!.prepareControl(fixture.goal);
      expire();
      const next = await fixture.integration.goals!.prepareControl({ ...fixture.goal, runId: 'next-successor' });
      expect(next!.handle).toEqual(fixture.handle);
      await fixture.integration.goals!.cancelControl(next!.preparation);
      expect(fixture.native.calls.goal).toBe(0);
    } finally { clock.mockRestore(); await fixture.dispose(); }
  });
}
