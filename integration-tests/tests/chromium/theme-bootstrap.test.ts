import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { FONT_OPTIONS } from "../../../web/src/lib/theme/fonts";
import {
  TYPOGRAPHY_SURFACES,
  TYPOGRAPHY_SIZE_OPTIONS,
  TYPOGRAPHY_DEFAULTS,
  type TypographyPreferences,
} from "../../../web/src/lib/theme/typography";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_PROFILES,
  getThemeProfile,
  resolveThemeId,
  type ColorScheme,
  type ThemeId,
} from "../../../web/src/lib/theme/themes";

const APP_URL = "http://theme-bootstrap.test/";
const LOCAL_SETTINGS_KEY = "pref_local_settings";
const STARTUP_MARKER = `<script>
globalThis.__themeBeforeApplicationStartup = {
  themeId: document.documentElement.dataset.theme,
  appearance: document.documentElement.dataset.themeAppearance,
  typography: Object.fromEntries(["interface","chat-list","chat-feed","chat-code","code-editor","code-diff","terminal"].map(id => [id, {
    font: document.documentElement.getAttribute('data-' + id + '-font'),
    size: document.documentElement.getAttribute('data-' + id + '-font-size'),
    cssSize: document.documentElement.style.getPropertyValue('--' + id + '-font-size'),
    scale: document.documentElement.style.getPropertyValue('--' + id + '-font-scale'),
  }])),
  dark: document.documentElement.classList.contains('dark'),
  colorScheme: document.documentElement.style.colorScheme,
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
  appleStatusBarStyle: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content'),
};
</script>`;

interface ThemeScenario {
  name: string;
  storedSettings: string | null;
  systemColorScheme: ColorScheme;
  expectedThemeId: ThemeId;
  terminalAppearance?: boolean;
  typography?: Partial<TypographyPreferences>;
  storageUnavailable?: boolean;
}

function defaultThemeId(systemColorScheme: ColorScheme): ThemeId {
  return resolveThemeId(DEFAULT_THEME_PREFERENCE, systemColorScheme);
}

const fixedScenarios: ThemeScenario[] = THEME_PROFILES.flatMap((profile) =>
  [false, true].map((terminalAppearance) => ({
    name: `fixed ${profile.id}, terminal=${terminalAppearance} ignores the opposite system scheme`,
    storedSettings: JSON.stringify({
      themePreference: { mode: "fixed", themeId: profile.id },
      terminalAppearance,
    }),
    systemColorScheme: profile.colorScheme === "dark" ? "light" : "dark",
    expectedThemeId: profile.id,
    terminalAppearance,
  })),
);

const malformedSettings = [
  ["missing settings", null],
  ["legacy settings", JSON.stringify({ theme: "dark", colorblindMode: true })],
  ["malformed JSON", "{"],
  ["an array preference", JSON.stringify({ themePreference: [] })],
  [
    "an array theme ID",
    JSON.stringify({
      themePreference: { mode: "fixed", themeId: ["classic-dark"] },
    }),
  ],
  [
    "an inherited-property theme ID",
    JSON.stringify({ themePreference: { mode: "fixed", themeId: "toString" } }),
  ],
  [
    "a prototype theme ID",
    JSON.stringify({
      themePreference: { mode: "fixed", themeId: "__proto__" },
    }),
  ],
  [
    "a scheme-incompatible System pair",
    JSON.stringify({
      themePreference: {
        mode: "system",
        lightThemeId: "classic-dark",
        darkThemeId: "classic-light",
      },
    }),
  ],
] as const;

const scenarios: ThemeScenario[] = [
  {
    name: "shipped explicit sizes survive renderer-default migration",
    storedSettings: JSON.stringify({
      codeEditorFontSize: "18",
      gitDiffFontSize: "16",
      terminalFontSize: "15",
    }),
    typography: {
      codeEditorFontSize: "18",
      gitDiffFontSize: "16",
      terminalFontSize: "15",
    },
    systemColorScheme: "light",
    expectedThemeId: defaultThemeId("light"),
  },
  {
    name: "shipped renderer defaults preserve per-owner default sizes",
    storedSettings: JSON.stringify({
      codeEditorFontSize: "12",
      gitDiffFontSize: "12",
      terminalFontSize: "13",
      chatCodeFontSize: "12",
    }),
    typography: { chatCodeFontSize: "12" },
    systemColorScheme: "light",
    expectedThemeId: defaultThemeId("light"),
  },
  {
    name: "a present but invalid migration marker preserves explicit sizes",
    storedSettings: JSON.stringify({
      interfaceFontSize: null,
      codeEditorFontSize: "12",
      gitDiffFontSize: "12",
      terminalFontSize: "13",
    }),
    typography: {
      codeEditorFontSize: "12",
      gitDiffFontSize: "12",
      terminalFontSize: "13",
    },
    systemColorScheme: "light",
    expectedThemeId: defaultThemeId("light"),
  },
  ...fixedScenarios,
  ...TYPOGRAPHY_SURFACES.flatMap(({ id, fontKey, sizeKey }) =>
    FONT_OPTIONS.flatMap((font) =>
      TYPOGRAPHY_SIZE_OPTIONS.map((size) => ({
        name: `${id}: ${font} at ${size}`,
        storedSettings: JSON.stringify({
          interfaceFontSize: "default",
          [fontKey]: font,
          [sizeKey]: size,
          terminalAppearance: true,
        }),
        typography: { [fontKey]: font, [sizeKey]: size },
        terminalAppearance: true,
        systemColorScheme: "light" as const,
        expectedThemeId: defaultThemeId("light"),
      })),
    ),
  ),
  ...[null, "serif", "toString", {}, [], 1, "99", "14px"].map((value) => ({
    name: `invalid typography ${JSON.stringify(value)}`,
    storedSettings: JSON.stringify(
      Object.fromEntries(
        TYPOGRAPHY_SURFACES.flatMap(({ fontKey, sizeKey }) => [
          [fontKey, value],
          [sizeKey, value],
        ]),
      ),
    ),
    systemColorScheme: "light" as const,
    expectedThemeId: defaultThemeId("light"),
  })),
  ...[null, "true", 1, {}, []].map((terminalAppearance) => ({
    name: `invalid terminal appearance ${JSON.stringify(terminalAppearance)}`,
    storedSettings: JSON.stringify({ terminalAppearance }),
    systemColorScheme: "light" as const,
    expectedThemeId: defaultThemeId("light"),
  })),
  {
    name: "a mixed System pair resolves its light selection",
    storedSettings: JSON.stringify({
      themePreference: {
        mode: "system",
        lightThemeId: "classic-light",
        darkThemeId: "colorblind-dark",
      },
    }),
    systemColorScheme: "light",
    expectedThemeId: "classic-light",
  },
  {
    name: "a mixed System pair resolves its dark selection",
    storedSettings: JSON.stringify({
      themePreference: {
        mode: "system",
        lightThemeId: "colorblind-light",
        darkThemeId: "classic-dark",
      },
    }),
    systemColorScheme: "dark",
    expectedThemeId: "classic-dark",
  },
  ...malformedSettings.flatMap(([name, storedSettings]) =>
    (["light", "dark"] as const).map((systemColorScheme) => ({
      name: `${name} uses the ${systemColorScheme} default`,
      storedSettings,
      systemColorScheme,
      expectedThemeId: defaultThemeId(systemColorScheme),
    })),
  ),
  {
    name: "unavailable storage uses the dark default",
    storedSettings: null,
    systemColorScheme: "dark",
    expectedThemeId: defaultThemeId("dark"),
    storageUnavailable: true,
  },
];

