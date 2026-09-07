import { expect, test } from 'bun:test';
import { userContents } from '../../support/chat-assertions.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('steers the visible Codex queue head and preserves later paused work', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  const held = environment.model.scriptHeldTurn([codexAssistantMessage('queue steer active reply')]);
  environment.model.scriptTurn([codexAssistantMessage('queue steer guidance reply')]);
  environment.model.scriptTurn([codexAssistantMessage('queue steer future reply')]);

  try {
    await withE2eFixture('queue-steer-workflow', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      const active = await fixture.integration.client.startChat(liveCodexStartRequest({
        chatId,
        projectPath: fixture.integration.dirs.project,
        command: 'queue steer active prompt',
      }));
      if (!active.turnId) throw new Error('Codex omitted the active turn ID.');
      await held.requested;

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await app.sendComposer('queue steer guidance');
      await app.sendComposer('queue steer future');
      await app.waitForQueuedPreview('queue steer guidance');
      await fixture.integration.client.pauseQueue(chatId);
      await app.waitForText('Resume queue');

      expect(await app.hasResponsiveAction('Steer')).toBe(true);
      await app.clickButton('Next queued message');
      await app.waitForQueuedPreview('queue steer future');
      expect(await app.hasResponsiveAction('Steer')).toBe(false);
      await app.clickButton('Previous queued message');
      await app.waitForQueuedPreview('queue steer guidance');

      await app.clickResponsiveAction('Steer');
      await app.waitForQueuedPreview('queue steer future');
      const afterSteer = await fixture.integration.client.getExecutionControl(chatId);
      expect(afterSteer.queue.entries.map((entry) => entry.content)).toEqual(['queue steer future']);
      expect(afterSteer.queue.pause).not.toBeNull();

      held.release();
      await fixture.integration.client.waitForTurnTerminal(chatId, active.turnId);
      await app.waitForText('queue steer guidance reply');
      await app.clickButton('Resume queue');
      await app.waitForText('queue steer future reply');

      const transcript = await fixture.integration.client.getMessages(chatId);
      expect(userContents(transcript.messages).filter(
        (content) => content === 'queue steer guidance',
      )).toHaveLength(1);
      environment.model.assertSettled();
      fixture.assertNoBrowserErrors();
    }, {
      serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: environment.prepareWorkspace,
    });
  } finally {
    held.release();
    await environment.dispose();
  }
}, 120_000);
