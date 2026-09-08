import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import type { ThemeRendererPresentation } from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";
import { contrastRatio } from "../../support/color-contrast";

const APP_URL = "http://theme-terminal-contrast.test/";
interface TerminalPresentation extends ThemeRendererPresentation {
  readonly background: string;
}

const PRESENTATIONS: readonly TerminalPresentation[] = [
  { colorScheme: "light", rendererPalette: "standard", background: "#ffffff" },
  { colorScheme: "dark", rendererPalette: "standard", background: "#1e1e1e" },
  {
    colorScheme: "light",
    rendererPalette: "colorblind",
    background: "#ffffff",
  },
  { colorScheme: "dark", rendererPalette: "colorblind", background: "#1e1e1e" },
];
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
        body: `<!doctype html><style>${stylesheet}#terminal{width:640px;height:100px}</style><div id="terminal"></div><script type="module">import { renderTerminalSample } from "/fixture.js"; globalThis.renderTerminalSample = renderTerminalSample;</script>`,
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
      for (const presentation of PRESENTATIONS) {
        for (const sample of SAMPLES) {
          const colors = await page.locator("#terminal").evaluate(
            async (root, { presentation, sequence }) => {
              const scope = globalThis as typeof globalThis & {
                renderTerminalSample: (
                  parent: HTMLElement,
                  theme: TerminalPresentation,
                  content: string,
                ) => Promise<() => void>;
              };
              root.replaceChildren();
              root.style.backgroundColor = presentation.background;
              const dispose = await scope.renderTerminalSample(
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
            `${presentation.rendererPalette} ${presentation.colorScheme} ${sample.name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
