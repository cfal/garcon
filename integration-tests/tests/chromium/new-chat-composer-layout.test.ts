import { describe, expect, test } from "bun:test";
import type { Locator } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";

async function openNewChat(fixture: ChromiumFixture): Promise<Locator> {
  const response = await fixture.page.goto(fixture.integration.garcon.baseUrl, {
    waitUntil: "domcontentloaded",
  });
  if (!response?.ok())
    throw new Error(`SPA navigation failed with ${response?.status()}.`);

  await fixture.page
    .getByRole("button", { name: "New Chat", exact: true })
    .click();
  await fixture.page
    .getByRole("status", { name: "Loading chat defaults..." })
    .waitFor({ state: "detached" });
  return fixture.page.getByRole("dialog").filter({
    has: fixture.page.locator('[data-slot="composer-bottom-bar"]'),
  });
}

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing layout bounds.");
  return box;
}

describe("Chromium New Chat composer layout", () => {
  test("keeps compact actions and floating surfaces inside constrained viewports", async () => {
    await withChromiumFixture(
      "new-chat-composer-layout",
      async (fixture, markPhase) => {
        markPhase("opening New Chat at phone width");
        await fixture.page.setViewportSize({ width: 390, height: 844 });
        const dialog = await openNewChat(fixture);
        const bottomBar = dialog.locator('[data-slot="composer-bottom-bar"]');

        markPhase("checking responsive composer actions");
        await bottomBar
          .getByRole("button", { name: "More composer actions" })
          .waitFor({ state: "visible" });
        expect(
          await bottomBar
            .getByRole("button", { name: "Open expanded composer" })
            .count(),
        ).toBe(0);
        expect(
          await bottomBar
            .getByRole("button", { name: "Refine prompt" })
            .count(),
        ).toBe(0);
        await bottomBar
          .getByRole("button", { name: "More composer actions" })
          .click();
        await fixture.page
          .getByRole("menuitem", { name: "Open expanded composer" })
          .waitFor();
        await fixture.page
          .getByRole("menuitem", { name: "Refine prompt" })
          .waitFor();
        await fixture.page.keyboard.press("Escape");

        markPhase("checking the compact Add menu");
        const addTrigger = bottomBar.getByRole("button", {
          name: "Add to prompt",
        });
        await addTrigger.click();
        const addMenu = fixture.page.getByRole("menu");
        const [triggerBox, menuBox] = await Promise.all([
          bounds(addTrigger),
          bounds(addMenu),
        ]);
        expect(menuBox.width).toBeLessThanOrEqual(256);
        expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(triggerBox.y);
        expect(menuBox.x).toBeGreaterThanOrEqual(8);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(382);
        await fixture.page.keyboard.press("Escape");

        markPhase(
          "checking model-selector collision margins at the sm boundary",
        );
        await fixture.page.setViewportSize({ width: 640, height: 900 });
        await bottomBar.getByRole("button", { name: /Claude .* Opus/ }).click();
        const modelPopover = fixture.page.locator(
          '[data-slot="popover-content"]',
        );
        await modelPopover.waitFor({ state: "visible" });
        const [dialogBox, popoverBox] = await Promise.all([
          bounds(dialog),
          bounds(modelPopover),
        ]);
        expect(dialogBox.width).toBeGreaterThanOrEqual(600);
        expect(dialogBox.x).toBeGreaterThanOrEqual(8);
        expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(632);
        expect(popoverBox.x).toBeGreaterThanOrEqual(8);
        expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(632);
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
