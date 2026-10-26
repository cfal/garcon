import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect as browserExpect } from "playwright/test";
import type { Locator } from "playwright";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  clickWorkspaceWindowAddAction,
  collapseCanonicalFilesWindow,
} from "../../support/chromium-workspace.js";
import { initializeFixtureRepository } from "../../support/git-fixture.js";
import {
  expectFontSizeMenuFits,
  setTypography,
} from "../../support/typography.js";
import { TYPOGRAPHY_SURFACES } from "../../../web/src/lib/theme/typography.js";
import type { CanvasContent } from "../../../common/chat-canvas.js";

async function measureSelects(container: Locator) {
  return container.evaluate((element) => {
    const canvas = document.createElement("canvas").getContext("2d")!;
    return [...element.querySelectorAll("select")].map((select) => {
      const css = getComputedStyle(select);
      canvas.font = `${css.fontSize} ${css.fontFamily}`;
      return {
        label: select.getAttribute("aria-label") ?? select.id,
        fontSize: parseFloat(css.fontSize),
        textWidth: canvas.measureText(select.selectedOptions[0].text).width,
        available:
          select.clientWidth -
          parseFloat(css.paddingLeft) -
          parseFloat(css.paddingRight),
      };
    });
  });
}

test("conflict diffs preserve their default and apply independent sizes with a touch floor", async () => {
  const bundle = await buildWebBrowserEntry(
    "src/lib/theme/__tests__/editor-font-fixture.ts",
  );
  await withChromiumFixture(
    "conflict-typography",
    async ({ page, context, integration }) => {
      await page.goto(integration.garcon.baseUrl);
      await page.evaluate(() => {
        const host = document.createElement("div");
        host.id = "conflict-typography-fixture";
        document.body.append(host);
      });
      await page.addScriptTag({
        type: "module",
        content: `${bundle}\nmountConflictEditor(document.querySelector('#conflict-typography-fixture'));`,
      });
      const content = page
        .locator("#conflict-typography-fixture .cm-content")
        .first();
      await browserExpect(content).toHaveCSS("font-size", "13px");
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "20",
      });
      await browserExpect(content).toHaveCSS("font-size", "13px");
      await browserExpect(content).not.toHaveCSS(
        "font-family",
        /Departure Mono/,
      );
      await setTypography(page, {
        codeDiffFont: "departure-mono",
        gitDiffFontSize: "20",
      });
      await browserExpect(content).toHaveCSS("font-size", "20px");
      await browserExpect(content).toHaveCSS("font-family", /Departure Mono/);
      await setTypography(page, { gitDiffFontSize: "10" });
      await browserExpect(content).toHaveCSS("font-size", "10px");
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      await browserExpect(content).toHaveCSS("font-size", "16px");
      await cdp.detach();
    },
  );
}, 180_000);

