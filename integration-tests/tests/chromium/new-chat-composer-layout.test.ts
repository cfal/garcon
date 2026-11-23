import { describe, expect, test } from "bun:test";
import type { Locator } from "playwright";
import { expect as expectLocator } from "playwright/test";
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
            headers: {
              Authorization: `Bearer ${fixture.integration.garcon.authToken}`,
            },
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

        markPhase("opening both overflow menus at the tile width floor");
        await bottomBar.evaluate((bar) => { bar.style.width = '136px'; });
        const addTrigger = bottomBar.getByRole("button", { name: "More composer actions" });
        await addTrigger.click();
        const addMenu = fixture.page.getByRole("menu");
        for (const name of [/Add image/, /Snippets/, /Open expanded composer/, /Refine prompt/]) {
          await addMenu.getByRole("menuitem", { name }).waitFor();
        }
        const menuBox = await bounds(addMenu);
        expect(menuBox.width).toBeLessThanOrEqual(256);
        expect(menuBox.x).toBeGreaterThanOrEqual(8);
        expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(382);
        await fixture.page.keyboard.press("Escape");
        await addMenu.waitFor({ state: "detached" });

        markPhase("checking permission choices fit on a phone");
        const settingsMenu = bottomBar.getByRole("button", { name: "More model settings" });
        await settingsMenu.click();
        const settingsPopup = fixture.page.locator('[data-slot="dropdown-menu-content"]');
        await waitForAnimations(settingsPopup);
        await fixture.page.getByRole("menuitem", { name: /^Permission mode:/ }).click();
        const permissionMenu = fixture.page.locator('[data-slot="dropdown-menu-sub-content"]');
        await waitForAnimations(permissionMenu);
        const permissionBox = await bounds(permissionMenu);
        expect(permissionBox.x).toBeGreaterThanOrEqual(0);
        expect(permissionBox.x + permissionBox.width).toBeLessThanOrEqual(390);
        await permissionMenu.getByRole("menuitemradio", { name: /Plan Mode/ }).click();
        await settingsPopup.waitFor({ state: "detached" });
        await settingsMenu.click();
        await fixture.page.getByRole("menuitem", { name: "Permission mode: Plan Mode" }).waitFor();

        markPhase("opening the compact model picker from overflow");
        await fixture.page.getByRole("menuitem", { name: /Agent \/ model.*Claude.*Opus/ }).click();
        const compactSelector = fixture.page.locator(
          '[data-slot="model-selector-compact"]',
        );
        await compactSelector.waitFor({ state: "visible" });
        await bottomBar.evaluate((bar) => { bar.style.removeProperty("width"); });
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

        const longModelTrigger = bottomBar.locator('[data-slot="model-selector-trigger"]:visible');
        const send = bottomBar.getByRole("button", { name: "Start session" });
        await expectLocator(settingsMenu).toBeFocused();
        await expectLocator(longModelTrigger).toHaveCount(0);
        const [sendBox, settingsBox] = await Promise.all([bounds(send), bounds(settingsMenu)]);
        expect(settingsBox.y).toBeCloseTo(sendBox.y, 0);
        expect(settingsBox.x + settingsBox.width).toBeLessThanOrEqual(sendBox.x);
        await settingsMenu.click();
        const modelRow = fixture.page.getByRole("menuitem", { name: /Agent \/ model/ });
        const summary = modelRow.locator("[data-menu-description]");
        await expectLocator(summary).toHaveText(`Direct (Chat Completions) / ${LONG_MODEL_LABEL}`);
        expect(await summary.evaluate(node => node.scrollWidth <= node.clientWidth && getComputedStyle(node).whiteSpace !== 'nowrap')).toBe(true);
        await modelRow.click();
        await expectLocator(compactSelector).toBeVisible();
        await fixture.page.keyboard.press("Escape");
        await expectLocator(settingsMenu).toBeFocused();
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
        await expectLocator(longModelTrigger).toHaveText(LONG_MODEL_LABEL);
        await expectLocator(longModelTrigger).toHaveAccessibleName(LONG_MODEL_LABEL);
        await expectLocator(longModelTrigger).toHaveAccessibleDescription(`Direct (Chat Completions) / Integration Fake OpenAI / ${LONG_MODEL_LABEL}`);
        expect(await longModelTrigger.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
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
        markPhase("resizing a desktop tile with the model picker open");
        await bottomBar.evaluate((bar) => { bar.style.width = "196px"; });
        await settingsMenu.waitFor();
        expect(await modelPopover.isVisible()).toBe(true);
        await fixture.page.keyboard.press("Escape");
        await modelPopover.waitFor({ state: "detached" });
        await expectLocator(settingsMenu).toBeFocused();
        await settingsMenu.click();
        await fixture.page.getByRole("menuitem", { name: /Agent \/ model/ }).click();
        await modelPopover.waitFor();
        await bottomBar.evaluate((bar) => { bar.style.removeProperty("width"); });
        await longModelTrigger.waitFor();
        await modelPopover.getByRole("textbox").press("Enter");
        await modelPopover.waitFor({ state: "detached" });
        await expectLocator(longModelTrigger).toBeFocused();
        markPhase("restoring the agent prefix and every shortcut when the full row fits");
        await fixture.page.setViewportSize({ width: 1280, height: 900 });
        await dialog.evaluate(node => { node.style.maxWidth = node.style.width = '1000px'; });
        await expectLocator(longModelTrigger).toHaveText(`Direct (Chat Completions) ${LONG_MODEL_LABEL}`);
        await expectLocator(addTrigger).toHaveCount(0);
        await expectLocator(settingsMenu).toHaveCount(0);
        markPhase("dropping the agent prefix before folding any buttons");
        await bottomBar.evaluate(bar => {
          const [prompt, settings] = Array.from(bar.querySelectorAll('[data-composer-group]'),
            group => group.getBoundingClientRect());
          const spaceBetweenGroups = settings!.left - prompt!.right;
          bar.style.width = `${Math.floor(bar.getBoundingClientRect().width - spaceBetweenGroups)}px`;
        });
        await expectLocator(longModelTrigger).toHaveText(LONG_MODEL_LABEL);
        await expectLocator(addTrigger).toHaveCount(0);
        await expectLocator(settingsMenu).toHaveCount(0);
        markPhase("folding the focused permission picker without activating Project Path");
        const permissionTrigger = bottomBar.getByRole("button", { name: /^Permission mode:/ });
        await permissionTrigger.press("ArrowDown");
        await fixture.page.getByRole("menuitemradio").first().focus();
        await bottomBar.evaluate((bar) => { bar.style.width = "136px"; });
        await expectLocator(settingsMenu).toBeFocused();
        await expectLocator(fixture.page.locator('[data-slot="directory-browser"]')).toHaveCount(0);
        markPhase("returning focus to a newly inline editing action");
        await addTrigger.click();
        await fixture.page.getByRole("menuitem", { name: "Open expanded composer" }).focus();
        await bottomBar.evaluate((bar) => { bar.style.width = "350px"; });
        await expectLocator(bottomBar.getByRole("button", { name: "Open expanded composer" })).toBeFocused();
        await expectLocator(fixture.page.getByRole("menu")).toHaveCount(0);
        expect(await bottomBar.evaluate((bar) => bar.scrollWidth <= bar.clientWidth)).toBe(true);
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
