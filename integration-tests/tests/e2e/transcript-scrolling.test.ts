import { describe, expect, test } from 'bun:test';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

describe('Lightpanda transcript scrolling', () => {
	test('fills short live history and pages from the initial prompt back to the live tail', async () => {
		await withE2eFixture('transcript-scrolling', async (fixture) => {
			const app = new SpaDriver(fixture.page, fixture.integration);
			const turns = Array.from(
				{ length: 51 },
				(_, index) => `scroll-history-turn-${String(index).padStart(2, '0')}`,
			);
			const firstTurn = turns[0]!;
			const middleTurn = turns[40]!;
			const lastTurn = turns.at(-1)!;

			await fixture.page.setViewport({ width: 1_280, height: 20_000 });
			await app.open();
			await fixture.waitForSpaWebSocket();
			await app.startOpenAiDirectChat(firstTurn);
			await app.waitForText(`echo:${firstTurn}`);
			await app.waitForChatProcessing(false);
			const chatId = await fixture.page.evaluate(() =>
				decodeURIComponent(globalThis.location.pathname.slice('/chat/'.length)),
			);
			const waitForFeedText = async (text: string, present = true) => {
				await fixture.page.waitForFunction(
					({ expected, shouldBePresent }) => {
						const feed = document.querySelector<HTMLElement>(
							'[role="log"][aria-label="Chat messages"]',
						);
						return (feed?.innerText.includes(expected) ?? false) === shouldBePresent;
					},
					{ timeout: 20_000 },
					{ expected: text, shouldBePresent: present },
				);
			};

			for (const content of turns.slice(1)) {
				const accepted = await fixture.integration.client.runDirectChat({
					chatId,
					content,
					agent: fixture.integration.directAgents.openAi,
				});
				expect(
					(await fixture.integration.client.waitForTurnTerminal(chatId, accepted.turnId)).type,
				).toBe('agent-run-finished');
			}

			await waitForFeedText(`echo:${lastTurn}`);
			await waitForFeedText(firstTurn);
			expect(await app.hasButton('Load more')).toBe(false);

			await app.setViewport(1_280, 800);
			await fixture.page.$eval('[role="log"][aria-label="Chat messages"]', (element) => {
				const feed = element as HTMLElement;
				feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -200 }));
				feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 200);
				feed.dispatchEvent(new Event('scroll', { bubbles: true }));
			});
			await fixture.page.waitForFunction(
				() => {
					const button = document.querySelector<HTMLButtonElement>(
						'button[title="Scroll to initial prompt"]',
					);
					if (!button || button.disabled) return false;
					button.click();
					return true;
				},
				{ timeout: 20_000 },
			);
			await waitForFeedText(lastTurn, false);
			await waitForFeedText(firstTurn);

			const scrollToBottom = async () => {
				await fixture.page.$eval('[role="log"][aria-label="Chat messages"]', (element) => {
					const feed = element as HTMLElement;
					feed.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1_000 }));
					feed.scrollTop = feed.scrollHeight;
					feed.dispatchEvent(new Event('scroll', { bubbles: true }));
				});
			};

			await scrollToBottom();
			await waitForFeedText(`echo:${middleTurn}`);
			await scrollToBottom();
			await waitForFeedText(`echo:${lastTurn}`);
			expect(await app.hasButton('Load more')).toBe(false);
			fixture.assertNoBrowserErrors();
		});
	});
});
