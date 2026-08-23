import { describe, expect, test } from "bun:test";
import type {
  SnippetsMutationResponse,
  SnippetsSnapshot,
} from "../../../common/snippets.js";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

const NEW_CHAT_COMPOSER =
  '[role="dialog"] textarea[placeholder="How can I help you today?"]';

describe("Lightpanda new-chat snippet expansion", () => {
  test("uses one chat ID through expansion, navigation, and server creation", async () => {
    await withE2eFixture("snippet-new-chat-id", async (fixture) => {
      const snapshot =
        await fixture.integration.client.get<SnippetsSnapshot>(
          "/api/v1/snippets",
        );
      await fixture.integration.client.post<SnippetsMutationResponse>(
        "/api/v1/snippets",
        {
          expectedRevision: snapshot.revision,
          snippet: {
            shortName: "handoff",
            template: "Continue chat {{chat_id}}",
            defaultArguments: "",
          },
        },
      );

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.clickButton("New Chat");
      await fixture.page.waitForFunction(
        () => {
          const dialog = document.querySelector('[role="dialog"]');
          return (
            dialog !== null &&
            dialog.querySelector(
              '[role="status"][aria-label="Loading chat defaults..."]',
            ) === null
          );
        },
        { timeout: 20_000 },
      );

      const directProviderSelected = await fixture.page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return [...(dialog?.querySelectorAll("button") ?? [])].some(
          (element) => {
            const name =
              element.getAttribute("aria-label") ||
              element.textContent?.trim() ||
              "";
            return (
              name.includes("Direct (Chat Completions)") &&
              name.includes("Integration Echo")
            );
          },
        );
      });
      if (!directProviderSelected) {
        await fixture.page.evaluate(() => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
          const button = dialog
            ? [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
                (element) =>
                  (element.getAttribute("aria-label") ?? "").includes(" / "),
              )
            : null;
          if (!button || button.disabled)
            throw new Error("Missing new chat model selector.");
          button.click();
        });
        await app.waitForButton("Chat Completions", { timeout: 30_000 });
        await app.clickButton("Chat Completions");
        await app.waitForButton("Integration Echo", { timeout: 30_000 });
        await app.clickButton("Integration Echo");
      }

      await app.fill(
        '[role="dialog"] input[aria-label="Project Path"]',
        fixture.integration.dirs.project,
      );
      await app.fill(NEW_CHAT_COMPOSER, "/s handoff");
      await app.waitForDialogButtonEnabled("Start session");
      await app.clickButton("Start session");
      await fixture.page.waitForFunction(
        (selector) =>
          /^Continue chat \d{16}$/.test(
            document.querySelector<HTMLTextAreaElement>(selector)?.value ?? "",
          ),
        { timeout: 20_000 },
        NEW_CHAT_COMPOSER,
      );

      const expandedPrompt = await fixture.page.$eval(
        NEW_CHAT_COMPOSER,
        (element) => (element as HTMLTextAreaElement).value,
      );
      const chatId = expandedPrompt.replace("Continue chat ", "");
      expect(
        (await fixture.integration.client.listChats()).sessions,
      ).not.toContainEqual(expect.objectContaining({ id: chatId }));

      const requestPromise =
        fixture.integration.fakeProviders.openAi.waitForRequest(
          { lastUserText: expandedPrompt },
          { timeoutMs: 20_000 },
        );
      await app.waitForDialogButtonEnabled("Start session");
      await app.clickButton("Start session");
      await requestPromise;
      await fixture.page.waitForFunction(
        (expectedChatId) =>
          window.location.pathname ===
          `/chat/${encodeURIComponent(expectedChatId)}`,
        { timeout: 20_000 },
        chatId,
      );

      const navigatedChatId = decodeURIComponent(
        new URL(fixture.page.url()).pathname.slice(6),
      );
      expect(navigatedChatId).toBe(chatId);
      expect(
        (await fixture.integration.client.listChats()).sessions,
      ).toContainEqual(expect.objectContaining({ id: chatId }));
      fixture.assertNoBrowserErrors();
    });
  });
});
