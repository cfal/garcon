import { expect, test } from "bun:test";
import { parseIssueBootstrap } from "../../../common/issue-responses.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  collapseCanonicalFilesWindow,
  clickWorkspaceWindowAddAction,
} from "../../support/chromium-workspace.js";
import { Deferred, withTimeout } from "../../support/deferred.js";
import type { Route } from "playwright";

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
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page
        .getByRole("button", { name: "Open ISS-1", exact: true })
        .waitFor();
      const started = new Deferred<Route>();
      await context.route("**/api/v1/issues/mutate", async (route) => {
        if (!started.resolve(route)) await route.continue();
      });
      await page
        .getByRole("button", { name: "Change status of ISS-1" })
        .click();
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
          .locator('[data-status="in-review"] [data-issue-id="ISS-1"]')
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
        .locator('[data-status="open"] [data-issue-id="ISS-1"]')
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
      await page.getByRole("button", { name: "Board", exact: true }).click();
      const card = page.locator('.issue-card[data-issue-id="ISS-1"]');
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
          const search = rect(".issue-search input");
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
      const filters = page.getByRole("button", {
        name: "Filters",
        exact: true,
      });
      const beforeFilter = await filters.boundingBox();
      await filters.click();
      const afterFilter = await filters.boundingBox();
      expect(afterFilter?.x).toBe(beforeFilter?.x);
      expect(afterFilter?.y).toBe(beforeFilter?.y);
      await filters.click();
      const started = new Deferred<Route>();
      await context.route("**/api/v1/issues/counts?*", async (route) => {
        if (!started.resolve(route)) await route.continue();
      });
      await page
        .getByPlaceholder("Search issues…")
        .fill("No matching synthetic issue ".repeat(6));
      const beforeBoard = await page.locator(".issue-board").boundingBox();
      await page.getByRole("button", { name: "Search", exact: true }).click();
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
          await page.getByText("Loading issues…", { exact: true }).count(),
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
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileIssuesPanel = page.locator(
        '[id="mobile-panel-singleton:issues"][aria-hidden="false"]',
      );
      await mobileIssuesPanel.waitFor();
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
      await page.getByRole("button", { name: "Board", exact: true }).click();
      const card = page.locator('.issue-card[data-issue-id="ISS-1"]');
      await card.click({ position: { x: 5, y: 5 } });
      await page.locator(".issue-detail-title").waitFor();
      await page
        .getByRole("button", { name: "Issue view settings", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", {
          name: "Always open details full width",
        })
        .click();
      await page.keyboard.press("Escape");
      expect(await page.locator(".issue-collection").isVisible()).toBe(false);
      await page.getByRole("button", { name: "Back to issues" }).click();
      expect(await card.isVisible()).toBe(true);
      await page.reload();
      await card.waitFor();
      await card.click({ position: { x: 5, y: 5 } });
      await page.locator(".issue-detail-title").waitFor();
      expect(await page.locator(".issue-collection").isVisible()).toBe(false);
      assertNoBrowserErrors();
    },
  );
});
