import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

declare global {
  interface Window {
    XYFlowSystem: typeof import('@xyflow/system');
  }
}

test('the patched graph UMD runs in a browser without a process shim', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const script = await readFile(new URL('../../../node_modules/@xyflow/system/dist/umd/index.js', import.meta.url), 'utf8');
    await page.addScriptTag({ content: script });
    const result = await page.evaluate(() => {
      window.XYFlowSystem.handleAttributionWarning('svelte');
      return {
        hasProcess: 'process' in window,
        bounds: window.XYFlowSystem.getNodesBounds([
          { id: 'a', position: { x: 10, y: 20 }, width: 100, height: 50, data: {} },
        ]),
      };
    });
    expect(result).toEqual({ hasProcess: false, bounds: { x: 10, y: 20, width: 100, height: 50 } });
  } finally {
    await browser.close();
  }
});
