import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { withChromiumFixture } from "../../support/chromium-fixture.js";

interface RootThemeProjection {
  themeId: string | undefined;
  dark: boolean;
  colorScheme: string;
  themeColor: string | null;
}

async function rootThemeProjection(page: Page): Promise<RootThemeProjection> {
  return page.evaluate(() => ({
    themeId: document.documentElement.dataset.theme,
    dark: document.documentElement.classList.contains("dark"),
    colorScheme: document.documentElement.style.colorScheme,
    themeColor:
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute("content") ?? null,
  }));
}

describe("theme switching", () => {
  test("keeps Fixed and configurable System selections aligned through reload", async () => {
    await withChromiumFixture("theme switching", async (fixture, markPhase) => {
      const { page } = fixture;
      markPhase("opening the SPA and local settings");
      const response = await page.goto(fixture.integration.garcon.baseUrl, {
        waitUntil: "domcontentloaded",
      });
      expect(response?.ok()).toBe(true);
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "phosphor-light",
      );
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await page.getByRole("dialog", { name: "Settings" }).waitFor();
      await page.getByRole("tab", { name: "Local Settings" }).click();

      markPhase("selecting a fixed dark profile");
      await page.getByRole("radio", { name: "Use one theme" }).click();
      await page
        .getByRole("combobox", { name: "Theme", exact: true })
        .selectOption("colorblind-dark");
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "colorblind-dark",
      );
      expect(await rootThemeProjection(page)).toEqual({
        themeId: "colorblind-dark",
        dark: true,
        colorScheme: "dark",
        themeColor: "#0c1117",
      });
      await page.emulateMedia({ colorScheme: "light" });
      expect((await rootThemeProjection(page)).themeId).toBe("colorblind-dark");

      markPhase("configuring a mixed System pair");
      await page.getByRole("radio", { name: "Follow system" }).click();
      await page
        .getByRole("combobox", { name: "Light theme" })
        .selectOption("classic-light");
      await page
        .getByRole("combobox", { name: "Dark theme" })
        .selectOption("phosphor-dark");
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "classic-light",
      );
      expect(await rootThemeProjection(page)).toEqual({
        themeId: "classic-light",
        dark: false,
        colorScheme: "light",
        themeColor: "#ffffff",
      });

      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "phosphor-dark",
      );
      expect(await rootThemeProjection(page)).toEqual({
        themeId: "phosphor-dark",
        dark: true,
        colorScheme: "dark",
        themeColor: "#090b11",
      });

      markPhase("reloading the persisted System selection");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "phosphor-dark",
      );
      const persisted = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("pref_local_settings") ?? "{}"),
      );
      expect(persisted.themePreference).toEqual({
        mode: "system",
        lightThemeId: "classic-light",
        darkThemeId: "phosphor-dark",
      });
      expect(persisted).not.toHaveProperty("theme");
      expect(persisted).not.toHaveProperty("colorblindMode");
      fixture.assertNoBrowserErrors();
    });
  });
});
