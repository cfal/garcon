import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda queue workflow', () => {
  test('browses, edits, deletes, pauses, and resumes queued messages', async () => {
    await withE2eFixture('queue-workflow', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeOpenAi.holdNext({ lastUserText: 'ui-queue-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startDirectChat('ui-queue-a');
      await active.received;

      const chat = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-queue-a');
      if (!chat) throw new Error('Started queue chat was not listed.');

      await app.sendComposer('ui-queue-b');
      await app.waitForQueuedPreview('ui-queue-b');
      await app.sendComposer('ui-queue-c');
      await app.waitForText('1 of 2');
      expect(await app.hasButton('Interrupt and send')).toBe(true);

      await app.clickButton('Next queued message');
      await app.waitForQueuedPreview('ui-queue-c');
      await app.waitForText('2 of 2');
      expect(await app.hasButton('Interrupt and send')).toBe(false);
      await app.clickButton('Previous queued message');
      await app.waitForQueuedPreview('ui-queue-b');

      await app.clickButton('Edit queue');
      await app.clickQueuedRowAction('ui-queue-b', 'Edit queued message');
      await app.fillQueuedEditor('ui-queue-b-edited');
      await app.clickDialogButton('Save edit');
      await app.waitForText('ui-queue-b-edited');
      await app.clickQueuedRowAction('ui-queue-c', 'Remove from queue');
      await app.waitForTextAbsent('ui-queue-c');
      await app.clickDialogButton('Pause queue');
      await app.waitForText('Resume queue');
      await app.clickDialogButton('Close');

      active.releaseEcho();
      await app.waitForText('echo:ui-queue-a');
      expect(fixture.integration.fakeOpenAi.requests().some((request) =>
        request.lastUserText === 'ui-queue-b-edited')).toBe(false);

      await app.clickButton('Resume queue');
      await fixture.integration.fakeOpenAi.waitForRequest({ lastUserText: 'ui-queue-b-edited' });
      await app.waitForText('echo:ui-queue-b-edited');

      const queue = await fixture.integration.client.getQueue(chat.id);
      expect(queue.entries).toHaveLength(0);
      expect(queue.pause).toBeNull();
      expect(fixture.integration.fakeOpenAi.requests().some((request) =>
        request.lastUserText === 'ui-queue-c')).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });
});
