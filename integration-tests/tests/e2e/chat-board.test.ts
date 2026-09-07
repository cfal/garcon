import { describe, expect, test } from "bun:test";
import type { ChatBoardCatalog } from "../../../common/chat-boards.js";
import type { ChatTagsMutationResponse } from "../../../common/chat-tag-mutations.js";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

describe("Lightpanda Chat Board", () => {
  test("creates a live board, transitions a chat, and restores the surface", async () => {
    await withE2eFixture("chat-board", async (fixture) => {
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();

      await app.selectWorkspaceWindowSurface("Open Chat Board");
      await fixture.page.waitForSelector("[data-chat-board-panel]");
      await app.waitForText("Create your first board");
      await app.clickButton("Create board");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector('[role="dialog"]')
          ?.textContent?.includes("Manage boards"),
      );
      await app.fill('[role="dialog"] input', "Delivery");
      await app.clickDialogButton("Add");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector('[role="dialog"]')
          ?.textContent?.includes("Edit columns"),
      );

      await app.clickDialogButton("Add column");
      await app.clickDialogButton("Add column");
      await fixture.page.evaluate(() => {
        const inputs = [
          ...document.querySelectorAll<HTMLInputElement>(
            '[role="dialog"] input',
          ),
        ];
        const values = ["Delivery", "Ready", "ready", "Review", "review"];
        if (inputs.length !== values.length) {
          throw new Error(
            `Expected ${values.length} board inputs, found ${inputs.length}`,
          );
        }
        inputs.forEach((input, index) => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set?.call(input, values[index]);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
      });
      await app.clickDialogButton("Save");
      await fixture.page.waitForFunction(() =>
        document
          .querySelector("[data-chat-board-column-id]")
          ?.textContent?.includes("Ready"),
      );

      const catalog = await fixture.integration.client.get<ChatBoardCatalog>(
        "/api/v1/chat-boards",
      );
      expect(catalog.boards[0]?.columns.map((column) => column.name)).toEqual([
        "Ready",
        "Review",
      ]);

      const chatId = fixture.integration.newChatId();
      const started = await fixture.integration.client.startDirectChat({
        chatId,
        content: "Synthetic Chat Board task",
        projectPath: fixture.integration.dirs.project,
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(
        chatId,
        started.turnId,
      );
      await fixture.integration.client.patch<ChatTagsMutationResponse>(
        "/api/v1/chats/tags/delta",
        { chatId, addTags: ["ready"] },
      );
      await fixture.page.waitForSelector(
        `[data-chat-board-chat-id="${chatId}"]`,
      );

      await fixture.page.evaluate((id) => {
        const card = document.querySelector<HTMLElement>(
          `[data-chat-board-chat-id="${id}"]`,
        );
        const transition = card
          ? [...card.querySelectorAll<HTMLButtonElement>("button")].find(
              (button) => button.getAttribute("aria-label") === "Transition…",
            )
          : null;
        if (!transition) throw new Error(`Missing transition action for ${id}`);
        transition.click();
      }, chatId);
      await fixture.page.waitForFunction(() =>
        document
          .querySelector('[role="dialog"]')
          ?.textContent?.includes("Transition Chat"),
      );
      await app.clickDialogButton("Apply tag changes");
      await fixture.page.waitForFunction(
        async (id) => {
          const response = await fetch("/api/v1/chats");
          const body = (await response.json()) as {
            sessions?: { id: string; tags: string[] }[];
          };
          return (
            body.sessions
              ?.find((chat) => chat.id === id)
              ?.tags.includes("review") === true
          );
        },
        { timeout: 20_000 },
        chatId,
      );

      await fixture.page.waitForFunction(
        () =>
          localStorage
            .getItem("workspace_layout_v2")
            ?.includes("chat-board") === true,
        { timeout: 20_000 },
      );
      const beforeReloadConnections =
        await fixture.spaWebSocketConnectionCount();
      await fixture.page.reload({ waitUntil: [] });
      await fixture.waitForSpaWebSocket({
        afterConnectionCount: beforeReloadConnections,
      });
      await fixture.page.waitForSelector("[data-chat-board-panel]");
      await app.waitForText("Delivery");
      await fixture.page.waitForSelector(
        `[data-chat-board-chat-id="${chatId}"]`,
      );
      fixture.assertNoBrowserErrors();
    });
  }, 60_000);
});
