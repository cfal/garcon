import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { userContents } from '../../support/chat-assertions.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';

test('interrupt-and-send re-prepares cancelled queued admission before committing the retained input', async () => {
  const entered = new Deferred<void>();
  const release = new Deferred<void>();
  const settled = new Deferred<void>();
  const gate = Bun.serve({
    hostname: '0.0.0.0', port: 0, idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/settled') settled.resolve();
      else { entered.resolve(); await release.promise; }
      return new Response(null, { status: 204 });
    },
  });
  try {
    await withIntegrationFixture('admission-cancellation-queued', async (fixture) => {
      const chatId = fixture.newChatId();
      const agent = fixture.directAgents.openAi;
      const first = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic initial input' });
      const queued = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'Synthetic pending input' });
      try {
        const started = await fixture.client.startDirectChat({ chatId, agent,
          projectPath: fixture.dirs.project, content: 'Synthetic initial input' });
        await first.received;
        await fixture.client.enqueueNew(chatId, 'Synthetic pending input');
        first.releaseText('Synthetic initial result');
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        await withTimeout(entered.promise, 5_000, () => 'Prepared admission did not reach the commit barrier');
        expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['Synthetic initial input']);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
        await fixture.client.interruptAndSend({ chatId, clientRequestId: crypto.randomUUID() });
        release.resolve();
        await withTimeout(settled.promise, 5_000, () => 'Cancelled admission did not settle');

        await withTimeout(queued.received, 5_000, () => 'The requested fresh drain did not dispatch the retained head');
        const terminalCursor = fixture.client.markEvents();
        queued.releaseText('Synthetic queued result');
        await fixture.client.waitForProcessing(chatId, false, { afterIndex: terminalCursor });
        expect(userContents((await fixture.client.getMessages(chatId)).messages))
          .toEqual(['Synthetic initial input', 'Synthetic pending input']);
        expect(fixture.fakeProviders.openAi.requests()).toHaveLength(2);
        expect((await fixture.client.getExecutionControl(chatId)).queue.entries).toEqual([]);
        const beforeRestart = await fixture.client.getMessages(chatId);
        await fixture.restartGarcon();
        expect(await fixture.client.getMessages(chatId)).toEqual(beforeRestart);
      } finally {
        release.resolve();
        first.allowAbort(); first.releaseText('Synthetic cleanup');
        queued.allowAbort(); queued.releaseText('Synthetic cleanup');
      }
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      preloadModules: [fileURLToPath(new URL('../../support/execution-admission-preload.ts', import.meta.url))],
      serverEnvironment: { GARCON_TEST_EXECUTION_ADMISSION_GATE: `http://127.0.0.1:${gate.port}` },
    });
  } finally { release.resolve(); await gate.stop(true); }
}, 30_000);
