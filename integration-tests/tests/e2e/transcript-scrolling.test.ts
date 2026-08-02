import { describe, expect, test } from "bun:test";
import type { CDPSession, Page } from "puppeteer-core";
import { withE2eFixture, type E2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

const FEED_SELECTOR = '[role="log"][aria-label="Chat messages"]';

interface VisibleAnchor {
  rowId: string;
  offset: number;
  scrollTop: number;
}

function pageSession(page: Page): CDPSession {
  return (page as Page & { _client(): CDPSession })._client();
}

async function evaluateInPage<T>(
  session: CDPSession,
  expression: string,
): Promise<T> {
  const response = await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text,
    );
  }
  return response.result.value as T;
}

async function installTranscriptGeometry(
  session: CDPSession,
  rowHeight: number,
): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
			if (!feed) throw new Error('Transcript feed not found');
			const geometry = { rowHeight: ${JSON.stringify(rowHeight)} };
			globalThis.__transcriptTestGeometry = geometry;
			const boundaryHeight = 36;
			const viewportHeight = 400;
			let scrollTop = 0;
			const boundariesHeight = () =>
				feed.querySelectorAll('[data-transcript-page-boundary]').length * boundaryHeight;
			const contentHeight = () =>
				Math.max(
					viewportHeight,
					feed.querySelectorAll('[data-chat-anchor-id]').length * geometry.rowHeight + boundariesHeight(),
				);
			Object.defineProperties(feed, {
				clientHeight: { configurable: true, get: () => viewportHeight },
				scrollHeight: { configurable: true, get: contentHeight },
				scrollTop: {
					configurable: true,
					get: () => scrollTop,
					set: (value) => {
						scrollTop = Math.max(0, Math.min(Number(value), contentHeight() - viewportHeight));
					},
				},
			});
			scrollTop = contentHeight() - viewportHeight;
			const nativeRect = HTMLElement.prototype.getBoundingClientRect;
			HTMLElement.prototype.getBoundingClientRect = function () {
				if (this === feed) {
					return {
						bottom: viewportHeight,
						height: viewportHeight,
						left: 0,
						right: 800,
						top: 0,
						width: 800,
						x: 0,
						y: 0,
						toJSON: () => ({}),
					};
				}
				if (this.matches('[data-chat-anchor-id]') && feed.contains(this)) {
					const rows = Array.from(feed.querySelectorAll('[data-chat-anchor-id]'));
					const topBoundary = feed.querySelector('[data-transcript-page-boundary="earlier"]')
						? boundaryHeight
						: 0;
					const top = topBoundary + rows.indexOf(this) * geometry.rowHeight - scrollTop;
					return {
						bottom: top + geometry.rowHeight,
						height: geometry.rowHeight,
						left: 0,
						right: 800,
						top,
						width: 800,
						x: 0,
						y: top,
						toJSON: () => ({}),
					};
				}
				return nativeRect.call(this);
			};
			return true;
		})()`,
  );
}

async function setTranscriptRowHeight(
  session: CDPSession,
  rowHeight: number,
): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const geometry = globalThis.__transcriptTestGeometry;
			if (!geometry) throw new Error('Transcript geometry not installed');
			geometry.rowHeight = ${JSON.stringify(rowHeight)};
			return true;
		})()`,
  );
}

async function prepareInitialWindowNavigation(
  page: Page,
  session: CDPSession,
): Promise<void> {
  await evaluateInPage<number>(
    session,
    `(() => {
			const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
			if (!feed) throw new Error('Transcript feed not found');
			feed.dispatchEvent(new Event('touchstart', { bubbles: true }));
			feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 100);
			feed.dispatchEvent(new Event('scroll', { bubbles: true }));
			return feed.scrollTop;
		})()`,
  );
  await page.waitForSelector(
    'button[title="Scroll to initial prompt"]:not([disabled])',
    {
      timeout: 20_000,
    },
  );
}

async function clickInitialWindow(session: CDPSession): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `document.querySelector('button[title="Scroll to initial prompt"]')?.click() === undefined`,
  );
}

async function navigateToInitialWindow(
  page: Page,
  session: CDPSession,
): Promise<void> {
  await prepareInitialWindowNavigation(page, session);
  await clickInitialWindow(session);
}

