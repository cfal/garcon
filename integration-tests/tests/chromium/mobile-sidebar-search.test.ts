import { describe, expect, test } from "bun:test";
import type { CDPSession } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";

async function seedScrollableChatList(fixture: ChromiumFixture): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    const chatId = fixture.integration.newChatId();
    const accepted = await fixture.integration.client.startDirectChat({
      chatId,
      content: `mobile search result ${String(index).padStart(2, "0")}`,
      projectPath: fixture.integration.dirs.project,
      agent: fixture.integration.directAgents.openAi,
    });
    expect(
      (
        await fixture.integration.client.waitForTurnTerminal(
          chatId,
          accepted.turnId,
        )
      ).type,
    ).toBe("agent-run-finished");
  }
}

async function openMobileSearch(fixture: ChromiumFixture) {
  const cdp = await fixture.context.newCDPSession(fixture.page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await fixture.page.setViewportSize({ width: 390, height: 844 });
  const response = await fixture.page.goto(fixture.integration.garcon.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  if (!response?.ok())
    throw new Error(`SPA navigation failed with ${response?.status()}.`);

  await fixture.page.getByRole("button", { name: "Menu", exact: true }).click();
  const drawer = fixture.page.getByRole("dialog", { name: "Chats" });
  await drawer.waitFor();
  await drawer.getByRole("button", { name: "Search chats..." }).click();

  const searchDialog = fixture.page.getByRole("dialog", {
    name: "Search chats...",
  });
  await searchDialog.waitFor();
  return { cdp, drawer, searchDialog };
}

async function dragResultsUp(
  fixture: ChromiumFixture,
  cdp: CDPSession,
): Promise<void> {
  const results = fixture.page.locator('[data-slot="search-dialog-results"]');
  const bounds = await results.boundingBox();
  if (!bounds) throw new Error("Search results have no touch target bounds.");
  const x = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height - 40;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ id: 1, x, y: startY, radiusX: 1, radiusY: 1, force: 1 }],
  });
  for (const offset of [80, 160, 240, 320]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          id: 1,
          x,
          y: startY - offset,
          radiusX: 1,
          radiusY: 1,
          force: 1,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}

