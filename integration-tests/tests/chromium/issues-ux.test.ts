import { expect, test } from "bun:test";
import { parseIssueBootstrap } from "../../../common/issue-responses.js";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import {
  collapseCanonicalFilesWindow,
  clickWorkspaceWindowAddAction,
} from "../../support/chromium-workspace.js";
import { Deferred, withTimeout } from "../../support/deferred.js";
import type { Route } from "playwright";

test("mobile Issues opens, saves and closes without crypto.randomUUID", async () => {
  await withChromiumFixture(
    "issues-mobile-navigation",
    async ({ page, context, integration, browserErrors }) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setTouchEmulationEnabled", {
        enabled: true,
        maxTouchPoints: 1,
      });
      await context.addInitScript(() => {
        Object.defineProperty(crypto, "randomUUID", { value: undefined });
      });
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
      expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe(
        "undefined",
      );
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(true);
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
      await panel.getByRole("button", { name: "Project", exact: true }).click();
      const projects = page.getByRole("dialog", {
        name: "Project",
        exact: true,
      });
      expect(
        await projects.getByRole("button").first().textContent(),
      ).toContain("All projects");
      await projects
        .getByRole("button", { name: "Release", exact: true })
        .click();
      expect(
        await panel
          .getByRole("button", { name: "Project", exact: true })
          .textContent(),
      ).toContain("Release");
      await panel.getByRole("button", { name: "Project", exact: true }).click();
      await projects
        .getByRole("button", { name: "All projects", exact: true })
        .click();
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
      const projectTrigger = panel.getByRole("button", {
        name: "Project",
        exact: true,
      });
      const label = panel.getByLabel("Label", { exact: true });
      await label.fill("x".repeat(65));
      await projectTrigger.click();
      await projects
        .getByRole("button", { name: "Release", exact: true })
        .click();
      expect(await projectTrigger.getAttribute("aria-expanded")).toBe("true");
      expect(await projectTrigger.textContent()).toContain("All projects");
      expect(await label.inputValue()).toBe("x".repeat(65));
      expect(await panel.getByRole("alert").textContent()).toContain(
        "Invalid filter",
      );
      await page.keyboard.press("Escape");
      await panel.getByLabel("Label", { exact: true }).fill("bug");
      await panel.getByPlaceholder("Search issues…").press("Enter");
      await projectTrigger.click();
      await projects
        .getByRole("button", { name: "Release", exact: true })
        .click();
      expect(await projectTrigger.getAttribute("aria-expanded")).toBe("false");
      expect(await projectTrigger.textContent()).toContain("Release");
      await projectTrigger.click();
      await projects
        .getByRole("button", { name: "All projects", exact: true })
        .click();
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
      const detailGeometry = await panel
        .locator(".issue-detail")
        .evaluate((detail) => {
          const rect = (selector: string) =>
            detail.querySelector(selector)!.getBoundingClientRect();
          const identity = rect(".issue-detail-identity");
          const title = rect(".issue-detail-title");
          const status = rect(".issue-status-button");
          const buttons = [
            ...detail.querySelectorAll(
              ".issue-detail-title + .issue-actions button",
            ),
          ];
          return {
            identityAboveTitle: identity.bottom <= title.top,
            statusBelowTitle: status.top >= title.bottom,
            actions: buttons.map((button) => button.textContent?.trim()),
            assignmentBesideValue: detail.querySelector(
              ".issue-assignee-value",
            )!.textContent,
          };
        });
      expect(detailGeometry).toMatchObject({
        identityAboveTitle: true,
        statusBelowTitle: true,
        actions: ["Open", "Edit", "Close issue"],
      });
      expect(detailGeometry.assignmentBesideValue).toContain("Unassigned");
      expect(detailGeometry.assignmentBesideValue).toContain("Assign to me");
      const composer = panel.locator(".issue-composer");
      const comment = composer.getByRole("textbox", {
        name: "Comment",
        exact: true,
      });
      await comment.fill("Synthetic progress for refinement");
      expect(
        await comment.evaluate((input) => getComputedStyle(input).fontSize),
      ).toBe("16px");
      await composer
        .getByRole("button", { name: "Expand comment editor" })
        .click();
      const editor = page.getByRole("dialog", { name: "Comment", exact: true });
      const content = editor.locator('.cm-content[aria-label="Comment"]');
      await content.fill("Updated synthetic progress");
      await editor
        .getByRole("button", { name: "Close expanded editor" })
        .click();
      await editor.waitFor({ state: "detached" });
      expect(await comment.inputValue()).toBe("Updated synthetic progress");
      const target = integration.directAgents.openAi;
      await integration.client.updateSettings({
        ui: {
          promptRefinement: {
            agentId: target.agentId,
            model: target.provider.model,
            apiProviderId: target.provider.providerId,
            modelEndpointId: target.provider.endpointId,
            modelProtocol: target.provider.protocol,
            thinkingMode: "none",
          },
        },
      });
      const refinement = integration.fakeProviders.openAi.holdNext({
        model: target.provider.model,
      });
      await composer.getByRole("button", { name: "Refine prompt" }).click();
      const modelRequest = await refinement.received;
      try {
        expect(modelRequest.lastUserText).toContain(
          "The draft is an issue comment, not a chat prompt.",
        );
        expect(modelRequest.lastUserText).toContain(
          "Updated synthetic progress",
        );
        expect(
          await composer
            .getByRole("button", { name: "Comment", exact: true })
            .isDisabled(),
        ).toBe(true);
      } finally {
        refinement.releaseText("Refined synthetic progress");
      }
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>(
            ".issue-composer textarea",
          )?.value === "Refined synthetic progress",
      );
      await composer
        .getByRole("button", { name: "Comment", exact: true })
        .click();
      await panel
        .locator(".issue-comment")
        .getByText("Refined synthetic progress", { exact: true })
        .waitFor();
      await panel.getByRole("button", { name: "Back to issues" }).click();
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      expect(
        await panel.getByLabel("Label", { exact: true }).inputValue(),
      ).toBe("bug");
      await panel
        .getByRole("button", { name: "New issue", exact: true })
        .click();
      const create = page.getByRole("dialog");
      await create
        .getByLabel("Title", { exact: true })
        .fill("Synthetic mobile creation");
      await create.getByLabel("Project", { exact: true }).fill("Release");
      await create
        .getByRole("button", { name: "Create issue", exact: true })
        .click();
      await panel
        .getByRole("heading", {
          name: "Synthetic mobile creation",
          exact: true,
        })
        .waitFor();
      expect(
        await panel.locator(".issue-detail-identity .issue-id").textContent(),
      ).toBe("G-2");
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
      await page
        .locator(".issue-browser > .issue-notice")
        .getByRole("button", { name: "Discard draft" })
        .click();
      expect(
        await page
          .getByText("Synthetic rejected move", { exact: true })
          .count(),
      ).toBe(0);
      expect(
        await page.getByRole("button", { name: "Keep editing" }).count(),
      ).toBe(0);
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
          const search = rect(".issue-project-picker");
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
      const searchGeometry = await mobileIssuesPanel
        .locator(".issues-toolbar")
        .evaluate((toolbar) => {
          const input = toolbar
            .querySelector(".issue-search input")!
            .getBoundingClientRect();
          const clear = toolbar
            .querySelector(".issue-search-row button")!
            .getBoundingClientRect();
          const filters = toolbar
            .querySelector(".issue-filter-options")!
            .getBoundingClientRect();
          const bounds = toolbar.getBoundingClientRect();
          return {
            clearOnRight:
              clear.left >= input.right && clear.right <= bounds.right,
            aligned:
              Math.abs(clear.top - input.top) < 1 &&
              Math.abs(clear.height - input.height) < 1,
            bottomGap: bounds.bottom - filters.bottom,
            hasFooter: toolbar.querySelector(".issue-filter-footer") !== null,
          };
        });
      expect(searchGeometry.clearOnRight).toBe(true);
      expect(searchGeometry.aligned).toBe(true);
      expect(searchGeometry.bottomGap).toBeLessThanOrEqual(13);
      expect(searchGeometry.hasFooter).toBe(false);
      await mobileIssuesPanel
        .getByRole("button", { name: "Clear", exact: true })
        .click();
      expect(
        await mobileIssuesPanel.getByPlaceholder("Search issues…").inputValue(),
      ).toBe("");
      expect(
        await mobileIssuesPanel
          .getByRole("button", { name: "In review · 0", exact: true })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      await mobileIssuesPanel
        .getByRole("button", { name: "Open · 1", exact: true })
        .click();
      await mobileIssuesPanel
        .getByRole("button", { name: "Open G-1", exact: true })
        .waitFor();
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
