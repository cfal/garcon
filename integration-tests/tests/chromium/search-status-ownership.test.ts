import { expect, test } from "bun:test";
import type { Route, WebSocketRoute } from "playwright";
import type { TranscriptSearchStatusV1 } from "../../../common/chat-search.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { Deferred, withTimeout } from "../../support/deferred.js";

test("a WebSocket search update retires the root reconnect status request", async () => {
  await withChromiumFixture(
    "search-status-ownership",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      await integration.client.updateSettings({
        features: { transcriptSearch: { enabled: true } },
      });
      const held = new Deferred<Route>();
      const socket = new Deferred<WebSocketRoute>();
      await context.route("**/api/v1/chats/search/status", async (route) => {
        if (!held.resolve(route)) await route.continue();
      });
      await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
        const server = route.connectToServer();
        server.onMessage((message) => {
          if (JSON.parse(String(message)).type !== "transcript-search-status")
            route.send(message);
        });
        socket.resolve(route);
      });
      await page.goto(integration.garcon.baseUrl);
      const request = await withTimeout(
        held.promise,
        20_000,
        () => "Missing root status request",
      );
      const olderResponse = await request.fetch();
      const connected = await withTimeout(
        socket.promise,
        20_000,
        () => "Missing browser socket",
      );
      await page
        .getByRole("button", { name: "Search chats...", exact: true })
        .click();
      const status = {
        version: 1,
        phase: "rebuilding",
        chats: { total: 9, indexed: 4, pending: 5, failed: 0, unindexed: 0 },
        queuedJobs: 5,
        resync: { completedChats: 4, totalChats: 9 },
        backlogRows: 0,
        activeChat: null,
        lastErrorCode: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies TranscriptSearchStatusV1;
      const cancelled = page.waitForEvent("requestfailed", {
        predicate: (candidate) => candidate === request.request(),
      });
      connected.send(
        JSON.stringify({ type: "transcript-search-status", status }),
      );
      await page
        .locator('[data-slot="transcript-search-status"]')
        .filter({ hasText: "Indexing 4 of 9 chats" })
        .waitFor();
      await cancelled;
      await request.fulfill({ response: olderResponse });
      expect(
        await page
          .locator('[data-slot="transcript-search-status"]')
          .innerText(),
      ).toContain("Indexing 4 of 9 chats");
      assertNoBrowserErrors();
    },
  );
}, 120_000);
