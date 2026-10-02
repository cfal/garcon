import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';

test('loads Markdown, HTML and WAST highlighting only when an editor needs it', async () => {
  await withChromiumFixture('lazy-language-chunks', async ({ page, integration, assertNoBrowserErrors }) => {
    const manifest: Record<string, { name?: string; file: string }> = JSON.parse(await readFile(
      new URL('../../../web/.svelte-kit/output/client/.vite/manifest.json', import.meta.url), 'utf8',
    ));
    const implementations = Object.values(manifest).filter(entry =>
      entry.name?.startsWith('vendor-cm-lang-') && entry.name !== 'vendor-cm-lang-metadata',
    );
    const requested = new Set<string>();
    page.on('request', request => requested.add(new URL(request.url()).pathname));
    const samples = [
      { name: 'sample.md', content: '# Synthetic heading\n\n**Highlighted text**\n' },
      { name: 'sample.html', content: '<section class="example">Synthetic content</section>\n' },
      { name: 'sample.wat', content: '(module (func (result i32) i32.const 42))\n' },
    ];
    for (const sample of samples) await writeFile(join(integration.dirs.project, sample.name), sample.content);
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({
      chatId, content: 'Synthetic language fixture', projectPath: integration.dirs.project,
      agent: integration.directAgents.openAi,
    });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await browserExpect(page.locator('[data-file-tree-entry-text]').filter({ hasText: 'sample.md' })).toBeVisible();
    expect(implementations.filter(entry => requested.has(`/${entry.file}`))).toEqual([]);

    for (const sample of samples) {
      await page.getByRole('tab', { name: 'Files', exact: true }).click();
      await page.locator('[data-file-tree-entry-text]').filter({ hasText: sample.name }).click();
      const surface = page.locator('[data-workspace-surface-id^="file:"][aria-hidden="false"]');
      if (sample.name.endsWith('.md')) await surface.getByRole('button', { name: 'Edit', exact: true }).click();
      const source = surface.locator('.cm-content');
      await browserExpect(source.locator('.cm-line')).toHaveText(sample.content.split('\n'));
      await browserExpect(source.locator('.cm-line span[class]').first()).toBeVisible();
    }
    for (const name of ['vendor-cm-lang-template', 'vendor-cm-lang-markup', 'vendor-cm-lang-programming']) {
      const chunk = implementations.find(entry => entry.name === name);
      expect(chunk).toBeDefined();
      expect(requested.has(`/${chunk!.file}`)).toBe(true);
    }
    assertNoBrowserErrors();
  });
}, 120_000);
