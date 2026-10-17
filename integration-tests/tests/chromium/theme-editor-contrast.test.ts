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
import type { mountDiffEditor } from "../../../web/src/lib/files/editor/__tests__/editor-contrast-fixture";

const APP_URL = "http://theme-editor-contrast.test/";

type DiffEditorScope = typeof globalThis & {
  mountDiffEditor: typeof mountDiffEditor;
  diffEditor: Awaited<ReturnType<typeof mountDiffEditor>>;
};

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
type SelectionMode = "drawn" | "native";

interface EditorThemeFixture {
  readonly editorKind: EditorKind;
  readonly selectionMode: SelectionMode;
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
    if (fixtureTheme.selectionMode === "drawn" && !selection)
      throw new Error("Missing CodeMirror selection.");
    if (fixtureTheme.selectionMode === "native") {
      if (selection) throw new Error("Expected the iOS native-selection path.");
      if (!document.getSelection()?.toString())
        throw new Error("Missing native CodeMirror selection.");
    }

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
      selection
        ? getComputedStyle(selection).backgroundColor
        : getComputedStyle(textElements[0]!, "::selection").backgroundColor,
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

  const selectionTest = test.each(["drawn", "native"] as const);
  selectionTest("%s selection contrast", async (selectionMode) => {
    const [editorJavascript, promptJavascript] = await Promise.all([
      buildWebBrowserEntry(
        "src/lib/files/editor/__tests__/editor-contrast-fixture.ts",
      ),
      buildWebBrowserEntry(
        "src/lib/prompt-editor/__tests__/prompt-editor-contrast-fixture.ts",
      ),
    ]);
    const assetDirectory = fileURLToPath(
      new URL("../../../web/build/_app/immutable/assets", import.meta.url),
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
    const context = await browser.newContext(
      selectionMode === "native"
        ? {
            userAgent:
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
            hasTouch: true,
            isMobile: true,
            viewport: { width: 390, height: 844 },
          }
        : {},
    );
    if (selectionMode === "native") {
      // Activates CodeMirror's iOS path independently of the host browser engine.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "vendor", {
          get: () => "Apple Computer, Inc.",
        });
        Object.defineProperty(navigator, "platform", { get: () => "iPhone" });
      });
    }
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
        body: '<!doctype html><link rel="stylesheet" href="/theme.css"><input id="other-control" aria-label="Other control"><div id="editor"></div><div class="markdown-code-block"><span class="cm-code-addition">Static addition</span><span class="cm-code-deletion">Static deletion</span></div><script type="module">import { mountEditor, mountDiffEditor } from "/editor-fixture.js"; import { mountPromptEditor } from "/prompt-fixture.js"; globalThis.mountEditor = mountEditor; globalThis.mountDiffEditor = mountDiffEditor; globalThis.mountPromptEditor = mountPromptEditor;</script>',
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
            selectionMode,
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
          if (
            selectionMode === "drawn" &&
            profile.rendererPalette === "semantic" &&
            editorKind === "file"
          ) {
            for (const foreground of colors.foregrounds) {
              expect(
                contrastRatio(foreground, colors.selectionBackground),
                `${label} selected syntax ${foreground}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }

      if (selectionMode === "native") return;

      const retained = await page.evaluate(async () => {
        const root = document.querySelector<HTMLElement>("#editor")!;
        const scope = globalThis as typeof globalThis & {
          mountEditor: (
            parent: HTMLElement,
            themeId: RendererThemeId,
          ) => {
            dom: HTMLElement;
            focus(): void;
            dispatch(transaction: { selection: { anchor: number } }): void;
            destroy(): void;
          };
        };
        root.replaceChildren();
        document.documentElement.dataset.theme = "lagoon-dark";
        const view = scope.mountEditor(root, "semantic-dark");
        view.focus();
        await new Promise(requestAnimationFrame);
        const themeIds = [
          "lagoon-dark",
          "rose-dark",
          "moss-dark",
          "lagoon-dark",
        ];
        const samples = [];
        for (const themeId of themeIds) {
          document.documentElement.dataset.theme = themeId;
          samples.push({
            background: getComputedStyle(view.dom).backgroundColor,
            selection: getComputedStyle(
              view.dom.querySelector(".cm-selectionBackground")!,
            ).backgroundColor,
            focused: view.dom.contains(document.activeElement),
          });
        }
        view.dispatch({ selection: { anchor: 0 } });
        await new Promise(requestAnimationFrame);
        const cursors = themeIds.map((themeId) => {
          document.documentElement.dataset.theme = themeId;
          return getComputedStyle(view.dom.querySelector(".cm-cursor")!)
            .borderLeftColor;
        });
        view.destroy();
        return { samples, cursors };
      });
      expect(retained.samples[0]).toEqual(retained.samples[3]);
      expect(
        new Set(retained.samples.map((sample) => sample.background)).size,
      ).toBe(3);
      expect(new Set(retained.cursors).size).toBe(3);
      expect(retained.cursors[0]).toBe(retained.cursors[3]);
      expect(
        new Set(retained.samples.map((sample) => sample.selection)).size,
      ).toBe(3);
      expect(retained.samples.every((sample) => sample.focused)).toBe(true);

      for (const profile of THEME_PROFILES.filter(
        (profile) => profile.rendererPalette === "semantic",
      )) {
        await page.evaluate(async (profile) => {
          document.documentElement.dataset.theme = profile.id;
          document.documentElement.classList.toggle(
            "dark",
            profile.colorScheme === "dark",
          );
          const root = document.querySelector<HTMLElement>("#editor")!;
          root.replaceChildren();
          const scope = globalThis as DiffEditorScope;
          scope.diffEditor = await scope.mountDiffEditor(
            root,
            `${profile.rendererPalette}-${profile.colorScheme}`,
          );
        }, profile);

        for (const lineNumber of [1, 2]) {
          const clip = await page.evaluate(async (lineNumber) => {
            const view = (globalThis as DiffEditorScope).diffEditor;
            const line = view.state.doc.line(lineNumber);
            view.dispatch({ selection: { anchor: line.from + 2 } });
            view.focus();
            document.querySelector<HTMLInputElement>("#other-control")!.focus();
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            const start = view.coordsAtPos(line.from + 2)!;
            const end = view.coordsAtPos(line.from + 18)!;
            return {
              x: start.left,
              y: start.top,
              width: end.left - start.left,
              height: start.bottom - start.top,
            };
          }, lineNumber);
          const unselected = await page.screenshot({ clip });
          const selection = await page.evaluate(async (lineNumber) => {
            const view = (globalThis as DiffEditorScope).diffEditor;
            const line = view.state.doc.line(lineNumber);
            view.focus();
            view.dispatch({
              selection: { anchor: line.from + 2, head: line.from + 18 },
            });
            document.querySelector<HTMLInputElement>("#other-control")!.focus();
            await new Promise(requestAnimationFrame);
            await new Promise(requestAnimationFrame);
            const lineElement =
              view.dom.querySelectorAll<HTMLElement>(".cm-line")[
                lineNumber - 1
              ]!;
            const marker = view.dom.querySelector<HTMLElement>(
              ".cm-selectionBackground",
            )!;
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = 1;
            const context = canvas.getContext("2d")!;
            for (const layer of [view.dom, marker, lineElement]) {
              context.fillStyle = getComputedStyle(layer).backgroundColor;
              context.fillRect(0, 0, 1, 1);
            }
            const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
            return {
              text: view.state.sliceDoc(
                view.state.selection.main.from,
                view.state.selection.main.to,
              ),
              focused: view.hasFocus,
              markers: view.dom.querySelectorAll(".cm-selectionBackground")
                .length,
              foreground: getComputedStyle(lineElement.querySelector("span")!)
                .color,
              background: `rgb(${red}, ${green}, ${blue})`,
            };
          }, lineNumber);
          expect(selection.text, `${profile.id} retained diff text`).toBe(
            lineNumber === 1 ? "dded content is " : "eleted content i",
          );
          expect(selection.focused, `${profile.id} blurred diff editor`).toBe(
            false,
          );
          expect(
            selection.markers,
            `${profile.id} retained selection layer`,
          ).toBeGreaterThan(0);
          const selected = await page.screenshot({ clip });
          expect(
            selected.equals(unselected),
            `${profile.id} line ${lineNumber} visible retained selection`,
          ).toBe(false);
          expect(
            contrastRatio(selection.foreground, selection.background),
            `${profile.id} line ${lineNumber} selected diff text`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        const staticBackgrounds = await page
          .locator(".markdown-code-block span")
          .evaluateAll((elements) =>
            elements.map(
              (element) => getComputedStyle(element).backgroundColor,
            ),
          );
        expect(
          staticBackgrounds.every((color) => color !== "rgba(0, 0, 0, 0)"),
          `${profile.id} static diff backgrounds`,
        ).toBe(true);
        await page.evaluate(() =>
          (globalThis as DiffEditorScope).diffEditor.destroy(),
        );
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
