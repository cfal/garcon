import { describe, expect, test } from "bun:test";
import { chromium } from "playwright";
import type { RendererThemeId } from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";

const APP_URL = "http://theme-mermaid-contrast.test/";
const RENDERER_THEMES: readonly RendererThemeId[] = [
  "standard-light",
  "standard-dark",
  "colorblind-light",
  "colorblind-dark",
];

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

function luminance(rgb: string): number {
  const channels = rgb
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (!channels || channels.length !== 3)
    throw new Error(`Unsupported color: ${rgb}`);
  const linear = channels.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("Mermaid theme contrast", () => {
  test("keeps rendered flowchart and Gantt labels readable in every renderer theme", async () => {
    const javascript = await buildWebBrowserEntry(
      "src/lib/components/chat/mermaid-loader.ts",
    );
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(`${APP_URL}**`, async (route) => {
      if (new URL(route.request().url()).pathname === "/loader.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: javascript,
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><div id="diagram"></div><script type="module">import { renderMermaid } from "/loader.js"; globalThis.renderMermaid = renderMermaid;</script>',
      });
    });

    try {
      await page.goto(APP_URL);
      await page.waitForFunction(
        () =>
          typeof (globalThis as typeof globalThis & { renderMermaid?: unknown })
            .renderMermaid === "function",
      );
      for (const themeId of RENDERER_THEMES) {
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
            (root, { backgroundSelector, labelProperty, labelSelector, svg }) => {
              root.innerHTML = svg;
              const label = root.querySelector<SVGElement>(labelSelector);
              const background =
                root.querySelector<SVGElement>(backgroundSelector);
              if (!label || !background) {
                throw new Error("Missing Mermaid contrast targets.");
              }
              const labelStyle = getComputedStyle(label);
              return {
                foreground:
                  labelProperty === "color" ? labelStyle.color : labelStyle.fill,
                background: getComputedStyle(background).fill,
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
            `${themeId} ${diagram.name}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
