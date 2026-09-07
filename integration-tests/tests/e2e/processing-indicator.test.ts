import { describe, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda processing indicator', () => {
  test('keeps the Anthropic successor indicator visible after the predecessor terminal arrives', async () => {
    await withE2eFixture('anthropic-processing-indicator', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const predecessor = fixture.integration.fakeProviders.anthropic.holdNext({
        lastUserText: 'ui-processing-a',
      });
      const successor = fixture.integration.fakeProviders.anthropic.holdNext({
        lastUserText: 'ui-processing-b',
      });

      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startAnthropicDirectChat('ui-processing-a');
      await predecessor.received;
      await app.waitForChatProcessing(true);

      const chat = (await fixture.integration.client.listChats()).sessions.find(
        (entry) => entry.preview.firstMessage === 'ui-processing-a',
      );
      if (!chat) throw new Error('Started Anthropic chat was not listed.');

      await app.sendComposer('ui-processing-b');
      await app.waitForQueuedPreview('ui-processing-b');
      const predecessorTerminalCursor = await fixture.spaWebSocketEventCount();

      predecessor.releaseEcho();
      await successor.received;
      await fixture.waitForSpaWebSocketEvent({
        afterIndex: predecessorTerminalCursor,
        type: 'agent-run-finished',
        chatId: chat.id,
      });
      await app.waitForChatProcessing(true);

      successor.releaseEcho();
      await app.waitForText('echo:ui-processing-b');
      await app.waitForChatProcessing(false);
      fixture.assertNoBrowserErrors();
    });
  });
});
