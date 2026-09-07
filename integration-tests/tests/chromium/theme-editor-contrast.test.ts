import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import type { RendererThemeId } from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";

const APP_URL = "http://theme-editor-contrast.test/";
const RENDERER_THEMES: readonly {
  readonly id: RendererThemeId;
  readonly parentBackground: string;
}[] = [
  { id: "standard-light", parentBackground: "hsl(220 25% 97%)" },
  { id: "standard-dark", parentBackground: "hsl(222 33% 5%)" },
  { id: "colorblind-light", parentBackground: "#ffffff" },
  { id: "colorblind-dark", parentBackground: "#0c1117" },
];

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

interface ManifestEntry {
  readonly name?: string;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
}

function collectStaticImports(
  manifest: Record<string, ManifestEntry>,
  entryKey: string,
): Set<string> {
  const imports = new Set<string>();
  const pending = [...(manifest[entryKey]?.imports ?? [])];
  for (const dependency of pending) {
    if (imports.has(dependency)) continue;
    imports.add(dependency);
    pending.push(...(manifest[dependency]?.imports ?? []));
  }
  return imports;
}

describe("CodeMirror theme contrast", () => {
  test("keeps CodeMirror implementation chunks behind the editor runtime import", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(
          "../../../web/.svelte-kit/output/client/.vite/manifest.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Record<string, ManifestEntry>;
    const rootEntryKey = Object.keys(manifest).find((key) =>
      key.endsWith("/nodes/0.js"),
    );
    if (!rootEntryKey) throw new Error("Missing root layout manifest entry");

    const editorEntryKey = "src/lib/files/editor/code-editor-controller.svelte.ts";
    expect(manifest[rootEntryKey]?.dynamicImports).toContain(editorEntryKey);
    const rootImports = collectStaticImports(manifest, rootEntryKey);
    const eagerEditorChunks = [...rootImports].filter((key) => {
      return manifest[key]?.name === "vendor-codemirror-editor";
    });
    expect(eagerEditorChunks).toEqual([]);
  });

  test("keeps every rendered syntax color readable in every renderer theme", async () => {
    const javascript = await buildWebBrowserEntry(
      "src/lib/files/editor/__tests__/editor-contrast-fixture.ts",
    );
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
        body: '<!doctype html><div id="editor"></div><script type="module">import { mountEditor } from "/fixture.js"; globalThis.mountEditor = mountEditor;</script>',
      });
    });

    try {
      await page.goto(APP_URL);
      await page.waitForFunction(
        () =>
          typeof (globalThis as typeof globalThis & { mountEditor?: unknown })
            .mountEditor === "function",
      );
      for (const theme of RENDERER_THEMES) {
        const colors = await page
          .locator("#editor")
          .evaluate((root, rendererTheme) => {
            const scope = globalThis as typeof globalThis & {
              mountEditor: (
                parent: HTMLElement,
                themeId: string,
              ) => { destroy(): void };
            };
            root.replaceChildren();
            root.setAttribute(
              "style",
              `background: ${rendererTheme.parentBackground}`,
            );
            const view = scope.mountEditor(
              root as HTMLElement,
              rendererTheme.id,
            );
            const editor = root.querySelector<HTMLElement>(".cm-editor");
            if (!editor) throw new Error("Missing CodeMirror editor.");
            const editorBackground = getComputedStyle(editor).backgroundColor;
            const background =
              editorBackground === "rgba(0, 0, 0, 0)"
                ? getComputedStyle(root).backgroundColor
                : editorBackground;
            const foregrounds = [
              ...new Set(
                [...root.querySelectorAll<HTMLElement>(".cm-content span")].map(
                  (element) => getComputedStyle(element).color,
                ),
              ),
            ];
            view.destroy();
            return { background, foregrounds };
          }, theme);
        expect(
          colors.foregrounds.length,
          `${theme.id} rendered syntax colors`,
        ).toBeGreaterThan(4);
        const failures = colors.foregrounds
          .map((foreground) => ({
            foreground,
            ratio: contrastRatio(foreground, colors.background),
          }))
          .filter(({ ratio }) => ratio < 4.5);
        expect(
          failures,
          `${theme.id} syntax colors on ${colors.background}`,
        ).toEqual([]);
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
