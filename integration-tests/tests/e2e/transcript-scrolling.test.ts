import { describe, expect, test } from "bun:test";
import type { Page } from "puppeteer-core";
import { withE2eFixture, type E2eFixture } from "../../support/e2e-fixture.js";
import type { ConfiguredDirectTestAgent } from "../../support/garcon-client.js";
import { SpaDriver } from "../../support/spa-driver.js";

const FEED_SELECTOR = "[data-chat-scroll-viewport]";
const SIZER_SELECTOR = "[data-chat-virtual-sizer]";
const ITEM_SELECTOR = "[data-chat-virtual-item]";

interface VirtualTranscriptSnapshot {
  busy: boolean;
  modelCount: number;
  mountedCount: number;
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
  await app.waitForText(`echo:${firstTurn}`);
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
  // Every turn above proved itself with a terminal, so this is only a cheap guard that the
  // seed reached the ledger. Ordinals also cover session and run-ended rows, so the
  // watermark runs ahead of the conversation rather than matching it.
  const seededTranscript = await fixture.integration.client.getMessages(chatId, {
    limit: 1,
  });
  expect(seededTranscript.lastOrdinal).toBeGreaterThanOrEqual(turns.length * 2);
  return chatId;
}

async function installPageRequestGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const gate = { armed: false, release: null as (() => void) | null, requestCount: 0 };
    Object.assign(globalThis, { __transcriptPageRequestGate: gate });
    const gatedFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(requestUrl, globalThis.location.href);
      const isPageRequest =
        url.pathname === "/api/v1/chats/messages" && url.searchParams.has("beforeOrdinal");
      if (!isPageRequest) return nativeFetch(input, init);
      gate.requestCount += 1;
      if (gate.armed) {
        gate.armed = false;
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        gate.release = null;
      }
      return nativeFetch(input, init);
    };
    globalThis.fetch = gatedFetch as typeof globalThis.fetch;
  });
}

async function setPageRequestGate(page: Page, armed: boolean): Promise<void> {
  await page.evaluate((nextArmed) => {
    const gate = (
      globalThis as typeof globalThis & {
        __transcriptPageRequestGate?: { armed: boolean };
      }
    ).__transcriptPageRequestGate;
    if (!gate) throw new Error("Transcript page request gate not installed");
    gate.armed = nextArmed;
  }, armed);
}

async function releasePageRequest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const gate = (
      globalThis as typeof globalThis & {
        __transcriptPageRequestGate?: { release: (() => void) | null };
      }
    ).__transcriptPageRequestGate;
    if (!gate?.release) throw new Error("Transcript page request is not waiting");
    gate.release();
  });
}

async function pageRequestCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __transcriptPageRequestGate?: { requestCount: number };
        }
      ).__transcriptPageRequestGate?.requestCount ?? 0,
  );
}

