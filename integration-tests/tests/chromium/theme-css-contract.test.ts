import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes";
import { contrastRatio } from "../../support/color-contrast";

const APP_URL = "http://theme-css-contract.test/";
const DIFF_SYNTAX_CLASSES = [
  "cm-code-keyword",
  "cm-code-title",
  "cm-code-meta",
  "cm-code-invalid",
  "cm-code-string",
  "cm-code-symbol",
  "cm-code-comment",
  "cm-code-name",
  "cm-code-section",
  "cm-code-addition",
  "cm-code-deletion",
] as const;

function diffSyntaxFixture(idPrefix: string): string {
  return DIFF_SYNTAX_CLASSES.map(
    (className) =>
      `<span id="${idPrefix}-${className}" class="${className}">${className}</span>`,
  ).join(" ");
}

function declaredProperties(source: string): string[] {
  return [...new Set(source.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])].sort();
}

async function applyProfile(
  page: Page,
  profile: (typeof THEME_PROFILES)[number],
): Promise<void> {
  await page.evaluate((theme) => {
    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.classList.toggle("dark", theme.colorScheme === "dark");
    root.style.colorScheme = theme.colorScheme;
  }, profile);
}

async function readRenderedColors(
  page: Page,
  selector: string,
  options: {
    pseudoElement?: string;
  } = {},
): Promise<{
  foreground: string;
  background: string;
  border: string;
  surface: string;
}> {
  return page.locator(selector).evaluate((element, colorOptions) => {
    const surface = getComputedStyle(document.body).backgroundColor;
    const style = getComputedStyle(element, colorOptions.pseudoElement);
    const composite = (
      paint: string,
      backdrop: string,
      filter: string,
    ): string => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing canvas context");
      context.fillStyle = backdrop;
      context.fillRect(0, 0, 1, 1);
      context.filter = filter;
      context.fillStyle = paint;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue] = context
        .getImageData(0, 0, 1, 1)
        .data.slice(0, 3);
      return `rgb(${red}, ${green}, ${blue})`;
    };
    const backgroundLayers: Element[] = [];
    let current: Element | null = element;
    while (current && current !== document.body) {
      backgroundLayers.unshift(current);
      current = current.parentElement;
    }
    let background = surface;
    for (const layer of backgroundLayers) {
      const layerStyle = getComputedStyle(layer);
      background = composite(
        layerStyle.backgroundColor,
        background,
        layerStyle.filter,
      );
    }
    if (colorOptions.pseudoElement) {
      background = composite(style.backgroundColor, background, style.filter);
    }
    return {
      foreground: composite(style.color, background, style.filter),
      background,
      border: style.borderColor,
      surface,
    };
  }, options);
}

async function readNormalAndHoveredColors(page: Page, selector: string) {
  await page.mouse.move(0, 0);
  const normal = await readRenderedColors(page, selector);
  await page.locator(selector).hover();
  const hovered = await readRenderedColors(page, selector);
  return { normal, hovered };
}

