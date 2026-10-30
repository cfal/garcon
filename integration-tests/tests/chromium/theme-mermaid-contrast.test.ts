import { describe, expect, test } from "bun:test";
import { captureBrowserErrors } from '../../support/browser-errors.js';
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  THEME_PROFILES,
  rendererThemeIdFor,
} from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";
import { contrastRatio } from "../../support/color-contrast";

const APP_URL = "http://theme-mermaid-contrast.test/";

const DIAGRAMS = [
  {
    name: "flowchart node label",
    source: "flowchart LR\nA[Start] --> B[Finish]",
    labelSelector: ".nodeLabel",
    backgroundSelector: ".label-container",
    labelProperty: "color",
  },
  {
    name: "Gantt task label",
    source:
      "gantt\ntitle Contrast\ndateFormat YYYY-MM-DD\nsection Work\nTask A :a1, 2026-01-01, 2d",
    labelSelector: ".taskText",
    backgroundSelector: ".task",
    labelProperty: "fill",
  },
  {
    name: "completed Gantt task label",
    source:
      "gantt\ntitle Contrast\ndateFormat YYYY-MM-DD\nsection Work\nTask A :done, a1, 2026-01-01, 2d",
    labelSelector: ".doneText0",
    backgroundSelector: ".done0",
    labelProperty: "fill",
  },
  {
    name: "critical Gantt task label",
    source:
      "gantt\ntitle Contrast\ndateFormat YYYY-MM-DD\nsection Work\nTask A :crit, a1, 2026-01-01, 2d",
    labelSelector: ".critText0",
    backgroundSelector: ".crit0",
    labelProperty: "fill",
  },
] as const;

