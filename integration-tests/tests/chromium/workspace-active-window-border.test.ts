import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";
import {
  collapseCanonicalFilesWindow,
  clickWorkspaceWindowAddAction,
} from "../../support/chromium-workspace.js";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes.js";
import { initializeFixtureRepository } from "../../support/git-fixture.js";

const BORDER = "[data-workspace-window-active-border]";

async function openChat({ page, integration }: ChromiumFixture): Promise<void> {
  const chatId = integration.newChatId();
  const started = await integration.client.startDirectChat({
    chatId,
    content: "active window border fixture",
    projectPath: integration.dirs.project,
    agent: integration.directAgents.openAi,
  });
  await integration.client.waitForTurnTerminal(chatId, started.turnId);
  await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
  await page.locator("[data-composer] textarea").waitFor();
}

async function toggleHighlight(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await dialog
    .getByRole("switch", { name: "Highlight active window", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

async function activateWindow(page: Page, windowId: string): Promise<void> {
  await page
    .locator(`[data-workspace-window-titlebar="${windowId}"]`)
    .click({ position: { x: 3, y: 3 } });
  await page.waitForFunction(
    (id) =>
      document
        .querySelector("[data-workspace-window-active-border]")
        ?.getAttribute("data-workspace-window-active-border") === id,
    windowId,
  );
}

async function captureScreenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.GARCON_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
}

async function measureWorkspaceGeometry(page: Page) {
  return page
    .locator(
      "[data-workspace-window-id], [data-workspace-window-content], [data-composer]",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
}

test("the default active-window border preserves geometry, respects opt-out, and only appears with multiple visible windows", async () => {
  await withChromiumFixture(
    "workspace-active-border-preference",
    async (fixture) => {
      const { page } = fixture;
      const activeBorder = page.locator(BORDER);
      await openChat(fixture);
      await activeBorder.waitFor();
      expect(await activeBorder.count()).toBe(1);
      const before = await measureWorkspaceGeometry(page);
      await captureScreenshot(page, "active-window-desktop");

      await toggleHighlight(page);
      expect(await activeBorder.count()).toBe(0);
      expect(await measureWorkspaceGeometry(page)).toEqual(before);
      await page.reload();
      await page.locator("[data-composer] textarea").waitFor();
      expect(await activeBorder.count()).toBe(0);
      await toggleHighlight(page);
      await activeBorder.waitFor();
      expect(await measureWorkspaceGeometry(page)).toEqual(before);
      await page.reload();
      await activeBorder.waitFor();
      expect(
        await activeBorder.getAttribute("data-workspace-window-active-border"),
      ).toBe("window-main");

      await page
        .locator('[data-workspace-window-fullscreen="window-main"]')
        .click();
      await activeBorder.waitFor({ state: "detached" });
      await page
        .locator('[data-workspace-window-fullscreen="window-main"]')
        .click();
      await activeBorder.waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await activeBorder.waitFor({ state: "detached" });
      await captureScreenshot(page, "active-window-mobile");
      await page.setViewportSize({ width: 1440, height: 900 });
      await activeBorder.waitFor();
      await collapseCanonicalFilesWindow(page);
      await activeBorder.waitFor({ state: "detached" });
      expect(
        await page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("pref_local_settings")!)
              .highlightActiveWindow,
        ),
      ).toBe(true);
      fixture.assertNoBrowserErrors();
    },
  );
});

async function expectSingleStroke(
  page: Page,
  x: number,
  y: number,
  axis: "x" | "y",
): Promise<void> {
  const clip = { x: Math.round(x), y: Math.round(y), width: 1, height: 1 };
  if (axis === "x") {
    clip.x -= 1;
    clip.width = 3;
  } else {
    clip.y -= 1;
    clip.height = 3;
  }
  const png = await page.screenshot({
    animations: "disabled",
    clip,
  });
  const matches = await page.evaluate(
    async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.fillStyle = getComputedStyle(
        document.querySelector("[data-workspace-window-active-border]")!,
      ).borderTopColor;
      context.fillRect(0, 0, 1, 1);
      const expected = [...context.getImageData(0, 0, 1, 1).data];
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      return [0, 1, 2].map((index) =>
        expected.every(
          (value, channel) =>
            Math.abs(value - pixels[index * 4 + channel]!) <= 2,
        ),
      );
    },
    `data:image/png;base64,${png.toString("base64")}`,
  );
  expect(matches).toEqual([false, true, false]);
}

test("one-pixel active borders cover shared separators across themes, nested splits, and resize", async () => {
  await withChromiumFixture(
    "workspace-active-border-pixels",
    async (fixture) => {
      const { page } = fixture;
      const activeBorder = page.locator(BORDER);
      await page.setViewportSize({ width: 1440, height: 900 });
      await initializeFixtureRepository(fixture.integration.dirs.project);
      await openChat(fixture);
      await activeBorder.waitFor();
      // Keeps half splits and 24px keyboard resize steps on whole pixel boundaries.
      const host = await page.locator(".workspace-host-region").boundingBox();
      expect(host).toEqual({ x: 320, y: 0, width: 1120, height: 900 });
      const vertical = page.getByRole("separator", { name: "Resize windows" });
      await vertical.dblclick();
      await page.mouse.move(0, 0);

      for (const theme of THEME_PROFILES) {
        await page.evaluate(({ id, colorScheme }) => {
          document.documentElement.dataset.theme = id;
          document.documentElement.classList.toggle(
            "dark",
            colorScheme === "dark",
          );
        }, theme);
        for (const id of ["window-main", "window-files"]) {
          await activateWindow(page, id);
          const line = await page
            .locator("[data-workspace-window-separator-line]")
            .boundingBox();
          if (!line) throw new Error("Missing shared separator.");
          await expectSingleStroke(page, line.x, line.y + 100, "x");
        }
        await captureScreenshot(page, `active-window-${theme.id}`);
      }

      await clickWorkspaceWindowAddAction(page, "Open Git History", "window-files");
      await page
        .locator('[data-workspace-window-menu-trigger="window-files"]')
        .click();
      await page
        .getByRole("menuitem", {
          name: "Move to new window below",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-workspace-window-id]").length === 3,
      );
      const lowerId = await activeBorder.getAttribute(
        "data-workspace-window-active-border",
      );
      if (!lowerId) throw new Error("Missing lower window.");
      const horizontal = page.locator(
        '[role="separator"][aria-orientation="horizontal"]',
      );
      await horizontal.dblclick();
      await page.mouse.move(0, 0);
      for (const id of ["window-files", lowerId]) {
        await activateWindow(page, id);
        const line = await horizontal
          .locator("[data-workspace-window-separator-line]")
          .boundingBox();
        if (!line) throw new Error("Missing horizontal separator.");
        await expectSingleStroke(page, line.x + 100, line.y, "y");
      }

      await horizontal.focus();
      await horizontal.press("ArrowUp");
      await activateWindow(page, "window-files");
      const resizedLine = await horizontal
        .locator("[data-workspace-window-separator-line]")
        .boundingBox();
      const border = await activeBorder.boundingBox();
      if (!resizedLine || !border) throw new Error("Missing resized border.");
      expect(
        Math.abs(border.y + border.height - 1 - resizedLine.y),
      ).toBeLessThan(0.1);
      await expectSingleStroke(page, resizedLine.x + 100, resizedLine.y, "y");
      await captureScreenshot(page, "active-window-nested");
      fixture.assertNoBrowserErrors();
    },
  );
});
