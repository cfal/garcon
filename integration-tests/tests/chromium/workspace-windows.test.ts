import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";

const WINDOW_SELECTOR = "[data-workspace-window-id]";

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], {
    cwd: projectPath,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

async function createGitFixture(projectPath: string): Promise<void> {
  await runGit(projectPath, ["init", "-b", "main"]);
  await runGit(projectPath, ["config", "user.email", "test@example.com"]);
  await runGit(projectPath, ["config", "user.name", "Chromium Test"]);
  await writeFile(join(projectPath, "workspace.txt"), "baseline\n", "utf8");
  await runGit(projectPath, ["add", "workspace.txt"]);
  await runGit(projectPath, ["commit", "-m", "baseline revision"]);
}

async function createChat(
  fixture: ChromiumFixture,
  content: string,
): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  return chatId;
}

async function openChat(
  fixture: ChromiumFixture,
  chatId: string,
): Promise<void> {
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: "domcontentloaded" },
  );
  if (!response?.ok())
    throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator(WINDOW_SELECTOR).waitFor({ state: "visible" });
  await fixture.page
    .locator(`[data-sidebar-virtual-row="${chatId}"]`)
    .waitFor({ state: "visible" });
}

async function openNewWindow(page: Page, label: string): Promise<string> {
  const previousCount = await page.locator(WINDOW_SELECTOR).count();
  await page.locator("[data-workspace-new-window-menu]").click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll("[data-workspace-window-id]").length ===
      expectedCount,
    previousCount + 1,
  );
  return page
    .locator('[data-workspace-window-current="true"]')
    .getAttribute("data-workspace-window-id")
    .then((windowId) => {
      if (!windowId)
        throw new Error(`Opening ${label} did not produce a current window.`);
      return windowId;
    });
}

async function openWindowTab(
  page: Page,
  windowId: string,
  label: string,
): Promise<void> {
  await page
    .locator(`[data-workspace-window-menu-trigger="${windowId}"]`)
    .click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function waitForTabLabelMode(
  page: Page,
  windowId: string,
  mode: "full" | "truncated" | "icon-only",
): Promise<void> {
  await page.waitForFunction(
    ({ expectedWindowId, expectedMode }) =>
      document
        .querySelector(`[data-workspace-window-tabs="${expectedWindowId}"]`)
        ?.getAttribute("data-workspace-tab-label-mode") === expectedMode,
    { expectedWindowId: windowId, expectedMode: mode },
  );
}

async function setTabRailWidth(
  page: Page,
  windowId: string,
  width: number | null,
): Promise<void> {
  await page
    .locator(`[data-workspace-window-tabs="${windowId}"]`)
    .evaluate((element, nextWidth) => {
      (element as HTMLElement).style.flex =
        nextWidth === null ? "" : `0 0 ${nextWidth}px`;
    }, width);
}

async function verifyAdaptiveTabLabels(
  page: Page,
  windowId: string,
): Promise<void> {
  await waitForTabLabelMode(page, windowId, "full");
  const tabViewport = page.locator(
    `[data-workspace-window-tabs="${windowId}"]`,
  );
  const measuredCount = await page
    .locator(
      `[data-workspace-window-id="${windowId}"] [data-window-tab-measure-id]`,
    )
    .count();
  expect(measuredCount).toBe(2);

  await setTabRailWidth(page, windowId, 130);
  await waitForTabLabelMode(page, windowId, "truncated");
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(2);

  await setTabRailWidth(page, windowId, 58);
  await waitForTabLabelMode(page, windowId, "icon-only");
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(2);

  await setTabRailWidth(page, windowId, 28);
  await waitForTabLabelMode(page, windowId, "icon-only");
  await page.waitForFunction(
    (expectedWindowId) =>
      document.querySelectorAll(
        `[data-workspace-window-tabs="${expectedWindowId}"] [role="tab"]`,
      ).length === 1,
    windowId,
  );
  expect(await tabViewport.locator('[role="tab"]').count()).toBe(1);

  await setTabRailWidth(page, windowId, null);
  await waitForTabLabelMode(page, windowId, "full");
}

async function openChatTabBelow(page: Page, windowId: string): Promise<string> {
  const previousCount = await page.locator(WINDOW_SELECTOR).count();
  await page
    .locator(`[id="${windowId}-tab-chat-view:${windowId}"]`)
    .click({ button: "right" });
  const closeItem = page.getByRole("menuitem", {
    name: "Close tab",
    exact: true,
  });
  expect(await closeItem.getAttribute("data-disabled")).not.toBeNull();
  await page
    .getByRole("menuitem", { name: "Open in new window below", exact: true })
    .click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll("[data-workspace-window-id]").length ===
      expectedCount,
    previousCount + 1,
  );
  const openedWindowId = await page
    .locator('[data-workspace-window-current="true"]')
    .getAttribute("data-workspace-window-id");
  if (!openedWindowId || openedWindowId === windowId) {
    throw new Error(
      "Chat tab context action did not create a new current window.",
    );
  }
  return openedWindowId;
}

