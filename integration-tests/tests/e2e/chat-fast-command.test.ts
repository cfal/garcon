import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { waitForVisibleResponse } from '../../support/live-agent.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { SpaDriver } from '../../support/spa-driver.js';
import { startScriptedCodexTestEnvironment, type ScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed } from '../../support/scripted-codex-speed.js';

describe('Lightpanda per-chat Fast commands', () => {
  let environment: ScriptedCodexTestEnvironment;
  beforeAll(async () => { environment = await startScriptedCodexTestEnvironment(); });
  afterAll(async () => { await environment?.dispose(); });

  test('switches one chat, reports status after reload, and never sends commands to the model', async () => {
    await withE2eFixture('chat-fast-command', async (fixture) => {
      const integration = fixture.integration;
      const chatId = integration.newChatId();
      const marker = `speed-seed-${crypto.randomUUID()}`;
      environment.model.scriptTurn([codexAssistantMessage(marker)]);
      const afterIndex = integration.client.markEvents();
      const turn = await integration.client.startChat(liveCodexStartRequest({
        chatId, projectPath: integration.dirs.project, command: 'Synthetic speed test.',
      }));
      await waitForVisibleResponse({ fixture: integration, chatId, turnId: turn.turnId, marker, afterIndex });
      const app = new SpaDriver(fixture.page, integration);
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      const requestsBefore = environment.model.requests().length;

      await app.sendComposer('/fast on');
      await app.waitForText('Fast mode is on for this chat.');
      expect((await integration.client.listChats()).sessions.find((chat) => chat.id === chatId)?.agentSettings.values.speed).toBe('fast');
      await fixture.page.reload();
      await fixture.waitForSpaWebSocket();
      await app.sendComposer('/fast status');
      await app.waitForText('Fast mode is on for this chat.');
      await app.sendComposer('/fast off');
      await app.waitForText('Fast mode is off for this chat.');
      expect((await integration.client.listChats()).sessions.find((chat) => chat.id === chatId)?.agentSettings.values.speed).toBe('standard');
      expect(environment.model.requests()).toHaveLength(requestsBefore);
      environment.model.assertSettled();
      fixture.assertNoBrowserErrors();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (directories) => prepareScriptedCodexSpeed(environment, directories),
    });
  }, 120_000);
});
