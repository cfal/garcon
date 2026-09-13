import { describe, expect, test } from "bun:test";
import {
  parseTicketBootstrap,
  parseTicketDetail,
} from "../../../common/ticket-responses.js";
import { parseTicketWriteResult } from "../../../common/ticket-records.js";
import type { TicketMutationPayload } from "../../../common/ticket-commands.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  clickWorkspaceWindowAddAction,
  collapseCanonicalFilesWindow,
} from "../../support/chromium-workspace.js";

describe("Chromium Tickets interaction", () => {
  test("keeps newer editor focus while a status completion waits for authoritative counts", async () => {
    await withChromiumFixture("tickets-status-focus-owner", async (fixture) => {
      const { page, integration } = fixture;
      const bootstrap = parseTicketBootstrap(
        await integration.client.get("/api/v1/tickets/bootstrap"),
      );
      for (let number = 1; number <= 2; number++) {
        await integration.client.post("/api/v1/tickets/mutate", {
          requestId: crypto.randomUUID(),
          expectedStoreId: bootstrap.storeId,
          payload: {
            action: "create",
            input: { title: `Synthetic ticket ${number}`, project: "Release" },
          },
        });
      }
      await page.goto(integration.garcon.baseUrl, {
        waitUntil: "domcontentloaded",
      });
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Tickets");
      await page
        .getByRole("button", { name: "Ticket view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Board", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Open G-2", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const title = page.getByLabel("Title", { exact: true });
      await title.fill("Newer unsaved title");
      const status = page.getByRole("button", {
        name: "Change status of G-1",
      });
      await status.focus();
      await status.click();
      await page
        .getByRole("menuitem", { name: "Close ticket", exact: true })
        .click();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const captured = new Promise<void>((resolve) => {
        started = resolve;
      });
      await page.route("**/api/v1/tickets/counts?*", async (route) => {
        started();
        await held;
        await route.continue();
      });
      try {
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Close ticket", exact: true })
          .click();
        await captured;
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        await title.focus();
        await title.evaluate((element: HTMLInputElement) =>
          element.setSelectionRange(2, 8, "backward"),
        );
        release();
        await page
          .locator('[data-ticket-id="G-1"]')
          .waitFor({ state: "hidden" });
        await page
          .getByText("This ticket is outside the current filters.", {
            exact: true,
          })
          .waitFor();
        expect(
          await title.evaluate((element: HTMLInputElement) => ({
            focused: document.activeElement === element,
            value: element.value,
            start: element.selectionStart,
            end: element.selectionEnd,
            direction: element.selectionDirection,
          })),
        ).toEqual({
          focused: true,
          value: "Newer unsaved title",
          start: 2,
          end: 8,
          direction: "backward",
        });
        fixture.assertNoBrowserErrors();
      } finally {
        release();
        await page.unroute("**/api/v1/tickets/counts?*");
      }
    });
  });

  test("preserves the visible collection anchor and focused row across a remote insert", async () => {
    await withChromiumFixture(
      "tickets-collection-anchor",
      async ({ page, integration, assertNoBrowserErrors }) => {
        const bootstrap = parseTicketBootstrap(
          await integration.client.get("/api/v1/tickets/bootstrap"),
        );
        const create = (title: string) =>
          integration.client.post("/api/v1/tickets/mutate", {
            requestId: crypto.randomUUID(),
            expectedStoreId: bootstrap.storeId,
            payload: {
              action: "create",
              input: { title, project: "Synthetic scroll project" },
            },
          });
        for (let index = 1; index <= 60; index++)
          await create(`Synthetic ticket ${index}`);
        await page.goto(integration.garcon.baseUrl, {
          waitUntil: "domcontentloaded",
        });
        await collapseCanonicalFilesWindow(page);
        await clickWorkspaceWindowAddAction(page, "Open Tickets");
        const row = page.locator('[data-ticket-id="G-35"]');
        await row.waitFor();
        await row.scrollIntoViewIfNeeded();
        await row.locator("button").first().focus();
        const snapshot = () =>
          page.locator('[data-ticket-scroll="list"]').evaluate((element) => {
            const top = element.getBoundingClientRect().top;
            const anchor = [
              ...element.querySelectorAll<HTMLElement>("[data-ticket-id]"),
            ].find((node) => node.getBoundingClientRect().bottom > top);
            return {
              id: anchor?.dataset.ticketId,
              offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
              focus:
                document.activeElement?.closest<HTMLElement>("[data-ticket-id]")
                  ?.dataset.ticketId,
            };
          });
        const before = await snapshot();
        await create("Synthetic newly inserted ticket");
        await page.waitForFunction(() =>
          document
            .querySelector(".ticket-list .ticket-counts")
            ?.textContent?.includes("61"),
        );
        const after = await snapshot();
        expect(after.id).toBe(before.id);
        expect(after.focus).toBe("G-35");
        expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);
        assertNoBrowserErrors();
      },
    );
  });

  test("retains a dirty editor through window transfer and rapid chat switching with incoming updates", async () => {
    await withChromiumFixture(
      "tickets-window-transfer",
      async (fixture, markPhase) => {
        const { page, integration } = fixture;
        const bootstrap = parseTicketBootstrap(
          await integration.client.get("/api/v1/tickets/bootstrap"),
        );
        const create = (title: string) =>
          integration.client.post("/api/v1/tickets/mutate", {
            requestId: crypto.randomUUID(),
            expectedStoreId: bootstrap.storeId,
            payload: {
              action: "create",
              input: { title, project: "Synthetic host project" },
            },
          });
        await create("Synthetic retained ticket");
        const chats: string[] = [];
        for (const content of [
          "Synthetic first chat",
          "Synthetic second chat",
        ]) {
          const chatId = integration.newChatId();
          const started = await integration.client.startDirectChat({
            chatId,
            content,
            projectPath: integration.dirs.project,
            agent: integration.directAgents.openAi,
          });
          await integration.client.waitForTurnTerminal(chatId, started.turnId);
          chats.push(chatId);
        }
        await page.goto(
          `${integration.garcon.baseUrl}/chat/${chats[0]}?ticket=G-1`,
          { waitUntil: "domcontentloaded" },
        );
        await collapseCanonicalFilesWindow(page);
        await page.locator(".ticket-detail-title").waitFor();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const title = page.locator(".ticket-detail .ticket-title-input");
        await title.fill("Synthetic retained editor");
        await title.evaluate((element) => {
          if (!(element instanceof HTMLInputElement))
            throw new Error("Expected editor");
          element.focus();
          element.setSelectionRange(2, 9, "backward");
        });
        const owner = await page
          .locator('[data-workspace-window-active-surface="singleton:tickets"]')
          .getAttribute("data-workspace-window-id");
        markPhase("moving the editor into a different window");
        await page
          .locator(`[id="${owner}-tab-singleton:tickets"]`)
          .click({ button: "right" });
        await page
          .getByRole("menuitem", {
            name: "Move to new window right",
            exact: true,
          })
          .click();
        await page.waitForFunction(
          (previous) =>
            document
              .querySelector(
                '[data-workspace-window-active-surface="singleton:tickets"]',
              )
              ?.getAttribute("data-workspace-window-id") !== previous,
          owner,
        );
        await title.waitFor();
        expect(
          await title.evaluate((element) => {
            if (!(element instanceof HTMLInputElement))
              throw new Error("Expected editor");
            return {
              value: element.value,
              focused: element === document.activeElement,
              start: element.selectionStart,
              end: element.selectionEnd,
            };
          }),
        ).toEqual({
          value: "Synthetic retained editor",
          focused: true,
          start: 2,
          end: 9,
        });
        markPhase("switching chats while ticket updates arrive");
        for (let index = 0; index < 6; index++) {
          await page
            .locator(`[data-sidebar-virtual-row="${chats[index % 2]}"]`)
            .click();
          await create(`Synthetic background update ${index}`);
        }
        await page.locator('[role="tab"][id$="-tab-singleton:tickets"]').click();
        await title.waitFor({ state: "visible" });
        expect(await title.inputValue()).toBe("Synthetic retained editor");
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test("renders a persisted single-status lane at 390px", async () => {
    await withChromiumFixture(
      "tickets-narrow-restored-lane",
      async ({ page, context, integration, assertNoBrowserErrors }) => {
        const bootstrap = parseTicketBootstrap(
          await integration.client.get("/api/v1/tickets/bootstrap"),
        );
        const mutate = (payload: TicketMutationPayload) =>
          integration.client.post("/api/v1/tickets/mutate", {
            requestId: crypto.randomUUID(),
            expectedStoreId: bootstrap.storeId,
            payload,
          });
        await mutate({
          action: "create",
          input: { title: "Synthetic review ticket", project: "Release" },
        });
        await mutate({
          action: "update",
          ticketId: "G-1",
          expectedRevision: 1,
          patch: { status: "in-review" },
        });
        await context.addInitScript(() =>
          localStorage.setItem(
            "garcon-tickets-preferences-v1",
            JSON.stringify({
              version: 1,
              layout: "board",
              query: { status: "in-review" },
            }),
          ),
        );
        await page.setViewportSize({ width: 390, height: 900 });
        await page.goto(`${integration.garcon.baseUrl}/?ticket=G-1`, {
          waitUntil: "domcontentloaded",
        });
        await page.locator(".ticket-detail-title").waitFor();
        await page
          .locator(".tickets-surface")
          .getByRole("button", { name: "Back to tickets", exact: true })
          .click();
        const lane = page.locator('.ticket-lane[data-status="in-review"]');
        await lane.waitFor({ state: "visible" });
        expect(await lane.getAttribute("data-active")).toBe("true");
        expect(await lane.locator('[data-ticket-id="G-1"]').isVisible()).toBe(
          true,
        );
        assertNoBrowserErrors();
      },
    );
  });

  test("preserves dirty text, focus and selection across responsive hosts and remote updates", async () => {
    await withChromiumFixture(
      "tickets-responsive-focus",
      async (fixture, markPhase) => {
        const { page, integration } = fixture;
        const bootstrap = parseTicketBootstrap(
          await integration.client.get("/api/v1/tickets/bootstrap"),
        );
        const mutate = async (payload: TicketMutationPayload) =>
          parseTicketWriteResult(
            await integration.client.post("/api/v1/tickets/mutate", {
              requestId: crypto.randomUUID(),
              expectedStoreId: bootstrap.storeId,
              payload,
            }),
          );
        await mutate({
          action: "create",
          input: {
            title: "Synthetic focused ticket",
            project: "Synthetic release",
          },
        });
        markPhase("opening a deep-linked ticket without a chat");
        await page.goto(`${integration.garcon.baseUrl}/?ticket=G-1`, {
          waitUntil: "domcontentloaded",
        });
        await page.locator(".ticket-detail-title").waitFor();
        await collapseCanonicalFilesWindow(page);
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const title = page.locator(".ticket-detail .ticket-title-input");
        await title.fill("Unsaved synthetic title");
        await title.evaluate((element) => {
          if (!(element instanceof HTMLInputElement))
            throw new Error("Expected title input");
          element.focus();
          element.setSelectionRange(2, 10, "backward");
        });
        markPhase("refreshing without replacing the editor");
        await mutate({
          action: "update",
          ticketId: "G-1",
          expectedRevision: 1,
          patch: { title: "Remote synthetic title" },
        });
        await page.waitForFunction(
          () =>
            document.querySelector(".ticket-row-title")?.textContent ===
            "Remote synthetic title",
        );
        expect(await title.inputValue()).toBe("Unsaved synthetic title");
        expect(
          await title.evaluate((element) => {
            if (!(element instanceof HTMLInputElement))
              throw new Error("Expected title input");
            return {
              focused: element === document.activeElement,
              start: element.selectionStart,
              end: element.selectionEnd,
            };
          }),
        ).toEqual({ focused: true, start: 2, end: 10 });
        for (const width of [768, 390, 1440]) {
          markPhase(`restoring the editor at ${width}px`);
          await page.setViewportSize({ width, height: 900 });
          await title.waitFor({ state: "visible" });
          await page.waitForFunction(() => {
            const input = document.querySelector<HTMLInputElement>(
              ".ticket-detail .ticket-title-input",
            );
            return (
              input === document.activeElement &&
              input?.selectionStart === 2 &&
              input.selectionEnd === 10
            );
          });
          expect(await title.inputValue()).toBe("Unsaved synthetic title");
          expect(
            await page
              .locator("[data-tickets-panel]")
              .evaluate(
                (element) => element.scrollWidth <= element.clientWidth + 1,
              ),
          ).toBe(true);
        }
        markPhase("honoring explicit focus outside the surface during refresh");
        const outside = page
          .locator("[data-workspace-window-fullscreen]")
          .first();
        await outside.focus();
        await mutate({
          action: "comment",
          ticketId: "G-1",
          body: "Synthetic remote comment",
        });
        await page.locator("[data-comment-id]").waitFor();
        expect(
          await outside.evaluate(
            (element) => element === document.activeElement,
          ),
        ).toBe(true);
        for (const dark of [true, false]) {
          await page.evaluate(
            (enabled) =>
              document.documentElement.classList.toggle("dark", enabled),
            dark,
          );
          expect(
            await title.evaluate((element) => getComputedStyle(element).color),
          ).not.toBe("rgba(0, 0, 0, 0)");
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await title.inputValue()).toBe("Unsaved synthetic title");
        fixture.assertNoBrowserErrors();
      },
    );
  });

  test("moves status with the pointer and keeps a keyboard-accessible equivalent", async () => {
    await withChromiumFixture("tickets-status-drag", async (fixture) => {
      const { page, integration } = fixture;
      const bootstrap = parseTicketBootstrap(
        await integration.client.get("/api/v1/tickets/bootstrap"),
      );
      await integration.client.post("/api/v1/tickets/mutate", {
        requestId: crypto.randomUUID(),
        expectedStoreId: bootstrap.storeId,
        payload: {
          action: "create",
          input: {
            title: "Synthetic draggable ticket",
            project: "Synthetic release",
          },
        },
      });
      await page.goto(integration.garcon.baseUrl, {
        waitUntil: "domcontentloaded",
      });
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Tickets");
      await page
        .getByRole("button", { name: "Ticket view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Board", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const handle = page.locator('[data-ticket-id="G-1"] [data-ticket-drag]');
      await handle.waitFor();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-ticket-id="G-1"]')
            ?.getAttribute("draggable") === "true",
      );
      await handle.dragTo(
        page.locator('.ticket-lane[data-status="in-review"] h3'),
      );
      await page
        .locator(
          '.ticket-lane[data-status="in-review"] [data-ticket-id="G-1"][aria-busy="false"]',
        )
        .waitFor();
      const current = parseTicketDetail(
        await integration.client.get("/api/v1/tickets/detail?ticketId=G-1"),
      );
      expect(current.ticket.status).toBe("in-review");
      expect(current.ticket.assignee).toBeNull();
      const status = page.getByRole("button", {
        name: "Change status of G-1",
      });
      await status.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("menuitem", { name: "Close ticket", exact: true })
        .click();
      await page.getByRole("dialog").waitFor();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(
        parseTicketDetail(
          await integration.client.get("/api/v1/tickets/detail?ticketId=G-1"),
        ).ticket.status,
      ).toBe("in-review");
      await status.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("menuitem", { name: "Close ticket", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("textbox")
        .fill("Synthetic closing comment");
      let injectedReadFailures = 0;
      await page.route("**/api/v1/tickets/counts?*", (route) => {
        injectedReadFailures++;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Synthetic authoritative refresh unavailable",
            errorCode: "TICKET_STORAGE_UNAVAILABLE",
            retryable: false,
          }),
        });
      });
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Close ticket", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      const refreshError = page
        .locator(".ticket-browser > .ticket-notice")
        .filter({
          hasText: "Synthetic authoritative refresh unavailable",
        });
      await refreshError.waitFor();
      expect(await page.locator('[data-ticket-id="G-1"]').count()).toBe(1);
      expect(
        await page
          .locator('.tickets-surface > .sr-only[role="status"]')
          .textContent(),
      ).toBe("G-1 moved to In review.");
      await page.unroute("**/api/v1/tickets/counts?*");
      await refreshError
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await page
        .getByText("This ticket is outside the current filters.", {
          exact: true,
        })
        .waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement ===
          document.querySelector('.ticket-lane[data-status="open"] h3'),
      );
      expect(await page.locator('[data-ticket-id="G-1"]').count()).toBe(0);
      expect(
        parseTicketDetail(
          await integration.client.get("/api/v1/tickets/detail?ticketId=G-1"),
        ).ticket.status,
      ).toBe("closed");
      const expectedFailure =
        "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
      expect(injectedReadFailures).toBeGreaterThan(0);
      const reportedFailures = fixture.browserErrors.filter(
        (error) => error === expectedFailure,
      );
      // Superseded reads can abort before Chromium emits a resource diagnostic.
      expect(reportedFailures.length).toBeGreaterThan(0);
      expect(reportedFailures.length).toBeLessThanOrEqual(injectedReadFailures);
      for (let index = fixture.browserErrors.length - 1; index >= 0; index--) {
        if (fixture.browserErrors[index] === expectedFailure)
          fixture.browserErrors.splice(index, 1);
      }
      fixture.assertNoBrowserErrors();
    });
  });
});
