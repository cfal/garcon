import { describe, expect, test } from 'bun:test';
import type { Page } from 'puppeteer-core';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';
import {
  replaceFirstAcceptedResponse,
  waitForAcceptedResponseRequestBodies,
} from '../../support/accepted-response-loss.js';

interface BrowserRequestGate {
	path: string;
	requestCount: number;
	release: (() => void) | null;
}

type RequestGateGlobal = typeof globalThis & {
	__garconBrowserRequestGate?: BrowserRequestGate;
};

async function holdFirstBrowserRequest(page: Page, path: string): Promise<void> {
	await page.evaluate((targetPath) => {
		const originalFetch = globalThis.fetch.bind(globalThis);
		const testGlobal = globalThis as RequestGateGlobal;
		testGlobal.__garconBrowserRequestGate = {
			path: targetPath,
			requestCount: 0,
			release: null,
		};
		const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const inputUrl = typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
			const gate = testGlobal.__garconBrowserRequestGate;
			if (gate && new URL(inputUrl, globalThis.location.href).pathname === gate.path) {
				gate.requestCount += 1;
				if (gate.requestCount === 1) {
					await new Promise<void>((resolve) => {
						gate.release = resolve;
					});
				}
			}
			return originalFetch(input, init);
		};
		Object.defineProperty(globalThis, 'fetch', {
			configurable: true,
			writable: true,
			value: gatedFetch,
		});
	}, path);
}

async function waitForHeldBrowserRequest(page: Page): Promise<void> {
	await page.waitForFunction(
		() => (globalThis as RequestGateGlobal).__garconBrowserRequestGate?.requestCount === 1,
		{ timeout: 10_000 },
	);
}

async function browserRequestCount(page: Page): Promise<number> {
	return page.evaluate(() => (
		(globalThis as RequestGateGlobal).__garconBrowserRequestGate?.requestCount ?? 0
	));
}

async function releaseHeldBrowserRequest(page: Page): Promise<void> {
	await page.evaluate(() => {
		const gate = (globalThis as RequestGateGlobal).__garconBrowserRequestGate;
		if (!gate?.release) throw new Error('No browser request is waiting for release.');
		const release = gate.release;
		gate.release = null;
		release();
	});
}

