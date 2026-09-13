import { expect, test } from "bun:test";
import { parseIssueBootstrap } from "../../../common/issue-responses.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  collapseCanonicalFilesWindow,
  clickWorkspaceWindowAddAction,
} from "../../support/chromium-workspace.js";
import { Deferred, withTimeout } from "../../support/deferred.js";
import type { Route } from "playwright";

test("mobile Issues opens from the chat menu, fills the panel and closes back to chat", async () => {
  await withChromiumFixture(
    "issues-mobile-navigation",
    async ({ page, context, integration, browserErrors }) => {
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId,
        content: "Synthetic mobile Issues navigation",
        projectPath: integration.dirs.project,
        agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      const bootstrap = parseIssueBootstrap(
        await integration.client.get("/api/v1/issues/bootstrap"),
      );
      await integration.client.post("/api/v1/issues/mutate", {
        requestId: crypto.randomUUID(),
        expectedStoreId: bootstrap.storeId,
        payload: {
          action: "create",
          input: {
            title: "Synthetic mobile issue",
            project: "Release",
            labels: ["bug"],
          },
        },
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      await page.locator("[data-mobile-current-chat-menu] button").click();
      await page
        .getByRole("menuitem", { name: "Open Issues", exact: true })
        .click();
      const panel = page.locator(
        '[id="mobile-panel-singleton:issues"][aria-hidden="false"]',
      );
      await panel.getByRole("button", { name: "Open G-1" }).waitFor();
      expect(
        await panel.getByRole("button", { name: "Back", exact: true }).count(),
      ).toBe(0);
      expect(await panel.getByPlaceholder("Search issues…").isVisible()).toBe(
        false,
      );
      const compactGeometry = await panel
        .locator(".issue-toolbar-heading")
        .evaluate((heading) => {
          const controls = [
            ...heading.querySelectorAll("input, button"),
          ].filter((item) => item.getBoundingClientRect().width > 0);
          const bounds = heading.getBoundingClientRect();
          return controls.every((item) => {
            const rect = item.getBoundingClientRect();
            return (
              rect.left >= bounds.left &&
              rect.right <= bounds.right + 1 &&
              Math.abs(
                rect.top + rect.height / 2 - (bounds.top + bounds.height / 2),
              ) < 1
            );
          });
        });
      expect(compactGeometry).toBe(true);
      const rowGutters = await panel.locator(".issue-row").evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const list = row.parentElement!.getBoundingClientRect();
        return {
          left: bounds.left - list.left,
          right: list.right - bounds.right,
        };
      });
      expect(rowGutters.left).toBe(0);
      expect(rowGutters.right).toBeLessThanOrEqual(16);
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      await panel.getByLabel("Label", { exact: true }).fill("bug");
      await panel.getByPlaceholder("Search issues…").press("Enter");
      await panel.getByRole("button", { name: "Hide search options" }).click();
      const captured = new Deferred<Route>();
      await context.route("**/api/v1/issues/detail?*", async (route) => {
        if (!captured.resolve(route)) await route.continue();
      });
      await panel.getByRole("button", { name: "Open G-1" }).click();
      const held = await withTimeout(
        captured.promise,
        20_000,
        () => "Issue detail request was not captured",
      );
      try {
        await panel.locator(".issue-detail-status").waitFor();
        expect(await panel.locator(".issues-toolbar").isVisible()).toBe(false);
        const loadingGeometry = await panel
          .locator(".issue-detail-status")
          .evaluate((status) => {
            const region = status.getBoundingClientRect();
            const spinner = status
              .querySelector("svg")!
              .getBoundingClientRect();
            return {
              x: spinner.x + spinner.width / 2 - region.x - region.width / 2,
              y: spinner.y + spinner.height / 2 - region.y - region.height / 2,
            };
          });
        expect(Math.abs(loadingGeometry.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(loadingGeometry.y)).toBeLessThanOrEqual(1);
      } finally {
        await held.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Synthetic detail unavailable",
            errorCode: "ISSUE_STORAGE_UNAVAILABLE",
            retryable: true,
          }),
        });
      }
      await panel
        .locator(".issue-detail-status")
        .getByText("Synthetic detail unavailable")
        .waitFor();
      expect(await panel.locator(".issue-detail-status svg").count()).toBe(0);
      expect(await panel.locator(".issues-toolbar").isVisible()).toBe(false);
      await panel
        .locator(".issue-detail-status")
        .getByRole("button", { name: "Refresh" })
        .click();
      await panel.locator(".issue-detail-title").waitFor();
      expect(await panel.locator(".issues-toolbar").isVisible()).toBe(false);
      await panel.getByRole("button", { name: "Back to issues" }).click();
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      expect(
        await panel.getByLabel("Label", { exact: true }).inputValue(),
      ).toBe("bug");
      await panel.getByRole("button", { name: "Close Issues" }).click();
      await panel.waitFor({ state: "hidden" });
      await page.locator("[data-mobile-current-chat-menu]").waitFor();
      expect(browserErrors.filter((error) => !error.includes("503"))).toEqual(
        [],
      );
    },
  );
});