describe("Mermaid theme contrast", () => {
  test("keeps rendered labels and their selections readable inside message bubbles in every profile", async () => {
    const javascript = await buildWebBrowserEntry(
      "src/lib/components/rich-text/mermaid-loader.ts",
    );
    const assetsDirectory = fileURLToPath(
      new URL("../../../web/build/_app/immutable/assets/", import.meta.url),
    );
    let css = "";
    for (const filename of await readdir(assetsDirectory)) {
      if (filename.endsWith(".css")) {
        css += await readFile(`${assetsDirectory}/${filename}`, "utf8");
      }
    }
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const browserErrors: string[] = [];
    captureBrowserErrors(page.context(), browserErrors);
    const departureFont = await readFile(fileURLToPath(new URL(
      '../../../web/src/lib/theme/assets/DepartureMono-1.500-core.woff2', import.meta.url,
    )));
    await page.route(`${APP_URL}**`, async (route) => {
      if (new URL(route.request().url()).pathname.endsWith('.woff2')) {
        await route.fulfill({ contentType: 'font/woff2', body: departureFont });
        return;
      }
      if (new URL(route.request().url()).pathname === "/loader.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: javascript,
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>${css}</style>
          <div id="bubble" class="bg-user-bubble text-user-bubble-foreground">
            <div class="markdown-body prose prose-sm text-inherit">
              <div class="overflow-hidden rounded-md border border-border bg-muted/30">
                <div id="diagram" class="mermaid-container overflow-x-auto p-4"></div>
              </div>
            </div>
          </div>
          <script type="module">import { renderMermaid } from "/loader.js"; globalThis.renderMermaid = renderMermaid;</script>`,
      });
    });

    try {
      await page.goto(APP_URL);
      await page.waitForFunction(
        () =>
          typeof (globalThis as typeof globalThis & { renderMermaid?: unknown })
            .renderMermaid === "function",
      );
      for (const profile of THEME_PROFILES) {
        const themeId = rendererThemeIdFor(profile);
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme.id;
          document.documentElement.dataset.themeAppearance = 'terminal';
          document.documentElement.classList.toggle(
            "dark",
            theme.colorScheme === "dark",
          );
          document.documentElement.style.colorScheme = theme.colorScheme;
        }, profile);
        for (const diagram of DIAGRAMS) {
          const svg = await page.evaluate(
            async ({ source, themeId }) => {
              const scope = globalThis as typeof globalThis & {
                renderMermaid: (
                  diagramSource: string,
                  rendererTheme: string,
                ) => Promise<string>;
              };
              return scope.renderMermaid(source, themeId);
            },
            { source: diagram.source, themeId },
          );
          const colors = await page.locator("#diagram").evaluate(
            (
              root,
              { backgroundSelector, labelProperty, labelSelector, svg },
            ) => {
              getSelection()?.removeAllRanges();
              document
                .getElementById("bubble")!
                .classList.remove(
                  "selection:bg-user-bubble-foreground",
                  "selection:text-user-bubble",
                );
              root.innerHTML = svg;
              const label = root.querySelector<SVGElement>(labelSelector);
              const background =
                root.querySelector<SVGElement>(backgroundSelector);
              if (!label || !background) {
                throw new Error("Missing Mermaid contrast targets.");
              }
              const labelStyle = getComputedStyle(label);
              const selectionStyle = getComputedStyle(
                label.querySelector("p") ?? label,
                "::selection",
              );
              return {
                foreground:
                  labelProperty === "color"
                    ? labelStyle.color
                    : labelStyle.fill,
                background: getComputedStyle(background).fill,
                selection: {
                  foreground: selectionStyle.color,
                  background: selectionStyle.backgroundColor,
                },
              };
            },
            {
              backgroundSelector: diagram.backgroundSelector,
              labelProperty: diagram.labelProperty,
              labelSelector: diagram.labelSelector,
              svg,
            },
          );
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} ${diagram.name}`,
          ).toBeGreaterThanOrEqual(4.5);
          await page.locator("#bubble").evaluate((bubble) => {
            bubble.classList.add(
              "selection:bg-user-bubble-foreground",
              "selection:text-user-bubble",
            );
          });
          const label = page.locator(diagram.labelSelector).first();
          const unselectedPixels = await label.screenshot();
          const selected = await label.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            const style = getComputedStyle(
              element.querySelector("p") ?? element,
              "::selection",
            );
            return {
              text: selection.toString(),
              foreground: style.color,
              background: style.backgroundColor,
            };
          });
          const selectionLabel = `${profile.id} ${diagram.name} selection`;
          expect(selected.text.length, selectionLabel).toBeGreaterThan(0);
          expect(selected.foreground, selectionLabel).toBe(
            colors.selection.foreground,
          );
          expect(selected.background, selectionLabel).toBe(
            colors.selection.background,
          );
          expect(
            contrastRatio(selected.foreground, selected.background),
            `${selectionLabel} text`,
          ).toBeGreaterThanOrEqual(4.5);
          if (profile.rendererPalette === "semantic") {
            expect(
              contrastRatio(selected.background, colors.background),
              `${selectionLabel} separation`,
            ).toBeGreaterThanOrEqual(3);
          }
          const selectedPixels = await label.screenshot();
          expect(selectedPixels.equals(unselectedPixels), selectionLabel).toBe(
            false,
          );
        }
      }
      const geometry = await page.evaluate(async () => {
        const scope = globalThis as typeof globalThis & {
          renderMermaid: (source: string, theme: string) => Promise<string>;
        };
        const root = document.querySelector('#diagram')!;
        const source = 'flowchart TB\nA[Independent font selections] --> B[A longer label that wraps across several lines inside a fixed diagram node]';
        const read = () => Array.from(root.querySelectorAll('foreignObject')).map((box) => {
          const label = box.querySelector('.nodeLabel')!;
          const bounds = label.getBoundingClientRect();
          return { font: getComputedStyle(label).fontFamily, width: bounds.width, height: bounds.height,
            boxWidth: box.getAttribute('width'), boxHeight: box.getAttribute('height') };
        });
        document.documentElement.dataset.themeAppearance = 'standard';
        document.documentElement.dataset.interfaceFont = 'default';
        document.documentElement.dataset.chatFeedFont = 'default';
        document.documentElement.dataset.chatCodeFont = 'default';
        for (const surface of ['interface', 'chat-feed', 'chat-code']) document.documentElement.style.removeProperty(`--${surface}-font-override`);
        const cachedSvg = await scope.renderMermaid(source, 'standard-light');
        root.innerHTML = cachedSvg;
        const standard = read();
        document.documentElement.dataset.themeAppearance = 'terminal';
        document.documentElement.dataset.interfaceFont = 'departure-mono';
        document.documentElement.dataset.chatFeedFont = 'departure-mono';
        document.documentElement.dataset.chatCodeFont = 'departure-mono';
        for (const surface of ['interface', 'chat-feed', 'chat-code']) document.documentElement.style.setProperty(`--${surface}-font-override`, 'var(--font-choice-departure-mono)');
        await document.fonts.ready;
        const toggled = read();
        root.innerHTML = await scope.renderMermaid(source, 'standard-light');
        const cached = read();
        root.innerHTML = await scope.renderMermaid(source + '\n', 'standard-light');
        return { standard, toggled, cached, fresh: read(), fontLoaded: document.fonts.check('11px "Departure Mono"') };
      });
      expect(geometry.fontLoaded).toBe(true);
      expect(geometry.standard).toHaveLength(2);
      expect(geometry.toggled).toEqual(geometry.standard);
      expect(geometry.cached).toEqual(geometry.standard);
      expect(geometry.fresh).toEqual(geometry.standard);
      expect(browserErrors).toEqual([]);
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
