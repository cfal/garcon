import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "puppeteer-core";
import { withE2eFixture } from "../../support/e2e-fixture.js";
import { SpaDriver } from "../../support/spa-driver.js";

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], {
    cwd: projectPath,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

describe("Lightpanda workspace host fullscreen", () => {
  test("fullscreens either host while retaining the hidden Chat draft", async () => {
    await withE2eFixture("workspace-host-fullscreen", async (fixture) => {
      const project = fixture.integration.dirs.project;
      await runGit(project, ["init", "-b", "main"]);
      await runGit(project, ["config", "user.email", "test@example.com"]);
      await runGit(project, ["config", "user.name", "E2E Test"]);
      await writeFile(join(project, "review.txt"), "before\n", "utf8");
      await runGit(project, ["add", "review.txt"]);
      await runGit(project, ["commit", "-m", "base"]);
      await writeFile(join(project, "review.txt"), "after\n", "utf8");

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await installGitContainerGeometry(fixture.page);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat("workspace-fullscreen-seed");
      await app.waitForText("echo:workspace-fullscreen-seed");
      await app.fill(
        'textarea[placeholder="Reply..."]',
        "Retained fullscreen draft",
      );

      await app.clickButton("Open sidebar");
      const initialChatListHidden = await fixture.page.$eval(
        '[data-desktop-layout-pane="chat-list"]',
        (element) => element.getAttribute("aria-hidden"),
      );
      await app.openWorkspaceActions("main");
      await app.waitForMenuItemEnabled("Fullscreen");
      await app.clickMenuItem("Fullscreen");
      await waitForHostState(fixture.page, "main");
      await app.openWorkspaceActions("main");
      await app.waitForMenuItemEnabled("Exit fullscreen");
      await app.clickMenuItem("Exit fullscreen");
      await waitForHostState(fixture.page, null);
      expect(
        await fixture.page.$eval(
          '[data-desktop-layout-pane="chat-list"]',
          (element) => element.getAttribute("aria-hidden"),
        ),
      ).toBe(initialChatListHidden);

      await app.openWorkspaceActions("main");
      await app.waitForMenuItemEnabled("New Terminal");
      await app.clickMenuItem("New Terminal");
      await fixture.page.waitForSelector(
        '[id^="main-panel-terminal:"][aria-hidden="false"] [data-terminal-host]',
      );
      const terminalId = await fixture.page.$eval(
        '[id^="main-panel-terminal:"][aria-hidden="false"] ' +
          'select[aria-label="Terminal session"]',
        (element) => (element as HTMLSelectElement).value,
      );
      expect(terminalId).not.toBe("");
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[id^="main-panel-terminal:"][aria-hidden="false"]')
            ?.textContent?.includes("Attached") === true,
        { timeout: 20_000 },
      );

      await clickHostMenuItem(fixture.page, "sidebar", "Fullscreen");
      await waitForHostState(fixture.page, "sidebar");
      await clickHostMenuItem(fixture.page, "sidebar", "Exit fullscreen");
      await waitForHostState(fixture.page, null);
      await fixture.page.waitForSelector(
        '[id^="main-panel-terminal:"][aria-hidden="false"] [data-terminal-host]',
      );
      expect(
        await fixture.page.$eval(
          '[id^="main-panel-terminal:"][aria-hidden="false"] ' +
            'select[aria-label="Terminal session"]',
          (element) => (element as HTMLSelectElement).value,
        ),
      ).toBe(terminalId);
      await fixture.page.waitForFunction(
        () =>
          document
            .querySelector('[id^="main-panel-terminal:"][aria-hidden="false"]')
            ?.textContent?.includes("Attached") === true,
        { timeout: 20_000 },
      );

      await clickHostMenuItem(fixture.page, "sidebar", "Open Git Compare");
      await fixture.page.waitForSelector(
        '[id="sidebar-panel-singleton:git-compare"][aria-hidden="false"]',
      );
      await fixture.page.waitForFunction(
        () => {
          const panel = document.querySelector(
            '[id="sidebar-panel-singleton:git-compare"][aria-hidden="false"]',
          );
          return (
            panel?.textContent?.includes("Working Tree") === true &&
            !panel.textContent.includes("Loading comparison")
          );
        },
        { timeout: 20_000 },
      );

      await clickHostMenuItem(fixture.page, "sidebar", "Fullscreen");
      await waitForHostState(fixture.page, "sidebar");
      await fixture.page.evaluate((projectPath) => {
        const sidebar = document.querySelector(
          '[data-desktop-layout-pane="workspace-sidebar"]',
        );
        const trigger = [
          ...(sidebar?.querySelectorAll<HTMLButtonElement>("button") ?? []),
        ].find((button) => button.getAttribute("aria-label") === projectPath);
        if (!trigger)
          throw new Error("Missing fullscreen sidebar Git target trigger.");
        trigger.focus();
        trigger.click();
      }, project);
      await fixture.page.waitForSelector(
        '[role="dialog"][aria-label="Git target"]',
      );
      await app.clickButton("Cancel");
      await fixture.page.waitForFunction(
        (projectPath) => {
          const main = document.querySelector<HTMLElement>(
            '[data-desktop-layout-pane="main"]',
          );
          return (
            document.querySelector(
              '[role="dialog"][aria-label="Git target"]',
            ) === null &&
            document.activeElement?.getAttribute("aria-label") ===
              projectPath &&
            main !== null &&
            (main.inert || main.hasAttribute("inert"))
          );
        },
        { timeout: 20_000 },
        project,
      );
      await fixture.page.waitForSelector(
        '[id="sidebar-panel-singleton:git-compare"]' +
          ' [data-git-virtual-diff-root] button[aria-label="Add to chat"]',
        { timeout: 20_000 },
      );
      await fixture.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[id="sidebar-panel-singleton:git-compare"]' +
            ' [data-git-virtual-diff-root] button[aria-label="Add to chat"]',
        );
        if (!button)
          throw new Error("Missing fullscreen Compare comment affordance.");
        button.click();
      });
      await fixture.page.waitForSelector(
        "[data-git-comment-composer] textarea",
      );
      await app.fill(
        "[data-git-comment-composer] textarea",
        "Please verify the fullscreen comparison.",
      );
      await fixture.page.evaluate(() => {
        const composer = document.querySelector("[data-git-comment-composer]");
        const submit = [...(composer?.querySelectorAll("button") ?? [])].find(
          (button) => button.textContent?.trim() === "Add to chat",
        );
        if (!submit)
          throw new Error("Missing fullscreen Compare comment submit action.");
        submit.click();
      });
      await app.waitForText("Added to the Chat composer.");

      await clickHostMenuItem(fixture.page, "sidebar", "Exit fullscreen");
      await waitForHostState(fixture.page, null);

      await clickHostMenuItem(fixture.page, "sidebar", "Fullscreen");
      await waitForHostState(fixture.page, "sidebar");
      await fixture.page.waitForSelector(
        '[data-workspace-fullscreen-toggle="sidebar"][aria-pressed="true"]',
      );
      await fixture.page.$eval(
        '[data-workspace-fullscreen-toggle="sidebar"]',
        (button) => (button as HTMLButtonElement).click(),
      );
      await waitForHostState(fixture.page, null);

      await app.selectMainWorkspaceSurface("Chat");
      const draft = await fixture.page.$eval(
        'textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      );
      expect(draft).toContain("Retained fullscreen draft");
      expect(draft).toContain("Git review comment");
      expect(draft).toContain("Please verify the fullscreen comparison.");
      fixture.assertNoBrowserErrors();
    });
  });
});

