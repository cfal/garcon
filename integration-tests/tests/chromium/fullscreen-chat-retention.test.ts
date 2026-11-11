import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  AssistantMessage,
  BashToolUseMessage,
  ToolResultMessage,
  UserMessage,
  type ChatMessage,
} from "../../../common/chat-types.js";
import type {
  PersistedWorkspaceLayoutNode,
  PersistedWorkspaceLayoutV2,
} from "../../../common/workspace-layout.js";
import { TranscriptLedgerStore } from "../../../server/controller/ledger/store.js";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";
import { seedLocalSettings } from "../../support/local-settings-seed.js";

type ChatIngestionScope = typeof globalThis & {
  __fullscreenChatFrontiers: Record<string, number>;
};

async function observeChatIngestion(fixture: ChromiumFixture): Promise<void> {
  await fixture.context.addInitScript(() => {
    const scope = globalThis as ChatIngestionScope;
    scope.__fullscreenChatFrontiers = {};
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args: ConstructorParameters<typeof WebSocket>) {
        const socket = new Target(...args);
        if (new URL(String(args[0]), location.href).pathname === "/ws") {
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data));
            if (message.type === "chat-messages") {
              scope.__fullscreenChatFrontiers[message.chatId] =
                message.lastOrdinal;
            }
          });
        }
        return socket;
      },
    });
  });
}

function chatLayout(chatIds: readonly string[]): PersistedWorkspaceLayoutV2 {
  let partitionIndex = 0;
  function tree(
    ids: readonly string[],
    offset = 0,
    depth = 0,
  ): PersistedWorkspaceLayoutNode {
    if (ids.length === 1) {
      const ref = { type: "chat" as const, chatId: ids[0]! };
      return {
        type: "window",
        id: offset === 0 ? "window-main" : `window-retained-${offset}`,
        order: [ref],
        active: ref,
        mru: [ref],
      };
    }
    const midpoint = Math.ceil(ids.length / 2);
    return {
      type: "partition",
      id: `partition-retained-${partitionIndex++}`,
      direction: depth % 2 === 0 ? "horizontal" : "vertical",
      ratio: 0.5,
      children: [
        tree(ids.slice(0, midpoint), offset, depth + 1),
        tree(ids.slice(midpoint), offset + midpoint, depth + 1),
      ],
    };
  }
  return { version: 2, root: tree(chatIds), unplacedTerminalIds: [] };
}

async function seedChats(
  fixture: ChromiumFixture,
  count: number,
  tail: readonly ChatMessage[] = [],
): Promise<string[]> {
  const chatIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const chatId = fixture.integration.newChatId();
    const turn = await fixture.integration.client.startDirectChat({
      chatId,
      content: `Synthetic retained chat ${index}`,
      projectPath: fixture.integration.dirs.project,
      agent: fixture.integration.directAgents.openAi,
    });
    await fixture.integration.client.waitForTurnTerminal(chatId, turn.turnId);
    chatIds.push(chatId);
  }
  await fixture.integration.restartGarcon({
    beforeStart: async () => {
      const store = new TranscriptLedgerStore(
        join(fixture.integration.dirs.workspace, "transcript-ledgers"),
      );
      try {
        for (const chatId of chatIds) {
          const view = store.currentView(chatId);
          if (!view) throw new Error("Missing synthetic transcript view");
          store.append(chatId, view.viewId, [
            ...Array.from({ length: 120 }, (_, index) => {
              const at = new Date(Date.UTC(2026, 0, 1) + index).toISOString();
              return {
                kind: "provider-row" as const,
                at,
                message: new AssistantMessage(
                  at,
                  `## Synthetic row ${index}\n\nA generic explanation with **emphasis** and enough words to wrap across narrow windows.\n\n\`\`\`typescript\nexport const value = ${index};\n\`\`\`\n\n$ x = ${index} $`,
                ),
                providerMeta: null,
              };
            }),
            ...tail.map((message) => ({
              kind: "provider-row" as const,
              at: message.timestamp,
              message,
              providerMeta: null,
            })),
          ]);
        }
      } finally {
        store.close();
      }
    },
  });
  return chatIds;
}

