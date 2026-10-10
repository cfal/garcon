import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { codexAssistantMessage } from "../../support/fake-codex-model.js";
import { liveCodexStartRequest } from "../../support/live-codex.js";
import { startScriptedCodexTestEnvironment } from "../../support/scripted-codex.js";

test("reorders, expands, edits, and steers queued messages from the chat on desktop and mobile", async () => {
  const environment = await startScriptedCodexTestEnvironment();
  const held = environment.model.scriptHeldTurn([
    codexAssistantMessage("Synthetic interface review completed."),
  ]);
  environment.model.scriptTurn([
    codexAssistantMessage("Synthetic steering received."),
  ]);
  const messages = [
    "Review the empty and loading states before changing the layout.",
    "Check the mobile layout and keyboard navigation.\nKeep the composer visible and preserve the current draft.",
    "Use the existing design tokens.\nInclude screenshots of the compact and expanded queue.",
  ];
  const artifactDir = join(
    import.meta.dir,
    "../../artifacts/chromium/inline-queue",
  );
  await mkdir(artifactDir, { recursive: true });
  try {
    await withChromiumFixture(
      "inline-queue",
      async ({ page, integration, assertNoBrowserErrors }, phase) => {
        const chatId = integration.newChatId();
        const active = await integration.client.startChat(
          liveCodexStartRequest({
            chatId,
            projectPath: integration.dirs.project,
            command: "Review the queued-message interface.",
          }),
        );
        await held.requested;
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const composer = page.getByPlaceholder("Reply...", { exact: true });
        const queueButton = page.getByRole("button", {
          name: "Queue message",
          exact: true,
        });
        await browserExpect(queueButton).toBeVisible({ timeout: 20_000 });
        for (const message of messages) {
          await composer.fill(message);
          await queueButton.click();
          await browserExpect(composer).toHaveValue("");
        }
        await composer.fill("Keep this draft while arranging the queue.");
        const tray = page.locator("[data-queue-status-summary]");
        const previews = tray.locator("[data-queue-preview]");
        const captureDesktop = async (name: string) => {
          const bounds = await tray.boundingBox();
          if (!bounds) throw new Error("Queue tray is not visible");
          await page.screenshot({
            path: join(artifactDir, name),
            clip: {
              x: bounds.x - 8,
              y: bounds.y - 8,
              width: bounds.width + 16,
              height: 908 - bounds.y,
            },
          });
        };
        await browserExpect(previews).toHaveText(messages);
        await browserExpect(tray.getByRole("button", { name: "Steer", exact: true })).toHaveCount(3);
        await browserExpect(
          page.getByRole("button", { name: "Edit queue", exact: true }),
        ).toHaveCount(0);
        await captureDesktop("desktop-compact.png");

        phase("checking the head overflow menu");
        await tray
          .getByRole("button", { name: "Queue actions", exact: true })
          .first()
          .click();
        await browserExpect(
          page.getByRole("menuitem", { name: "Send now", exact: true }),
        ).toBeVisible();
        await captureDesktop("desktop-menu.png");
        await page.keyboard.press("Escape");
        await browserExpect(page.getByRole("menu")).toHaveCount(0);

        phase("dragging the last message to the top");
        const entriesBeforeMove = (
          await integration.client.getExecutionControl(chatId)
        ).queue.entries;
        const lastHandle = tray.locator(
          `[data-queue-drag-id="${entriesBeforeMove[2].id}"]`,
        );
        const firstRow = tray.locator(
          `[data-queue-entry-id="${entriesBeforeMove[0].id}"]`,
        );
        await lastHandle.dragTo(firstRow, { targetPosition: { x: 100, y: 2 } });
        const reordered = [messages[2], messages[0], messages[1]];
        await browserExpect(previews).toHaveText(reordered);
        expect(
          (
            await integration.client.getExecutionControl(chatId)
          ).queue.entries.map((entry) => entry.content),
        ).toEqual(reordered);
        await browserExpect(composer).toHaveValue(
          "Keep this draft while arranging the queue.",
        );

        phase("expanding and editing directly from the tray");
        await tray
          .getByRole("button", { name: "Expand all queued messages" })
          .click();
        await browserExpect(
          tray.getByRole("button", { name: "Collapse queued message 3" }),
        ).toHaveAttribute("aria-expanded", "true");
        await captureDesktop("desktop-expanded.png");
        await tray
          .getByRole("button", { name: "Edit queued message", exact: true })
          .last()
          .click();
        const dialog = page.getByRole("dialog");
        const editedMessage =
          "Check the mobile layout, keyboard navigation, and focus after reordering.";
        await dialog.locator("textarea").fill(editedMessage);
        await dialog
          .getByRole("button", { name: "Save edit", exact: true })
          .click();
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await browserExpect(dialog).toHaveCount(0);
        await browserExpect(previews.last()).toHaveText(editedMessage);

        phase("using the queue on a narrow screen");
        await page.setViewportSize({ width: 390, height: 844 });
        await browserExpect(composer).toBeVisible();
        await tray
          .getByRole("button", { name: "Expand all queued messages" })
          .click();
        await browserExpect
          .poll(() =>
            tray
              .locator("[data-queue-entry-id]")
              .evaluateAll((rows) =>
                rows.every(
                  (row, index) =>
                    index === 0 ||
                    rows[index - 1].getBoundingClientRect().bottom <=
                      row.getBoundingClientRect().top + 1,
                ),
              ),
          )
          .toBe(true);
        await page.screenshot({
          path: join(artifactDir, "mobile-expanded.png"),
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await tray
          .getByRole("button", { name: "Queue actions", exact: true })
          .first()
          .click();
        await browserExpect(
          page.getByRole("menuitem", { name: "Send now", exact: true }),
        ).toBeVisible();
        await browserExpect(
          page.getByRole("menuitem", { name: /Move/ }),
        ).toHaveCount(0);
        await page.screenshot({ path: join(artifactDir, "mobile-menu.png") });
        await page.keyboard.press("Escape");
        await browserExpect(page.getByRole("menu")).toHaveCount(0);
        await browserExpect(previews.first()).toHaveText(messages[2]);
        await browserExpect(composer).toHaveValue(
          "Keep this draft while arranging the queue.",
        );

        phase("steering from the chat while later work remains paused");
        await tray.getByRole("button", { name: "Pause", exact: true }).click();
        await browserExpect(
          tray.getByRole("button", { name: "Resume queue", exact: true }),
        ).toBeVisible();
        await tray.getByRole("button", { name: "Steer", exact: true }).nth(1).click();
        await browserExpect(previews).toHaveText([messages[2], editedMessage]);
        expect(
          (await integration.client.getExecutionControl(chatId)).queue.pause,
        ).not.toBeNull();
        held.release();
        if (!active.turnId) throw new Error("Missing active turn");
        await integration.client.waitForTurnTerminal(chatId, active.turnId);
        await browserExpect(
          page.getByText("Synthetic steering received.", { exact: true }),
        ).toBeVisible();
        environment.model.assertSettled();
        assertNoBrowserErrors();
      },
      undefined,
      {
        serverEnvironment: environment.serverEnvironment,
        prepareWorkspace: environment.prepareWorkspace,
      },
    );
  } finally {
    held.release();
    await environment.dispose();
  }
}, 120_000);

test("retains late reorder errors and keeps a large expanded queue above a tall landscape composer", async () => {
  await withChromiumFixture(
    "inline-queue-review-regressions",
    async (
      { page, integration, assertNoBrowserErrors, browserErrors },
      phase,
    ) => {
      const chatA = integration.newChatId();
      const chatB = integration.newChatId();
      const held = integration.fakeProviders.openAi.holdNext({
        lastUserText: "Synthetic queue regression",
      });
      try {
        await integration.client.startDirectChat({
          chatId: chatA,
          content: "Synthetic queue regression",
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        await held.received;
        await integration.client.startDirectChat({
          chatId: chatB,
          content: "Synthetic alternate chat",
          projectPath: integration.dirs.project,
          agent: integration.directAgents.openAi,
        });
        for (let index = 0; index < 3; index++)
          await integration.client.enqueueNew(
            chatA,
            `Synthetic initial message ${index}`,
          );
        await integration.client.pauseQueue(chatA);
        const control = await integration.client.getExecutionControl(chatA);
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatA}`);
        const tray = page.locator("[data-queue-status-summary]");
        await browserExpect(tray.locator("[data-queue-preview]")).toHaveCount(
          3,
        );
        let releaseFailure!: () => void;
        const failureGate = new Promise<void>((resolve) => {
          releaseFailure = resolve;
        });
        await page.route(
          "**/api/v1/chats/queue/entries/move",
          async (route) => {
            await failureGate;
            await route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({
                success: false,
                error: "Synthetic reorder conflict",
                errorCode: "QUEUE_ENTRY_REORDER_CONFLICT",
                retryable: false,
                control: control,
              }),
            });
          },
        );
        const pendingMove = page.waitForRequest(
          "**/api/v1/chats/queue/entries/move",
        );
        await tray
          .locator(`[data-queue-drag-id="${control.queue.entries[2].id}"]`)
          .dragTo(
            tray.locator(
              `[data-queue-entry-id="${control.queue.entries[0].id}"]`,
            ),
            { targetPosition: { x: 100, y: 2 } },
          );
        await pendingMove;
        const select = async (chatId: string) => {
          await page
            .locator(`[data-sidebar-virtual-row="${chatId}"]`)
            .getByRole("button")
            .first()
            .click();
          await browserExpect(
            page.locator(`[data-conversation-panel-chat-id="${chatId}"]`),
          ).toBeVisible();
        };
        await select(chatB);
        releaseFailure();
        await browserExpect(
          page.getByText(
            "Queue order changed. Review the latest order and try again.",
            { exact: true },
          ),
        ).toHaveCount(0);
        await select(chatA);
        await browserExpect(
          page.getByText(
            "Queue order changed. Review the latest order and try again.",
            { exact: true },
          ),
        ).toBeVisible();
        expect(browserErrors.splice(0)).toEqual([
          "console.error: Failed to load resource: the server responded with a status of 409 (Conflict)",
        ]);
        await page.unroute("**/api/v1/chats/queue/entries/move");

        phase("verifying bounded rendering and access to the queue tail");
        for (let index = 0; index < 250; index++)
          await integration.client.enqueueNew(
            chatA,
            `Synthetic budget message ${index}\nSynthetic expanded detail.`,
          );
        await browserExpect(
          tray.getByText("253 queued", { exact: true }),
        ).toBeVisible();
        expect(
          await tray.locator("[data-queue-entry-id]").count(),
        ).toBeLessThan(40);
        const list = tray.locator("[data-queue-list]");
        await list.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await browserExpect(
          tray.locator("[data-queue-preview]").last(),
        ).toHaveText(
          "Synthetic budget message 249\nSynthetic expanded detail.",
        );
        await tray
          .getByRole("button", {
            name: "Expand all queued messages",
            exact: true,
          })
          .click();
        await page.setViewportSize({ width: 900, height: 480 });
        const composer = page.getByPlaceholder("Reply...", { exact: true });
        await composer.fill(
          Array.from(
            { length: 9 },
            (_, index) => `Synthetic tall draft line ${index}`,
          ).join("\n"),
        );
        await browserExpect(composer).toBeInViewport();
        await browserExpect
          .poll(async () => {
            const queueBounds = await tray.boundingBox();
            const composerBounds = await page
              .locator("[data-composer]")
              .boundingBox();
            return Boolean(
              queueBounds &&
              composerBounds &&
              queueBounds.y + queueBounds.height <= composerBounds.y,
            );
          })
          .toBe(true);
        await list.evaluate((element) => {
          element.scrollTop = 0;
        });
        await browserExpect(
          tray.locator("[data-queue-preview]").first(),
        ).toHaveText("Synthetic initial message 0");
        const artifactDir = join(
          import.meta.dir,
          "../../artifacts/chromium/inline-queue",
        );
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          path: join(artifactDir, "landscape-tall-composer.png"),
        });
        assertNoBrowserErrors();
      } finally {
        held.releaseEcho();
      }
    },
  );
}, 120_000);

test("preserves the composer and background queue updates across rapid chat switches", async () => {
  await withChromiumFixture(
    "inline-queue-chat-switch",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const chatA = integration.newChatId();
      const chatB = integration.newChatId();
      const heldA = integration.fakeProviders.openAi.holdNext({
        lastUserText: "Synthetic queue chat A",
      });
      const heldB = integration.fakeProviders.openAi.holdNext({
        lastUserText: "Synthetic queue chat B",
      });
      try {
        for (const [chatId, content] of [
          [chatA, "Synthetic queue chat A"],
          [chatB, "Synthetic queue chat B"],
        ]) {
          await integration.client.startDirectChat({
            chatId,
            content,
            projectPath: integration.dirs.project,
            agent: integration.directAgents.openAi,
          });
        }
        await Promise.all([heldA.received, heldB.received]);
        await integration.client.enqueueNew(
          chatA,
          "Synthetic queued message A",
        );
        await integration.client.enqueueNew(
          chatB,
          "Synthetic queued message B",
        );
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatA}`);
        const composer = page.getByPlaceholder("Reply...", { exact: true });
        await browserExpect(composer).toBeVisible();
        await composer.fill("Synthetic draft A");
        await composer.focus();
        const composerElement = await composer.elementHandle();
        const tray = page.locator("[data-queue-status-summary]");
        const composerTop = (await composer.boundingBox())?.y;
        const select = async (chatId: string) => {
          await page
            .locator(`[data-sidebar-virtual-row="${chatId}"]`)
            .getByRole("button")
            .first()
            .click();
          await browserExpect(
            page.locator(`[data-conversation-panel-chat-id="${chatId}"]`),
          ).toBeVisible();
        };
        await select(chatB);
        await composer.fill("Synthetic draft B");
        await integration.client.enqueueNew(
          chatA,
          "Synthetic background queued message A",
        );
        for (let iteration = 0; iteration < 3; iteration++) {
          await select(chatA);
          await browserExpect(tray.locator("[data-queue-preview]")).toHaveText([
            "Synthetic queued message A",
            "Synthetic background queued message A",
          ]);
          await browserExpect(composer).toHaveValue("Synthetic draft A");
          await select(chatB);
          await browserExpect(tray.locator("[data-queue-preview]")).toHaveText([
            "Synthetic queued message B",
          ]);
          await browserExpect(composer).toHaveValue("Synthetic draft B");
          expect((await composer.boundingBox())?.y).toBe(composerTop);
        }
        expect(
          await page.evaluate(
            (element) =>
              element ===
              document.querySelector('textarea[placeholder="Reply..."]'),
            composerElement,
          ),
        ).toBe(true);
        for (let index = 0; index < 12; index++) {
          await Promise.all([
            integration.client.enqueueNew(
              chatA,
              `Synthetic long queue A ${index}`,
            ),
            integration.client.enqueueNew(
              chatB,
              `Synthetic long queue B ${index}`,
            ),
          ]);
        }
        await browserExpect(
          tray.getByText("13 queued", { exact: true }),
        ).toBeVisible();
        await tray.locator("[data-queue-list]").evaluate((list) => {
          list.scrollTop = list.scrollHeight;
        });
        expect(
          await tray
            .locator("[data-queue-list]")
            .evaluate((list) => list.scrollTop),
        ).toBeGreaterThan(0);
        await select(chatA);
        await browserExpect(
          tray.getByText("14 queued", { exact: true }),
        ).toBeVisible();
        expect(
          await tray
            .locator("[data-queue-list]")
            .evaluate((list) => list.scrollTop),
        ).toBe(0);
        await browserExpect(
          tray.locator("[data-queue-preview]").first(),
        ).toBeInViewport();
        await integration.client.pauseQueue(chatA);
        heldA.releaseEcho();
        await browserExpect(
          tray.getByText("Queue paused", { exact: true }),
        ).toBeVisible();
        await browserExpect(composer).toHaveValue("Synthetic draft A");
        assertNoBrowserErrors();
      } finally {
        heldA.releaseEcho();
        heldB.releaseEcho();
      }
    },
  );
}, 120_000);
