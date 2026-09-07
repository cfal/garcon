import { describe, expect, test } from "bun:test";
import type { Locator } from "playwright";
import {
  withChromiumFixture,
  type ChromiumFixture,
} from "../../support/chromium-fixture.js";

const LONG_MODEL_LABEL =
  "Integration Echo With An Extended Mobile Display Name";

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

async function waitForAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

describe("Chromium New Chat composer layout", () => {
  test("keeps compact actions and floating surfaces inside constrained viewports", async () => {
    await withChromiumFixture(
      "new-chat-composer-layout",
      async (fixture, markPhase) => {
        markPhase("opening New Chat at phone width");
        await fixture.page.setViewportSize({ width: 390, height: 844 });
        const directProvider = fixture.integration.directAgents.openAi.provider;
        const modelUpdate = await fixture.page.request.put(
          `${fixture.integration.garcon.baseUrl}/api/v1/api-providers?id=${encodeURIComponent(directProvider.providerId)}`,
          {
            data: {
              endpoint: {
                models: [
                  { value: directProvider.model, label: LONG_MODEL_LABEL },
                ],
              },
            },
          },
        );
        expect(modelUpdate.ok()).toBe(true);
        const dialog = await openNewChat(fixture);
        const bottomBar = dialog.locator('[data-slot="composer-bottom-bar"]');
        await fixture.page.evaluate(() => {
          document.documentElement.style.setProperty(
            "--safe-area-inset-left",
            "12px",
          );
          document.documentElement.style.setProperty(
            "--safe-area-inset-right",
            "28px",
          );
        });
        await waitForAnimations(dialog);

        markPhase("checking iPhone safe-area containment");
        const dialogBoxAtPhoneWidth = await bounds(dialog);
        expect(dialogBoxAtPhoneWidth.x).toBeGreaterThanOrEqual(16);
        expect(
          dialogBoxAtPhoneWidth.x + dialogBoxAtPhoneWidth.width,
        ).toBeLessThanOrEqual(362);
        // The dialog clips horizontal overflow; the form must fit inside the
        // dialog instead of relying on the clip to hide it.
        expect(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);

        markPhase("checking content containment at 360px width");
        await fixture.page.setViewportSize({ width: 360, height: 844 });
        const dialogBoxAt360 = await bounds(dialog);
        expect(dialogBoxAt360.x).toBeGreaterThanOrEqual(16);
        expect(dialogBoxAt360.x + dialogBoxAt360.width).toBeLessThanOrEqual(344);
        expect(
          await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        await fixture.page.setViewportSize({ width: 390, height: 844 });

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

        markPhase("checking the compact model selector");
        await bottomBar.getByRole("button", { name: /Claude .* Opus/ }).click();
        const compactSelector = fixture.page.locator(
          '[data-slot="model-selector-compact"]',
        );
        await compactSelector.waitFor({ state: "visible" });
        const modelDialog = fixture.page.getByRole("dialog").filter({
          has: compactSelector,
        });
        await waitForAnimations(modelDialog);
        const doneButton = modelDialog.getByRole("button", { name: "Done" });
        const [modelDialogBox, doneButtonBox, overflow] = await Promise.all([
          bounds(modelDialog),
          bounds(doneButton),
          modelDialog.evaluate((node) => {
            const compact = node.querySelector<HTMLElement>(
              '[data-slot="model-selector-compact"]',
            );
            const footer = node.querySelector<HTMLElement>(
              '[data-slot="model-selector-compact-footer"]',
            );
            if (!compact || !footer)
              throw new Error("Missing compact model-selector layout.");
            return {
              dialogFits: node.scrollWidth <= node.clientWidth,
              compactFits: compact.scrollWidth <= compact.clientWidth,
              footerFits: footer.scrollWidth <= footer.clientWidth,
            };
          }),
        ]);
        expect(modelDialogBox.x).toBeGreaterThanOrEqual(16);
        expect(modelDialogBox.x + modelDialogBox.width).toBeLessThanOrEqual(
          362,
        );
        expect(doneButtonBox.x + doneButtonBox.width).toBeLessThanOrEqual(
          modelDialogBox.x + modelDialogBox.width - 8,
        );
        expect(overflow).toEqual({
          dialogFits: true,
          compactFits: true,
          footerFits: true,
        });

        markPhase("checking long model selection at phone width");
        await modelDialog.getByRole("button", { name: "Back" }).click();
        await modelDialog.getByRole("button", { name: "Back" }).click();
        await modelDialog
          .getByRole("button", { name: "Chat Completions", exact: true })
          .click();
        await modelDialog
          .getByRole("button", { name: "Integration Fake OpenAI", exact: true })
          .click();
        await modelDialog
          .getByRole("option", { name: LONG_MODEL_LABEL, exact: true })
          .click();
        await modelDialog.waitFor({ state: "detached" });

        const longModelTrigger = bottomBar.getByRole("button", {
          name: `Direct (Chat Completions) / Integration Fake OpenAI / ${LONG_MODEL_LABEL}`,
          exact: true,
        });
        const thinkingTrigger = bottomBar.locator(
          '[data-slot="thinking-mode-trigger"]',
        );
        const [addTriggerBox, thinkingTriggerBox, longModelTriggerBox] =
          await Promise.all([
            bounds(addTrigger),
            bounds(thinkingTrigger),
            bounds(longModelTrigger),
          ]);
        expect(thinkingTriggerBox.y).toBeCloseTo(addTriggerBox.y, 0);
        expect(longModelTriggerBox.y).toBeCloseTo(addTriggerBox.y, 0);
        expect(
          await longModelTrigger.evaluate((node) => {
            const label = node.querySelector<HTMLElement>(
              '[data-slot="model-selector-trigger-secondary"]',
            );
            return Boolean(label && label.scrollWidth > label.clientWidth);
          }),
        ).toBe(true);
        expect(
          await bottomBar.evaluate(
            (node) => node.scrollWidth <= node.clientWidth,
          ),
        ).toBe(true);

        await fixture.page.evaluate(() => {
          document.documentElement.style.removeProperty(
            "--safe-area-inset-left",
          );
          document.documentElement.style.removeProperty(
            "--safe-area-inset-right",
          );
        });

        markPhase(
          "checking model-selector collision margins at the sm boundary",
        );
        await fixture.page.setViewportSize({ width: 640, height: 900 });
        await bottomBar
          .getByRole("button", { name: "Open expanded composer" })
          .waitFor({ state: "visible" });
        expect(
          await bottomBar
            .getByRole("button", { name: "More composer actions" })
            .count(),
        ).toBe(0);
        await longModelTrigger.click();
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
