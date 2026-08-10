import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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

  test("keeps breadcrumb and expanded listings synchronized across presentation changes", async () => {
    await withE2eFixture("file-tree-responsive-listing", async (fixture) => {
      const rootPath = fixture.integration.dirs.project;
      const firstLevelPath = join(rootPath, "level-one");
      const secondLevelPath = join(firstLevelPath, "level-two");
      const firstSiblingPath = join(rootPath, "sibling-a");
      const secondSiblingPath = join(rootPath, "sibling-b");
      await Promise.all([
        mkdir(secondLevelPath, { recursive: true }),
        mkdir(firstSiblingPath, { recursive: true }),
        mkdir(secondSiblingPath, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(rootPath, "root-only.txt"), "root\n", "utf8"),
        writeFile(join(firstLevelPath, "first-only.txt"), "first\n", "utf8"),
        writeFile(join(secondLevelPath, "second-only.txt"), "second\n", "utf8"),
        writeFile(join(firstSiblingPath, "a-only.txt"), "a\n", "utf8"),
        writeFile(join(firstSiblingPath, "shared.txt"), "a shared\n", "utf8"),
        writeFile(join(secondSiblingPath, "b-only.txt"), "b\n", "utf8"),
        writeFile(join(secondSiblingPath, "shared.txt"), "b shared\n", "utf8"),
      ]);

      const rootEntries = [
        firstLevelPath,
        firstSiblingPath,
        secondSiblingPath,
        join(rootPath, "root-only.txt"),
      ];
      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat("file-tree-responsive-listing-seed", {
        projectPath: rootPath,
      });
      if (await app.hasButton("Open sidebar"))
        await app.clickButton("Open sidebar");
      await app.selectSidebarWorkspaceSurface("Files");
      await expectFileListing(fixture.page, rootPath, rootEntries);

      await enterDirectory(fixture.page, firstLevelPath);
      await expectFileListing(fixture.page, firstLevelPath, [
        secondLevelPath,
        join(firstLevelPath, "first-only.txt"),
      ]);
      await enterDirectory(fixture.page, secondLevelPath);
      await expectFileListing(fixture.page, secondLevelPath, [
        join(secondLevelPath, "second-only.txt"),
      ]);

      await fixture.page.evaluate(() => {
        document.documentElement.dataset.fileTreeHostMoveRealm = "retained";
      });
      await app.openWorkspaceActions("sidebar");
      await app.waitForMenuItemEnabled("Move to main view");
      await app.clickMenuItem("Move to main view");
      await expectFileListing(fixture.page, secondLevelPath, [
        join(secondLevelPath, "second-only.txt"),
      ]);
      expect(
        await fixture.page.evaluate(
          () => document.documentElement.dataset.fileTreeHostMoveRealm,
        ),
      ).toBe("retained");
      await navigateToBreadcrumb(fixture.page, rootPath);
      await expectFileListing(fixture.page, rootPath, rootEntries);

      await app.setViewport(390, 844);
      await app.clickButton("Files");
      await expectFileListing(fixture.page, rootPath, rootEntries);
      await enterDirectory(fixture.page, firstLevelPath);
      await expectFileListing(fixture.page, firstLevelPath, [
        secondLevelPath,
        join(firstLevelPath, "first-only.txt"),
      ]);
      await enterDirectory(fixture.page, secondLevelPath);
      await expectFileListing(fixture.page, secondLevelPath, [
        join(secondLevelPath, "second-only.txt"),
      ]);
      await navigateToBreadcrumb(fixture.page, rootPath);
      await expectFileListing(fixture.page, rootPath, rootEntries);

      await expandDirectory(fixture.page, firstSiblingPath);
      await expectFileListing(fixture.page, rootPath, [
        ...rootEntries,
        join(firstSiblingPath, "a-only.txt"),
        join(firstSiblingPath, "shared.txt"),
      ]);
      await expandDirectory(fixture.page, secondSiblingPath);
      const expandedEntries = [
        ...rootEntries,
        join(firstSiblingPath, "a-only.txt"),
        join(firstSiblingPath, "shared.txt"),
        join(secondSiblingPath, "b-only.txt"),
        join(secondSiblingPath, "shared.txt"),
      ];
      await expectFileListing(fixture.page, rootPath, expandedEntries);

      await app.setViewport(1_440, 900);
      if (await app.hasButton("Open sidebar"))
        await app.clickButton("Open sidebar");
      await app.selectSidebarWorkspaceSurface("Files");
      await expectFileListing(fixture.page, rootPath, rootEntries);
      fixture.assertNoBrowserErrors();
    });
  });
});

async function expectFileListing(
  page: Page,
  directoryPath: string,
  expectedEntryPaths: string[],
): Promise<void> {
  const expectedPaths = [...expectedEntryPaths].sort();
  await page.waitForFunction(
    ({ expectedDirectoryPath, expectedPaths }) => {
      const currentPath = document
        .querySelector('[data-file-tree-breadcrumbs] [aria-current="location"]')
        ?.getAttribute("title");
      const rows = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-file-tree-row-key]:not([data-file-tree-row-key="file-tree-parent-row"])',
        ),
      ];
      const paths = rows
        .map((row) =>
          row.querySelector('[role="rowheader"]')?.getAttribute("title"),
        )
        .filter((path): path is string => typeof path === "string")
        .sort();
      const keys = rows.map((row) => row.dataset.fileTreeRowKey);
      return (
        currentPath === expectedDirectoryPath &&
        document.querySelector("[data-file-tree-loading]") === null &&
        paths.length === expectedPaths.length &&
        paths.every((path, index) => path === expectedPaths[index]) &&
        keys.every((key) => typeof key === "string") &&
        new Set(keys).size === keys.length
      );
    },
    { timeout: 20_000 },
    { expectedDirectoryPath: directoryPath, expectedPaths },
  );

  const listing = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-file-tree-row-key]:not([data-file-tree-row-key="file-tree-parent-row"])',
      ),
    ];
    return {
      paths: rows
        .map((row) =>
          row.querySelector('[role="rowheader"]')?.getAttribute("title"),
        )
        .filter((path): path is string => typeof path === "string")
        .sort(),
      keys: rows.map((row) => row.dataset.fileTreeRowKey),
    };
  });
  expect(listing.paths).toEqual(expectedPaths);
  expect(new Set(listing.keys).size).toBe(listing.keys.length);
}

async function navigateToBreadcrumb(page: Page, path: string): Promise<void> {
  await page.evaluate((targetPath) => {
    const breadcrumb = [
      ...document.querySelectorAll<HTMLButtonElement>(
        "[data-file-tree-breadcrumbs] button",
      ),
    ].find((button) => button.getAttribute("aria-label") === targetPath);
    if (!breadcrumb) throw new Error(`Missing breadcrumb: ${targetPath}`);
    breadcrumb.click();
  }, path);
}

async function expandDirectory(page: Page, path: string): Promise<void> {
  await page.evaluate((directoryPath) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-file-tree-row] [role="rowheader"]',
      ),
    ].find((element) => element.getAttribute("title") === directoryPath);
    const row = header?.closest<HTMLElement>("[data-file-tree-row]");
    const disclosure = row?.querySelector<HTMLButtonElement>("button");
    if (!row || !disclosure)
      throw new Error(`Missing directory disclosure: ${directoryPath}`);
    if (row.getAttribute("aria-expanded") !== "true") disclosure.click();
  }, path);
}

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
