import { expect as browserExpect } from "playwright/test";
import type { Page } from "playwright";
import {
  TYPOGRAPHY_SURFACES,
  type TypographyPreferences,
} from "../../web/src/lib/theme/typography.js";

export async function setTypography(
  page: Page,
  preferences: Partial<TypographyPreferences>,
): Promise<void> {
  await page.evaluate((values) => {
    const key = "pref_local_settings";
    localStorage.setItem(
      key,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(key) ?? "{}"),
        ...values,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key, storageArea: localStorage }),
    );
  }, preferences);
  for (const { id, fontKey, sizeKey } of TYPOGRAPHY_SURFACES) {
    const font = preferences[fontKey];
    const size = preferences[sizeKey];
    if (font !== undefined) {
      await browserExpect(page.locator("html")).toHaveAttribute(
        `data-${id}-font`,
        font,
      );
    }
    if (size !== undefined) {
      await browserExpect(page.locator("html")).toHaveAttribute(
        `data-${id}-font-size`,
        size,
      );
    }
  }
  await page.evaluate(() => document.fonts.ready);
}

export async function expectFontSizeMenuFits(
  page: Page,
  defaultLabel: string,
): Promise<void> {
  const trigger = page.getByRole("menuitem").filter({ hasText: "Font size" });
  await trigger.hover();
  const option = page.getByRole("menuitemradio", {
    name: defaultLabel,
    exact: true,
  });
  await browserExpect(option).toBeVisible();
  await browserExpect
    .poll(() =>
      option.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          element.scrollWidth <= element.clientWidth &&
          rect.left >= 0 &&
          rect.right <= innerWidth
        );
      }),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}