async function waitForHostState(
  page: Page,
  host: "main" | "sidebar" | null,
): Promise<void> {
  await page.waitForFunction(
    (expectedHost) => {
      const main = document.querySelector<HTMLElement>(
        '[data-desktop-layout-pane="main"]',
      );
      const sidebar = document.querySelector<HTMLElement>(
        '[data-desktop-layout-pane="workspace-sidebar"]',
      );
      const chatList = document.querySelector<HTMLElement>(
        '[data-desktop-layout-pane="chat-list"]',
      );
      if (!main || !sidebar || !chatList) return false;
      const isInert = (element: HTMLElement): boolean =>
        element.inert || element.hasAttribute("inert");
      if (expectedHost === "main") {
        return (
          !isInert(main) &&
          main.getAttribute("aria-hidden") === "false" &&
          isInert(sidebar) &&
          sidebar.getAttribute("aria-hidden") === "true" &&
          chatList.getAttribute("aria-hidden") === "true"
        );
      }
      if (expectedHost === "sidebar") {
        return (
          isInert(main) &&
          main.getAttribute("aria-hidden") === "true" &&
          !isInert(sidebar) &&
          sidebar.getAttribute("aria-hidden") === "false" &&
          sidebar.dataset.workspaceHostFullscreen === "sidebar" &&
          chatList.getAttribute("aria-hidden") === "true"
        );
      }
      return (
        main.getAttribute("aria-hidden") === "false" &&
        sidebar.getAttribute("aria-hidden") === "false" &&
        sidebar.dataset.workspaceHostFullscreen === undefined
      );
    },
    { timeout: 20_000 },
    host,
  );
}

