import { describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes";

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
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Settings", exact: true })
        .waitFor();

      markPhase("selecting a fixed dark profile");
      await page.getByRole("radio", { name: "Use one theme" }).click();
      const themeSelect = page.getByRole("combobox", {
        name: "Theme",
        exact: true,
      });
      const previewColors = new Map<string, string[]>();
      for (const profile of [
        ...THEME_PROFILES,
        THEME_PROFILES.find((profile) => profile.id === "rose-dark")!,
      ]) {
        await themeSelect.focus();
        await themeSelect.selectOption(profile.id);
        await page.waitForFunction(
          (id) => document.documentElement.dataset.theme === id,
          profile.id,
        );
        expect(await rootThemeProjection(page)).toEqual({
          themeId: profile.id,
          dark: profile.colorScheme === "dark",
          colorScheme: profile.colorScheme,
          themeColor: profile.browserThemeColor,
        });
        expect(
          await themeSelect.evaluate(
            (element) => element === document.activeElement,
          ),
        ).toBe(true);
        expect(
          await page.locator(`[data-theme-preview="${profile.id}"]`).count(),
        ).toBe(1);
        const colors = await page
          .locator(`[data-theme-preview="${profile.id}"]`)
          .evaluate((preview) => {
            const roles = [
              "background",
              "card",
              "primary",
              "interactive-accent",
              "diff-add-bg",
              "diff-del-bg",
            ];
            return Array.from(preview.children).map((swatch, index) => {
              const expected = document.createElement("span");
              expected.style.backgroundColor = `hsl(var(--${roles[index]}))`;
              preview.append(expected);
              const result = {
                actual: getComputedStyle(swatch).backgroundColor,
                expected: getComputedStyle(expected).backgroundColor,
              };
              expected.remove();
              return result;
            });
          });
        expect(colors).toHaveLength(6);
        for (const color of colors) {
          expect(color.actual, `${profile.id} preview swatch`).toBe(
            color.expected,
          );
          expect(color.actual).not.toBe("rgba(0, 0, 0, 0)");
        }
        previewColors.set(
          profile.id,
          colors.map((color) => color.actual),
        );
      }
      expect(previewColors.get("classic-light")!.slice(0, 4)).toEqual(
        previewColors.get("colorblind-light")!.slice(0, 4),
      );
      expect(previewColors.get("classic-light")!.slice(4)).not.toEqual(
        previewColors.get("colorblind-light")!.slice(4),
      );
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
      expect(
        await page.getByRole("combobox", { name: "Light theme" }).inputValue(),
      ).toBe("colorblind-light");
      expect(
        await page.getByRole("combobox", { name: "Dark theme" }).inputValue(),
      ).toBe("colorblind-dark");
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