async function requestEarlierPageByScroll(
  page: Page,
): Promise<void> {
  const requestCountBeforeScroll = await pageRequestCount(page);
  await page.$eval(FEED_SELECTOR, (feedElement) => {
    const feed = feedElement as HTMLElement;
    // Reports keyboard intent before applying its scroll; Lightpanda clamps the
    // desired offset to its reported top edge instead of exposing native extent.
    const target = feed.clientHeight * 1.5;
    feed.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
    feed.scrollTop = target;
    feed.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForFunction(
    (previousCount) => {
      const requestCount = (
        globalThis as typeof globalThis & {
          __transcriptPageRequestGate?: { requestCount: number };
        }
      ).__transcriptPageRequestGate?.requestCount ?? 0;
      return requestCount > previousCount;
    },
    { timeout: 20_000 },
    requestCountBeforeScroll,
  );
}

async function waitForFinishedTurn(
  fixture: E2eFixture,
  chatId: string,
  turnId: string,
): Promise<void> {
  expect((await fixture.integration.client.waitForTurnTerminal(chatId, turnId)).type).toBe(
    "agent-run-finished",
  );
}

async function runDirectTurns(
  fixture: E2eFixture,
  chatId: string,
  agent: ConfiguredDirectTestAgent,
  contents: readonly string[],
): Promise<void> {
  for (const content of contents) {
    const accepted = await fixture.integration.client.runDirectChat({ chatId, content, agent });
    if (!accepted.turnId) throw new Error(`Turn ${content} was accepted without an ID`);
    await waitForFinishedTurn(fixture, chatId, accepted.turnId);
  }
}

function eraMarkers(era: string, count = 18): string[] {
  return Array.from(
    { length: count },
    (_, index) => `carryover-ui-${era}-${String(index).padStart(2, "0")}`,
  );
}

async function waitForTranscriptIdle(page: Page): Promise<void> {
  await page.waitForFunction(
    ({ selector }) =>
      document.querySelector<HTMLElement>(selector)?.getAttribute('aria-busy') === 'false',
    { timeout: 20_000 },
    { selector: FEED_SELECTOR },
  );
}

async function waitForModelCount(page: Page, minimum: number): Promise<void> {
  await page.waitForFunction(
    ({ selector, minimumCount }) =>
      Number(
        document.querySelector<HTMLElement>(selector)?.dataset.chatVirtualModelCount ?? 0,
      ) >= minimumCount,
    { timeout: 20_000 },
    { selector: SIZER_SELECTOR, minimumCount: minimum },
  );
}

async function virtualTranscriptSnapshot(page: Page): Promise<VirtualTranscriptSnapshot> {
  return page.$eval(FEED_SELECTOR, (feed, selectors) => ({
    busy: feed.getAttribute("aria-busy") === "true",
    modelCount: Number(
      feed.querySelector<HTMLElement>(selectors.sizer)?.dataset.chatVirtualModelCount ?? 0,
    ),
    mountedCount: feed.querySelectorAll(selectors.item).length,
  }), { sizer: SIZER_SELECTOR, item: ITEM_SELECTOR });
}

describe("Lightpanda transcript scrolling", () => {
  test("[TLV5-PAGE.07-LIGHTPANDA-01] pages earlier history while keeping the virtual DOM bounded", async () => {
    await withE2eFixture("transcript-scrolling", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const turns = Array.from(
        { length: 101 },
        (_, index) => `scroll-history-turn-${String(index).padStart(3, "0")}`,
      );
      await fixture.page.setViewport({ width: 1_280, height: 800 });
      const chatId = await seedDirectChat(fixture, app, turns);

      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await waitForModelCount(fixture.page, 50);
      // The initial paint gate now holds aria-busy through the staged reveal and end
      // restoration, so readiness is awaited instead of asserted immediately.
      await waitForTranscriptIdle(fixture.page);
      await installPageRequestGate(fixture.page);

      const initial = await virtualTranscriptSnapshot(fixture.page);
      expect(initial.busy).toBe(false);
      expect(initial.modelCount).toBeGreaterThanOrEqual(50);
      expect(initial.mountedCount).toBeLessThan(initial.modelCount);
      expect(initial.mountedCount).toBeLessThan(60);
      expect(await app.hasButton("Load more")).toBe(false);
      expect(await app.hasButton("Load earlier messages")).toBe(false);

      await setPageRequestGate(fixture.page, true);
      await requestEarlierPageByScroll(fixture.page);
      await fixture.page.waitForFunction(
        ({ selector }) =>
          document.querySelector<HTMLElement>(selector)?.getAttribute("aria-busy") === "true",
        { timeout: 20_000 },
        { selector: FEED_SELECTOR },
      );
      expect((await virtualTranscriptSnapshot(fixture.page)).busy).toBe(true);
      await fixture.page.waitForSelector('[data-chat-earlier-loading-indicator]');
      expect(await app.hasButton("Load earlier messages")).toBe(false);
      await releasePageRequest(fixture.page);
      await waitForModelCount(fixture.page, initial.modelCount + 50);

      const expanded = await virtualTranscriptSnapshot(fixture.page);
      expect(expanded.busy).toBe(false);
      expect(expanded.mountedCount).toBeLessThan(expanded.modelCount);
      expect(expanded.mountedCount).toBeLessThan(60);
      expect(await pageRequestCount(fixture.page)).toBeGreaterThan(0);
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

  test("loads complete repeated-handoff history across archived and native pages", async () => {
    await withE2eFixture("repeated-agent-handoff-history", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      const chatId = fixture.integration.newChatId();
      const agentA = fixture.integration.directAgents.openAi;
      const agentB = fixture.integration.directAgents.anthropic;
      const firstEra = eraMarkers("a");
      const secondEra = eraMarkers("b");
      const thirdEra = eraMarkers("a-return");
      const expectedUsers = [...firstEra, ...secondEra, ...thirdEra];
      const handoffCount = 2;
      // Each handoff contributes an agent-switch row and a carryover notice.
      const handoffRows = handoffCount * 2;

      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content: firstEra[0]!,
        projectPath: fixture.integration.dirs.project,
        agent: agentA,
      });
      await waitForFinishedTurn(fixture, chatId, started.turnId);
      await runDirectTurns(fixture, chatId, agentA, firstEra.slice(1));

      const firstHandoffResponse = fixture.integration.fakeProviders.anthropic.holdNext({
        model: agentB.provider.model,
      });
      const firstHandoff = await fixture.integration.client.handoffDirectChat({
        chatId,
        content: secondEra[0]!,
        agent: agentB,
      });
      await firstHandoffResponse.received;
      expect(firstHandoffResponse.releaseText(`echo:${secondEra[0]}`)).toBe(true);
      await waitForFinishedTurn(fixture, chatId, firstHandoff.turnId);
      await runDirectTurns(fixture, chatId, agentB, secondEra.slice(1));

      const secondHandoffResponse = fixture.integration.fakeProviders.openAi.holdNext({
        model: agentA.provider.model,
      });
      const secondHandoff = await fixture.integration.client.handoffDirectChat({
        chatId,
        content: thirdEra[0]!,
        agent: agentA,
      });
      await secondHandoffResponse.received;
      expect(secondHandoffResponse.releaseText(`echo:${thirdEra[0]}`)).toBe(true);
      await waitForFinishedTurn(fixture, chatId, secondHandoff.turnId);
      await runDirectTurns(fixture, chatId, agentA, thirdEra.slice(1));

      await fixture.integration.restartGarcon();
      await fixture.page.setViewport({ width: 1_280, height: 800 });
      await app.openChat(chatId);
      await fixture.waitForSpaWebSocket();
      await waitForModelCount(fixture.page, 50);
      await waitForTranscriptIdle(fixture.page);
      await installPageRequestGate(fixture.page);

      const initial = await virtualTranscriptSnapshot(fixture.page);
      expect(initial.modelCount).toBeGreaterThanOrEqual(50);
      await app.waitForExactTextCount(`echo:${thirdEra.at(-1)}`, 1);

      await requestEarlierPageByScroll(fixture.page);
      await waitForModelCount(fixture.page, initial.modelCount + 50);
      await waitForTranscriptIdle(fixture.page);
      await requestEarlierPageByScroll(fixture.page);
      const expectedCompleteModelCount =
        initial.modelCount - 50 + expectedUsers.length * 2 + handoffRows;
      await waitForModelCount(fixture.page, expectedCompleteModelCount);
      await waitForTranscriptIdle(fixture.page);

      const loaded = await virtualTranscriptSnapshot(fixture.page);
      expect(loaded.modelCount).toBe(expectedCompleteModelCount);
      expect(loaded.mountedCount).toBeLessThan(loaded.modelCount);
      expect(await pageRequestCount(fixture.page)).toBeGreaterThan(1);

      await app.clickButton("Window actions");
      await app.clickMenuItem("Jump to user message");
      await app.waitForText("User messages");
      const navigatorRows = await app.userMessageNavigatorRows();
      expect(navigatorRows).toEqual([...expectedUsers].reverse());
      expect(navigatorRows.some((row) => row.includes("<carried-context"))).toBe(false);

      await app.clickUserMessageNavigatorRowContaining(firstEra[0]!);
      await app.waitForTextAbsent("User messages");
      await app.waitForExactTextCount(firstEra[0]!, 1);
      await app.waitForExactTextCount(`echo:${firstEra[0]}`, 1);
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);
});
