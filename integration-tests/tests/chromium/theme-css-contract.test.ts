import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { THEME_PROFILES } from "../../../web/src/lib/theme/themes";

const APP_URL = "http://theme-css-contract.test/";

function declaredProperties(source: string): string[] {
  return [...new Set(source.match(/--[a-z0-9-]+(?=\s*:)/g) ?? [])].sort();
}

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

    expect(appCss).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);
    expect(compiledCss).not.toMatch(/\.(?:dark\.)?colorblind(?:\s|\{|,)/);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.route(`${APP_URL}**`, async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/theme.css") {
        await route.fulfill({ contentType: "text/css", body: compiledCss });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><head><link rel="stylesheet" href="/theme.css"><style>*{transition:none!important}</style></head><body class="bg-background"><div id="dialog-surface" style="background:var(--dialog-surface)"><select class="select-native"><option>Theme</option></select><input id="input-boundary" class="border border-input bg-background dark:bg-input/30 placeholder:text-muted-foreground" placeholder="Input placeholder"><textarea id="textarea-boundary" class="border border-input bg-transparent dark:bg-input/30 placeholder:text-muted-foreground" placeholder="Textarea placeholder"></textarea></div><button id="git-action" class="bg-git-action-commit text-git-action-foreground">Commit</button><button id="git-action-hover" class="bg-git-action-commit-hover text-git-action-foreground">Commit</button><div id="dark-utility" class="bg-transparent dark:bg-input/30"></div></body></html>',
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
        lightAdded: "210 80% 45%",
        lightDeleted: "30 90% 50%",
        darkAdded: "210 85% 65%",
        darkDeleted: "30 92% 65%",
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

      for (const profile of ["phosphor-light", "phosphor-dark"] as const) {
        const colors = await page.evaluate((themeId) => {
          const root = document.documentElement;
          const select = document.querySelector<HTMLElement>(".select-native");
          const input = document.querySelector<HTMLElement>("#input-boundary");
          const textarea =
            document.querySelector<HTMLElement>("#textarea-boundary");
          const dialogSurface =
            document.querySelector<HTMLElement>("#dialog-surface");
          const gitAction = document.querySelector<HTMLElement>("#git-action");
          const gitActionHover =
            document.querySelector<HTMLElement>("#git-action-hover");
          if (
            !select ||
            !input ||
            !textarea ||
            !dialogSurface ||
            !gitAction ||
            !gitActionHover
          ) {
            throw new Error("Missing theme contrast fixtures");
          }
          root.dataset.theme = themeId;
          root.classList.toggle("dark", themeId === "phosphor-dark");
          const composite = (foreground: string, background: string) => {
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("Missing canvas context");
            context.fillStyle = background;
            context.fillRect(0, 0, 1, 1);
            context.fillStyle = foreground;
            context.fillRect(0, 0, 1, 1);
            const [red, green, blue] = context
              .getImageData(0, 0, 1, 1)
              .data.slice(0, 3);
            return `rgb(${red}, ${green}, ${blue})`;
          };
          const surfaceStyle = getComputedStyle(dialogSurface);
          const selectStyle = getComputedStyle(select);
          const inputStyle = getComputedStyle(input);
          const textareaStyle = getComputedStyle(textarea);
          const gitActionStyle = getComputedStyle(gitAction);
          const gitActionHoverStyle = getComputedStyle(gitActionHover);
          return {
            adjacentSurface: surfaceStyle.backgroundColor,
            inputBorder: inputStyle.borderColor,
            inputBackground: composite(
              inputStyle.backgroundColor,
              surfaceStyle.backgroundColor,
            ),
            inputPlaceholder: getComputedStyle(input, "::placeholder").color,
            textareaBackground: composite(
              textareaStyle.backgroundColor,
              surfaceStyle.backgroundColor,
            ),
            textareaPlaceholder: getComputedStyle(
              textarea,
              "::placeholder",
            ).color,
            selectBackground: selectStyle.backgroundColor,
            selectBorder: selectStyle.borderColor,
            gitForeground: gitActionStyle.color,
            gitBackground: gitActionStyle.backgroundColor,
            gitHoverForeground: gitActionHoverStyle.color,
            gitHoverBackground: gitActionHoverStyle.backgroundColor,
          };
        }, profile);
        expect(
          contrastRatio(colors.inputBorder, colors.adjacentSurface),
          `${profile} input boundary`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(colors.selectBorder, colors.selectBackground),
          `${profile} native-select boundary`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(colors.gitForeground, colors.gitBackground),
          `${profile} Git commit action`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(colors.gitHoverForeground, colors.gitHoverBackground),
          `${profile} Git commit action hover`,
        ).toBeGreaterThanOrEqual(4.5);
        if (profile === "phosphor-dark") {
          expect(
            contrastRatio(colors.inputPlaceholder, colors.inputBackground),
            `${profile} input placeholder`,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrastRatio(
              colors.textareaPlaceholder,
              colors.textareaBackground,
            ),
            `${profile} textarea placeholder`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    } finally {
      await context.close();
      await browser.close();
    }
  });
});
