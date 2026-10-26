import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect as browserExpect } from "playwright/test";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { clickWorkspaceWindowAddAction } from "../../support/chromium-workspace.js";
import { setTypography } from "../../support/typography.js";

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
      await setTypography(page, { interfaceFont: "departure-mono" });
      expect(
        await content.evaluate(
          (element) => getComputedStyle(element).fontFamily,
        ),
      ).toBe(originalFont);
      await setTypography(page, { codeEditorFont: "departure-mono" });
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
      await setTypography(page, { codeEditorFontSize: "18" });
      await browserExpect(content).toHaveCSS("font-size", "18px");
      await setTypography(page, { interfaceFontSize: "20" });
      await browserExpect(content).toHaveCSS("font-size", "18px");
      await setTypography(page, { interfaceFont: "default" });
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
      await setTypography(page, { codeEditorFont: "default" });
      await browserExpect(content).toHaveCSS("font-family", originalFont);
      await browserExpect(editor).toHaveAttribute(
        "data-retained-font-editor",
        "true",
      );
      assertNoBrowserErrors();
    },
  );
}, 60_000);

test("standalone Markdown keeps its own typography while Interface and chat fonts change", async () => {
  await withChromiumFixture(
    "standalone Markdown typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const filename = "typography.md";
      await writeFile(
        join(integration.dirs.project, filename),
        "Synthetic prose with `inline code`.\n\n```js\nconst example = 1;\n```\n",
      );
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic Markdown fixture",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page
        .locator("[data-file-tree-entry-text]")
        .filter({ hasText: filename })
        .click();
      const viewer = page.locator(".markdown-viewer-content");
      await browserExpect(viewer).toBeVisible();
      await viewer.evaluate((element) =>
        element.setAttribute("data-retained-viewer", "true"),
      );
      const prose = viewer.locator(".markdown-body > div").first();
      const inline = prose.locator("code");
      const block = viewer.locator("pre code");
      const fonts = await Promise.all(
        [prose, inline, block].map((locator) =>
          locator.evaluate((element) => getComputedStyle(element).fontFamily),
        ),
      );
      await setTypography(page, { interfaceFont: "departure-mono" });
      await setTypography(page, { interfaceFontSize: "20" });
      await setTypography(page, { chatFeedFont: "departure-mono" });
      await setTypography(page, { chatFeedFontSize: "18" });
      await setTypography(page, { chatCodeFont: "departure-mono" });
      await setTypography(page, { chatCodeFontSize: "20" });
      for (const [index, locator] of [prose, inline, block].entries()) {
        await browserExpect(locator).toHaveCSS("font-family", fonts[index]);
        await browserExpect(locator).toHaveCSS("font-size", "12px");
      }
      await browserExpect(viewer).toHaveAttribute(
        "data-retained-viewer",
        "true",
      );
      await browserExpect(
        viewer.locator(".markdown-code-block > div"),
      ).toHaveCSS("font-family", /Departure Mono/);
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
      await setTypography(page, { interfaceFont: "departure-mono" });
      await browserExpect(rows).toHaveCSS("font-family", originalFont);
      await setTypography(page, { terminalFont: "departure-mono" });
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
      await setTypography(page, { terminalFontSize: "18" });
      await browserExpect(rows).toHaveCSS("font-size", "18px");
      await setTypography(page, { terminalFont: "default" });
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
