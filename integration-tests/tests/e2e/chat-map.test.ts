import { describe, expect, test } from "bun:test";
import type { ChatSessionDeletedWsMessage } from "../../../common/ws-events.js";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

describe("Lightpanda Chat Map", () => {
  test("maps fork lineage, navigates chats, and preserves missing parents on mobile", async () => {
    await withE2eFixture("chat-map-lineage", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat("chat-map-source");
      await app.waitForText("echo:chat-map-source");

      const source = (
        await fixture.integration.client.listChats()
      ).sessions.find(
        (entry) => entry.preview.firstMessage === "chat-map-source",
      );
      if (!source) throw new Error("Chat Map source chat was not listed.");

      await app.clickButton("Chat actions");
      await app.waitForMenuItemEnabled("Fork");
      await app.clickMenuItem("Fork");
      const forkId = await app.waitForSelectedChatChange(source.id);
      const fork = (await fixture.integration.client.listChats()).sessions.find(
        (entry) => entry.id === forkId,
      );
      expect(fork?.parentChat).toMatchObject({
        chatId: source.id,
        relation: "fork",
      });

      await app.selectWorkspaceWindowSurface("Open chat map");
      await fixture.page.waitForSelector("[data-chat-map-panel]");
      const initialMap = await fixture.page.evaluate(
        ({ sourceId, childId }) => {
          const sourceLink = document.querySelector<HTMLAnchorElement>(
            `[data-chat-map-chat-id="${sourceId}"]`,
          );
          const childLink = document.querySelector<HTMLAnchorElement>(
            `[data-chat-map-chat-id="${childId}"]`,
          );
          const sourceNode = sourceLink?.closest<HTMLElement>(
            "[data-chat-map-node]",
          );
          const childNode = childLink?.closest<HTMLElement>(
            "[data-chat-map-node]",
          );
          return {
            sourceHref: sourceLink?.getAttribute("href") ?? null,
            childHref: childLink?.getAttribute("href") ?? null,
            childParentKey:
              childNode?.parentElement?.closest<HTMLElement>(
                "[data-chat-map-node]",
              )?.dataset.chatMapNode ?? null,
            childText: childNode?.textContent ?? "",
            sourceKey: sourceNode?.dataset.chatMapNode ?? null,
          };
        },
        { sourceId: source.id, childId: forkId },
      );
      expect(initialMap).toMatchObject({
        sourceHref: `/chat/${source.id}`,
        childHref: `/chat/${forkId}`,
        sourceKey: `chat:${source.id}`,
        childParentKey: `chat:${source.id}`,
      });
      expect(initialMap.childText).toContain("Fork");

      await fixture.page.evaluate((chatId) => {
        const link = document.querySelector<HTMLAnchorElement>(
          `[data-chat-map-chat-id="${chatId}"]`,
        );
        if (!link) throw new Error(`Missing Chat Map link for ${chatId}`);
        link.click();
      }, source.id);
      await app.waitForSelectedChat(source.id);

      await app.selectWorkspaceWindowSurface("Chat Map");
      await fixture.page.waitForSelector("[data-chat-map-panel]");
      const deleteCursor = fixture.integration.client.markEvents();
      await fixture.integration.client.deleteChat(source.id);
      await fixture.integration.client.waitForEvent(
        (event): event is ChatSessionDeletedWsMessage =>
          event.type === "chat-session-deleted" && event.chatId === source.id,
        "Chat Map parent deletion",
        { afterIndex: deleteCursor },
      );
      await fixture.page.waitForFunction(
        ({ parentId, childId }) => {
          const missing = document.querySelector<HTMLElement>(
            `[data-chat-map-missing-parent="${parentId}"]`,
          );
          const missingNode = missing?.closest<HTMLElement>(
            "[data-chat-map-node]",
          );
          const childNode = document
            .querySelector(`[data-chat-map-chat-id="${childId}"]`)
            ?.closest<HTMLElement>("[data-chat-map-node]");
          return (
            missingNode !== null &&
            childNode?.parentElement?.closest<HTMLElement>(
              "[data-chat-map-node]",
            ) === missingNode &&
            childNode?.textContent?.includes("Fork") === true
          );
        },
        { timeout: 20_000 },
        { parentId: source.id, childId: forkId },
      );

      await app.setViewport(390, 844);
      await fixture.page.waitForSelector(
        'nav[aria-label="Workspace navigation"]',
      );
      await fixture.page.evaluate(() => {
        const chat = [
          ...document.querySelectorAll<HTMLButtonElement>(
            'nav[aria-label="Workspace navigation"] button',
          ),
        ].find((button) => button.textContent?.trim() === "Chat");
        if (!chat) throw new Error("Missing mobile Chat destination.");
        chat.click();
      });
      await fixture.page.waitForFunction(
        () =>
          [
            ...document.querySelectorAll<HTMLButtonElement>(
              'nav[aria-label="Workspace navigation"] button',
            ),
          ].some(
            (button) =>
              button.textContent?.trim() === "Chat" &&
              button.getAttribute("aria-current") === "page",
          ),
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const map = [
          ...document.querySelectorAll<HTMLButtonElement>(
            'nav[aria-label="Workspace navigation"] button',
          ),
        ].find((button) => button.textContent?.trim() === "Map");
        if (!map) throw new Error("Missing mobile Map destination.");
        map.click();
      });
      await fixture.page.waitForFunction(
        () => {
          const currentMap = [
            ...document.querySelectorAll<HTMLButtonElement>(
              'nav[aria-label="Workspace navigation"] button',
            ),
          ].some(
            (button) =>
              button.textContent?.trim() === "Map" &&
              button.getAttribute("aria-current") === "page",
          );
          return (
            currentMap &&
            document.querySelector(
              '[data-chat-map-panel][data-presentation="mobile"]',
            ) !== null
          );
        },
        { timeout: 20_000 },
      );

      fixture.assertNoBrowserErrors();
    });
  });
});