describe("compiled theme CSS", () => {
  test("resolves every profile token and follows the projected dark class", async () => {
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
    const referenceProfile = await readFile(
      new URL(
        "../../../web/src/lib/theme/profiles/classic-light.css",
        import.meta.url,
      ),
      "utf8",
    );
    const appCss = await readFile(
      new URL("../../../web/src/app.css", import.meta.url),
      "utf8",
    );
    const profileProperties = declaredProperties(referenceProfile);
    const styledDiffSyntaxClasses = [
      ...new Set(
        [...appCss.matchAll(/\.code-highlight \.(cm-code-[a-z-]+)/g)].map(
          (match) => match[1],
        ),
      ),
    ].sort();

    expect(appCss).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
    expect(compiledCss).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
    expect(styledDiffSyntaxClasses).toEqual([...DIFF_SYNTAX_CLASSES].sort());

    const browser = await chromium.launch({
      headless: true,
      ignoreDefaultArgs: ["--hide-scrollbars"],
    });
    const context = await browser.newContext({
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.route(`${APP_URL}**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/theme.css") {
        await route.fulfill({ contentType: "text/css", body: compiledCss });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><link rel="stylesheet" href="/theme.css"><style>*{transition:none!important}</style></head><body class="bg-background">
          <div id="dialog-surface" style="background:var(--dialog-surface)">
            <select class="select-native"><option>Theme</option></select>
            <input id="input-boundary" class="border border-input bg-background dark:bg-input/30 placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground" placeholder="Input placeholder">
            <textarea id="textarea-boundary" class="border border-input bg-transparent dark:bg-input/30 placeholder:text-muted-foreground" placeholder="Textarea placeholder"></textarea>
          </div>
          <div class="bg-popover">
            <div id="destructive-menu-item" data-variant="destructive" class="data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[variant=destructive]:text-status-error-foreground data-[variant=destructive]:data-highlighted:bg-destructive/10 dark:data-[variant=destructive]:data-highlighted:bg-destructive/20 data-[variant=destructive]:data-highlighted:text-status-error-foreground">Delete</div>
          </div>
          <button id="git-action-commit" class="bg-git-action-commit text-git-action-foreground hover:bg-git-action-commit-hover">Commit</button>
          <button id="git-action-pull" class="bg-git-action-pull text-git-action-foreground hover:bg-git-action-pull-hover">Pull</button>
          <button id="git-action-push" class="bg-git-action-push text-git-action-foreground hover:bg-git-action-push-hover">Push</button>
          <span id="interactive-accent-text" class="bg-interactive-accent/10 text-interactive-accent">Selected file</span>
          <button id="filled-interactive-accent" class="bg-interactive-accent text-interactive-accent-foreground hover:brightness-110">Save</button>
          <button id="stage-action" class="bg-git-added/20 text-git-added hover:bg-git-added/30">Stage</button>
          <button id="unstage-action" class="bg-git-deleted/20 text-git-deleted hover:bg-git-deleted/30">Unstage</button>
          <pre id="inline-diff" class="bg-muted/50"><span id="inline-diff-addition" class="text-diff-addition">+added</span><span id="inline-diff-deletion" class="text-diff-deletion">-deleted</span><span id="inline-diff-hunk" class="text-diff-hunk">@@ hunk</span></pre>
          <div class="bg-muted/15">
            <div id="virtual-add-normal" class="bg-diff-add"><span id="virtual-add-normal-content" class="code-highlight text-diff-add-fg">+added ${diffSyntaxFixture("virtual-add-normal")}</span><span id="virtual-add-normal-line" class="text-diff-add-line-num">1</span><button id="virtual-add-normal-action" class="text-muted-foreground">+</button></div>
            <div id="virtual-add-composer" class="bg-interactive-accent/10"><span id="virtual-add-composer-content" class="code-highlight text-diff-add-fg">+added ${diffSyntaxFixture("virtual-add-composer")}</span><span id="virtual-add-composer-line" class="text-diff-add-line-num">1</span><button id="virtual-add-composer-action" class="text-muted-foreground">+</button></div>
            <div id="virtual-add-selected" class="bg-interactive-accent/20"><span id="virtual-add-selected-content" class="code-highlight text-diff-add-fg">+added ${diffSyntaxFixture("virtual-add-selected")}</span><span id="virtual-add-selected-line" class="text-diff-add-line-num">1</span><button id="virtual-add-selected-action" class="text-muted-foreground">+</button></div>
            <div id="virtual-del-normal" class="bg-diff-del"><span id="virtual-del-normal-content" class="code-highlight text-diff-del-fg">-deleted ${diffSyntaxFixture("virtual-del-normal")}</span><span id="virtual-del-normal-line" class="text-diff-del-line-num">1</span><button id="virtual-del-normal-action" class="text-muted-foreground">-</button></div>
            <div id="virtual-del-composer" class="bg-interactive-accent/10"><span id="virtual-del-composer-content" class="code-highlight text-diff-del-fg">-deleted ${diffSyntaxFixture("virtual-del-composer")}</span><span id="virtual-del-composer-line" class="text-diff-del-line-num">1</span><button id="virtual-del-composer-action" class="text-muted-foreground">-</button></div>
            <div id="virtual-del-selected" class="bg-interactive-accent/20"><span id="virtual-del-selected-content" class="code-highlight text-diff-del-fg">-deleted ${diffSyntaxFixture("virtual-del-selected")}</span><span id="virtual-del-selected-line" class="text-diff-del-line-num">1</span><button id="virtual-del-selected-action" class="text-muted-foreground">-</button></div>
            <div id="virtual-context-normal"><span id="virtual-context-normal-content" class="code-highlight">${diffSyntaxFixture("virtual-context-normal")}</span><span id="virtual-context-normal-line" class="text-foreground/70">1</span></div>
            <div id="virtual-context-composer" class="bg-interactive-accent/10"><span class="code-highlight">${diffSyntaxFixture("virtual-context-composer")}</span><span id="virtual-context-composer-line" class="text-foreground/70">1</span></div>
            <div id="virtual-context-selected" class="bg-interactive-accent/20"><span class="code-highlight">${diffSyntaxFixture("virtual-context-selected")}</span><span id="virtual-context-selected-line" class="text-foreground/70">1</span></div>
            <div id="virtual-hunk-header" class="bg-diff-hunk-header"><span id="virtual-hunk-header-text" class="text-muted-foreground">@@ hunk</span></div>
          </div>
          <div id="scroll-area-thumb" data-slot="scroll-area-thumb" class="bg-(color:--scroll-area-thumb) hover:bg-(color:--scroll-area-thumb-hover)" style="width:8px;height:32px"></div>
          <div id="dark-utility" class="bg-transparent dark:bg-input/30"></div>
          <div data-processing-surface="sidebar" class="bg-sidebar-chat-item-bg"><span class="sidebar-processing-indicator bg-status-processing"></span></div>
          <div data-processing-surface="selected sidebar" class="bg-sidebar-chat-item-selected-bg"><span class="sidebar-processing-indicator bg-status-processing"></span></div>
          <div data-processing-surface="selected workspace tab" class="bg-workspace-window-tab-selected"><span class="workspace-chat-processing-indicator bg-status-processing"></span></div>
          <div data-processing-surface="inactive workspace tab" class="bg-workspace-window-tab-selected-inactive"><span class="workspace-chat-processing-indicator bg-status-processing"></span></div>
          <div id="scrollbar" style="width:100px;height:40px;overflow:scroll;scrollbar-gutter:stable"><div style="height:80px"></div></div>
        </body></html>`,
      });
    });

    try {
      await page.goto(APP_URL);
      await page.locator(".select-native").waitFor();
      for (const profile of THEME_PROFILES) {
        const values = await page.evaluate(
          ({ profile, properties }) => {
            const root = document.documentElement;
            root.dataset.theme = profile.id;
            root.classList.toggle("dark", profile.colorScheme === "dark");
            root.style.colorScheme = profile.colorScheme;
            const style = getComputedStyle(root);
            return Object.fromEntries(
              properties.map((property) => [
                property,
                style.getPropertyValue(property).trim(),
              ]),
            );
          },
          { profile, properties: profileProperties },
        );
        for (const property of profileProperties) {
          expect(values[property], `${profile.id} ${property}`).not.toBe("");
        }
      }

      const colorblindValues = await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.theme = "colorblind-light";
        root.classList.remove("dark");
        const light = getComputedStyle(root);
        const lightAdded = light.getPropertyValue("--git-added").trim();
        const lightDeleted = light.getPropertyValue("--git-deleted").trim();
        root.dataset.theme = "colorblind-dark";
        root.classList.add("dark");
        const dark = getComputedStyle(root);
        return {
          lightAdded,
          lightDeleted,
          darkAdded: dark.getPropertyValue("--git-added").trim(),
          darkDeleted: dark.getPropertyValue("--git-deleted").trim(),
        };
      });
      expect(colorblindValues).toEqual({
        lightAdded: "210 80% 30%",
        lightDeleted: "30 90% 26%",
        darkAdded: "210 85% 77%",
        darkDeleted: "30 92% 68%",
      });

      const classDrivenDark = await page.evaluate(() => {
        const root = document.documentElement;
        const target = document.querySelector<HTMLElement>("#dark-utility");
        if (!target) throw new Error("Missing dark utility fixture");
        root.dataset.theme = "classic-light";
        root.classList.remove("dark");
        const withoutClass = getComputedStyle(target).backgroundColor;
        root.dataset.theme = "classic-dark";
        root.classList.add("dark");
        const withClass = getComputedStyle(target).backgroundColor;
        return { withoutClass, withClass };
      });
      expect(classDrivenDark.withoutClass).toBe("rgba(0, 0, 0, 0)");
      expect(classDrivenDark.withClass).not.toBe(classDrivenDark.withoutClass);

      const radii = await page.evaluate(() => {
        const root = document.documentElement;
        const select = document.querySelector<HTMLElement>(".select-native");
        if (!select) throw new Error("Missing native select fixture");
        root.dataset.theme = "classic-light";
        const classic = getComputedStyle(select).borderRadius;
        root.dataset.theme = "phosphor-light";
        const phosphor = getComputedStyle(select).borderRadius;
        return { classic, phosphor };
      });
      expect(radii).toEqual({ classic: "6px", phosphor: "12px" });

      for (const profile of THEME_PROFILES) {
        await applyProfile(page, profile);
        const processingColors = await page.evaluate(() => {
          return [
            ...document.querySelectorAll<HTMLElement>(
              "[data-processing-surface]",
            ),
          ].map((surface) => {
            const indicator = surface.querySelector<HTMLElement>(
              ".sidebar-processing-indicator, .workspace-chat-processing-indicator",
            );
            if (!indicator) throw new Error("Missing processing indicator");
            return {
              name: surface.dataset.processingSurface,
              indicator: getComputedStyle(indicator).backgroundColor,
              surface: getComputedStyle(surface).backgroundColor,
            };
          });
        });
        for (const colors of processingColors) {
          expect(
            contrastRatio(colors.indicator, colors.surface),
            `${profile.id} processing indicator on ${colors.name}`,
          ).toBeGreaterThanOrEqual(3);
        }

        for (const action of ["commit", "pull", "push"] as const) {
          const colors = await readNormalAndHoveredColors(
            page,
            `#git-action-${action}`,
          );
          expect(
            contrastRatio(colors.normal.foreground, colors.normal.background),
            `${profile.id} Git ${action} action`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(colors.hovered.foreground, colors.hovered.background),
            `${profile.id} Git ${action} action hover`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        const selectedAccent = await readRenderedColors(
          page,
          "#interactive-accent-text",
        );
        expect(
          contrastRatio(selectedAccent.foreground, selectedAccent.background),
          `${profile.id} interactive accent text`,
        ).toBeGreaterThanOrEqual(4.5);

        const filledAccent = await readNormalAndHoveredColors(
          page,
          "#filled-interactive-accent",
        );
        for (const [interaction, colors] of Object.entries(filledAccent)) {
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} filled interactive accent ${interaction}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        for (const action of ["stage", "unstage"] as const) {
          const colorsByInteraction = await readNormalAndHoveredColors(
            page,
            `#${action}-action`,
          );
          for (const [interaction, colors] of Object.entries(
            colorsByInteraction,
          )) {
            expect(
              contrastRatio(colors.foreground, colors.background),
              `${profile.id} ${action} action ${interaction}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }

        for (const kind of ["addition", "deletion", "hunk"] as const) {
          const colors = await readRenderedColors(page, `#inline-diff-${kind}`);
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} inline diff ${kind}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        for (const kind of ["add", "del"] as const) {
          for (const rowState of ["normal", "composer", "selected"] as const) {
            const row = `virtual-${kind}-${rowState}`;
            for (const role of ["content", "line"] as const) {
              const colors = await readRenderedColors(page, `#${row}-${role}`);
              expect(
                contrastRatio(colors.foreground, colors.background),
                `${profile.id} ${kind} ${rowState} ${role}`,
              ).toBeGreaterThanOrEqual(4.5);
            }

            const action = await readRenderedColors(page, `#${row}-action`);
            expect(
              contrastRatio(action.foreground, action.background),
              `${profile.id} ${kind} ${rowState} line action`,
            ).toBeGreaterThanOrEqual(3);

            for (const syntaxClass of DIFF_SYNTAX_CLASSES) {
              const syntax = await readRenderedColors(
                page,
                `#${row}-${syntaxClass}`,
              );
              expect(
                contrastRatio(syntax.foreground, syntax.background),
                `${profile.id} ${kind} ${rowState} ${syntaxClass}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }

        for (const rowState of ["normal", "composer", "selected"] as const) {
          const row = `virtual-context-${rowState}`;
          const colors = await readRenderedColors(page, `#${row}-line`);
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} context ${rowState} line number`,
          ).toBeGreaterThanOrEqual(4.5);

          for (const syntaxClass of DIFF_SYNTAX_CLASSES) {
            const syntax = await readRenderedColors(
              page,
              `#${row}-${syntaxClass}`,
            );
            expect(
              contrastRatio(syntax.foreground, syntax.background),
              `${profile.id} context ${rowState} ${syntaxClass}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }

        const hunkHeader = await readRenderedColors(
          page,
          "#virtual-hunk-header-text",
        );
        expect(
          contrastRatio(hunkHeader.foreground, hunkHeader.background),
          `${profile.id} virtual hunk header`,
        ).toBeGreaterThanOrEqual(4.5);

        const destructiveMenuItem = page.locator("#destructive-menu-item");
        const normalDestructiveMenu = await readRenderedColors(
          page,
          "#destructive-menu-item",
        );
        await destructiveMenuItem.evaluate((element) => {
          element.setAttribute("data-highlighted", "");
        });
        const highlightedDestructiveMenu = await readRenderedColors(
          page,
          "#destructive-menu-item",
        );
        await destructiveMenuItem.evaluate((element) => {
          element.removeAttribute("data-highlighted");
        });
        for (const [interaction, colors] of Object.entries({
          normal: normalDestructiveMenu,
          highlighted: highlightedDestructiveMenu,
        })) {
          expect(
            contrastRatio(colors.foreground, colors.background),
            `${profile.id} destructive menu item ${interaction}`,
          ).toBeGreaterThanOrEqual(4.5);
        }

        const scrollAreaThumb = await readNormalAndHoveredColors(
          page,
          "#scroll-area-thumb",
        );
        for (const [interaction, colors] of Object.entries(scrollAreaThumb)) {
          expect(
            contrastRatio(colors.background, colors.surface),
            `${profile.id} ScrollArea thumb ${interaction}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }

      for (const profile of ["phosphor-light", "phosphor-dark"] as const) {
        const descriptor = THEME_PROFILES.find(
          (candidate) => candidate.id === profile,
        );
        if (!descriptor) throw new Error(`Missing profile ${profile}`);
        await applyProfile(page, descriptor);
        const scrollbarWidth = await page.evaluate(() => {
          const scrollbar = document.querySelector<HTMLElement>("#scrollbar");
          if (!scrollbar) throw new Error("Missing scrollbar fixture");
          return scrollbar.offsetWidth - scrollbar.clientWidth;
        });
        const scrollbarColors = await readRenderedColors(page, "#scrollbar", {
          pseudoElement: "::-webkit-scrollbar-thumb",
        });
        expect(scrollbarWidth, `${profile} scrollbar width`).toBe(10);
        expect(
          contrastRatio(scrollbarColors.background, scrollbarColors.surface),
          `${profile} scrollbar thumb`,
        ).toBeGreaterThanOrEqual(3);
        const [
          dialogSurface,
          select,
          input,
          inputPlaceholder,
          textareaPlaceholder,
        ] = await Promise.all([
          readRenderedColors(page, "#dialog-surface"),
          readRenderedColors(page, ".select-native"),
          readRenderedColors(page, "#input-boundary"),
          readRenderedColors(page, "#input-boundary", {
            pseudoElement: "::placeholder",
          }),
          readRenderedColors(page, "#textarea-boundary", {
            pseudoElement: "::placeholder",
          }),
        ]);
        expect(
          contrastRatio(input.border, dialogSurface.background),
          `${profile} input boundary`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(select.border, select.background),
          `${profile} native-select boundary`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(
            inputPlaceholder.foreground,
            inputPlaceholder.background,
          ),
          `${profile} input placeholder`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(
            textareaPlaceholder.foreground,
            textareaPlaceholder.background,
          ),
          `${profile} textarea placeholder`,
        ).toBeGreaterThanOrEqual(4.5);

        for (const [label, selector] of [
          ["syntax", "#virtual-context-normal-cm-code-keyword"],
          ["input", "#input-boundary"],
        ] as const) {
          const selection = await readRenderedColors(page, selector, {
            pseudoElement: "::selection",
          });
          expect(
            contrastRatio(selection.foreground, selection.background),
            `${profile} ${label} selection`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  }, 20_000);
});
