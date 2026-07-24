import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  replaceFirstAcceptedResponse,
  waitForAcceptedResponseRequestBodies,
} from '../../support/accepted-response-loss.js';

describe('Lightpanda queue workflow', () => {
	test('moves queued messages with buttons and executes the authoritative order', async () => {
		await withE2eFixture('queue-reorder-workflow', async (fixture) => {
			const app = new SpaDriver(fixture.page, fixture.integration);
			const active = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'ui-reorder-a',
			});
			await app.open();
			await fixture.waitForSpaWebSocket();
			await app.startOpenAiDirectChat('ui-reorder-a');
			await active.received;

			await app.sendComposer('ui-reorder-b');
			await app.sendComposer('ui-reorder-c');
			await app.sendComposer('ui-reorder-d');
			await app.waitForQueuedPreview('ui-reorder-b');
			await app.clickResponsiveAction('Edit queue');
			await app.waitForQueuedDialogOrder(['ui-reorder-b', 'ui-reorder-c', 'ui-reorder-d']);

			await app.clickQueuedMove('ui-reorder-d', 'up');
			await app.waitForQueuedDialogOrder(['ui-reorder-b', 'ui-reorder-d', 'ui-reorder-c']);
			await app.waitForFocusedQueuedMove('ui-reorder-d');
			await app.clickQueuedMove('ui-reorder-d', 'up');
			await app.waitForQueuedDialogOrder(['ui-reorder-d', 'ui-reorder-b', 'ui-reorder-c']);
			await app.waitForFocusedQueuedMove('ui-reorder-d');

			const heldD = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'ui-reorder-d',
			});
			const heldB = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'ui-reorder-b',
			});
			const heldC = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'ui-reorder-c',
			});
			await app.clickDialogButton('Close');
			active.releaseEcho();
			await heldD.received;
			heldD.releaseEcho();
			await heldB.received;
			heldB.releaseEcho();
			await heldC.received;
			heldC.releaseEcho();
			await app.waitForText('echo:ui-reorder-c');

			expect(fixture.integration.fakeProviders.openAi.requests().map(
				(request) => request.lastUserText,
			)).toEqual(['ui-reorder-a', 'ui-reorder-d', 'ui-reorder-b', 'ui-reorder-c']);
			fixture.assertNoBrowserErrors();
		});
	});

  test('browses, edits, deletes, pauses, and resumes queued messages', async () => {
    await withE2eFixture('queue-workflow', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: 'ui-queue-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-queue-a');
      await active.received;

      const chat = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-queue-a');
      if (!chat) throw new Error('Started queue chat was not listed.');

      await app.sendComposer('ui-queue-b');
      await app.waitForQueuedPreview('ui-queue-b');
      await app.sendComposer('ui-queue-c');
      await app.waitForText('1 of 2');
      expect(await app.hasResponsiveAction('Send now')).toBe(true);

      await app.clickButton('Next queued message');
      await app.waitForQueuedPreview('ui-queue-c');
      await app.waitForText('2 of 2');
      expect(await app.hasResponsiveAction('Send now')).toBe(false);
      await app.clickButton('Previous queued message');
      await app.waitForQueuedPreview('ui-queue-b');

      await app.clickResponsiveAction('Edit queue');
      await app.clickQueuedRowAction('ui-queue-b', 'Edit queued message');
      await app.fillQueuedEditor('ui-queue-b-edited');
      await app.clickDialogButton('Save edit');
      await app.waitForText('ui-queue-b-edited');
      await app.clickQueuedRowAction('ui-queue-c', 'Remove from queue');
      await app.waitForTextAbsent('ui-queue-c');
      await app.clickDialogButton('Pause');
      await app.waitForText('Resume queue');
      await app.clickDialogButton('Close');

      active.releaseEcho();
      await app.waitForText('echo:ui-queue-a');
      expect(fixture.integration.fakeProviders.openAi.requests().some((request) =>
        request.lastUserText === 'ui-queue-b-edited')).toBe(false);

      await app.clickButton('Resume queue');
      await fixture.integration.fakeProviders.openAi.waitForRequest({ lastUserText: 'ui-queue-b-edited' });
      await app.waitForText('echo:ui-queue-b-edited');

      const queue = (await fixture.integration.client.getExecutionControl(chat.id)).queue;
      expect(queue.entries).toHaveLength(0);
      expect(queue.pause).toBeNull();
      expect(fixture.integration.fakeProviders.openAi.requests().some((request) =>
        request.lastUserText === 'ui-queue-c')).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });

  test('retries queue-as-new with one identity after a lost accepted response', async () => {
    await withE2eFixture('queue-draft-lost-response', async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const active = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: 'ui-queue-draft-a' });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('ui-queue-draft-a');
      await active.received;

      const chat = (await fixture.integration.client.listChats()).sessions.find((entry) =>
        entry.preview.firstMessage === 'ui-queue-draft-a');
      if (!chat) throw new Error('Queue draft chat was not listed.');
      await app.sendComposer('ui-queue-draft-original');
      await app.waitForQueuedPreview('ui-queue-draft-original');
      const originalEntry = (await fixture.integration.client.getExecutionControl(chat.id)).queue.entries[0];
      if (!originalEntry) throw new Error('Original queued draft was not persisted.');

      await app.clickButton('Edit queued message');
      await app.fillQueuedEditor('ui-queue-draft-retry');
      await fixture.integration.client.deleteQueued({
        chatId: chat.id,
        entryId: originalEntry.id,
        clientRequestId: crypto.randomUUID(),
      });
      await app.waitForText('This message is no longer queued');

      await replaceFirstAcceptedResponse(fixture.page, '/api/v1/chats/queue/entries');
      await app.clickDialogButton('Queue draft as new');
      await app.waitForQueuedPreview('ui-queue-draft-retry');

      const interceptedBodies = await waitForAcceptedResponseRequestBodies(fixture.page, 2);
      expect(interceptedBodies).toHaveLength(2);
      expect(interceptedBodies[1]).toMatchObject({
        clientRequestId: interceptedBodies[0].clientRequestId,
        content: interceptedBodies[0].content,
      });
      const queued = (await fixture.integration.client.getExecutionControl(chat.id)).queue.entries;
      expect(queued).toEqual([
        expect.objectContaining({ content: 'ui-queue-draft-retry' }),
      ]);

      await app.clickDialogButton('Close');
      active.releaseEcho();
      await app.waitForText('echo:ui-queue-draft-retry');
      expect(fixture.integration.fakeProviders.openAi.requests().filter((request) => (
        request.lastUserText === 'ui-queue-draft-retry'
      ))).toHaveLength(1);
      fixture.assertNoBrowserErrors();
    });
  });
});
