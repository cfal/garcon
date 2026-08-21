import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const APP_URL = "http://theme-bootstrap.test/";
const LOCAL_SETTINGS_KEY = "pref_local_settings";
const STARTUP_MARKER = `<script>
globalThis.__themeBeforeApplicationStartup = {
  dark: document.documentElement.classList.contains('dark'),
  colorScheme: document.documentElement.style.colorScheme,
};
</script>`;

interface ThemeScenario {
  name: string;
  storedSettings: string | null;
  systemColorScheme: "dark" | "light";
  expectedDark: boolean;
}

const scenarios: ThemeScenario[] = [
  {
    name: "stored dark overrides a light system",
    storedSettings: JSON.stringify({ theme: "dark" }),
    systemColorScheme: "light",
    expectedDark: true,
  },
  {
    name: "stored light overrides a dark system",
    storedSettings: JSON.stringify({ theme: "light" }),
    systemColorScheme: "dark",
    expectedDark: false,
  },
  {
    name: "system follows dark",
    storedSettings: JSON.stringify({ theme: "system" }),
    systemColorScheme: "dark",
    expectedDark: true,
  },
  {
    name: "system follows light",
    storedSettings: JSON.stringify({ theme: "system" }),
    systemColorScheme: "light",
    expectedDark: false,
  },
  {
    name: "missing settings follow the system",
    storedSettings: null,
    systemColorScheme: "dark",
    expectedDark: true,
  },
  {
    name: "malformed settings follow the system",
    storedSettings: "{",
    systemColorScheme: "dark",
    expectedDark: true,
  },
];

describe("theme bootstrap", () => {
  test("applies the resolved theme before application startup", async () => {
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
          ({ key, storedSettings }) => {
            if (storedSettings === null) localStorage.removeItem(key);
            else localStorage.setItem(key, storedSettings);
          },
          { key: LOCAL_SETTINGS_KEY, storedSettings: scenario.storedSettings },
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
              dark: boolean;
              colorScheme: string;
            };
          };
          return annotatedGlobal.__themeBeforeApplicationStartup;
        });
        expect(startupTheme, scenario.name).toEqual({
          dark: scenario.expectedDark,
          colorScheme: scenario.expectedDark ? "dark" : "light",
        });

        await context.close();
      }
    } finally {
      await browser.close();
    }
  });
});