async function verifySeparators(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const metrics = [
      ...document.querySelectorAll<HTMLElement>(
        "[data-workspace-window-separator-line]",
      ),
    ].map((line) => {
      const bounds = line.getBoundingClientRect();
      return {
        orientation: line.parentElement?.getAttribute("aria-orientation"),
        width: bounds.width,
        height: bounds.height,
        color: getComputedStyle(line).backgroundColor,
      };
    });
    const chatList = document.querySelector<HTMLElement>(
      "[data-workspace-chat-list]",
    );
    if (!chatList) throw new Error("Missing chat-list divider.");
    const chatListStyle = getComputedStyle(chatList);
    const dividerColor =
      Number.parseFloat(chatListStyle.borderRightWidth) > 0
        ? chatListStyle.borderRightColor
        : chatListStyle.borderLeftColor;
    return { metrics, dividerColor };
  });
  const vertical = result.metrics.find(
    (entry) => entry.orientation === "vertical",
  );
  const horizontal = result.metrics.find(
    (entry) => entry.orientation === "horizontal",
  );
  if (!vertical || !horizontal)
    throw new Error("Missing both workspace separator axes.");
  expect(vertical.width).toBe(1);
  expect(vertical.height).toBeGreaterThan(1);
  expect(horizontal.height).toBe(1);
  expect(horizontal.width).toBeGreaterThan(1);
  expect(vertical.color).toBe(result.dividerColor);
  expect(horizontal.color).toBe(result.dividerColor);
}

async function verifyFocusedWindow(
  page: Page,
  focusedWindowId: string,
  inactiveWindowId: string,
): Promise<void> {
  await page
    .locator(`[data-workspace-window-titlebar="${focusedWindowId}"]`)
    .click({ position: { x: 3, y: 3 } });
  await page.waitForFunction(
    (expectedWindowId) =>
      document
        .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
        ?.getAttribute("data-workspace-window-current") === "true",
    focusedWindowId,
  );
  expect(
    await page
      .locator("[data-workspace-window-focus-ring]")
      .getAttribute("data-workspace-window-focus-ring"),
  ).toBe(focusedWindowId);
  const focusedClasses =
    (await page
      .locator(`[data-workspace-window-titlebar="${focusedWindowId}"]`)
      .getAttribute("class")) ?? "";
  const inactiveClasses =
    (await page
      .locator(`[data-workspace-window-titlebar="${inactiveWindowId}"]`)
      .getAttribute("class")) ?? "";
  expect(focusedClasses.includes("bg-accent/50")).toBe(true);
  expect(inactiveClasses.includes("bg-muted/30")).toBe(true);
  expect(inactiveClasses.includes("bg-accent/50")).toBe(false);
}

async function openFile(page: Page, absolutePath: string): Promise<void> {
  await page.waitForFunction(
    (path) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-file-tree-row] [role="rowheader"]',
        ),
      ].some((element) => element.getAttribute("title") === path),
    absolutePath,
  );
  await page.evaluate((path) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-file-tree-row] [role="rowheader"]',
      ),
    ].find((element) => element.getAttribute("title") === path);
    const row = header?.closest<HTMLElement>("[data-file-tree-row]");
    if (!row) throw new Error(`Missing file tree row: ${path}`);
    row.click();
  }, absolutePath);
}

async function dragChatToWindow(
  page: Page,
  input: {
    chatId: string;
    windowId: string;
    edge?: "right" | "bottom";
    expectBlocked?: boolean;
  },
): Promise<void> {
  const source = page.locator(
    `[data-sidebar-virtual-row="${input.chatId}"][draggable="true"]`,
  );
  const target = page.locator(`[data-workspace-window-id="${input.windowId}"]`);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox)
    throw new Error("Missing workspace Chat drag geometry.");

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const edge = input.edge ?? "right";
  const targetX =
    edge === "right"
      ? targetBox.x + targetBox.width - 12
      : targetBox.x + targetBox.width / 2;
  const targetY =
    edge === "bottom"
      ? targetBox.y + targetBox.height - 12
      : targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target
      .locator("[data-workspace-window-drop-layer]")
      .waitFor({ state: "visible" });
    if (input.expectBlocked) {
      await target
        .getByText("4 windows max", { exact: true })
        .waitFor({ state: "visible" });
    } else {
      await target
        .getByText(
          edge === "right" ? "Open new window right" : "Open new window below",
          {
            exact: true,
          },
        )
        .waitFor({ state: "visible" });
    }
  } finally {
    await page.mouse.up();
  }
}