async function seedDirectChat(
  fixture: E2eFixture,
  app: SpaDriver,
  turns: readonly string[],
): Promise<string> {
  const firstTurn = turns[0];
  if (!firstTurn) throw new Error("Transcript seed requires at least one turn");
  await app.open();
  await fixture.waitForSpaWebSocket();
  await app.startOpenAiDirectChat(firstTurn);
  await app.waitForText(`echo:${firstTurn.split("\n")[0]}`);
  await app.waitForChatProcessing(false);
  const chatId = await fixture.page.evaluate(() =>
    decodeURIComponent(globalThis.location.pathname.slice("/chat/".length)),
  );
  await fixture.page.goto("about:blank");

  for (const content of turns.slice(1)) {
    const accepted = await fixture.integration.client.runDirectChat({
      chatId,
      content,
      agent: fixture.integration.directAgents.openAi,
    });
    expect(
      (
        await fixture.integration.client.waitForTurnTerminal(
          chatId,
          accepted.turnId,
        )
      ).type,
    ).toBe("agent-run-finished");
  }
  const seededTranscript = await fixture.integration.client.getMessages(
    chatId,
    { limit: 1 },
  );
  expect(seededTranscript.lastSeq).toBe(turns.length * 2);
  return chatId;
}

async function installPageRequestGate(session: CDPSession): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const nativeFetch = globalThis.fetch.bind(globalThis);
			const gate = { armed: false, release: null, requestCount: 0 };
			globalThis.__transcriptPageRequestGate = gate;
			globalThis.fetch = async (input, init) => {
				const requestUrl = input instanceof Request ? input.url : String(input);
				const url = new URL(requestUrl, globalThis.location.href);
				const isPageRequest =
					url.pathname === '/api/v1/chats/messages' && url.searchParams.has('beforeSeq');
				if (!isPageRequest) return nativeFetch(input, init);
				gate.requestCount += 1;
				if (gate.armed) {
					gate.armed = false;
					await new Promise((resolve) => {
						gate.release = resolve;
					});
					gate.release = null;
				}
				return nativeFetch(input, init);
			};
			return true;
		})()`,
  );
}

async function setPageRequestGate(
  session: CDPSession,
  armed: boolean,
): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const gate = globalThis.__transcriptPageRequestGate;
			if (!gate) throw new Error('Transcript page request gate not installed');
			gate.armed = ${JSON.stringify(armed)};
			return true;
		})()`,
  );
}

