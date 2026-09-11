import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../../../common/json.js';
import { userContents } from '../../support/chat-assertions.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { claudeText } from '../../support/fake-claude-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveClaudeStartRequest } from '../../support/live-claude.js';
import { startScriptedClaudeTestEnvironment } from '../../support/scripted-claude.js';

for (const delivery of ['direct', 'queued'] as const) {
  test(`${delivery} admission keeps its configuration across a later settings save`, async () => {
    const entered = new Deferred<string>();
    const release = new Deferred<void>();
    const gate = Bun.serve({
      hostname: '0.0.0.0', port: 0, idleTimeout: 0,
      async fetch(request) {
        const input: unknown = await request.json();
        if (!isRecord(input) || typeof input.turnId !== 'string') return new Response(null, { status: 400 });
        entered.resolve(input.turnId);
        await release.promise;
        return new Response(null, { status: 204 });
      },
    });
    try {
      await withIntegrationFixture(`admitted-configuration-${delivery}`, async (fixture) => {
        const chatId = fixture.newChatId();
        const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic initial input' });
        const admitted = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic admitted input' });
        const next = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic next input' });
        try {
          const started = await fixture.client.startDirectChat({
            chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project, content: 'synthetic initial input',
          });
          await first.received;
          if (delivery === 'queued') await fixture.client.enqueueNew(chatId, 'synthetic admitted input');
          first.releaseText('synthetic initial result');
          await fixture.client.waitForTurnTerminal(chatId, started.turnId);
          if (delivery === 'direct') await fixture.client.runChat({
            chatId, command: 'synthetic admitted input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          });
          const turnId = await withTimeout(entered.promise, 5_000, () => 'Admitted turn did not reach dispatch');
          expect(userContents((await fixture.client.getMessages(chatId)).messages))
            .toEqual(['synthetic initial input', 'synthetic admitted input']);
          expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
          expect(await fixture.client.patch('/api/v1/chats/execution-settings', { chatId, thinkingMode: 'low' }))
            .toMatchObject({ success: true, thinkingMode: 'low' });

          release.resolve();
          const dispatched = await withTimeout(admitted.received, 5_000, () => 'Settings save prevented admitted dispatch');
          expect(dispatched.body.reasoning_effort).toBeUndefined();
          admitted.releaseText('synthetic admitted result');
          await fixture.client.waitForTurnTerminal(chatId, turnId);
          const following = await fixture.client.runChat({
            chatId, command: 'synthetic next input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
          });
          expect((await next.received).body.reasoning_effort).toBe('low');
          next.releaseText('synthetic next result');
          await fixture.client.waitForTurnTerminal(chatId, following.turnId);
          expect(fixture.fakeProviders.openAi.requests()).toHaveLength(3);
        } finally {
          release.resolve();
          for (const output of [first, admitted, next]) {
            output.allowAbort();
            output.releaseText('synthetic cleanup');
          }
        }
      }, {
        authentication: 'account', bindAddress: '0.0.0.0',
        preloadModules: [fileURLToPath(new URL('../../support/execution-dispatch-preload.ts', import.meta.url))],
        serverEnvironment: { GARCON_TEST_EXECUTION_DISPATCH_GATE: `http://127.0.0.1:${gate.port}` },
      });
    } finally {
      release.resolve();
      await gate.stop(true);
    }
  }, 30_000);
}

test('an admitted Claude turn keeps its configuration after a live session settings apply', async () => {
  const environment = await startScriptedClaudeTestEnvironment();
  const entered = new Deferred<string>();
  const release = new Deferred<void>();
  const gate = Bun.serve({
    hostname: '0.0.0.0', port: 0, idleTimeout: 0,
    async fetch(request) {
      const input: unknown = await request.json();
      if (!isRecord(input) || typeof input.turnId !== 'string') return new Response(null, { status: 400 });
      entered.resolve(input.turnId);
      await release.promise;
      return new Response(null, { status: 204 });
    },
  });
  try {
    for (const result of ['initial', 'admitted', 'next']) environment.model.scriptTurn([claudeText(`synthetic ${result} result`)]);
    await withIntegrationFixture('admitted-live-session-configuration', async (fixture) => {
      try {
        const chatId = fixture.newChatId();
        const initial = await fixture.client.startChat({
          ...liveClaudeStartRequest({ chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input' }),
          model: 'synthetic-original-model', thinkingMode: 'low',
        });
        await fixture.client.waitForTurnTerminal(chatId, initial.turnId);
        await fixture.client.runChat({
          chatId, command: 'synthetic admitted input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        });
        const turnId = await withTimeout(entered.promise, 5_000, () => 'Admitted Claude turn did not reach dispatch');
        expect(userContents((await fixture.client.getMessages(chatId)).messages))
          .toEqual(['synthetic initial input', 'synthetic admitted input']);
        expect(await fixture.client.patch('/api/v1/chats/execution-settings', {
          chatId, thinkingMode: 'none',
        })).toMatchObject({ success: true, thinkingMode: 'none' });
        expect(await fixture.client.patch('/api/v1/chats/model', {
          chatId, model: 'synthetic-updated-model',
        })).toMatchObject({ success: true, model: 'synthetic-updated-model' });
        release.resolve();
        await fixture.client.waitForTurnTerminal(chatId, turnId);
        const following = await fixture.client.runChat({
          chatId, command: 'synthetic next input', clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(),
        });
        await fixture.client.waitForTurnTerminal(chatId, following.turnId);
        const requests = environment.model.requests();
        expect(requests).toHaveLength(3);
        expect(requests.map((request) => request.body.model))
          .toEqual(['synthetic-original-model', 'synthetic-original-model', 'synthetic-updated-model']);
        environment.model.assertSettled();
      } finally { release.resolve(); }
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/execution-dispatch-preload.ts', import.meta.url))],
      serverEnvironment: { ...environment.serverEnvironment, GARCON_TEST_EXECUTION_DISPATCH_GATE: `http://127.0.0.1:${gate.port}` },
    });
  } finally {
    release.resolve();
    environment.dispose();
    await gate.stop(true);
  }
}, 30_000);
