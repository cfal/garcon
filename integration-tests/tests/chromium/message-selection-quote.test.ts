import { describe, expect, test } from 'bun:test';
import type { Locator, Page } from 'playwright';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

const ASSISTANT_TRIGGER_SELECTOR = '[data-chat-message-type="assistant-message"] [data-slot="context-menu-trigger"]';
const COMPOSER_TEXTAREA_SELECTOR = '[data-composer] textarea';

interface SelectionClickPoint {
	x: number;
	y: number;
}

/** Selects the marker text inside the assistant message and returns a clickable point within it. */
async function selectAssistantMarker(
	trigger: Locator,
	marker: string,
): Promise<SelectionClickPoint> {
	return trigger.evaluate(
		(element, selectedMarker) => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode();
			while (node && !(node.textContent ?? '').includes(selectedMarker)) {
				node = walker.nextNode();
			}
			if (!node) throw new Error(`No assistant text node contains ${selectedMarker}.`);
			const text = node.textContent ?? '';
			const start = text.indexOf(selectedMarker);
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + selectedMarker.length);
			const selection = document.getSelection();
			if (!selection) throw new Error('The browser selection API is unavailable.');
			selection.removeAllRanges();
			selection.addRange(range);
			document.dispatchEvent(new Event('selectionchange'));
			const rect = [...range.getClientRects()].find((candidate) => candidate.width > 0);
			if (!rect) throw new Error('The selected assistant range has no visible client rect.');
			if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
				throw new Error('The selected assistant range is not fully inside the viewport.');
			}
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		},
		marker,
	);
}

async function openMessageMenuAtSelection(
	page: Page,
	point: SelectionClickPoint,
): Promise<void> {
	await page.mouse.click(point.x, point.y, { button: 'right' });
}

async function quoteSelectionAndWaitForDraft(
	page: Page,
	marker: string,
): Promise<void> {
	await page.getByRole('menuitem', { name: 'Quote selection' }).click();
	const quoted = `> ${marker}\n\n`;
	await page.waitForFunction(
		({ selector, expected }) =>
			(document.querySelector<HTMLTextAreaElement>(selector)?.value ?? '') === expected,
		{ selector: COMPOSER_TEXTAREA_SELECTOR, expected: quoted },
		{ timeout: 10_000 },
	);
	await assertComposerNotFocused(page);
}

async function assertComposerNotFocused(page: Page): Promise<void> {
	expect(
		await page.evaluate(
			(selector) => document.activeElement !== document.querySelector(selector),
			COMPOSER_TEXTAREA_SELECTOR,
		),
	).toBe(true);
}

describe('Chromium message selection actions', () => {
	test('quotes a native-context-menu selection into the composer and preserves duplicate quotes', async () => {
		await withChromiumFixture('message-selection-quote', async (fixture, markPhase) => {
			const marker = 'chromium-quote-seed';
			const chatId = fixture.integration.newChatId();
			const started = await fixture.integration.client.startDirectChat({
				chatId,
				content: marker,
				projectPath: fixture.integration.dirs.project,
				agent: fixture.integration.directAgents.openAi,
			});
			expect(
				(await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId)).type,
			).toBe('agent-run-finished');

			const response = await fixture.page.goto(
				`${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
				{ waitUntil: 'domcontentloaded' },
			);
			if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);

			const trigger = fixture.page.locator(ASSISTANT_TRIGGER_SELECTOR).first();
			await trigger.getByText(`echo:${marker}`, { exact: true }).waitFor();
			await fixture.page.locator(COMPOSER_TEXTAREA_SELECTOR).waitFor();

			markPhase('first quote');
			const point = await selectAssistantMarker(trigger, `echo:${marker}`);
			await openMessageMenuAtSelection(fixture.page, point);
			await fixture.page.getByRole('menuitem', { name: 'Copy selection' }).waitFor();
			await quoteSelectionAndWaitForDraft(fixture.page, `echo:${marker}`);

			markPhase('repeat quote');
			const repeatPoint = await selectAssistantMarker(trigger, `echo:${marker}`);
			await openMessageMenuAtSelection(fixture.page, repeatPoint);
			const quotedTwice = `> echo:${marker}\n\n> echo:${marker}\n\n`;
			await fixture.page.getByRole('menuitem', { name: 'Quote selection' }).click();
			await fixture.page.waitForFunction(
				({ selector, expected }) =>
					(document.querySelector<HTMLTextAreaElement>(selector)?.value ?? '') === expected,
				{ selector: COMPOSER_TEXTAREA_SELECTOR, expected: quotedTwice },
				{ timeout: 10_000 },
			);
			await assertComposerNotFocused(fixture.page);

			markPhase('cleared selection');
			await fixture.page.evaluate(() => {
				document.getSelection()?.removeAllRanges();
				document.dispatchEvent(new Event('selectionchange'));
			});
			await openMessageMenuAtSelection(fixture.page, repeatPoint);
			await fixture.page.getByRole('menuitem', { name: 'Copy text' }).waitFor();
			expect(
				await fixture.page
					.getByRole('menuitem', { name: 'Quote selection' })
					.count(),
			).toBe(0);
			await fixture.page.keyboard.press('Escape');

			fixture.assertNoBrowserErrors();
		});
	});
});
