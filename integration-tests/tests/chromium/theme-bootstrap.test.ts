import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
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
  storageUnavailable?: boolean;
}

function defaultThemeId(systemColorScheme: ColorScheme): ThemeId {
  return resolveThemeId(DEFAULT_THEME_PREFERENCE, systemColorScheme);
}

const fixedScenarios: ThemeScenario[] = THEME_PROFILES.map((profile) => ({
  name: `fixed ${profile.id} ignores the opposite system scheme`,
  storedSettings: JSON.stringify({
    themePreference: { mode: "fixed", themeId: profile.id },
  }),
  systemColorScheme: profile.colorScheme === "dark" ? "light" : "dark",
  expectedThemeId: profile.id,
}));

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
  ...fixedScenarios,
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
          dark: expectedProfile.colorScheme === "dark",
          colorScheme: expectedProfile.colorScheme,
          themeColor: expectedProfile.browserThemeColor,
          appleStatusBarStyle:
            expectedProfile.colorScheme === "dark"
              ? "black-translucent"
              : "default",
        });

        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