test("a rejected optimistic move restores the visible mobile lane", async () => {
  await withChromiumFixture(
    "issues-ux-move-rollback",
    async ({ page, context, integration, browserErrors }) => {
      const bootstrap = parseIssueBootstrap(
        await integration.client.get("/api/v1/issues/bootstrap"),
      );
      await integration.client.post("/api/v1/issues/mutate", {
        requestId: crypto.randomUUID(),
        expectedStoreId: bootstrap.storeId,
        payload: {
          action: "create",
          input: { title: "Synthetic rollback card", project: "Release" },
        },
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(integration.garcon.baseUrl);
      await clickWorkspaceWindowAddAction(page, "Open Issues");
      await page
        .getByRole("button", { name: "Issue view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Board", exact: true })
        .click();
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Open G-1", exact: true })
        .waitFor();
      const started = new Deferred<Route>();
      await context.route("**/api/v1/issues/mutate", async (route) => {
        if (!started.resolve(route)) await route.continue();
      });
      await page.getByRole("button", { name: "Change status of G-1" }).click();
      await page
        .getByRole("menuitem", { name: "In review", exact: true })
        .click();
      const held = await withTimeout(
        started.promise,
        20_000,
        () => "Move was not captured",
      );
      try {
        await page
          .locator('[data-status="in-review"] [data-issue-id="G-1"]')
          .waitFor();
        expect(
          await page.getByText("Saving…", { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await page
            .locator("[data-issue-search-button]")
            .getAttribute("aria-busy"),
        ).toBe("true");
        expect(await page.getByText(/Recovered drafts/).count()).toBe(0);
      } finally {
        await held.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            success: false,
            error: "Synthetic rejected move",
            errorCode: "ISSUE_REVISION_CONFLICT",
            retryable: false,
          }),
        });
      }
      await page
        .locator('[data-status="open"] [data-issue-id="G-1"]')
        .waitFor();
      expect(
        await page
          .getByRole("button", { name: "Open · 1", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await page
        .getByText("Synthetic rejected move", { exact: true })
        .first()
        .waitFor();
      expect(browserErrors.filter((error) => !error.includes("409"))).toEqual(
        [],
      );
    },
  );
});

test("Issues toolbar stays aligned and search retains the board until results arrive", async () => {
  await withChromiumFixture(
    "issues-ux-toolbar",
    async ({ page, context, integration, assertNoBrowserErrors }) => {
      const bootstrap = parseIssueBootstrap(
        await integration.client.get("/api/v1/issues/bootstrap"),
      );
      await integration.client.post("/api/v1/issues/mutate", {
        requestId: crypto.randomUUID(),
        expectedStoreId: bootstrap.storeId,
        payload: {
          action: "create",
          input: { title: "Synthetic retained card", project: "Release" },
        },
      });
      await page.setViewportSize({ width: 1920, height: 1000 });
      await page.goto(integration.garcon.baseUrl);
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Issues");
      await page
        .getByRole("button", { name: "Issue view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Board", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const card = page.locator('.issue-card[data-issue-id="G-1"]');
      await card.waitFor();
      const geometry = await page
        .locator(".issues-surface")
        .evaluate((panel) => {
          const rect = (selector: string) =>
            panel.querySelector(selector)!.getBoundingClientRect();
          const board = rect(".issue-board");
          const lanes = [...panel.querySelectorAll(".issue-lane")].map((lane) =>
            lane.getBoundingClientRect(),
          );
          const search = rect(".issue-project-control input");
          const button = rect("[data-issue-search-button]");
          const scroll = rect(".issue-lane-scroll");
          const item = rect(".issue-card");
          return {
            rightGap: board.right - lanes.at(-1)!.right,
            leftGap: lanes[0]!.left - board.left,
            widths: lanes.map((lane) => lane.width),
            searchCenter: search.y + search.height / 2,
            buttonCenter: button.y + button.height / 2,
            paddingLeft: item.left - scroll.left,
            paddingRight: scroll.right - item.right,
          };
        });
      expect(
        Math.abs(geometry.rightGap - geometry.leftGap),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.max(...geometry.widths) - Math.min(...geometry.widths),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.searchCenter - geometry.buttonCenter),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(geometry.paddingLeft - geometry.paddingRight),
      ).toBeLessThanOrEqual(1);
      const searchToggle = page.getByRole("button", {
        name: "Search",
        exact: true,
      });
      const beforeToggle = await searchToggle.boundingBox();
      await searchToggle.click();
      const afterToggle = await page
        .getByRole("button", { name: "Hide search options" })
        .boundingBox();
      expect(afterToggle?.x).toBe(beforeToggle?.x);
      expect(afterToggle?.y).toBe(beforeToggle?.y);
      expect(
        await page
          .getByRole("button", { name: "Filters", exact: true })
          .count(),
      ).toBe(0);
      const started = new Deferred<Route>();
      await context.route("**/api/v1/issues/counts?*", async (route) => {
        if (!started.resolve(route)) await route.continue();
      });
      await page
        .getByPlaceholder("Search issues…")
        .fill("No matching synthetic issue ".repeat(6));
      const beforeBoard = await page.locator(".issue-board").boundingBox();
      await page.getByPlaceholder("Search issues…").press("Enter");
      const held = await withTimeout(
        started.promise,
        20_000,
        () => "Search was not captured",
      );
      try {
        expect(await card.isVisible()).toBe(true);
        expect(await page.locator(".issue-board").boundingBox()).toEqual(
          beforeBoard,
        );
        expect(
          await page
            .locator(".issue-collection")
            .getByText("Loading issues…", { exact: true })
            .count(),
        ).toBe(0);
        expect(
          await page
            .locator("[data-issue-search-button]")
            .getAttribute("aria-busy"),
        ).toBe("true");
      } finally {
        await held.continue();
      }
      await card.waitFor({ state: "hidden" });
      await page
        .getByRole("combobox", { name: "Status", exact: true })
        .selectOption("in-review");
      await page
        .getByRole("combobox", { name: "Priority", exact: true })
        .selectOption("1");
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileIssuesPanel = page.locator(
        '[id="mobile-panel-singleton:issues"][aria-hidden="false"]',
      );
      await mobileIssuesPanel.waitFor();
      const mobileSearch = mobileIssuesPanel.locator(
        "[data-issue-search-button]",
      );
      if ((await mobileSearch.getAttribute("aria-expanded")) === "false")
        await mobileSearch.click();
      const chipGeometry = await mobileIssuesPanel
        .locator(".issue-filter-footer")
        .evaluate((footer) => {
          const strip = footer.querySelector(".issue-filter-chip-scroll")!;
          const footerRect = footer.getBoundingClientRect();
          const stripRect = strip.getBoundingClientRect();
          return {
            overflows: strip.scrollWidth > strip.clientWidth,
            inside:
              stripRect.top >= footerRect.top &&
              stripRect.bottom <= footerRect.bottom,
          };
        });
      expect(chipGeometry).toEqual({ overflows: true, inside: true });
      expect(
        await page.getByText("No issues yet", { exact: true }).count(),
      ).toBe(0);
      assertNoBrowserErrors();
    },
  );
});

test("card whitespace opens details and full-width detail preference survives reload", async () => {
  await withChromiumFixture(
    "issues-ux-details",
    async ({ page, integration, assertNoBrowserErrors }) => {
      const bootstrap = parseIssueBootstrap(
        await integration.client.get("/api/v1/issues/bootstrap"),
      );
      await integration.client.post("/api/v1/issues/mutate", {
        requestId: crypto.randomUUID(),
        expectedStoreId: bootstrap.storeId,
        payload: {
          action: "create",
          input: { title: "Synthetic clickable card", project: "Release" },
        },
      });
      await page.goto(integration.garcon.baseUrl);
      await collapseCanonicalFilesWindow(page);
      await clickWorkspaceWindowAddAction(page, "Open Issues");
      expect(
        await page
          .getByRole("button", { name: "Close Issues", exact: true })
          .count(),
      ).toBe(0);
      await page
        .getByRole("button", { name: "Issue view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Board", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const card = page.locator('.issue-card[data-issue-id="G-1"]');
      await page
        .getByRole("button", { name: "Issue view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", {
          name: "Always expand details",
        })
        .click();
      await page.keyboard.press("Escape");
      await card.click({ position: { x: 5, y: 5 } });
      await page.locator(".issue-detail-title").waitFor();
      expect(await page.locator(".issue-collection").isVisible()).toBe(false);
      expect(await page.locator(".issues-toolbar").isVisible()).toBe(false);
      const expandedGeometry = await page
        .locator(".issues-surface")
        .evaluate((panel) => {
          const detail = panel
            .querySelector(".issue-detail")!
            .getBoundingClientRect();
          const bounds = panel.getBoundingClientRect();
          return {
            top: detail.top - bounds.top,
            height: detail.height - bounds.height,
          };
        });
      expect(expandedGeometry).toEqual({ top: 0, height: 0 });
      await page.getByRole("button", { name: "Back to issues" }).click();
      expect(await card.isVisible()).toBe(true);
      await page.reload();
      await card.waitFor();
      await card.click({ position: { x: 5, y: 5 } });
      await page.locator(".issue-detail-title").waitFor();
      expect(await page.locator(".issue-collection").isVisible()).toBe(false);
      expect(await page.locator(".issues-toolbar").isVisible()).toBe(false);
      assertNoBrowserErrors();
    },
  );
});