async function installGitContainerGeometry(page: Page): Promise<void> {
  await page.evaluateOnNewDocument(() => {
    const NativeResizeObserver = globalThis.ResizeObserver;
    class GitAwareResizeObserver implements ResizeObserver {
      readonly #callback: ResizeObserverCallback;
      readonly #native: ResizeObserver;

      constructor(callback: ResizeObserverCallback) {
        this.#callback = callback;
        this.#native = new NativeResizeObserver((entries) => {
          this.#callback(entries, this);
        });
      }

      observe(target: Element, options?: ResizeObserverOptions): void {
        this.#native.observe(target, options);
        queueMicrotask(() => {
          if (
            !(target instanceof HTMLElement) ||
            !target.matches("[data-git-workbench], [data-git-diff-document]")
          ) {
            return;
          }
          const rect = target.getBoundingClientRect();
          const blockSize = Math.max(rect.height, 800);
          const boxSize = [{ inlineSize: 1_200, blockSize }];
          this.#callback(
            [
              {
                target,
                contentRect: new DOMRect(rect.x, rect.y, 1_200, blockSize),
                borderBoxSize: boxSize,
                contentBoxSize: boxSize,
                devicePixelContentBoxSize: boxSize,
              },
            ],
            this,
          );
        });
      }

      unobserve(target: Element): void {
        this.#native.unobserve(target);
      }

      disconnect(): void {
        this.#native.disconnect();
      }
    }

    globalThis.ResizeObserver = GitAwareResizeObserver;
  });
}

async function clickHostMenuItem(
  page: Page,
  host: "main" | "sidebar",
  name: string,
): Promise<void> {
  const toolbarSelector =
    host === "main"
      ? "[data-floating-workspace-toolbar]"
      : "[data-floating-sidebar-toolbar]";
  await page.evaluate((selector) => {
    const trigger = document.querySelector<HTMLButtonElement>(
      `${selector} [data-workspace-taskbar-end] [data-slot="dropdown-menu-trigger"]`,
    );
    if (!trigger) throw new Error(`Missing ${selector} workspace menu.`);
    trigger.click();
  }, toolbarSelector);
  await page.waitForFunction(
    ({ expectedHost, expectedName }) => {
      const item = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-slot="dropdown-menu-content"][data-state="open"][data-workspace-taskbar-menu="${expectedHost}"] [role="menuitem"]`,
        ),
      ].find(
        (candidate) =>
          (candidate.getAttribute("aria-label") ||
            candidate.textContent?.trim()) === expectedName,
      );
      return (
        (item?.getAttribute("aria-label") || item?.textContent?.trim()) ===
          expectedName && item?.getAttribute("aria-disabled") !== "true"
      );
    },
    { timeout: 20_000 },
    { expectedHost: host, expectedName: name },
  );
  await page.evaluate(
    ({ expectedHost, expectedName }) => {
      const item = [
        ...document.querySelectorAll<HTMLElement>(
          `[data-slot="dropdown-menu-content"][data-state="open"][data-workspace-taskbar-menu="${expectedHost}"] [role="menuitem"]`,
        ),
      ].find(
        (candidate) =>
          (candidate.getAttribute("aria-label") ||
            candidate.textContent?.trim()) === expectedName,
      );
      if (!item)
        throw new Error(
          `Missing open ${expectedName} item for ${expectedHost}.`,
        );
      item.click();
    },
    { expectedHost: host, expectedName: name },
  );
}