test("canvas previews stay outside Chat List typography and preserve wheel panning", async () => {
  await withChromiumFixture(
    "canvas-typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
        content: "Synthetic canvas preview",
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      const content: CanvasContent = {
        title: "Typography canvas",
        nodes: [
          {
            id: "card",
            type: "chat",
            chatId,
            boxId: null,
            position: { x: 100, y: 100 },
          },
        ],
        connections: [],
      };
      await integration.client.post("/api/v1/chat-canvases", {
        id: "typography",
        content,
      });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Canvas");
      const card = page.locator("[data-canvas-chat-card]");
      const title = card.locator('[data-slot="chat-summary-header"]');
      await browserExpect(title).toBeVisible();
      const baseline = await title.evaluate((element) => ({
        font: getComputedStyle(element).fontFamily,
        size: getComputedStyle(element).fontSize,
      }));
      await setTypography(page, {
        chatListFont: "departure-mono",
        chatListFontSize: "20",
      });
      await browserExpect(title).toHaveCSS("font-family", baseline.font);
      await browserExpect(title).toHaveCSS("font-size", baseline.size);
      const viewport = page.locator(".svelte-flow__viewport");
      const before = await viewport.evaluate(
        (element) => getComputedStyle(element).transform,
      );
      await card.hover();
      await page.mouse.wheel(0, 40);
      await browserExpect
        .poll(() =>
          viewport.evaluate((element) => getComputedStyle(element).transform),
        )
        .not.toBe(before);
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("chat list, prose, inline code, blocks and Git diffs have independent typography", async () => {
  await withChromiumFixture(
    "scoped-typography",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await initializeFixtureRepository(integration.dirs.project);
      await writeFile(
        join(integration.dirs.project, "example.txt"),
        "changed\n",
      );
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
        content:
          "Synthetic prose with `inline_code`.\n\n```text\nstandalone_code\n```\n\n| Column |\n| --- |\n| Value |",
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const paragraph = page
        .locator("[data-chat-feed-content] .markdown-body > div")
        .filter({ hasText: /^Synthetic prose/ })
        .first();
      const inline = paragraph.locator("code");
      const block = page
        .locator("[data-chat-feed-content] .markdown-code-block pre")
        .filter({ hasText: "standalone_code" })
        .first();
      const codeHeader = page
        .locator("[data-chat-feed-content] .markdown-code-block > div")
        .first();
      const title = page.locator(
        `[data-sidebar-virtual-row="${chatId}"] [data-slot="chat-summary-header"]`,
      );
      const newChat = page
        .getByRole("button", { name: "New Chat", exact: true })
        .first();
      const composer = page
        .locator("[data-conversation-composer-host] textarea")
        .first();
      await browserExpect(paragraph).toBeVisible();
      await browserExpect(paragraph).toHaveCSS("font-size", "14px");
      await browserExpect(inline).toHaveCSS("font-size", "12.6px");
      await browserExpect(block).toHaveCSS("font-size", "12px");
      const tableHeader = page
        .locator("[data-chat-feed-content] .markdown-body th")
        .first();
      await browserExpect(tableHeader).toHaveCSS("font-size", "14px");
      const initial = await newChat.evaluate((element) => ({
        font: getComputedStyle(element).fontFamily,
        size: getComputedStyle(element).fontSize,
      }));
      const composerFont = await composer.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      const headerFont = await codeHeader.evaluate(
        (element) => getComputedStyle(element).fontFamily,
      );
      await setTypography(page, {
        chatListFont: "departure-mono",
        chatListFontSize: "20",
      });
      await browserExpect(title).toHaveCSS("font-size", "20px");
      await browserExpect(title).toHaveCSS("font-family", /Departure Mono/);
      const summaryFits = await title.evaluate((element) => {
        const summary = element.closest('[data-slot="sidebar-chat-summary"]')!;
        const row = summary.closest("[data-sidebar-virtual-row]")!;
        return (
          summary.getBoundingClientRect().bottom <=
          row.getBoundingClientRect().bottom + 1
        );
      });
      expect(summaryFits).toBe(true);
      await browserExpect(newChat).toHaveCSS("font-family", initial.font);
      await browserExpect(newChat).toHaveCSS("font-size", initial.size);
      await browserExpect(paragraph).toHaveCSS("font-size", "14px");
      await setTypography(page, {
        chatFeedFont: "departure-mono",
        chatFeedFontSize: "20",
      });
      await browserExpect(paragraph).toHaveCSS("font-size", "20px");
      await browserExpect(paragraph).toHaveCSS("font-family", /Departure Mono/);
      await browserExpect(inline).toHaveCSS("font-size", "18px");
      await browserExpect(tableHeader).toHaveCSS("font-size", "20px");
      await browserExpect(block).toHaveCSS("font-size", "12px");
      await browserExpect(composer).toHaveCSS("font-family", composerFont);
      await browserExpect(codeHeader).toHaveCSS("font-family", headerFont);
      await setTypography(page, {
        chatCodeFont: "departure-mono",
        chatCodeFontSize: "18",
      });
      await browserExpect(block).toHaveCSS("font-size", "18px");
      await browserExpect(block).toHaveCSS("font-family", /Departure Mono/);
      await browserExpect(block.locator("code")).toHaveCSS(
        "font-family",
        /Departure Mono/,
      );
      await browserExpect(inline).toHaveCSS("font-family", /Departure Mono/);
      await browserExpect(inline).toHaveCSS("font-size", "18px");
      await setTypography(page, {
        chatFeedFont: "default",
        chatFeedFontSize: "default",
      });
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "18",
      });
      await browserExpect(newChat).toHaveCSS("font-size", "18px");
      await browserExpect(paragraph).toHaveCSS("font-size", "14px");
      await browserExpect(paragraph).not.toHaveCSS(
        "font-family",
        /Departure Mono/,
      );
      await browserExpect(title).toHaveCSS("font-size", "20px");
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Git Workbench");
      const diff = page
        .locator(
          '[data-workspace-surface-id="singleton:git"] [data-git-diff-review-row]',
        )
        .first();
      await browserExpect(diff).toBeVisible();
      await browserExpect(diff).toHaveCSS("font-size", "12px");
      await setTypography(page, {
        codeDiffFont: "departure-mono",
        gitDiffFontSize: "20",
      });
      await browserExpect(diff).toHaveCSS("font-size", "20px");
      await browserExpect(diff).toHaveCSS("font-family", /Departure Mono/);
      const gitSurface = page.locator(
        '[data-workspace-surface-id="singleton:git"]',
      );
      const hunk = gitSurface
        .locator("[data-git-diff-content-row] span.typography-code-diff")
        .first();
      for (const mode of ["Unified", "Split"]) {
        await gitSurface
          .getByRole("button", { name: "More Git actions", exact: true })
          .click();
        await page
          .getByRole("menuitem")
          .filter({ hasText: "Diff mode" })
          .hover();
        await page
          .getByRole("menuitemradio", { name: mode, exact: true })
          .click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        for (const font of ["default", "departure-mono"] as const) {
          for (const size of ["default", "20"] as const) {
            await setTypography(page, {
              codeDiffFont: font,
              gitDiffFontSize: size,
              interfaceFontSize: size === "default" ? "10" : "20",
            });
            const lineHeight = size === "default" ? 18 : 30;
            await browserExpect(diff).toHaveCSS(
              "line-height",
              `${lineHeight}px`,
            );
            await browserExpect(hunk).toHaveCSS(
              "line-height",
              `${lineHeight}px`,
            );
            await browserExpect(hunk).toHaveCSS(
              "font-size",
              size === "default" ? "10px" : "16px",
            );
            await browserExpect
              .poll(() =>
                diff.evaluate(
                  (element) => element.getBoundingClientRect().height,
                ),
              )
              .toBe(lineHeight);
            await browserExpect
              .poll(() =>
                hunk.evaluate(
                  (element) =>
                    element.parentElement!.getBoundingClientRect().height,
                ),
              )
              .toBe(lineHeight + 12);
          }
        }
      }
      await setTypography(page, {
        chatCodeFont: "default",
        chatCodeFontSize: "10",
      });
      await browserExpect(diff).toHaveCSS("font-size", "20px");
      await browserExpect(diff).toHaveCSS("font-family", /Departure Mono/);
      await setTypography(page, {
        interfaceFont: "departure-mono",
        interfaceFontSize: "20",
      });
      for (const width of [1440, 641, 640, 560, 481, 480, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await gitSurface
          .getByRole("button", { name: "More Git actions", exact: true })
          .click();
        await expectFontSizeMenuFits(page, "11-13px (Default)");
      }
      assertNoBrowserErrors();
    },
  );
}, 180_000);

test("all typography controls fit at maximum size on desktop and touch screens", async () => {
  await withChromiumFixture(
    "typography-settings-fit",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      await page.goto(integration.garcon.baseUrl);
      await page
        .getByRole("button", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await browserExpect(
        dialog.getByRole("tab", { name: "Appearance", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await setTypography(
        page,
        Object.fromEntries(
          TYPOGRAPHY_SURFACES.flatMap(({ fontKey, sizeKey }) => [
            [fontKey, "departure-mono"],
            [sizeKey, "20"],
          ]),
        ),
      );
      const artifacts = join(import.meta.dirname, "../../artifacts/chromium");
      await mkdir(artifacts, { recursive: true });
      const cdp = await context.newCDPSession(page);
      for (const width of [1440, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await cdp.send("Emulation.setTouchEmulationEnabled", {
          enabled: width < 640,
        });
        const typography = dialog.locator(
          'section[aria-labelledby="typography-heading"]',
        );
        await typography.scrollIntoViewIfNeeded();
        await browserExpect(typography.getByRole("button")).toHaveCount(9);
        for (const button of await typography.getByRole("button").all()) {
          expect(
            await button.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
        }
        expect(
          await dialog.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(artifacts, `typography-settings-${width}.png`),
        });
        await typography
          .getByRole("button", {
            name: /^Expanded Text Editors Font:/,
          })
          .click();
        const picker = page.getByRole("dialog", {
          name: "Expanded Text Editors Font",
          exact: true,
        });
        await picker.getByRole("radio", { name: /\(Default\)/ }).check();
        await picker.getByRole("combobox").selectOption("default");
        await page.evaluate(() => document.fonts.ready);
        const fit = await measureSelects(picker);
        expect(fit).toHaveLength(1);
        for (const label of await picker.locator("fieldset label").all()) {
          expect(
            await label.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          ).toBe(true);
        }
        for (const control of fit) {
          expect(
            control.textWidth,
            `${width}: ${JSON.stringify(control)}`,
          ).toBeLessThanOrEqual(control.available + 1);
          if (width < 640) expect(control.fontSize).toBeGreaterThanOrEqual(16);
        }
        expect(
          await picker.evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        ).toBe(true);
        await page.screenshot({
          path: join(artifacts, `font-dialog-${width}.png`),
        });
        await picker.getByRole("button", { name: "Cancel" }).click();
        await dialog
          .getByRole("tab", { name: "Behavior", exact: true })
          .click();
        const behaviorFit = await measureSelects(dialog);
        expect(behaviorFit.length).toBeGreaterThanOrEqual(5);
        for (const control of behaviorFit)
          expect(
            control.textWidth,
            `${width}: ${JSON.stringify(control)}`,
          ).toBeLessThanOrEqual(control.available + 1);
        await page.screenshot({
          path: join(artifacts, `behavior-settings-${width}.png`),
        });
        await dialog
          .getByRole("tab", { name: "Appearance", exact: true })
          .click();
      }
      await cdp.detach();
      assertNoBrowserErrors();
    },
  );
}, 180_000);
