/** Checks real service-worker installation and on-demand font caching. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from 'playwright/test';
import { createChromiumFixture } from '../support/chromium-fixture.js';

const output = resolve(process.argv[2] ?? '/projects/font-optimization-evidence/cache');
await mkdir(output, { recursive: true });
const fixture = await createChromiumFixture({ serviceWorkers: 'allow' });
try {
  const { page, integration } = fixture;
  await page.goto(integration.garcon.baseUrl);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  const fontCache = () => page.evaluate(async () => {
    const requests = (await Promise.all((await caches.keys()).map(async name => (await caches.open(name)).keys()))).flat();
    return requests.map(request => new URL(request.url).pathname).filter(path => /\.(woff2?|ttf|otf)$/.test(path));
  });
  const installed = await fontCache();
  expect(installed).toEqual([]);
  await page.evaluate(async () => {
    const sample = document.createElement('div');
    sample.id = 'cache-font-proof';
    sample.style.fontFamily = 'JetBrains Mono';
    sample.textContent = 'ASCII “quotes”—…';
    document.body.append(sample);
    sample.getBoundingClientRect();
    await document.fonts.ready;
  });
  await expect.poll(fontCache).toHaveLength(1);
  const core = await fontCache();
  expect(core[0]).toContain('JetBrainsMono-core.');
  await page.evaluate(async () => {
    document.querySelector('#cache-font-proof')!.textContent += ' ∑';
    document.body.getBoundingClientRect();
    await document.fonts.ready;
  });
  await expect.poll(fontCache).toHaveLength(2);
  const extended = await fontCache();
  expect(extended.some(path => path.includes('JetBrainsMono-extended.'))).toBe(true);
  await writeFile(resolve(output, 'cache.json'), JSON.stringify({ installed, core, extended }, null, 2) + '\n');
  console.log({ installed, core, extended });
} finally {
  await fixture.context.close();
  await fixture.browser.close();
  await fixture.integration.dispose();
}
