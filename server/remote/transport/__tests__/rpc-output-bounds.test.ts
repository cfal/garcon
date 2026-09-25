import { expect, test } from 'bun:test';
import { AssistantMessage } from '@garcon/common/chat-types';
import type { AgentChatReference, AgentProducerNotification } from '@garcon/server-agent-interface';
import { ProducerBindings } from '../../../controller/agents/producer-bindings.js';
import { ProducerLease } from '../../../controller/ledger/producer-lease.js';
import { remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`publication failure aborts native startup after its binding closes (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const generation = fixture.generations[0]!;
      const integration = await fixture.executor.getAgentIntegration('test');
      const session = fixture.controller.current;
      const errors: unknown[] = [];
      const failures: string[] = [];
      const bindings = new ProducerBindings(error => errors.push(error), chatId => failures.push(chatId));
      const lease = new ProducerLease(() => {}, () => {});
      const producerBinding = await bindings.bind(integration, 'test-chat', lease);
      const closed = Promise.withResolvers<void>();
      const close = generation.integration.producers.close;
      generation.integration.producers.close = async (binding, options) => {
        await close(binding, options);
        if (binding.id === producerBinding.id) closed.resolve();
      };
      const entered = Promise.withResolvers<void>();
      generation.hooks.start = () => { entered.resolve(); return release.promise; };
      const request = { ...await requestFor(integration), producerBinding };
      const starting = integration.execution.start(request);
      await entered.promise;
      generation.hooks.start = async () => {};
      const healthyLease = new ProducerLease(() => {}, () => {});
      const healthyBinding = await bindings.bind(integration, 'healthy-chat', healthyLease);
      const healthy = await integration.execution.start({
        ...request, chatId: 'healthy-chat', runId: 'healthy-run', producerBinding: healthyBinding,
      });
      generation.nativePublishers[0]!({
        type: 'rows',
        rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'x'.repeat(17 * 1024 * 1024)) }],
      });
      await closed.promise;
      expect(lease.closed).toBe(true);
      expect(failures).toEqual(['test-chat']);
      expect(generation.calls.abort).toBe(0);
      release.resolve();
      await expect(starting).rejects.toMatchObject({ code: 'STALE_RESOURCE' });
      expect(generation.calls.abort).toBe(1);
      expect(healthyLease.closed).toBe(false);
      await expect(integration.execution.abort(healthy)).resolves.toBe(true);
      expect(generation.calls.abort).toBe(2);
      expect(errors).toEqual([]);
      expect(fixture.controller.current).toBe(session);
      expect(fixture.executor.availability).toBe('ready');
    } finally { release.resolve(); await fixture.dispose(); }
  }, 10_000);

  test(`large history is paged and an oversized row rejects only its reader (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    const release = Promise.withResolvers<void>();
    try {
      const generation = fixture.generations[0]!;
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const entered = Promise.withResolvers<void>();
      generation.hooks.start = () => { entered.resolve(); return release.promise; };
      const unrelated = integration.execution.start(request);
      await entered.promise;
      const chat: AgentChatReference = {
        chatId: request.chatId, projectPath: request.projectPath, agentId: 'test', model: request.model,
        agentSessionId: 'test-session', nativeSession: null, nativeSeedReceipt: null,
        carryOverRevision: 'revision', settings: request.settings,
      };
      const rows = Array.from({ length: 272 }, () => ({
        message: new AssistantMessage('2026-01-01T00:00:00Z', 'x'.repeat(64 * 1024)),
      }));
      generation.hooks.history = async function* () { yield rows; };
      const session = fixture.controller.current;
      let count = 0;
      let pages = 0;
      for await (const page of integration.nativeHistoryImport!.load({ chat, signal: new AbortController().signal })) {
        count += page.length;
        pages++;
        expect(JSON.stringify(page).length).toBeLessThan(1024 * 1024);
      }
      expect(count).toBe(rows.length);
      expect(pages).toBeGreaterThan(1);
      const escaped = [{ message: new AssistantMessage('2026-01-01T00:00:00Z', '"'.repeat(5 * 1024 * 1024)) }];
      generation.hooks.history = async function* () { yield escaped; };
      let escapedCount = 0;
      for await (const page of integration.nativeHistoryImport!.load({ chat, signal: new AbortController().signal })) {
        expect(page).toEqual(escaped);
        escapedCount += page.length;
      }
      expect(escapedCount).toBe(1);
      let closed = false;
      generation.hooks.history = async function* () {
        try { yield [{ message: new AssistantMessage('2026-01-01T00:00:00Z', 'x'.repeat(17 * 1024 * 1024)) }]; }
        finally { closed = true; }
      };
      const reader = integration.nativeHistoryImport!.load({ chat, signal: new AbortController().signal })[Symbol.asyncIterator]();
      await expect(reader.next()).rejects.toMatchObject({ outcome: 'rejected' });
      expect(closed).toBe(true);
      release.resolve();
      await unrelated;
      expect(fixture.controller.current).toBe(session);
      expect(fixture.executor.availability).toBe('ready');
    } finally { release.resolve(); await fixture.dispose(); }
  }, 15_000);

  test(`oversized replies and publications leave unrelated execution available (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const generation = fixture.generations[0]!;
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      await integration.execution.start(request);
      const received: AgentProducerNotification[] = [];
      const failure = Promise.withResolvers<void>();
      integration.producers.subscribe(notification => {
        received.push(notification);
        if (notification.event.type === 'publication-failed') failure.resolve();
      });
      const session = fixture.controller.current;
      const oversized = 'x'.repeat(17 * 1024 * 1024);
      generation.hooks.query = async () => oversized;
      await expect(integration.singleQuery!.run({
        prompt: 'test', model: request.model, thinkingMode: request.thinkingMode,
        settings: request.settings, endpoint: null, signal: new AbortController().signal,
      })).rejects.toMatchObject({ outcome: 'unknown' });
      generation.nativePublishers[0]!({ type: 'rows', rows: [{ message: new AssistantMessage('2026-01-01T00:00:00Z', oversized) }] });
      await failure.promise;
      generation.nativePublishers[0]!({ type: 'run-ended', runId: request.runId, outcome: 'finished' });
      await integration.execution.start(await requestFor(integration));
      expect(received.filter(({ binding }) => binding.id === request.producerBinding.id)).toHaveLength(1);
      expect(fixture.controller.current).toBe(session);
      expect(fixture.executor.availability).toBe('ready');
    } finally { await fixture.dispose(); }
  }, 10_000);

  test(`queue saturation rejects a new call before dispatch (${dialer} dials)`, async () => {
    let writable = true;
    const fixture = await remoteFixture(dialer, (controller) => {
      controller.onSession(session => {
        const attach = session.attach.bind(session);
        session.attach = socket => attach({
          send: body => socket.send(body), close: () => socket.close(),
          canSend: bytes => writable && socket.canSend?.(bytes) !== false,
        });
      });
    });
    const pending: Promise<unknown>[] = [];
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const session = fixture.controller.current!;
      writable = false;
      const prompt = 'p'.repeat(3 * 1024 * 1024);
      for (let index = 0; index < 10; index++) {
        pending.push(integration.execution.start({ ...request, runId: crypto.randomUUID(), prompt }).catch(error => error));
      }
      await expect(integration.execution.start({ ...request, prompt })).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect(fixture.generations[0]!.calls.start).toBe(0);
      expect(session.channel.queuedFrames).toBe(10);
      expect(fixture.executor.availability).toBe('ready');
    } finally { await fixture.dispose(); await Promise.all(pending); }
  });
}
