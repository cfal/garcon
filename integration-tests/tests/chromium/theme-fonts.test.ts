import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect as browserExpect } from "playwright/test";
import type { Page } from "playwright";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { clickWorkspaceWindowAddAction } from "../../support/chromium-workspace.js";
import type { FontPreference } from "../../../web/src/lib/theme/fonts.js";

async function setFont(
  page: Page,
  key: "interfaceFont" | "monospaceFont",
  value: FontPreference,
) {
  await page.evaluate(
    ({ key, value }) => {
      const storageKey = "pref_local_settings";
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      localStorage.setItem(
        storageKey,
        JSON.stringify({ ...settings, [key]: value }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: storageKey,
          storageArea: localStorage,
        }),
      );
    },
    { key, value },
  );
  await browserExpect(page.locator("html")).toHaveAttribute(
    key === "interfaceFont" ? "data-interface-font" : "data-monospace-font",
    value,
  );
  await page.evaluate(() => document.fonts.ready);
}

test("independent fonts preserve an edited file and undo history", async () => {
  await withChromiumFixture(
    "retained editor typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const filename = "typography.txt";
      await writeFile(
        join(integration.dirs.project, filename),
        "Synthetic retained document\n",
      );
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic typography fixture",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page
        .locator("[data-file-tree-entry-text]")
        .filter({ hasText: filename })
        .click();
      const editor = page.locator(".cm-editor");
      const content = editor.locator(".cm-content");
      await browserExpect(content).toBeVisible();
      await editor.evaluate((element) =>
        element.setAttribute("data-retained-font-editor", "true"),
      );
      const originalFont = await content.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      await content.press("Control+Home");
      await page.keyboard.insertText("Unsaved ");
      await content.press("Shift+ArrowLeft");
      const selection = await page.evaluate(() =>
        window.getSelection()?.toString(),
      );
      await setFont(page, "interfaceFont", "departure-mono");
      expect(
        await content.evaluate(
          (element) => getComputedStyle(element).fontFamily,
        ),
      ).toBe(originalFont);
      await setFont(page, "monospaceFont", "departure-mono");
      await browserExpect
        .poll(() =>
          content.evaluate((element) => getComputedStyle(element).fontFamily),
        )
        .toContain("Departure Mono");
      await browserExpect(editor).toHaveAttribute(
        "data-retained-font-editor",
        "true",
      );
      await browserExpect(content).toContainText(
        "Unsaved Synthetic retained document",
      );
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
        selection,
      );
      await setFont(page, "interfaceFont", "default");
      expect(
        await page.evaluate(() => getComputedStyle(document.body).fontFamily),
      ).not.toContain("Departure Mono");
      await browserExpect
        .poll(() =>
          content.evaluate((element) => getComputedStyle(element).fontFamily),
        )
        .toContain("Departure Mono");
      await content.press("Control+z");
      await browserExpect(content).toHaveText("Synthetic retained document");
      await setFont(page, "monospaceFont", "default");
      await browserExpect(content).toHaveCSS("font-family", originalFont);
      await browserExpect(editor).toHaveAttribute(
        "data-retained-font-editor",
        "true",
      );
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test("terminal fonts update without clearing output or replacing the shell", async () => {
  await withChromiumFixture(
    "retained terminal typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await page.goto(integration.garcon.baseUrl);
      await clickWorkspaceWindowAddAction(page, "New Terminal");
      const terminal = page.locator(".xterm");
      const input = terminal.locator(".xterm-helper-textarea");
      await browserExpect(terminal).toBeVisible();
      await terminal.evaluate((element) =>
        element.setAttribute("data-retained-font-terminal", "true"),
      );
      await input.focus();
      await page.keyboard.type(
        'export FONT_TEST_VALUE=retained; printf "font-output-ready\\n"',
      );
      await page.keyboard.press("Enter");
      await browserExpect(terminal.locator(".xterm-screen")).toContainText(
        "font-output-ready",
      );
      const rows = terminal.locator(".xterm-rows");
      const originalFont = await rows.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      await setFont(page, "interfaceFont", "departure-mono");
      await browserExpect(rows).toHaveCSS("font-family", originalFont);
      await setFont(page, "monospaceFont", "departure-mono");
      await browserExpect
        .poll(() =>
          rows.evaluate((element) => getComputedStyle(element).fontFamily),
        )
        .toContain("Departure Mono");
      await browserExpect(terminal).toHaveAttribute(
        "data-retained-font-terminal",
        "true",
      );
      await browserExpect(terminal.locator(".xterm-screen")).toContainText(
        "font-output-ready",
      );
      await input.focus();
      await page.keyboard.type('printf "shell-%s\\n" "$FONT_TEST_VALUE"');
      await page.keyboard.press("Enter");
      await browserExpect(terminal.locator(".xterm-screen")).toContainText(
        "shell-retained",
      );
      await setFont(page, "monospaceFont", "default");
      await browserExpect(rows).toHaveCSS("font-family", originalFont);
      await browserExpect(terminal).toHaveAttribute(
        "data-retained-font-terminal",
        "true",
      );
      assertNoBrowserErrors();
    },
    undefined,
    { serverEnvironment: { GARCON_TERMINAL_SHELL: "/bin/sh" } },
  );
}, 60_000);
