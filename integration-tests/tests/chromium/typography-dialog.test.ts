import { expect, test } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  expectFontSizeMenuFits,
  setTypography,
} from "../../support/typography.js";
import { seedLocalSettings } from "../../support/local-settings-seed.js";
import {
  BashToolUseMessage,
  ToolResultMessage,
  WebSearchToolUseMessage,
} from "../../../common/chat-types.js";
import { TranscriptLedgerStore } from "../../../server/controller/ledger/store.js";

test("plain and formatted composers share Interface sizing on mouse and touch", async () => {
  await withChromiumFixture(
    "composer-typography",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic composer typography",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const cdp = await context.newCDPSession(page);
      for (const hasTouch of [false, true]) {
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: hasTouch,
        });
        await page.setViewportSize({
          width: hasTouch ? 390 : 1440,
          height: 900,
        });
        expect(
          await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
        ).toBe(hasTouch);
        for (const size of ["20", "10"] as const) {
          await setTypography(page, { interfaceFontSize: size });
          const expected = hasTouch
            ? Math.max(16, (16 * Number(size)) / 14)
            : (16 * Number(size)) / 14;
          for (const mode of ["source", "formatted"] as const) {
            await page.keyboard.press("Control+,");
            const settings = page.getByRole("dialog", {
              name: "Settings",
              exact: true,
            });
            await settings
              .getByRole("tab", { name: "Behavior", exact: true })
              .click();
            await settings
              .getByRole("combobox", { name: "Message format", exact: true })
              .selectOption(mode);
            await settings
              .getByRole("button", { name: "Close", exact: true })
              .click();
            const input =
              mode === "source"
                ? page.locator("[data-composer] textarea")
                : page.getByRole("textbox", { name: "Formatted message" });
            await browserExpect(input).toBeVisible();
            await browserExpect
              .poll(() =>
                input.evaluate((element) =>
                  parseFloat(getComputedStyle(element).fontSize),
                ),
              )
              .toBeCloseTo(expected, 3);
          }
        }
      }
      await cdp.detach();
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("proportional Interface fonts preserve monospace composer code and Vim commands", async () => {
  await withChromiumFixture(
    "interface-monospace-exceptions",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await page.addInitScript(seedLocalSettings, { codeEditorVimMode: true });
      await writeFile(
        join(integration.dirs.project, "font-command.txt"),
        "Synthetic source\n",
      );
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic font ownership fixture",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const composer = page.getByRole("textbox", { name: "Formatted message" });
      await composer.click();
      await page.keyboard.type("`example` ");
      await page
        .locator("[data-file-tree-entry-text]")
        .filter({ hasText: "font-command.txt" })
        .click();
      const editor = page.locator(".cm-editor .cm-content");
      await editor.click();
      await page.keyboard.press(":");
      const code = composer.locator("code");
      const panel = page.locator(".cm-vim-panel");
      const command = page.locator(".cm-vim-panel input");
      await browserExpect(code).toBeVisible();
      await browserExpect(command).toBeVisible();
      const defaults = await Promise.all(
        [code, panel, command].map((locator) =>
          locator.evaluate((element) => getComputedStyle(element).fontFamily),
        ),
      );
      for (const font of ["inter", "system-serif", "system-sans"] as const) {
        await setTypography(page, { interfaceFont: font });
        for (const [index, locator] of [code, panel, command].entries())
          await browserExpect(locator).toHaveCSS(
            "font-family",
            defaults[index],
          );
      }
      await setTypography(page, { interfaceFont: "jetbrains-mono" });
      for (const locator of [code, panel])
        await browserExpect(locator).toHaveCSS("font-family", /JetBrains Mono/);
      await browserExpect(command).toHaveCSS("font-family", defaults[2]);
      await page.keyboard.press("Escape");
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "20",
      });
      for (const width of [1440, 641, 640, 560, 481, 480, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page
          .getByRole("button", { name: "Editor settings", exact: true })
          .click();
        await expectFontSizeMenuFits(page, "12px (Default)");
      }
      assertNoBrowserErrors();
    },
    undefined,
    { composerInputMode: "formatted" },
  );
}, 180_000);