describe('Lightpanda queue workflow', () => {
	test('keeps a second message as a draft until direct admission is confirmed', async () => {
		await withE2eFixture('queue-direct-admission', async (fixture) => {
			const app = new SpaDriver(fixture.page, fixture.integration);
			await app.open();
			await fixture.waitForSpaWebSocket();
			await app.startOpenAiDirectChat('ui-admission-seed');
			await app.waitForText('echo:ui-admission-seed');
			const chat = (await fixture.integration.client.listChats()).sessions.find(
				(entry) => entry.preview.firstMessage === 'ui-admission-seed',
			);
			if (!chat) throw new Error('Admission-race chat was not listed.');

			await holdFirstBrowserRequest(fixture.page, '/api/v1/chats/run');
			const active = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'ui-admission-first',
			});
			await app.sendComposer('ui-admission-first');
			await waitForHeldBrowserRequest(fixture.page);
			await app.fill('textarea[placeholder="Reply..."]', 'ui-admission-second');

			const composer = await fixture.page.evaluate(() => {
				const textarea = document.querySelector<HTMLTextAreaElement>(
					'textarea[placeholder="Reply..."]',
				);
				const send = [...document.querySelectorAll('button')].find((element) => (
					!element.closest('[aria-hidden="true"]')
					&& element.getAttribute('aria-label') === 'Send message'
				)) as HTMLButtonElement | undefined;
				return {
					text: textarea?.value,
					textareaDisabled: textarea?.disabled,
					sendDisabled: send?.disabled,
				};
			});
			expect(composer).toEqual({
				text: 'ui-admission-second',
				textareaDisabled: false,
				sendDisabled: true,
			});
			await fixture.page.$eval('textarea[placeholder="Reply..."]', (element) => {
				element.dispatchEvent(new KeyboardEvent('keydown', {
					key: 'Enter',
					bubbles: true,
					cancelable: true,
				}));
			});
			expect(await browserRequestCount(fixture.page)).toBe(1);
			expect(await app.exactTextCount('ui-admission-second')).toBe(0);

			await releaseHeldBrowserRequest(fixture.page);
			await active.received;
			await app.submitComposerWithEnter('ui-admission-second', 'Queue message');
			await app.waitForQueuedPreview('ui-admission-second');
			const control = await fixture.integration.client.getExecutionControl(chat.id);
			expect(control.queue.entries.map((entry) => entry.content)).toEqual([
				'ui-admission-second',
			]);

			active.releaseEcho();
			await fixture.integration.fakeProviders.openAi.waitForRequest({
				lastUserText: 'ui-admission-second',
			});
			await app.waitForText('echo:ui-admission-second');
			expect(fixture.integration.fakeProviders.openAi.requests()
				.map((request) => request.lastUserText)
				.filter((text) => text.startsWith('ui-admission-'))).toEqual([
				'ui-admission-seed',
				'ui-admission-first',
				'ui-admission-second',
			]);
			fixture.assertNoBrowserErrors();
		});
	});

	test('clears stale controls and shows an Enter-queued message after restart', async () => {
		await withE2eFixture('queue-controls-after-restart', async (fixture) => {
			const app = new SpaDriver(fixture.page, fixture.integration);
			const before = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'before-restart-active',
			});
			await app.open();
			await fixture.waitForSpaWebSocket();
			await app.startOpenAiDirectChat('before-restart-active');
			await before.received;

			await app.sendComposer('before-restart-queued');
			await app.waitForQueuedPreview('before-restart-queued');
			const chat = (await fixture.integration.client.listChats()).sessions.find(
				(entry) => entry.preview.firstMessage === 'before-restart-active',
			);
			if (!chat) throw new Error('Restart queue chat was not listed.');
			await fixture.integration.client.pauseQueue(chat.id);
			await app.waitForText('Resume queue');

			const terminalCursor = fixture.integration.client.markEvents();
			before.releaseEcho();
			await fixture.integration.client.waitForProcessing(chat.id, false, {
				afterIndex: terminalCursor,
			});
			const priorConnectionCount = await fixture.spaWebSocketConnectionCount();
			expect(fixture.browserErrors).toEqual([]);
			const errorsBeforeCrash = fixture.browserErrors.length;

			await fixture.integration.crashAndRestartGarcon({ reusePort: true });
			await fixture.page.evaluate((previousCount) => {
				const scope = globalThis as typeof globalThis & {
					__garconSpaWsOpenCount?: number;
				};
				if ((scope.__garconSpaWsOpenCount ?? 0) <= previousCount) {
					globalThis.dispatchEvent(new Event('online'));
				}
			}, priorConnectionCount);
			await fixture.waitForSpaWebSocket({ afterConnectionCount: priorConnectionCount });
			const errorsAfterReconnect = fixture.browserErrors.length;
			await fixture.page.waitForFunction(
				() => document.querySelector('[data-queue-preview]') === null,
				{ timeout: 20_000 },
			);
			await app.waitForTextAbsent('Resume queue');
			await app.waitForComposerAction('Send message');

			const after = fixture.integration.fakeProviders.openAi.holdNext({
				lastUserText: 'after-restart-active',
			});
			await app.sendComposer('after-restart-active');
			await after.received;
			await app.submitComposerWithEnter('after-restart-queued', 'Queue message');

			await app.waitForQueuedPreview('after-restart-queued');
			const control = await fixture.integration.client.getExecutionControl(chat.id);
			expect(control.queue.entries.map((entry) => entry.content)).toEqual([
				'after-restart-queued',
			]);

			const afterTerminalCursor = fixture.integration.client.markEvents();
			after.releaseEcho();
			await fixture.integration.client.waitForProcessing(chat.id, false, {
				afterIndex: afterTerminalCursor,
			});
			const reconnectWindowErrors = fixture.browserErrors.slice(
				errorsBeforeCrash,
				errorsAfterReconnect,
			);
			expect(reconnectWindowErrors.filter(
				(message) => !message.startsWith('console.error: WebSocket error:'),
			)).toEqual([]);
			expect(fixture.browserErrors.slice(errorsAfterReconnect)).toEqual([]);
		});
	});

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
      expect(await app.hasResponsiveAction('Steer')).toBe(false);

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