describe("theme bootstrap", () => {
  test("defines browser-managed safe areas before scripts run", async () => {
    const appTemplate = await readFile(
      new URL("../../../web/src/app.html", import.meta.url),
      "utf8",
    );
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      await page.setContent(appTemplate);
      expect(
        await page.locator('meta[name="viewport"]').getAttribute("content"),
      ).toContain("viewport-fit=auto");
      expect(
        await page
          .locator('meta[name="apple-mobile-web-app-status-bar-style"]')
          .getAttribute("content"),
      ).toBe("default");
    } finally {
      await browser.close();
    }
  });

  test("applies the validated concrete profile before application startup", async () => {
    const appTemplate = await readFile(
      new URL("../../../web/src/app.html", import.meta.url),
      "utf8",
    );
    expect(appTemplate.indexOf("pref_local_settings")).toBeLessThan(
      appTemplate.indexOf("%sveltekit.head%"),
    );
    const testDocument = appTemplate
      .replace("%sveltekit.head%", STARTUP_MARKER)
      .replace("%sveltekit.body%", "");
    const browser = await chromium.launch({ headless: true });

    try {
      for (const scenario of scenarios) {
        const context = await browser.newContext({
          colorScheme: scenario.systemColorScheme,
        });
        await context.addInitScript(
          ({ key, storedSettings, storageUnavailable }) => {
            if (storageUnavailable) {
              Object.defineProperty(globalThis, "localStorage", {
                configurable: true,
                get() {
                  throw new DOMException(
                    "Storage unavailable",
                    "SecurityError",
                  );
                },
              });
              return;
            }
            if (storedSettings === null) localStorage.removeItem(key);
            else localStorage.setItem(key, storedSettings);
          },
          {
            key: LOCAL_SETTINGS_KEY,
            storedSettings: scenario.storedSettings,
            storageUnavailable: scenario.storageUnavailable ?? false,
          },
        );
        const page = await context.newPage();
        await page.route(`${APP_URL}**`, async (route) => {
          if (new URL(route.request().url()).pathname === "/") {
            await route.fulfill({
              contentType: "text/html",
              body: testDocument,
            });
            return;
          }
          await route.fulfill({ status: 204 });
        });

        const response = await page.goto(APP_URL);
        expect(response?.ok(), scenario.name).toBe(true);
        const startupTheme = await page.evaluate(() => {
          const annotatedGlobal = globalThis as typeof globalThis & {
            __themeBeforeApplicationStartup?: {
              themeId: string;
              appearance: string;
              typography: Record<
                string,
                { font: string; size: string; cssSize: string; scale: string }
              >;
              dark: boolean;
              colorScheme: string;
              themeColor: string | null;
              appleStatusBarStyle: string | null;
            };
          };
          return annotatedGlobal.__themeBeforeApplicationStartup;
        });
        const expectedProfile = getThemeProfile(scenario.expectedThemeId);
        expect(startupTheme, scenario.name).toEqual({
          themeId: expectedProfile.id,
          appearance: scenario.terminalAppearance ? "terminal" : "standard",
          typography: Object.fromEntries(
            TYPOGRAPHY_SURFACES.map(({ id, fontKey, sizeKey, defaultSize }) => {
              const typography = {
                ...TYPOGRAPHY_DEFAULTS,
                ...scenario.typography,
              };
              const size = typography[sizeKey];
              return [
                id,
                {
                  font: typography[fontKey],
                  size,
                  cssSize: size === "default" ? "" : `${size}px`,
                  scale: String((Number(size) || defaultSize) / defaultSize),
                },
              ];
            }),
          ),
          dark: expectedProfile.colorScheme === "dark",
          colorScheme: expectedProfile.colorScheme,
          themeColor: expectedProfile.browserThemeColor,
          appleStatusBarStyle: "default",
        });

        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
