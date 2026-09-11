import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { userContents } from '../../support/chat-assertions.js';
import { Deferred, withTimeout } from '../../support/deferred.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withIntegrationFixture } from '../../support/integration-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';

test('an unsupported provider rejects steering with its capability error before input admission', async () => {
  await withIntegrationFixture('steer-preparation-unsupported', async (fixture) => {
    const chatId = fixture.newChatId();
    const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: 'synthetic initial input' });
    try {
      const started = await fixture.client.startDirectChat({
        chatId, agent: fixture.directAgents.openAi, projectPath: fixture.dirs.project, content: 'synthetic initial input',
      });
      await held.received;
      await expect(fixture.client.steer({
        chatId, clientRequestId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), content: 'synthetic unsupported steer',
      })).rejects.toMatchObject({ status: 422, body: { errorCode: 'OPERATION_UNSUPPORTED' } });
      expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['synthetic initial input']);
      held.releaseText('synthetic completed response');
      await fixture.client.waitForTurnTerminal(chatId, started.turnId);
      expect(fixture.fakeProviders.openAi.requests()).toHaveLength(1);
    } finally { held.allowAbort(); held.releaseText('synthetic cleanup'); }
  }, { authentication: 'account', bindAddress: '0.0.0.0' });
}, 30_000);

test('a native terminal rejects prepared steering before input admission while terminal fanout waits', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  const admission = { entered: new Deferred<void>(), release: new Deferred<void>() };
  const terminal = { entered: new Deferred<void>(), release: new Deferred<void>() };
  const gate = Bun.serve({
    hostname: '0.0.0.0', port: 0, idleTimeout: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const checkpoint = path === '/admission' ? admission : path === '/terminal' ? terminal : null;
      if (!checkpoint || request.method !== 'POST') return new Response(null, { status: 404 });
      checkpoint.entered.resolve();
      await checkpoint.release.promise;
      return new Response(null, { status: 204 });
    },
  });
  const held = environment.model.scriptHeldTurn([codexAssistantMessage('synthetic completed response')]);
  try {
    await withIntegrationFixture('steer-preparation-terminal', async (fixture) => {
      const chatId = fixture.newChatId();
      const started = await fixture.client.startChat(liveCodexStartRequest({
        chatId, projectPath: fixture.dirs.project, command: 'synthetic initial input',
      }));
      await held.requested;
      const pending = fixture.client.steer({ chatId, clientRequestId: crypto.randomUUID(),
        clientMessageId: crypto.randomUUID(), content: 'synthetic stale steer',
      });
      void pending.catch(() => {});
      try {
        await withTimeout(admission.entered.promise, 5_000, () => 'Steering did not prepare its native target');
        held.release();
        await withTimeout(terminal.entered.promise, 5_000, () => 'The native turn did not finish');
        admission.release.resolve();
        await expect(pending).rejects.toMatchObject({ status: 409, body: { errorCode: 'STEER_TURN_CHANGED' } });
        expect(userContents((await fixture.client.getMessages(chatId)).messages)).toEqual(['synthetic initial input']);
        terminal.release.resolve();
        await fixture.client.waitForTurnTerminal(chatId, started.turnId);
        expect(environment.model.requests()).toHaveLength(1);
        environment.model.assertSettled();
      } finally {
        admission.release.resolve();
        terminal.release.resolve();
        await pending.catch(() => {});
      }
    }, {
      authentication: 'account', bindAddress: '0.0.0.0',
      serverEnvironment: { ...environment.serverEnvironment, GARCON_TEST_STEER_ADMISSION_GATE: `http://127.0.0.1:${gate.port}` },
      prepareWorkspace: environment.prepareWorkspace,
      preloadModules: [fileURLToPath(new URL('../../support/steer-admission-preload.ts', import.meta.url))],
    });
  } finally {
    held.release();
    admission.release.resolve();
    terminal.release.resolve();
    await gate.stop(true);
    await environment.dispose();
  }
}, 120_000);
