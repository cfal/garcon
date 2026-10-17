import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { chromium } from "playwright";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";
import { contrastRatio } from "../../support/color-contrast";

const APP_URL = "http://theme-terminal-contrast.test/";
type TerminalFixtureScope = typeof globalThis &
  typeof import("../../../web/src/lib/terminal/runtime/__tests__/terminal-contrast-fixture");
const SAMPLES = [
  { name: "black foreground", sequence: "\u001b[30mblack" },
  { name: "bright white on black", sequence: "\u001b[97;40mwhite" },
  { name: "red on black", sequence: "\u001b[31;40mred" },
] as const;

describe("terminal theme contrast", () => {
  test("keeps foregrounds readable when ANSI colors select explicit backgrounds", async () => {
    const [javascript, stylesheet] = await Promise.all([
      buildWebBrowserEntry(
        "src/lib/terminal/runtime/__tests__/terminal-contrast-fixture.ts",
      ),
      readFile(
        new URL(
          "../../../web/node_modules/@xterm/xterm/css/xterm.css",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const assets = new URL(
      "../../../web/build/_app/immutable/assets/",
      import.meta.url,
    );
    const themeCss = (
      await Promise.all(
        (await readdir(assets))
          .filter((file) => file.endsWith(".css"))
          .map((file) => readFile(new URL(file, assets), "utf8")),
      )
    ).join("\n");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(`${APP_URL}**`, async (route) => {
      if (new URL(route.request().url()).pathname === "/fixture.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: javascript,
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>${themeCss}\n${stylesheet}#terminal{width:640px;height:100px}</style><div id="terminal"></div><script type="module">import { renderTerminalSample, renderTerminalSelection, readTerminalColors } from "/fixture.js"; Object.assign(globalThis, { renderTerminalSample, renderTerminalSelection, readTerminalColors });</script>`,
      });
    });

    try {
      await page.goto(APP_URL);
      await page.waitForFunction(
        () =>
          typeof (
            globalThis as typeof globalThis & {
              renderTerminalSample?: unknown;
            }
          ).renderTerminalSample === "function",
      );
      for (const profile of THEME_PROFILES) {
        const presentation = await page.evaluate((profile) => {
          const root = document.documentElement;
          root.dataset.theme = profile.id;
          root.classList.toggle("dark", profile.colorScheme === "dark");
          const fixture = globalThis as TerminalFixtureScope;
          const colors = fixture.readTerminalColors(root);
          if (!colors)
            throw new Error(`Missing terminal colors for ${profile.id}`);
          return {
            colorScheme: profile.colorScheme,
            rendererPalette: profile.rendererPalette,
            ...colors,
          };
        }, profile);
        expect(
          contrastRatio(presentation.foreground, presentation.background),
          `${profile.id} foreground`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            presentation.selectionForeground,
            presentation.selectionBackground,
          ),
          `${profile.id} selection`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            presentation.selectionBackground,
            presentation.background,
          ),
          `${profile.id} visible selection`,
        ).toBeGreaterThanOrEqual(1.5);
        expect(
          contrastRatio(presentation.cursor, presentation.background),
          `${profile.id} cursor`,
        ).toBeGreaterThanOrEqual(3);
        const selection = await page
          .locator("#terminal")
          .evaluate(async (root, presentation) => {
            root.replaceChildren();
            root.style.backgroundColor = presentation.background;
            const fixture = globalThis as TerminalFixtureScope;
            const dispose = await fixture.renderTerminalSelection(
              root as HTMLElement,
              presentation,
            );
            const text = root.querySelector<HTMLElement>(".xterm-rows span");
            const highlight = root.querySelector<HTMLElement>(
              ".xterm-selection div",
            );
            if (!text || !highlight)
              throw new Error("Missing selected terminal output");
            const colors = {
              foreground: getComputedStyle(text).color,
              background: getComputedStyle(highlight).backgroundColor,
            };
            dispose();
            return colors;
          }, presentation);
        expect(
          contrastRatio(selection.foreground, selection.background),
          `${profile.id} rendered selection text`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(selection.background, presentation.background),
          `${profile.id} rendered selection visibility`,
        ).toBeGreaterThanOrEqual(1.5);
        for (const sample of SAMPLES) {
          const colors = await page.locator("#terminal").evaluate(
            async (root, { presentation, sequence }) => {
              const fixture = globalThis as TerminalFixtureScope;
              root.replaceChildren();
              root.style.backgroundColor = presentation.background;
              const dispose = await fixture.renderTerminalSample(
                root as HTMLElement,
                presentation,
                sequence,
              );
              const text = [
                ...root.querySelectorAll<HTMLElement>(".xterm-rows span"),
              ].find((element) => element.textContent?.trim());
              if (!text) throw new Error("Missing rendered terminal text.");
              const style = getComputedStyle(text);
              const textBackground = style.backgroundColor;
              const result = {
                foreground: style.color,
                background:
                  textBackground === "rgba(0, 0, 0, 0)" ||
                  textBackground === "transparent"
                    ? getComputedStyle(root).backgroundColor
                    : textBackground,
              };
              dispose();
              return result;
            },
            { presentation, sequence: sample.sequence },
          );
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} ${sample.name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