async function resizeFirstPartition(
  page: Page,
): Promise<{ value: string; persisted: string }> {
  await page.waitForFunction(
    () => localStorage.getItem("workspace_layout_v2") !== null,
  );
  const resizer = page
    .getByRole("separator", { name: "Resize windows" })
    .first();
  const bounds = await resizer.boundingBox();
  const orientation = await resizer.getAttribute("aria-orientation");
  const initialValue = await resizer.getAttribute("aria-valuenow");
  const initialPersisted = await page.evaluate(() =>
    localStorage.getItem("workspace_layout_v2"),
  );
  if (!bounds || !initialValue || !initialPersisted) {
    throw new Error("Missing workspace partition resize state.");
  }

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    orientation === "vertical" ? x + 80 : x,
    orientation === "horizontal" ? y + 80 : y,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    (previousValue) =>
      document
        .querySelector('[role="separator"][aria-label="Resize windows"]')
        ?.getAttribute("aria-valuenow") !== previousValue,
    initialValue,
  );
  const value = await resizer.getAttribute("aria-valuenow");
  if (!value) throw new Error("Workspace partition resize was not committed.");
  await page.waitForFunction((expectedValue) => {
    const raw = localStorage.getItem("workspace_layout_v2");
    if (!raw) return false;
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== "object") return false;
      const candidate = node as {
        type?: unknown;
        ratio?: unknown;
        children?: unknown[];
      };
      if (candidate.type !== "partition") return false;
      if (
        typeof candidate.ratio === "number" &&
        Math.round(candidate.ratio * 100) === Number(expectedValue)
      )
        return true;
      return candidate.children?.some(visit) ?? false;
    };
    return visit((JSON.parse(raw) as { root?: unknown }).root);
  }, value);
  const persisted = await page.evaluate(() =>
    localStorage.getItem("workspace_layout_v2"),
  );
  if (!persisted || persisted === initialPersisted) {
    throw new Error("Workspace partition resize was not persisted.");
  }
  return { value, persisted };
}

