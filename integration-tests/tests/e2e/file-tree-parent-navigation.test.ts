import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

describe("Lightpanda file tree parent navigation", () => {
  test("keeps repeated pointer and keyboard activation on the parent row through the root", async () => {
    await withE2eFixture("file-tree-parent-navigation", async (fixture) => {
      const rootPath = fixture.integration.dirs.project;
      const firstLevelPath = join(rootPath, "level-one");
      const secondLevelPath = join(firstLevelPath, "level-two");
      await mkdir(secondLevelPath, { recursive: true });

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat("file-tree-parent-navigation-seed", {
        projectPath: secondLevelPath,
      });
      if (await app.hasButton("Open sidebar"))
        await app.clickButton("Open sidebar");
      await app.selectSidebarWorkspaceSurface("Files");
      await waitForDirectory(fixture.page, secondLevelPath);

      await activateParent(fixture.page, "pointer");
      await waitForDirectory(fixture.page, firstLevelPath);
      await expectFocusedParent(fixture.page, rootPath, false);

      await activateParent(fixture.page, "pointer");
      await waitForDirectory(fixture.page, rootPath);
      await expectFocusedParent(fixture.page, null, true);

      await activateParent(fixture.page, "pointer");
      await waitForBrowserTurn(fixture.page);
      await waitForDirectory(fixture.page, rootPath);
      await expectFocusedParent(fixture.page, null, true);

      await enterDirectory(fixture.page, firstLevelPath);
      await waitForDirectory(fixture.page, firstLevelPath);
      await enterDirectory(fixture.page, secondLevelPath);
      await waitForDirectory(fixture.page, secondLevelPath);

      await activateParent(fixture.page, "keyboard");
      await waitForDirectory(fixture.page, firstLevelPath);
      await expectFocusedParent(fixture.page, rootPath, false);

      await activateParent(fixture.page, "keyboard");
      await waitForDirectory(fixture.page, rootPath);
      await expectFocusedParent(fixture.page, null, true);

      await activateParent(fixture.page, "keyboard");
      await waitForBrowserTurn(fixture.page);
      await waitForDirectory(fixture.page, rootPath);
      await expectFocusedParent(fixture.page, null, true);

      fixture.assertNoBrowserErrors();
    });
  });
});

async function waitForDirectory(page: Page, path: string): Promise<void> {
  await page.waitForFunction(
    (expectedPath) => {
      const currentPath = document
        .querySelector('[data-file-tree-breadcrumbs] [aria-current="location"]')
        ?.getAttribute("title");
      return (
        currentPath === expectedPath &&
        document.querySelector("[data-file-tree-grid]") !== null &&
        document.querySelector("[data-file-tree-loading]") === null
      );
    },
    { timeout: 20_000 },
    path,
  );
}

async function activateParent(
  page: Page,
  mode: "pointer" | "keyboard",
): Promise<void> {
  await page.evaluate((activationMode) => {
    const row = document.querySelector<HTMLElement>(
      '[data-file-tree-row-key="file-tree-parent-row"]',
    );
    if (!row) throw new Error("Missing file tree parent row");
    if (activationMode === "pointer") {
      row.click();
      return;
    }
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  }, mode);
}

async function enterDirectory(page: Page, path: string): Promise<void> {
  await page.evaluate((directoryPath) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-file-tree-row] [role="rowheader"]',
      ),
    ].find((element) => element.getAttribute("title") === directoryPath);
    const row = header?.closest<HTMLElement>("[data-file-tree-row]");
    if (!row) throw new Error(`Missing directory row: ${directoryPath}`);
    row.click();
  }, path);
}

async function expectFocusedParent(
  page: Page,
  expectedParentPath: string | null,
  disabled: boolean,
): Promise<void> {
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-file-tree-row-key") ===
      "file-tree-parent-row",
    { timeout: 20_000 },
  );
  const presentation = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(
      '[data-file-tree-row-key="file-tree-parent-row"]',
    );
    const viewport = document.querySelector<HTMLElement>(
      "[data-file-tree-grid]",
    );
    if (!row || !viewport) throw new Error("Missing focused file tree");
    return {
      parentPath:
        row.querySelector('[role="rowheader"]')?.getAttribute("title") ?? null,
      ariaDisabled: row.getAttribute("aria-disabled"),
      scrollTop: viewport.scrollTop,
    };
  });

  expect(presentation).toEqual({
    parentPath: expectedParentPath,
    ariaDisabled: disabled ? "true" : "false",
    scrollTop: 0,
  });
}

async function waitForBrowserTurn(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}