describe("Chromium mobile sidebar search", () => {
  test("keeps the full-screen search modal interactive and returns to the open drawer", async () => {
    await withChromiumFixture(
      "mobile-sidebar-search",
      async (fixture, markPhase) => {
        markPhase("seeding a scrollable chat list");
        await seedScrollableChatList(fixture);

        markPhase("opening search inside the mobile drawer");
        const { cdp, drawer, searchDialog } = await openMobileSearch(fixture);
        expect(
          await searchDialog.evaluate(
            (node) => getComputedStyle(node).pointerEvents,
          ),
        ).toBe("auto");
        expect(
          await fixture.page
            .locator("body")
            .evaluate((node) => node.style.pointerEvents),
        ).toBe("none");
        const phoneBounds = await searchDialog.boundingBox();
        expect(
          phoneBounds && {
            x: Math.round(phoneBounds.x),
            y: Math.round(phoneBounds.y),
            width: Math.round(phoneBounds.width),
            height: Math.round(phoneBounds.height),
          },
        ).toEqual({ x: 0, y: 0, width: 390, height: 844 });

        markPhase("checking icon-only mobile actions");
        for (const name of [
          "Sort search results: Best match",
          "Search help",
          "Add saved search",
          "Manage searches",
          "Close search",
        ]) {
          const action = searchDialog.getByRole("button", {
            name,
            exact: true,
          });
          await action.waitFor();
          expect((await action.textContent())?.trim()).toBe("");
          const bounds = await action.boundingBox();
          expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
        await fixture.page.setViewportSize({ width: 700, height: 844 });
        await fixture.page.waitForFunction(() => {
          const content = document.querySelector<HTMLElement>(
            "[data-search-dialog-content]",
          );
          if (!content) return false;
          const bounds = content.getBoundingClientRect();
          return Math.abs(bounds.x) < 1 && Math.abs(bounds.width - 700) < 1;
        });
        const tabletBounds = await searchDialog.boundingBox();
        expect(
          tabletBounds && {
            x: Math.round(tabletBounds.x),
            y: Math.round(tabletBounds.y),
            width: Math.round(tabletBounds.width),
            height: Math.round(tabletBounds.height),
          },
        ).toEqual({ x: 0, y: 0, width: 700, height: 844 });
        for (const name of [
          "Sort search results: Best match",
          "Search help",
          "Add saved search",
          "Manage searches",
          "Close search",
        ]) {
          const bounds = await searchDialog
            .getByRole("button", { name, exact: true })
            .boundingBox();
          expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
          expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
        }

        await searchDialog
          .getByRole("button", { name: "Search help", exact: true })
          .click();
        const helpDialog = fixture.page.getByRole("dialog").filter({
          has: fixture.page.getByRole("heading", {
            name: "Search help",
            exact: true,
          }),
        });
        await helpDialog.waitFor();
        const helpBounds = await helpDialog.boundingBox();
        expect(
          helpBounds && {
            x: Math.round(helpBounds.x),
            y: Math.round(helpBounds.y),
            width: Math.round(helpBounds.width),
            height: Math.round(helpBounds.height),
          },
        ).toEqual({ x: 0, y: 0, width: 700, height: 844 });
        await fixture.page.keyboard.press("Escape");
        await helpDialog.waitFor({ state: "detached" });
        await searchDialog.waitFor();

        await fixture.page.setViewportSize({ width: 390, height: 844 });
        await fixture.page.waitForFunction(() => {
          const content = document.querySelector<HTMLElement>(
            "[data-search-dialog-content]",
          );
          if (!content) return false;
          const bounds = content.getBoundingClientRect();
          return Math.abs(bounds.x) < 1 && Math.abs(bounds.width - 390) < 1;
        });

        markPhase("using search controls");
        await searchDialog
          .getByRole("button", {
            name: "Sort search results: Best match",
            exact: true,
          })
          .click();
        await fixture.page
          .getByRole("menuitemradio", {
            name: "Recent activity",
            exact: true,
          })
          .click();
        await searchDialog
          .getByRole("button", {
            name: "Sort search results: Recent activity",
            exact: true,
          })
          .waitFor();

        await searchDialog.getByRole("textbox").fill("mobile search");
        await searchDialog
          .getByRole("button", { name: "Add saved search", exact: true })
          .click();
        const editorDialog = fixture.page.getByRole("dialog").filter({
          has: fixture.page.getByRole("heading", {
            name: "Add saved search",
            exact: true,
          }),
        });
        await editorDialog.waitFor();
        await editorDialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await editorDialog.waitFor({ state: "detached" });
        await searchDialog.waitFor();

        await searchDialog
          .getByRole("button", { name: "Manage searches", exact: true })
          .click();
        const managerDialog = fixture.page.getByRole("dialog").filter({
          has: fixture.page.getByRole("heading", {
            name: "Manage saved searches",
            exact: true,
          }),
        });
        await managerDialog.waitFor();
        await fixture.page.keyboard.press("Escape");
        await managerDialog.waitFor({ state: "detached" });
        await searchDialog.waitFor();

        markPhase("scrolling the result viewport");
        const results = searchDialog.locator(
          '[data-slot="search-dialog-results"]',
        );
        await results.getByRole("option").first().waitFor();
        const geometry = await results.evaluate((node) => ({
          clientHeight: node.clientHeight,
          scrollHeight: node.scrollHeight,
        }));
        expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
        await dragResultsUp(fixture, cdp);
        await fixture.page.waitForFunction(
          () =>
            (document.querySelector<HTMLElement>(
              '[data-slot="search-dialog-results"]',
            )?.scrollTop ?? 0) > 0,
        );

        markPhase("closing search without dismissing the drawer");
        const urlBeforeClose = fixture.page.url();
        await searchDialog
          .getByRole("button", { name: "Close search", exact: true })
          .click();
        await searchDialog.waitFor({ state: "detached" });
        await drawer.waitFor();
        expect(fixture.page.url()).toBe(urlBeforeClose);
        expect(
          await drawer
            .getByRole("button", { name: "Search chats...", exact: true })
            .evaluate((node) => node === document.activeElement),
        ).toBe(true);

        markPhase("closing search with Escape without dismissing the drawer");
        await drawer
          .getByRole("button", { name: "Search chats...", exact: true })
          .click();
        await searchDialog.waitFor();
        await fixture.page.keyboard.press("Escape");
        await searchDialog.waitFor({ state: "detached" });
        await drawer.waitFor();
        expect(fixture.page.url()).toBe(urlBeforeClose);
        expect(
          await drawer
            .getByRole("button", { name: "Search chats...", exact: true })
            .evaluate((node) => node === document.activeElement),
        ).toBe(true);
        expect(
          await fixture.page
            .locator('[role="dialog"] [data-slot="composer-bottom-bar"]')
            .count(),
        ).toBe(0);
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