describe("Chromium workspace windows", () => {
  test("drags Chat onto any window, blocks the cap, and persists pointer resizing", async () => {
    await withChromiumFixture(
      "workspace-window-native-dnd-resize",
      async (fixture, markPhase) => {
        await createGitFixture(fixture.integration.dirs.project);
        markPhase("creating source chats");
        const chatA = await createChat(
          fixture,
          "workspace-window-chat-a-with-a-deliberately-long-title-for-tab-measurement",
        );
        const chatB = await createChat(fixture, "workspace-window-chat-b");
        await openChat(fixture, chatA);
        await fixture.page
          .locator(`[data-sidebar-virtual-row="${chatB}"]`)
          .waitFor({ state: "visible" });
        const chatWindowId = await fixture.page
          .locator('[data-workspace-window-current="true"]')
          .getAttribute("data-workspace-window-id");
        if (!chatWindowId) throw new Error("Missing initial Chat window.");

        markPhase("verifying adaptive labels and Chat tab actions");
        await openWindowTab(fixture.page, chatWindowId, "Open Git Compare");
        await fixture.page.waitForFunction(
          (expectedWindowId) =>
            document
              .querySelector(`[data-workspace-window-id="${expectedWindowId}"]`)
              ?.getAttribute("data-workspace-window-active-surface") ===
            "singleton:git-compare",
          chatWindowId,
        );
        await verifyAdaptiveTabLabels(fixture.page, chatWindowId);
        await openChatTabBelow(fixture.page, chatWindowId);
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);

        markPhase("opening a non-Chat target window");
        const filesWindowId = await openNewWindow(fixture.page, "Open Files");
        await fixture.page
          .locator(`[data-workspace-window-id="${filesWindowId}"]`)
          .waitFor({ state: "visible" });
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(3);

        markPhase("dragging a sidebar Chat onto the Files window");
        await dragChatToWindow(fixture.page, {
          chatId: chatB,
          windowId: filesWindowId,
        });
        await fixture.page.waitForFunction(
          () =>
            document.querySelectorAll("[data-workspace-window-id]").length ===
            4,
        );
        await fixture.page
          .getByLabel("Chat messages")
          .getByText("echo:workspace-window-chat-b", { exact: true })
          .waitFor();
        expect(
          await fixture.page
            .locator(`[data-workspace-window-id="${filesWindowId}"]`)
            .getAttribute("data-workspace-window-active-surface"),
        ).toBe("singleton:files");

        markPhase("verifying separator geometry and focused-window treatment");
        await verifySeparators(fixture.page);
        await verifyFocusedWindow(fixture.page, filesWindowId, chatWindowId);

        markPhase("resizing and restoring the partition");
        const resized = await resizeFirstPartition(fixture.page);
        await fixture.page.reload({ waitUntil: "domcontentloaded" });
        await fixture.page.waitForFunction(
          () =>
            document.querySelectorAll("[data-workspace-window-id]").length ===
            4,
        );
        expect(
          await fixture.page.evaluate(() =>
            localStorage.getItem("workspace_layout_v2"),
          ),
        ).toBe(resized.persisted);
        expect(
          await fixture.page
            .getByRole("separator", { name: "Resize windows" })
            .first()
            .getAttribute("aria-valuenow"),
        ).toBe(resized.value);

        markPhase("blocking Chat drag at four windows");
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
        await dragChatToWindow(fixture.page, {
          chatId: chatA,
          windowId: filesWindowId,
          expectBlocked: true,
        });
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
        await fixture.page.waitForFunction(
          () =>
            document.querySelector<HTMLButtonElement>(
              "[data-workspace-new-window-menu]",
            )?.disabled === true,
        );
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test("keeps a dirty file mounted while reversible fullscreen hides its window", async () => {
    await withChromiumFixture(
      "workspace-window-fullscreen-file-guard",
      async (fixture, markPhase) => {
        const project = fixture.integration.dirs.project;
        const filePath = join(project, "dirty-fullscreen.txt");
        await writeFile(filePath, "original\n", "utf8");

        markPhase("opening Chat and Files windows");
        const chatId = await createChat(fixture, "workspace-window-file-guard");
        await openChat(fixture, chatId);
        const chatWindow = fixture.page.locator(
          '[data-workspace-window-current="true"]',
        );
        const chatWindowId = await chatWindow.getAttribute(
          "data-workspace-window-id",
        );
        if (!chatWindowId) throw new Error("Missing current Chat window.");
        const filesWindowId = await openNewWindow(fixture.page, "Open Files");
        await openFile(fixture.page, filePath);
        await fixture.page.waitForFunction(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "[data-workspace-window-id]",
            ),
          ].some((element) =>
            element.dataset.workspaceWindowActiveSurface?.startsWith("file:"),
          ),
        );

        markPhase("editing the file");
        const editor = fixture.page.locator(
          '.cm-content[contenteditable="true"]',
        );
        await editor.click();
        await editor.pressSequentially("dirty edit");
        await fixture.page
          .locator('[aria-label="Unsaved"]')
          .waitFor({ state: "visible" });
        await fixture.page
          .locator(`[data-workspace-window-id="${filesWindowId}"]`)
          .evaluate(
            (element) =>
              ((element as HTMLElement).dataset.fullscreenInstance =
                "dirty-file"),
          );

        markPhase("entering reversible fullscreen");
        await fixture.page
          .locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`)
          .click();
        await fixture.page.waitForFunction(
          (expectedWindowId) =>
            document
              .querySelector(
                `[data-workspace-window-fullscreen="${expectedWindowId}"]`,
              )
              ?.getAttribute("aria-label") === "Exit fullscreen",
          chatWindowId,
        );
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);
        expect(await fixture.page.getByRole("dialog").count()).toBe(0);
        expect(
          await fixture.page.locator('[aria-label="Unsaved"]').count(),
        ).toBe(1);
        expect(
          await fixture.page
            .locator(`[data-workspace-window-id="${filesWindowId}"]`)
            .evaluate((element) => ({
              hidden: element.classList.contains("hidden"),
              inert: (element as HTMLElement).inert,
              marker: (element as HTMLElement).dataset.fullscreenInstance,
            })),
        ).toEqual({ hidden: true, inert: true, marker: "dirty-file" });

        markPhase("restoring the dirty file window");
        await fixture.page
          .locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`)
          .click();
        await fixture.page.waitForFunction((expectedWindowId) => {
          const workspaceWindow = document.querySelector<HTMLElement>(
            `[data-workspace-window-id="${expectedWindowId}"]`,
          );
          return Boolean(
            workspaceWindow && !workspaceWindow.classList.contains("hidden"),
          );
        }, filesWindowId);
        await fixture.page
          .locator('[aria-label="Unsaved"]')
          .waitFor({ state: "visible" });
        expect(await fixture.page.getByRole("dialog").count()).toBe(0);
        expect(
          await fixture.page
            .locator(`[data-workspace-window-id="${filesWindowId}"]`)
            .getAttribute("data-fullscreen-instance"),
        ).toBe("dirty-file");
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
