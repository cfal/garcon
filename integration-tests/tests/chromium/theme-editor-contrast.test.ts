import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import {
  rendererThemeIdFor,
  THEME_PROFILES,
  type ColorScheme,
  type RendererThemeId,
  type ThemeId,
} from "../../../web/src/lib/theme/themes";
import { buildWebBrowserEntry } from "../../support/web-browser-bundle";
import { contrastRatio } from "../../support/color-contrast";

const APP_URL = "http://theme-editor-contrast.test/";

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

type EditorKind = "file" | "prompt";

interface EditorThemeFixture {
  readonly editorKind: EditorKind;
  readonly rendererThemeId: RendererThemeId;
  readonly profileId: ThemeId;
  readonly colorScheme: ColorScheme;
}

interface RenderedEditorColors {
  readonly background: string;
  readonly foregrounds: string[];
  readonly selectionBackground: string;
  readonly selectionForegrounds: string[];
}

async function readRenderedEditorColors(
  page: Page,
  editorTheme: EditorThemeFixture,
): Promise<RenderedEditorColors> {
  return page.locator("#editor").evaluate(async (root, fixtureTheme) => {
    const documentRoot = document.documentElement;
    documentRoot.dataset.theme = fixtureTheme.profileId;
    documentRoot.classList.toggle("dark", fixtureTheme.colorScheme === "dark");

    interface MountedEditor {
      destroy(): void;
      focus(): void;
    }

    const scope = globalThis as typeof globalThis & {
      mountEditor: (
        parent: HTMLElement,
        themeId: RendererThemeId,
      ) => MountedEditor;
      mountPromptEditor: (parent: HTMLElement) => MountedEditor;
    };
    root.replaceChildren();
    root.setAttribute("style", "background: hsl(var(--background))");

    let mountedEditor: MountedEditor;
    if (fixtureTheme.editorKind === "file") {
      mountedEditor = scope.mountEditor(
        root as HTMLElement,
        fixtureTheme.rendererThemeId,
      );
    } else {
      mountedEditor = scope.mountPromptEditor(root as HTMLElement);
    }
    mountedEditor.focus();
    await new Promise(requestAnimationFrame);

    const editor = root.querySelector<HTMLElement>(".cm-editor");
    if (!editor) throw new Error("Missing CodeMirror editor.");
    const editorBackground = getComputedStyle(editor).backgroundColor;
    const background =
      editorBackground === "rgba(0, 0, 0, 0)"
        ? getComputedStyle(root).backgroundColor
        : editorBackground;
    const selection = root.querySelector<HTMLElement>(
      ".cm-selectionBackground",
    );
    if (!selection) throw new Error("Missing CodeMirror selection.");

    const composite = (paint: string, backdrop: string): string => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing canvas context.");
      context.fillStyle = backdrop;
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = paint;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context
        .getImageData(0, 0, 1, 1)
        .data.slice(0, 3);
      return `rgb(${red}, ${green}, ${blue})`;
    };

    let textElements: HTMLElement[];
    if (fixtureTheme.editorKind === "file") {
      textElements = [
        ...root.querySelectorAll<HTMLElement>(".cm-content span"),
      ];
    } else {
      textElements = [...root.querySelectorAll<HTMLElement>(".cm-line")];
    }
    const foregrounds = [
      ...new Set(
        textElements.map((element) => getComputedStyle(element).color),
      ),
    ];
    const selectionForegrounds = [
      ...new Set(
        textElements.map(
          (element) => getComputedStyle(element, "::selection").color,
        ),
      ),
    ];
    const selectionBackground = composite(
      getComputedStyle(selection).backgroundColor,
      background,
    );
    mountedEditor.destroy();
    return {
      background,
      foregrounds,
      selectionBackground,
      selectionForegrounds,
    };
  }, editorTheme);
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

    const editorEntryKey =
      "src/lib/files/editor/code-editor-controller.svelte.ts";
    expect(manifest[rootEntryKey]?.dynamicImports).toContain(editorEntryKey);
    const rootImports = collectStaticImports(manifest, rootEntryKey);
    const eagerEditorChunks = [...rootImports].filter((key) => {
      return manifest[key]?.name === "vendor-codemirror-editor";
    });
    expect(eagerEditorChunks).toEqual([]);
  });

  test("keeps rendered editor text readable across every profile", async () => {
    const [editorJavascript, promptJavascript] = await Promise.all([
      buildWebBrowserEntry(
        "src/lib/files/editor/__tests__/editor-contrast-fixture.ts",
      ),
      buildWebBrowserEntry(
        "src/lib/prompt-editor/__tests__/prompt-editor-contrast-fixture.ts",
      ),
    ]);
    const assetDirectory = fileURLToPath(
      new URL("../../../web/build/_app/immutable/assets/", import.meta.url),
    );
    const cssFiles = (await readdir(assetDirectory)).filter((file) =>
      file.endsWith(".css"),
    );
    expect(cssFiles.length).toBeGreaterThan(0);
    const compiledCss = (
      await Promise.all(
        cssFiles.map((file) => readFile(`${assetDirectory}/${file}`, "utf8")),
      )
    ).join("\n");
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route(`${APP_URL}**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/editor-fixture.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: editorJavascript,
        });
        return;
      }
      if (pathname === "/prompt-fixture.js") {
        await route.fulfill({
          contentType: "text/javascript",
          body: promptJavascript,
        });
        return;
      }
      if (pathname === "/theme.css") {
        await route.fulfill({ contentType: "text/css", body: compiledCss });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><link rel="stylesheet" href="/theme.css"><div id="editor"></div><script type="module">import { mountEditor } from "/editor-fixture.js"; import { mountPromptEditor } from "/prompt-fixture.js"; globalThis.mountEditor = mountEditor; globalThis.mountPromptEditor = mountPromptEditor;</script>',
      });
    });

    try {
      await page.goto(APP_URL);
      await page.waitForFunction(
        () =>
          typeof (globalThis as typeof globalThis & { mountEditor?: unknown })
            .mountEditor === "function" &&
          typeof (
            globalThis as typeof globalThis & {
              mountPromptEditor?: unknown;
            }
          ).mountPromptEditor === "function",
      );
      for (const profile of THEME_PROFILES) {
        for (const editorKind of ["file", "prompt"] as const) {
          const theme = {
            editorKind,
            rendererThemeId: rendererThemeIdFor(profile),
            profileId: profile.id,
            colorScheme: profile.colorScheme,
          } satisfies EditorThemeFixture;
          const colors = await readRenderedEditorColors(page, theme);
          const label = `${profile.id} ${editorKind} editor`;
          if (editorKind === "file") {
            expect(
              colors.foregrounds.length,
              `${label} syntax colors`,
            ).toBeGreaterThan(4);
          } else {
            expect(
              colors.foregrounds.length,
              `${label} text colors`,
            ).toBeGreaterThan(0);
          }
          const failures = colors.foregrounds
            .map((foreground) => ({
              foreground,
              ratio: contrastRatio(foreground, colors.background),
            }))
            .filter(({ ratio }) => ratio < 4.5);
          expect(failures, `${label} text on ${colors.background}`).toEqual([]);
          expect(
            colors.selectionForegrounds.length,
            `${label} selected text colors`,
          ).toBeGreaterThan(0);
          const selectionFailures = colors.selectionForegrounds
            .map((foreground) => ({
              foreground,
              ratio: contrastRatio(foreground, colors.selectionBackground),
            }))
            .filter(({ ratio }) => ratio < 4.5);
          expect(
            selectionFailures,
            `${label} selected text on ${colors.selectionBackground}`,
          ).toEqual([]);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
