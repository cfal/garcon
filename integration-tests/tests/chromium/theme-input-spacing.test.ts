import { expect, test } from "bun:test";
import { captureBrowserErrors } from '../../support/browser-errors.js';
import { readFile, readdir } from "node:fs/promises";
import { chromium } from "playwright";

for (const hasTouch of [false, true]) {
  test(`canvas and Vim inputs retain default spacing with ${hasTouch ? "touch" : "mouse"} input`, async () => {
    const assets = new URL(
      "../../../web/build/_app/immutable/assets/",
      import.meta.url,
    );
    const cssFiles = (await readdir(assets))
      .filter((name) => name.endsWith(".css"))
      .sort();
    expect(cssFiles.length).toBeGreaterThan(0);
    const css = (
      await Promise.all(
        cssFiles.map((name) => readFile(new URL(name, assets), "utf8")),
      )
    ).join("\n");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        hasTouch,
        viewport: { width: hasTouch ? 390 : 1440, height: 900 },
      });
      const browserErrors: string[] = [];
      captureBrowserErrors(page.context(), browserErrors);
      await page.setContent(`<!doctype html><html data-theme="phosphor-light">
        <head><style>${css}</style></head><body>
          <input class="canvas-input" value="Canvas title">
          <div class="cm-editor"><div class="cm-panel cm-vim-panel">
            <input value=":write">
          </div></div>
        </body></html>`);
      expect(
        await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      ).toBe(hasTouch);

      for (const size of ["default", "10", "20", "default"] as const) {
        const scale = size === "default" ? 1 : Number(size) / 14;
        const measurements = await page.evaluate((scale) => {
          document.documentElement.style.setProperty(
            "--interface-font-scale",
            String(scale),
          );
          function measure(selector: string) {
            const input = document.querySelector<HTMLInputElement>(selector)!;
            const style = getComputedStyle(input);
            return {
              fontSize: parseFloat(style.fontSize),
              lineHeight: parseFloat(style.lineHeight),
              height: input.getBoundingClientRect().height,
            };
          }
          return {
            canvas: measure(".canvas-input"),
            vim: measure(".cm-vim-panel input"),
          };
        }, scale);
        if (size === "default") {
          expect(measurements.canvas).toEqual({
            fontSize: hasTouch ? 16 : 14,
            lineHeight: 20,
            height: 38,
          });
          expect(measurements.vim).toEqual({
            fontSize: hasTouch ? 16 : 12,
            lineHeight: 18,
            height: 18,
          });
        } else {
          expect(measurements.canvas.fontSize).toBeCloseTo(
            hasTouch ? Math.max(16, 16 * scale) : 14 * scale,
            2,
          );
          expect(measurements.canvas.lineHeight).toBeCloseTo(
            Math.max(20, 20 * scale),
            2,
          );
          expect(measurements.canvas.height).toBeCloseTo(
            measurements.canvas.lineHeight + 18,
            1,
          );
          expect(measurements.vim.fontSize).toBeCloseTo(
            hasTouch ? Math.max(16, 12 * scale) : 12 * scale,
            2,
          );
          expect(measurements.vim.lineHeight).toBeCloseTo(
            Math.max(18, 18 * scale),
            2,
          );
          expect(measurements.vim.height).toBeCloseTo(
            measurements.vim.lineHeight,
            1,
          );
        }
      }
      expect(browserErrors).toEqual([]);
    } finally {
      await browser.close();
    }
  });
}