async function openLayout(
  fixture: ChromiumFixture,
  chatIds: readonly string[],
): Promise<void> {
  const setupUrl = `${fixture.integration.garcon.baseUrl}/__fullscreen-layout-setup`;
  await fixture.page.route(setupUrl, (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><title>Layout setup</title>",
  }));
  try {
    // Unloads the app and its pending persistence before replacing its layout.
    await fixture.page.goto(setupUrl);
    await fixture.page.evaluate((layout) => {
      localStorage.setItem("workspace_layout_v2", JSON.stringify(layout));
    }, chatLayout(chatIds));
  } finally {
    await fixture.page.unroute(setupUrl);
  }
  await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${chatIds[0]}`,
  );
  await waitForReadyPanels(fixture.page, chatIds.length);
}

async function waitForReadyPanels(page: Page, count: number): Promise<void> {
  await page.waitForFunction((expected) => {
    const panels = [
      ...document.querySelectorAll<HTMLElement>("[data-conversation-panel]"),
    ];
    return (
      panels.length === expected &&
      panels.every((panel) => {
        const viewport = panel.querySelector("[data-chat-scroll-viewport]");
        const sizer = panel.querySelector("[data-chat-virtual-sizer]");
        return (
          viewport?.getAttribute("aria-busy") === "false" &&
          sizer &&
          getComputedStyle(sizer).visibility !== "hidden" &&
          panel.querySelector("[data-chat-virtual-item]") &&
          !panel.querySelector("[data-chat-layout-pending]")
        );
      })
    );
  }, count);
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  });
}

async function toggleFullscreen(
  page: Page,
  fullscreen: boolean,
): Promise<void> {
  await page
    .locator('[data-workspace-window-fullscreen="window-main"]')
    .click();
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-workspace-window-fullscreen="window-main"]')
        ?.getAttribute("aria-label") ===
      (expected ? "Exit fullscreen" : "Fullscreen"),
    fullscreen,
  );
}

function panelSelector(chatId: string): string {
  return `[data-conversation-panel-chat-id="${chatId}"]`;
}

async function hiddenModelCounts(page: Page): Promise<(string | null)[]> {
  return page
    .locator("[data-workspace-window-id].hidden [data-chat-virtual-sizer]")
    .evaluateAll(elements => elements.map(element =>
      element.getAttribute("data-chat-virtual-model-count"),
    ));
}

async function readingAnchor(
  page: Page,
  chatId: string,
): Promise<{ rowId: string; offset: number }> {
  return page
    .locator(`${panelSelector(chatId)} [data-chat-scroll-viewport]`)
    .evaluate(async (element) => {
      const viewport = element as HTMLElement;
      function capture() {
        const top = viewport.getBoundingClientRect().top;
        const row = [
          ...viewport.querySelectorAll<HTMLElement>("[data-chat-virtual-item]"),
        ].find(
          (item) =>
            item.getBoundingClientRect().bottom > top + 1 &&
            item.querySelector("[data-chat-row-id]"),
        );
        const rowId =
          row?.querySelector<HTMLElement>("[data-chat-row-id]")?.dataset
            .chatRowId;
        if (!row || !rowId) throw new Error("Missing reading anchor");
        return { rowId, offset: row.getBoundingClientRect().top - top };
      }
      let previous = capture();
      let stableFrames = 0;
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const current = capture();
        const stable =
          previous.rowId === current.rowId &&
          Math.abs(previous.offset - current.offset) <= 0.5;
        stableFrames = stable ? stableFrames + 1 : 0;
        if (stableFrames >= 8) return current;
        previous = current;
      }
      throw new Error("Reading anchor did not settle");
    });
}

test("seeds a replacement layout after outgoing persistence flushes", async () => {
  await withChromiumFixture("fullscreen-layout-seed-after-flush", async (fixture) => {
    const chatIds = await seedChats(fixture, 3);
    const previousLayout = chatLayout(chatIds.slice(0, 2));
    await fixture.page.addInitScript((layout) => {
      window.addEventListener("pagehide", () => {
        // Models a pending app-owned write without relying on the debounce timing.
        if (document.scripts.length === 0) return;
        localStorage.setItem("workspace_layout_v2", JSON.stringify(layout));
        sessionStorage.setItem("fixture:outgoing-layout-flushed", "true");
      });
    }, previousLayout);
    await openLayout(fixture, chatIds.slice(0, 2));
    await openLayout(fixture, chatIds);
    expect(await fixture.page.evaluate(() =>
      sessionStorage.getItem("fixture:outgoing-layout-flushed"),
    )).toBe("true");
    expect(await fixture.page.locator("[data-conversation-panel]").count()).toBe(3);
  });
});

test.each([false, true])(
  "retains 2, 8, and 25 Chat trees through fullscreen (combined=%s)",
  async (combined) => {
    await withChromiumFixture(
      `fullscreen-chat-retention-${combined}`,
      async (fixture) => {
        await fixture.page.setViewportSize({ width: 3840, height: 2160 });
        await fixture.context.addInitScript(seedLocalSettings, {
          combineToolUseMessages: combined,
          showQuickCommitTray: false,
        });
        const chatIds = await seedChats(fixture, 25);
        await observeChatIngestion(fixture);
        const transcriptReads: string[] = [];
        fixture.page.on("request", (request) => {
          if (
            /\/chats\/(?:combined-)?messages$/.test(
              new URL(request.url()).pathname,
            )
          )
            transcriptReads.push(request.url());
        });
        for (const count of [2, 8, 25]) {
          await openLayout(fixture, chatIds.slice(0, count));
          await fixture.page
            .locator("[data-composer] textarea")
            .fill("Retained composer draft");
          await fixture.page
            .locator("[data-conversation-panel], [data-chat-virtual-sizer]")
            .evaluateAll((elements) => {
              elements.forEach(
                (element, index) =>
                  ((element as HTMLElement).dataset.retentionMarker =
                    String(index)),
              );
            });
          const persisted = await fixture.page.evaluate(() =>
            localStorage.getItem("workspace_layout_v2"),
          );
          transcriptReads.length = 0;
          for (let round = 0; round < 2; round++) {
            await toggleFullscreen(fixture.page, true);
            expect(
              await fixture.page.locator("[data-conversation-panel]").count(),
            ).toBe(count);
            const hidden = await fixture.page
              .locator("[data-workspace-window-id].hidden")
              .evaluateAll((windows) =>
                windows.map((window) => ({
                  inert: (window as HTMLElement).inert,
                  ariaHidden: window.getAttribute("aria-hidden"),
                  ownsComposer:
                    window.querySelector(
                      "[data-conversation-panel-composer-anchor]",
                    ) !== null,
                  ownsCommands:
                    window.querySelector(
                      "[data-conversation-panel-command-owner]",
                    ) !== null,
                  managedScroll:
                    window.querySelector(
                      '[data-workspace-scroll-region="primary"]',
                    ) !== null,
                  liveAnnouncements:
                    window.querySelector(
                      '[aria-live]:not([aria-live="off"])',
                    ) !== null,
                })),
              );
            expect(hidden).toEqual(
              Array.from({ length: count - 1 }, () => ({
                inert: true,
                ariaHidden: "true",
                ownsComposer: false,
                ownsCommands: false,
                managedScroll: false,
                liveAnnouncements: false,
              })),
            );
            if (count === 25 && round === 0) {
              const counts = await hiddenModelCounts(fixture.page);
              await fixture.page.evaluate(() => {
                (globalThis as ChatIngestionScope).__fullscreenChatFrontiers =
                  {};
              });
              await Promise.all(
                chatIds.slice(1).map(async (chatId, index) => {
                  const turn = await fixture.integration.client.runDirectChat({
                    chatId,
                    content: `retained-concurrent-${index}`,
                    agent: fixture.integration.directAgents.openAi,
                  });
                  await fixture.integration.client.waitForTurnTerminal(
                    chatId,
                    turn.turnId,
                  );
                }),
              );
              await fixture.page.waitForFunction(
                (ids) =>
                  ids.every(
                    (id) =>
                      (globalThis as ChatIngestionScope)
                        .__fullscreenChatFrontiers[id] > 0,
                  ),
                chatIds.slice(1),
              );
              expect(await hiddenModelCounts(fixture.page)).toEqual(counts);
            }
            await toggleFullscreen(fixture.page, false);
            await waitForReadyPanels(fixture.page, count);
            if (count === 25 && round === 0) {
              for (let index = 1; index < chatIds.length; index++) {
                await fixture.page
                  .locator(panelSelector(chatIds[index]!))
                  .getByText(`echo:retained-concurrent-${index - 1}`, {
                    exact: true,
                  })
                  .waitFor();
              }
            }
            expect(
              await fixture.page
                .locator("[data-conversation-panel], [data-chat-virtual-sizer]")
                .evaluateAll((elements) =>
                  elements.every(
                    (element, index) =>
                      (element as HTMLElement).dataset.retentionMarker ===
                      String(index),
                  ),
                ),
            ).toBe(true);
            expect(
              await fixture.page
                .locator("[data-composer] textarea")
                .inputValue(),
            ).toBe("Retained composer draft");
            expect(
              await fixture.page.evaluate(() =>
                localStorage.getItem("workspace_layout_v2"),
              ),
            ).toBe(persisted);
          }
          expect(transcriptReads).toEqual([]);
        }
        fixture.assertNoBrowserErrors();
      },
    );
  },
  180_000,
);

test("restores a retained reader after hidden live appends and a width change", async () => {
  await withChromiumFixture(
    "fullscreen-chat-retained-reader",
    async (fixture) => {
      await fixture.page.setViewportSize({ width: 1440, height: 900 });
      await fixture.context.addInitScript(seedLocalSettings, {
        showQuickCommitTray: false,
      });
      const chatIds = await seedChats(fixture, 2);
      await observeChatIngestion(fixture);
      await openLayout(fixture, chatIds);
      const reader = chatIds[1]!;
      const viewport = fixture.page.locator(
        `${panelSelector(reader)} [data-chat-scroll-viewport]`,
      );
      await viewport.evaluate((element) => {
        const feed = element as HTMLElement;
        feed.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: -600 }),
        );
        feed.scrollTop = (feed.scrollHeight - feed.clientHeight) / 2;
        feed.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const before = await readingAnchor(fixture.page, reader);
      const sizer = fixture.page.locator(
        `${panelSelector(reader)} [data-chat-virtual-sizer]`,
      );
      const modelCount = await sizer.getAttribute(
        "data-chat-virtual-model-count",
      );
      await toggleFullscreen(fixture.page, true);
      await fixture.page.setViewportSize({ width: 1800, height: 900 });
      const turn = await fixture.integration.client.runDirectChat({
        chatId: reader,
        content: "Synthetic hidden live append",
        agent: fixture.integration.directAgents.openAi,
      });
      await fixture.integration.client.waitForTurnTerminal(reader, turn.turnId);
      const frontier = await fixture.integration.client.getMessages(reader, {
        limit: 1,
      });
      await fixture.page.waitForFunction(
        ({ chatId, ordinal }) =>
          ((globalThis as ChatIngestionScope).__fullscreenChatFrontiers[
            chatId
          ] ?? 0) >= ordinal,
        { chatId: reader, ordinal: frontier.lastOrdinal },
      );
      await fixture.page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await sizer.getAttribute("data-chat-virtual-model-count")).toBe(
        modelCount,
      );
      await toggleFullscreen(fixture.page, false);
      await waitForReadyPanels(fixture.page, 2);
      const after = await readingAnchor(fixture.page, reader);
      expect(after.rowId).toBe(before.rowId);
      expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
      await viewport.evaluate((element) => {
        const feed = element as HTMLElement;
        feed.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, deltaY: 600 }),
        );
        feed.scrollTop = feed.scrollHeight;
        feed.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await fixture.page
        .locator(panelSelector(reader))
        .getByText("echo:Synthetic hidden live append", { exact: true })
        .waitFor();
      fixture.assertNoBrowserErrors();
    },
  );
}, 180_000);

test("preserves an expanded tool group without restoring focus to a hidden Chat", async () => {
  await withChromiumFixture(
    "fullscreen-chat-retained-tools",
    async (fixture) => {
      await fixture.page.setViewportSize({ width: 1440, height: 900 });
      await fixture.context.addInitScript(seedLocalSettings, {
        combineToolUseMessages: true,
        showQuickCommitTray: false,
      });
      const at = "2026-01-01T00:00:00.000Z";
      const tools = Array.from({ length: 6 }, (_, index) => [
        new BashToolUseMessage(
          at,
          `synthetic-tool-${index}`,
          `echo synthetic-${index}`,
        ),
        new ToolResultMessage(
          at,
          `synthetic-tool-${index}`,
          { output: `synthetic-${index}`, exitCode: 0 },
          false,
        ),
      ]).flat();
      const chatIds = await seedChats(fixture, 2, tools);
      await openLayout(fixture, chatIds);
      const group = fixture.page.locator(
        `${panelSelector(chatIds[1]!)} [data-chat-tool-group]`,
      );
      await group.click();
      await fixture.page.waitForFunction(
        (selector) =>
          document.querySelector(selector)?.getAttribute("aria-expanded") ===
          "true",
        `${panelSelector(chatIds[1]!)} [data-chat-tool-group]`,
      );
      await group.evaluate(
        (element) =>
          ((element as HTMLElement).dataset.retentionMarker = "expanded-group"),
      );
      await toggleFullscreen(fixture.page, true);
      expect(await group.getAttribute("aria-expanded")).toBe("true");
      await toggleFullscreen(fixture.page, false);
      await waitForReadyPanels(fixture.page, 2);
      expect(await group.getAttribute("data-retention-marker")).toBe(
        "expanded-group",
      );
      expect(await group.getAttribute("aria-expanded")).toBe("true");
      expect(
        await fixture.page
          .locator(panelSelector(chatIds[1]!))
          .evaluate((panel) => panel.contains(document.activeElement)),
      ).toBe(false);
      fixture.assertNoBrowserErrors();
    },
  );
}, 180_000);

test("suspends a nonempty hidden queue and restores its current entries", async () => {
  await withChromiumFixture("fullscreen-chat-retained-queue", async (fixture) => {
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    const chatIds = await seedChats(fixture, 2);
    const queuedChat = chatIds[1]!;
    const prompt = "Synthetic held queue turn";
    const held = fixture.integration.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    try {
      await fixture.integration.client.runDirectChat({
        chatId: queuedChat, content: prompt, agent: fixture.integration.directAgents.openAi,
      });
      await held.received;
      await openLayout(fixture, chatIds);
      await fixture.integration.client.pauseQueue(queuedChat);
      for (let index = 0; index < 12; index++) {
        await fixture.integration.client.enqueueNew(queuedChat, `Synthetic queued entry ${index}`);
      }
      const queue = fixture.page.locator(`${panelSelector(queuedChat)} [data-queue-status-summary]`);
      await queue.getByText("12 queued", { exact: true }).waitFor();
      const list = queue.locator("[data-queue-list]");
      await list.evaluate(async element => {
        const viewport = element as HTMLElement;
        viewport.dataset.retentionMarker = "queue";
        viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
        viewport.dispatchEvent(new Event("scroll"));
        for (let frame = 0; frame < 6; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      });
      const anchor = await list.evaluate(element => {
        const top = element.getBoundingClientRect().top;
        const row = [...element.querySelectorAll<HTMLElement>("[data-queue-entry-id]")]
          .find(item => item.getBoundingClientRect().bottom > top + 1)!;
        return { id: row.dataset.queueEntryId!, offset: row.getBoundingClientRect().top - top };
      });
      await toggleFullscreen(fixture.page, true);
      const hiddenHeight = await list.locator("ol").getAttribute("style");
      const rowIds = () => list.locator("[data-queue-entry-id]")
        .evaluateAll(rows => rows.map(row => row.getAttribute("data-queue-entry-id")));
      const hiddenRows = await rowIds();
      await fixture.integration.client.enqueueNew(queuedChat, "Synthetic hidden queue entry");
      await queue.getByText("13 queued", { exact: true }).waitFor({ state: "attached" });
      expect(await list.locator("ol").getAttribute("style")).toBe(hiddenHeight);
      expect(await rowIds()).toEqual(hiddenRows);
      await toggleFullscreen(fixture.page, false);
      await fixture.page.waitForFunction(({ chatId, id, offset }) => {
        const viewport = document.querySelector(`[data-conversation-panel-chat-id="${chatId}"] [data-queue-list]`);
        const row = viewport?.querySelector(`[data-queue-entry-id="${id}"]`);
        return viewport && row && Math.abs(row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset) <= 1;
      }, { chatId: queuedChat, ...anchor });
      await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await queue.getByText("Synthetic hidden queue entry", { exact: true }).waitFor();
      expect(await list.getAttribute("data-retention-marker")).toBe("queue");
      fixture.assertNoBrowserErrors();
    } finally {
      held.releaseEcho();
    }
  });
}, 180_000);

test("cancels pending message long presses when fullscreen hides their Chat", async () => {
  await withChromiumFixture("fullscreen-chat-pending-message-menu", async fixture => {
    const { page } = fixture;
    await page.setViewportSize({ width: 1440, height: 900 });
    const at = "2026-01-01T00:00:00.000Z";
    const chatIds = await seedChats(fixture, 2, [
      new UserMessage(at, "Synthetic long-press input"),
      new AssistantMessage(at, "Synthetic long-press output"),
    ]);
    await openLayout(fixture, chatIds);
    await page.clock.install();
    for (const [pointerType, messageType] of [["touch", "assistant"], ["pen", "user"]]) {
      await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
      const trigger = page.locator(`${panelSelector(chatIds[1]!)} .${messageType}-message-context-target`).last();
      await trigger.evaluate((element, type) => {
        (element as HTMLElement).dataset.retentionMarker = "pending-menu";
        element.dispatchEvent(new PointerEvent("pointerdown", {
          bubbles: true, cancelable: true, pointerType: type, clientX: 24, clientY: 36,
        }));
      }, pointerType);
      await page.locator('[data-workspace-window-fullscreen="window-main"]').evaluate(element => (element as HTMLElement).click());
      await page.clock.runFor(800);
      expect(await trigger.getAttribute("data-retention-marker")).toBe("pending-menu");
      expect(await page.getByRole("menu").count()).toBe(0);
      await trigger.dispatchEvent("contextmenu");
      expect(await page.getByRole("menu").count()).toBe(0);
      await page.locator('[data-workspace-window-fullscreen="window-main"]').evaluate(element => (element as HTMLElement).click());
      await page.clock.resume();
      await waitForReadyPanels(page, 2);
      await trigger.dispatchEvent("contextmenu");
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("menu").waitFor({ state: "hidden" });
    }
    fixture.assertNoBrowserErrors();
  });
}, 180_000);
