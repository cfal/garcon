import { expect, test } from "bun:test";
import type { Locator } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { clickWorkspaceWindowAddAction } from "../../support/chromium-workspace.js";

async function inputRowGeometry(modifier: Locator) {
  return modifier.evaluate((button) => {
    const row = button.parentElement!;
    return {
      width: row.clientWidth,
      contentWidth: row.scrollWidth,
      buttons: Array.from(row.querySelectorAll("button")).map((key) => {
        const { x, y, width, height } = key.getBoundingClientRect();
        return { x, y, width, height };
      }),
    };
  });
}

test("mobile terminal keys fit without shifting when modifiers activate or lock", async () => {
  await withChromiumFixture(
    "theme terminal controls",
    async ({ page, integration, assertNoBrowserErrors }) => {
      await page.goto(integration.garcon.baseUrl);
      await clickWorkspaceWindowAddAction(page, "New Terminal");
      await browserExpect(page.locator(".xterm")).toBeVisible();

      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 844 });
        for (const profile of THEME_PROFILES) {
          await page.evaluate((profile) => {
            document.documentElement.dataset.theme = profile.id;
            document.documentElement.classList.toggle(
              "dark",
              profile.colorScheme === "dark",
            );
          }, profile);
          for (const label of ["Ctrl", "Alt"]) {
            const modifier = page.getByRole("button", {
              name: label,
              exact: true,
            });
            const baseline = await inputRowGeometry(modifier);
            const context = `${profile.id} ${width}px ${label}`;
            expect(baseline.buttons).toHaveLength(8);
            expect(baseline.contentWidth, context).toBeLessThanOrEqual(
              baseline.width,
            );
            for (const bounds of baseline.buttons) {
              expect(bounds.x, context).toBeGreaterThanOrEqual(0);
              expect(bounds.x + bounds.width, context).toBeLessThanOrEqual(
                width,
              );
            }

            await modifier.click();
            await browserExpect(modifier).toHaveAttribute(
              "title",
              `${label}: Next key`,
            );
            expect(
              await inputRowGeometry(modifier),
              `${context} pending`,
            ).toEqual(baseline);
            await page
              .getByRole("button", { name: "Esc", exact: true })
              .click();
            await browserExpect(modifier).toHaveAttribute(
              "aria-pressed",
              "false",
            );

            await modifier.evaluate((button: HTMLButtonElement) => {
              button.click();
              button.click();
            });
            await browserExpect(modifier).toHaveAttribute(
              "title",
              `${label}: Locked`,
            );
            await browserExpect(modifier.locator("svg")).toBeVisible();
            expect(
              await inputRowGeometry(modifier),
              `${context} locked`,
            ).toEqual(baseline);
            await modifier.click();
            await browserExpect(modifier).toHaveAttribute(
              "aria-pressed",
              "false",
            );
          }
        }
      }
      assertNoBrowserErrors();
    },
    undefined,
    { serverEnvironment: { GARCON_TERMINAL_SHELL: "/bin/sh" } },
  );
}, 120_000);