test("raw message dialogs follow chat typography without changing identifier fields", async () => {
  await withChromiumFixture(
    "raw-message-typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const content = "Synthetic raw message";
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId,
        content,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      for (const kind of ["selection", "details"] as const) {
        await setTypography(page, {
          interfaceFont: "default",
          interfaceFontSize: "default",
          chatFeedFont: "default",
          chatFeedFontSize: "default",
          chatCodeFont: "default",
          chatCodeFontSize: "default",
        });
        if (kind === "selection") {
          await page
            .locator("[data-chat-feed-content]")
            .getByText(content, { exact: true })
            .click({ button: "right" });
          await page
            .getByRole("menuitem", { name: "Select text", exact: true })
            .click();
        } else {
          await page
            .locator(`[data-sidebar-virtual-row="${chatId}"]`)
            .click({ button: "right" });
          await page
            .getByRole("menuitem", { name: "Details", exact: true })
            .click();
        }
        const region = page.getByRole("region", {
          name: kind === "selection" ? "Select text" : "First message",
          exact: true,
        });
        await browserExpect(region).toHaveText(content);
        const defaultSize = kind === "selection" ? "14px" : "12px";
        await browserExpect(region).toHaveCSS("font-size", defaultSize);
        await setTypography(page, {
          interfaceFont: "departure-mono",
          interfaceFontSize: "20",
        });
        await browserExpect(region).toHaveCSS("font-size", defaultSize);
        await browserExpect(region).not.toHaveCSS(
          "font-family",
          /Departure Mono/,
        );
        await setTypography(page, {
          chatFeedFont: "inter",
          chatFeedFontSize: "18",
          chatCodeFont: "jetbrains-mono",
          chatCodeFontSize: "10",
        });
        await browserExpect(region).toHaveCSS("font-size", "18px");
        await browserExpect(region).toHaveCSS("font-family", /JetBrains Mono/);
        if (kind === "details") {
          await browserExpect(
            page.getByRole("region", { name: "Chat ID", exact: true }),
          ).toHaveCSS("font-family", /Departure Mono/);
        }
        await page.keyboard.press("Escape");
      }
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("font dialog titles clear the close button at the narrowest supported width", async () => {
  await withChromiumFixture(
    "font-dialog-heading-fit",
    async ({ page, integration }) => {
      await page.goto(integration.garcon.baseUrl);
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "20",
      });
      await page.setViewportSize({ width: 320, height: 900 });
      await page.keyboard.press("Control+,");
      for (const label of [
        "Code Diffs Font",
        "Expanded Text Editors Font",
        "Chat Code & Commands Font",
      ]) {
        await page
          .getByRole("button", { name: new RegExp(`^${label}`) })
          .click();
        const picker = page.getByRole("dialog", { name: label, exact: true });
        const overlaps = await picker.evaluate((element) => {
          const close = element
            .querySelector('[data-slot="dialog-close"]')!
            .getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(
            element.querySelector('[data-slot="dialog-title"]')!,
          );
          return [...range.getClientRects()].some(
            (rect) =>
              rect.right > close.left &&
              rect.left < close.right &&
              rect.bottom > close.top &&
              rect.top < close.bottom,
          );
        });
        expect(overlaps, label).toBe(false);
        await picker
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
      }
    },
  );
}, 180_000);

test("plain output preserves its proportional default and is independent of code", async () => {
  await withChromiumFixture(
    "plain-output-typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await page.addInitScript(seedLocalSettings, {
        autoExpandTools: true,
        combineToolUseMessages: false,
      });
      const chatId = integration.newChatId();
      const turn = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic tool typography",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, turn.turnId);
      await integration.restartGarcon({
        beforeStart: async () => {
          const ledger = new TranscriptLedgerStore(
            join(integration.dirs.workspace, "transcript-ledgers"),
          );
          try {
            const view = ledger.currentView(chatId)!;
            const at = "2026-01-01T00:00:00.000Z";
            ledger.append(
              chatId,
              view.viewId,
              [
                new BashToolUseMessage(
                  at,
                  "font-command",
                  "printf 'Synthetic command'",
                ),
                new WebSearchToolUseMessage(
                  at,
                  "font-search",
                  "Synthetic search",
                ),
                new ToolResultMessage(
                  at,
                  "font-search",
                  { raw: "Synthetic tool result" },
                  false,
                ),
              ].map((message) => ({
                kind: "provider-row" as const,
                at,
                message,
                providerMeta: null,
              })),
            );
          } finally {
            ledger.close();
          }
        },
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await setTypography(page, {
        chatOutputFont: "default",
        chatOutputFontSize: "default",
      });
      const code = page
        .locator("code")
        .filter({ hasText: "printf 'Synthetic command'" });
      const output = page.getByText("Synthetic tool result", { exact: true });
      await browserExpect(code).toHaveCSS("font-size", "12px");
      await browserExpect(output).toHaveCSS("font-size", "14px");
      const original = await output.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      expect(original).not.toMatch(/monospace|Departure|JetBrains/);
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "20",
        chatCodeFont: "jetbrains-mono",
        chatCodeFontSize: "18",
      });
      await browserExpect(code).toHaveCSS("font-family", /JetBrains Mono/);
      await browserExpect(code).toHaveCSS("font-size", "18px");
      await browserExpect(output).toHaveCSS("font-family", original);
      await browserExpect(output).toHaveCSS("font-size", "14px");
      await setTypography(page, {
        chatOutputFont: "system-serif",
        chatOutputFontSize: "20",
      });
      await browserExpect(output).toHaveCSS("font-family", /ui-serif/);
      await browserExpect(output).toHaveCSS("font-size", "20px");
      await browserExpect(code).toHaveCSS("font-family", /JetBrains Mono/);
      await browserExpect(code).toHaveCSS("font-size", "18px");
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("font dialog isolates drafts, restores focus, and persists the selected bundled face", async () => {
  await withChromiumFixture(
    "typography-dialog",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await page.goto(integration.garcon.baseUrl);
      await page
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      const button = settings.getByRole("button", {
        name: /^Expanded Text Editors Font:/,
      });
      const picker = page.getByRole("dialog", {
        name: "Expanded Text Editors Font",
        exact: true,
      });
      const root = page.locator("html");
      await button.click();
      await picker.getByRole("radio", { name: "Inter", exact: true }).check();
      await picker
        .getByRole("combobox", { name: "Size (px)", exact: true })
        .selectOption("18");
      const sample = picker.locator("[data-font-preview]");
      await browserExpect(sample).toHaveCSS("font-family", /^Inter,/);
      await browserExpect(sample).toHaveCSS("font-size", "18px");
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() =>
          [...document.fonts].some(
            (face) =>
              face.family === "Inter" &&
              face.style === "normal" &&
              face.status === "loaded",
          ),
        ),
      ).toBe(true);
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font",
        "default",
      );
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font-size",
        "default",
      );
      await page.keyboard.press("Escape");
      await browserExpect(picker).toHaveCount(0);
      await browserExpect(button).toBeFocused();
      await page.keyboard.press("Enter");
      await browserExpect(
        picker.getByRole("radio", { name: /\(Default\)/ }),
      ).toBeChecked();
      await picker
        .getByRole("radio", { name: "JetBrains Mono", exact: true })
        .check();
      await picker
        .getByRole("combobox", { name: "Size (px)", exact: true })
        .selectOption("18");
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() =>
          [...document.fonts].some(
            (face) =>
              face.family === "JetBrains Mono" &&
              face.style === "normal" &&
              face.status === "loaded",
          ),
        ),
      ).toBe(true);
      await picker.getByRole("button", { name: "Apply", exact: true }).click();
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font",
        "jetbrains-mono",
      );
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font-size",
        "18",
      );
      await browserExpect(root).toHaveAttribute(
        "data-code-editor-font",
        "default",
      );
      await button.click();
      await picker.getByRole("button", { name: "Reset to default" }).click();
      await picker.getByRole("button", { name: "Cancel" }).click();
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font",
        "jetbrains-mono",
      );
      await page.reload();
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font",
        "jetbrains-mono",
      );
      await browserExpect(root).toHaveAttribute(
        "data-expanded-editor-font-size",
        "18",
      );
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("expanded editor keeps its document and undo while its typography changes independently", async () => {
  await withChromiumFixture(
    "expanded-editor-typography",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      await page.goto(integration.garcon.baseUrl);
      // Explicit defaults separate this test's live owners from legacy preference seeding.
      await setTypography(page, {
        expandedEditorFont: "default",
        expandedEditorFontSize: "default",
        chatOutputFont: "default",
        chatOutputFontSize: "default",
      });
      await page
        .getByRole("button", { name: "New Chat", exact: true })
        .first()
        .click();
      const input = page.getByPlaceholder("How can I help you today?");
      await input.fill("Synthetic expanded text");
      const inlineFamily = await input.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      await page
        .getByRole("button", { name: "Open expanded composer", exact: true })
        .click();
      const editor = page.locator("[data-prompt-editor-dialog] .cm-content");
      await browserExpect(editor).toHaveCSS("font-size", "14px");
      const initialFamily = await editor.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" retained");
      await setTypography(page, {
        codeEditorFont: "jetbrains-mono",
        codeEditorFontSize: "20",
      });
      await browserExpect(editor).toHaveCSS("font-size", "14px");
      await browserExpect(editor).toHaveCSS("font-family", initialFamily);
      const retained = await editor.elementHandle();
      await setTypography(page, {
        expandedEditorFont: "inter",
        expandedEditorFontSize: "18",
      });
      await browserExpect(editor).toHaveCSS("font-family", /^Inter,/);
      await browserExpect(editor).toHaveCSS("font-size", "18px");
      expect(
        await editor.evaluate(
          (element, previous) => element === previous,
          retained,
        ),
      ).toBe(true);
      await browserExpect(editor).toHaveText(
        "Synthetic expanded text retained",
      );
      await page.keyboard.press("Control+z");
      await browserExpect(editor).toHaveText("Synthetic expanded text");
      await setTypography(page, { expandedEditorFontSize: "10" });
      await browserExpect(editor).toHaveCSS("font-size", "10px");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await browserExpect(editor).toHaveCSS("font-size", "16px");
      await cdp.detach();
      await page
        .getByRole("button", { name: "Close expanded editor", exact: true })
        .click();
      await browserExpect(input).toHaveValue("Synthetic expanded text");
      await browserExpect(input).toHaveCSS("font-family", inlineFamily);
      assertNoBrowserErrors();
    },
  );
}, 180_000);