async function releasePageRequest(session: CDPSession): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const release = globalThis.__transcriptPageRequestGate?.release;
			if (!release) throw new Error('Transcript page request is not waiting');
			release();
			return true;
		})()`,
  );
}

async function pageRequestCount(session: CDPSession): Promise<number> {
  return evaluateInPage<number>(
    session,
    `globalThis.__transcriptPageRequestGate?.requestCount ?? 0`,
  );
}

async function resetPageRequestCount(session: CDPSession): Promise<void> {
  await evaluateInPage<boolean>(
    session,
    `(() => {
			const gate = globalThis.__transcriptPageRequestGate;
			if (!gate) throw new Error('Transcript page request gate not installed');
			gate.requestCount = 0;
			return true;
		})()`,
  );
}

async function boundarySnapshot(
  session: CDPSession,
  direction: "earlier" | "later",
): Promise<{ busy: boolean; precedesTranscript: boolean; text: string }> {
  return evaluateInPage<{
    busy: boolean;
    precedesTranscript: boolean;
    text: string;
  }>(
    session,
    `(() => {
			const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
			const boundary = feed?.querySelector(
				'[data-transcript-page-boundary="${direction}"]',
			);
			const transcript = feed?.querySelector('[data-chat-transcript-scale]');
			if (!feed || !boundary || !transcript) throw new Error('Transcript boundary not found');
			return {
				busy: feed.getAttribute('aria-busy') === 'true',
				precedesTranscript: Boolean(
					boundary.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING,
				),
				text: boundary.textContent.trim(),
			};
		})()`,
  );
}

async function positionBeforeBoundaryEncounter(
  session: CDPSession,
  direction: "earlier" | "later",
): Promise<void> {
  await evaluateInPage<number>(
    session,
    `(() => {
			const selector = ${JSON.stringify(FEED_SELECTOR)};
			const requestedDirection = ${JSON.stringify(direction)};
			const feed = document.querySelector(selector);
			if (!feed) throw new Error('Transcript feed not found');
			const maxScrollTop = feed.scrollHeight - feed.clientHeight;
			feed.scrollTop =
				requestedDirection === 'earlier'
					? Math.min(200, maxScrollTop)
					: Math.max(0, maxScrollTop - 200);
			feed.dispatchEvent(new Event('scroll', { bubbles: true }));
			feed.scrollTop = requestedDirection === 'earlier' ? 0 : feed.scrollHeight;
			return feed.scrollTop;
		})()`,
  );
}

async function triggerBoundary(
  session: CDPSession,
  direction: "earlier" | "later",
): Promise<void> {
  await evaluateInPage<number>(
    session,
    `(() => {
			const selector = ${JSON.stringify(FEED_SELECTOR)};
			const requestedDirection = ${JSON.stringify(direction)};
			const feed = document.querySelector(selector);
			if (!feed) throw new Error('Transcript feed not found');
			const wheel = new Event('wheel', { bubbles: true });
			Object.defineProperty(wheel, 'deltaY', {
				value: requestedDirection === 'earlier' ? -1_000 : 1_000,
			});
			feed.dispatchEvent(wheel);
			feed.scrollTop = requestedDirection === 'earlier' ? 0 : feed.scrollHeight;
			feed.dispatchEvent(new Event('scroll', { bubbles: true }));
			return feed.scrollTop;
		})()`,
  );
}

async function visibleAnchor(session: CDPSession): Promise<VisibleAnchor> {
  return evaluateInPage<VisibleAnchor>(
    session,
    `(() => {
		const selector = ${JSON.stringify(FEED_SELECTOR)};
		const feed = document.querySelector(selector);
		if (!feed) throw new Error('Transcript feed not found');
		const viewportTop = feed.getBoundingClientRect().top;
		const row = Array.from(
			feed.querySelectorAll('[data-chat-anchor-id]'),
		).find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop);
		const rowId = row?.dataset.chatAnchorId;
		if (!row || !rowId) throw new Error('No visible durable transcript row');
		return {
			rowId,
			offset: row.getBoundingClientRect().top - viewportTop,
			scrollTop: feed.scrollTop,
		};
	})()`,
  );
}

async function anchorById(
  session: CDPSession,
  rowId: string,
): Promise<VisibleAnchor> {
  return evaluateInPage<VisibleAnchor>(
    session,
    `(() => {
			const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
			if (!feed) throw new Error('Transcript feed not found');
			const row = Array.from(feed.querySelectorAll('[data-chat-anchor-id]')).find(
				(candidate) => candidate.dataset.chatAnchorId === ${JSON.stringify(rowId)},
			);
			if (!row) {
				const rows = Array.from(feed.querySelectorAll('[data-chat-anchor-id]'));
				throw new Error(
					'Durable transcript row not found: ${rowId}; loaded ' +
						rows[0]?.dataset.chatAnchorId +
						' through ' +
						rows.at(-1)?.dataset.chatAnchorId,
				);
			}
			return {
				rowId: row.dataset.chatAnchorId,
				offset: row.getBoundingClientRect().top - feed.getBoundingClientRect().top,
				scrollTop: feed.scrollTop,
			};
		})()`,
  );
}

function expectStableAnchor(
  before: VisibleAnchor,
  after: VisibleAnchor,
  context: string,
): void {
  if (after.rowId !== before.rowId) {
    throw new Error(
      `${context}: expected ${JSON.stringify(before)}, received ${JSON.stringify(after)}`,
    );
  }
  expect(after.rowId).toBe(before.rowId);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
}

describe("Lightpanda transcript scrolling", () => {
  test("keeps the reading row stable while paging in both directions", async () => {
    await withE2eFixture("transcript-scrolling", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const turnMarkers = Array.from(
        { length: 101 },
        (_, index) => `scroll-history-turn-${String(index).padStart(3, "0")}`,
      );
      const turns = turnMarkers.map((marker) =>
        `${marker}\n\n${"pagination detail\n\n".repeat(12)}`.trim(),
      );
      const firstMarker = turnMarkers[0]!;
      const lastMarker = turnMarkers.at(-1)!;

      await fixture.page.setViewport({ width: 1_280, height: 800 });
      const chatId = await seedDirectChat(fixture, app, turns);
      const waitForFeedText = async (text: string, present = true) => {
        await fixture.page.waitForFunction(
          ({ expected, shouldBePresent }) => {
            const feed = document.querySelector<HTMLElement>(
              '[role="log"][aria-label="Chat messages"]',
            );
            return (
              (feed?.innerText.includes(expected) ?? false) === shouldBePresent
            );
          },
          { timeout: 20_000 },
          { expected: text, shouldBePresent: present },
        );
      };

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      const browser = pageSession(fixture.page);
      await waitForFeedText(`echo:${lastMarker}`);
      expect(await app.hasButton("Load more")).toBe(false);
      await installTranscriptGeometry(browser, 48);
      await installPageRequestGate(browser);
      await navigateToInitialWindow(fixture.page, browser);
      await waitForFeedText(lastMarker, false);
      await waitForFeedText(firstMarker);
      const initialWindow = await evaluateInPage<{
        anchorCount: number;
        clientHeight: number;
        hasNativeBottomAnchor: boolean;
        hasNextPageMarker: boolean;
        scrollHeight: number;
      }>(
        browser,
        `(() => {
					const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
					if (!feed) throw new Error('Transcript feed not found');
					return {
						anchorCount: feed.querySelectorAll('[data-chat-anchor-id]').length,
						clientHeight: feed.clientHeight,
						hasNativeBottomAnchor: Boolean(feed.querySelector('[data-chat-bottom-anchor]')),
						hasNextPageMarker: feed.innerText.includes(${JSON.stringify(turnMarkers[60])}),
						scrollHeight: feed.scrollHeight,
					};
				})()`,
      );
      expect(initialWindow.anchorCount).toBe(50);
      expect(initialWindow.hasNativeBottomAnchor).toBe(false);
      expect(initialWindow.hasNextPageMarker).toBe(false);
      expect(initialWindow.scrollHeight).toBeGreaterThan(
        initialWindow.clientHeight,
      );

      const laterMarkers = [
        turnMarkers[40]!,
        turnMarkers[60]!,
        turnMarkers[80]!,
        lastMarker,
      ];
      for (const [index, marker] of laterMarkers.entries()) {
        await positionBeforeBoundaryEncounter(browser, "later");
        const before = await visibleAnchor(browser);
        const requestsBefore = await pageRequestCount(browser);
        if (index === 0) await setPageRequestGate(browser, true);
        await triggerBoundary(browser, "later");
        if (index === 0) {
          await waitForFeedText("Loading later messages...");
          const loading = await boundarySnapshot(browser, "later");
          expect(loading.busy).toBe(true);
          expect(loading.precedesTranscript).toBe(false);
          expect(loading.text).toContain("Loading later messages...");
          await releasePageRequest(browser);
        }
        await waitForFeedText(`echo:${marker}`);
        const after = await visibleAnchor(browser);
        expectStableAnchor(before, after, `later page ${index + 1}`);
        expect(await pageRequestCount(browser)).toBe(requestsBefore + 1);

        const nextMarker = laterMarkers[index + 1];
        if (nextMarker) await waitForFeedText(`echo:${nextMarker}`, false);
      }

      const requestsAtLiveHead = await pageRequestCount(browser);
      await positionBeforeBoundaryEncounter(browser, "later");
      await triggerBoundary(browser, "later");
      await waitForFeedText(firstMarker, false);
      expect(await pageRequestCount(browser)).toBe(requestsAtLiveHead);

      await positionBeforeBoundaryEncounter(browser, "earlier");
      const beforeReveal = await visibleAnchor(browser);
      const requestsBeforeReveal = await pageRequestCount(browser);
      await triggerBoundary(browser, "earlier");
      await waitForFeedText(turnMarkers[1]!);
      const afterReveal = await anchorById(browser, beforeReveal.rowId);
      expectStableAnchor(
        beforeReveal,
        afterReveal,
        "earlier retained-row reveal",
      );
      expect(await pageRequestCount(browser)).toBe(requestsBeforeReveal);
      await waitForFeedText(firstMarker, false);

      await positionBeforeBoundaryEncounter(browser, "earlier");
      const beforeEarlierPage = await visibleAnchor(browser);
      const requestsBeforeEarlierPage = await pageRequestCount(browser);
      await setPageRequestGate(browser, true);
      await triggerBoundary(browser, "earlier");
      await waitForFeedText("Loading earlier messages...");
      const loadingEarlier = await boundarySnapshot(browser, "earlier");
      expect(loadingEarlier.busy).toBe(true);
      expect(loadingEarlier.precedesTranscript).toBe(true);
      expect(loadingEarlier.text).toContain("Loading earlier messages...");
      await releasePageRequest(browser);
      await waitForFeedText(firstMarker);
      const afterEarlierPage = await anchorById(
        browser,
        beforeEarlierPage.rowId,
      );
      expectStableAnchor(
        beforeEarlierPage,
        afterEarlierPage,
        "earlier network page",
      );
      expect(await pageRequestCount(browser)).toBe(
        requestsBeforeEarlierPage + 1,
      );
      expect(await app.hasButton("Load more")).toBe(false);

      const submittedPrompt = "submit-from-detached-transcript";
      const submittedRequest =
        fixture.integration.fakeProviders.openAi.waitForRequest(
          { lastUserText: submittedPrompt },
          { timeoutMs: 20_000 },
        );
      await app.fill("[data-composer] textarea", submittedPrompt);
      await app.clickButton("Send message");
      await submittedRequest;
      await waitForFeedText(submittedPrompt);
      await waitForFeedText(`echo:${submittedPrompt}`);
      await app.waitForChatProcessing(false);
      expect(await app.hasButton("Load later messages")).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });

  test("fills one short historical window without draining the remaining feed", async () => {
    await withE2eFixture("transcript-historical-underfill", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const turnMarkers = Array.from(
        { length: 61 },
        (_, index) =>
          `underfill-history-turn-${String(index).padStart(3, "0")}`,
      );
      await fixture.page.setViewport({ width: 1_280, height: 800 });
      const chatId = await seedDirectChat(fixture, app, turnMarkers);

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      const browser = pageSession(fixture.page);
      await app.waitForText(`echo:${turnMarkers.at(-1)}`);
      await installTranscriptGeometry(browser, 48);
      await installPageRequestGate(browser);
      await prepareInitialWindowNavigation(fixture.page, browser);
      await setTranscriptRowHeight(browser, 6);
      await resetPageRequestCount(browser);
      await clickInitialWindow(browser);
      await fixture.page.waitForFunction(
        (expected) =>
          document
            .querySelector<HTMLElement>(
              '[role="log"][aria-label="Chat messages"]',
            )
            ?.innerText.includes(expected) ?? false,
        { timeout: 20_000 },
        `echo:${turnMarkers[40]}`,
      );

      const snapshot = await evaluateInPage<{
        anchorCount: number;
        clientHeight: number;
        hasFirst: boolean;
        hasUnrequestedPage: boolean;
        scrollHeight: number;
      }>(
        browser,
        `(() => {
					const feed = document.querySelector(${JSON.stringify(FEED_SELECTOR)});
					if (!feed) throw new Error('Transcript feed not found');
					return {
						anchorCount: feed.querySelectorAll('[data-chat-anchor-id]').length,
						clientHeight: feed.clientHeight,
						hasFirst: feed.innerText.includes(${JSON.stringify(turnMarkers[0])}),
						hasUnrequestedPage: feed.innerText.includes(${JSON.stringify(turnMarkers[50])}),
						scrollHeight: feed.scrollHeight,
					};
				})()`,
      );
      expect(snapshot.anchorCount).toBe(100);
      expect(snapshot.hasFirst).toBe(true);
      expect(snapshot.hasUnrequestedPage).toBe(false);
      expect(snapshot.scrollHeight).toBeGreaterThan(snapshot.clientHeight);
      expect(await pageRequestCount(browser)).toBe(2);
      const boundary = await boundarySnapshot(browser, "later");
      expect(boundary.busy).toBe(false);
      expect(boundary.precedesTranscript).toBe(false);
      expect(boundary.text).toContain("Load later messages");
      const firstAnchor = await visibleAnchor(browser);
      expect(firstAnchor.rowId.endsWith(":1")).toBe(true);
      expect(firstAnchor.offset).toBe(0);
      expect(await app.hasButton("Load more")).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });

  test("keeps a new prompt visible without an ambiguous history action", async () => {
    await withE2eFixture("transcript-underfill", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const prompt = "underfilled-transcript-recent-prompt";

      await fixture.page.setViewport({ width: 1_280, height: 2_000 });
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat(prompt);
      await app.waitForText(prompt);
      await app.waitForText(`echo:${prompt}`);
      expect(await app.hasButton("Load more")).toBe(false);
      expect(await app.hasButton("Load earlier messages")).toBe(false);
      expect(await app.hasButton("Load later messages")).toBe(false);
      fixture.assertNoBrowserErrors();
    });
  });
});
