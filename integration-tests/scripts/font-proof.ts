/** Captures identical synthetic application content with original and generated fonts. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from 'playwright/test';
import { authenticateChromiumContext, createChromiumFixture } from '../support/chromium-fixture.js';

const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[2] ?? '/projects/font-optimization-evidence/application');
await mkdir(output, { recursive: true });
const sources: { file: string }[] = await Bun.file(join(root, 'scripts/fonts/sources.json')).json();
const originalFaces = sources.map(({ file }) => {
  const family = file.startsWith('Inter') ? 'Inter' : file.startsWith('JetBrains') ? 'JetBrains Mono' : 'Departure Mono';
  return `@font-face {font-family:'${family}';src:url('/__font_proof/${file}');font-style:${file.includes('Italic') ? 'italic' : 'normal'};font-weight:${family === 'Inter' ? '100 900' : family === 'JetBrains Mono' ? '100 800' : '400'};font-display:swap;}`;
}).join('\n');
const samples = {
  ascii: '# Font proof\n\nAVATAR To office affine -> != ===. “Quoted text”—a dash…\n\n*Italic text with **bold inside italics**.*\n\n```js\nconst result = items.filter(value => value !== null);\n// A code comment\n```',
  accents: '# Font proof\n\nCafé déjà vu. ĀČĎĒĢŁŊŒŘŠŤŪŽ. AV ÁV A\u0301V To Tô. Straße Œuvre. Ĳ\u0301 ĳ\u0301 Ƃ\u0301 Ƅ\u0301 ı\u0301 ø\u0301 ð\u0301 ƂA ƄA.\n\n*Italics with **bold café ĀŽ** inside.*\n\n```js\nconst café = "café"; // ĀŽ\n```',
  extended: '# Font proof\n\nUncommon symbols: ∑ − ≤. Mixed spacing: A   A Ƃ   Ƃ.\n\n*An italic **bold ∑** symbol.*\n\n```text\n∑\n```',
  cjk: '# Font proof\n\n中文 日本語 한국어 with ASCII text.\n\n*Italics and **bold 中文** together.*\n\n```text\n中文 日本語 한국어\n```',
};
const fixture = await createChromiumFixture({ chatTitleEnabled: false });
const { integration, browser } = fixture;
const cases: Record<string, string> = {};
try {
  for (const [name, content] of Object.entries(samples)) {
    const prompt = `Synthetic font proof ${name}`;
    integration.fakeProviders.openAi.respondMalformedThenTextNext({ lastUserText: prompt }, content);
    const chatId = integration.newChatId();
    const started = await integration.client.startDirectChat({ chatId, content: prompt, projectPath: integration.dirs.project, agent: integration.directAgents.openAi });
    await integration.client.waitForTurnTerminal(chatId, started.turnId);
    cases[name] = `/chat/${chatId}`;
  }
  cases.settings = cases.ascii;
  cases.editor = cases.ascii;
  await writeFile(join(integration.dirs.project, 'font-proof.ts'), '// Italic comment: café ĀŽ\nconst value = "中文";\n');
  // Clears unread/read-receipt presentation before either font revision is captured.
  await authenticateChromiumContext(fixture.context, integration);
  for (const path of new Set(Object.values(cases))) {
    await fixture.page.goto(integration.garcon.baseUrl + path);
    await expect(fixture.page.locator('[data-chat-feed-content]')).toContainText('Font proof');
    await fixture.page.waitForLoadState('networkidle');
  }
  const results: unknown[] = [];
  for (const mode of ['before', 'after', 'control'] as const) {
    for (const font of ['default', 'departure-mono', 'jetbrains-mono', 'inter'] as const) {
      for (const [name, path] of Object.entries(cases)) {
        for (const width of [1440, 390]) {
          const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: 'block', reducedMotion: 'reduce', colorScheme: 'light' });
          await authenticateChromiumContext(context, integration);
          await context.addInitScript((font) => localStorage.setItem('pref_local_settings', JSON.stringify({ interfaceFont: font, chatFeedFont: font, chatCodeFont: font === 'inter' ? 'jetbrains-mono' : font, codeEditorFont: font === 'inter' ? 'jetbrains-mono' : font, allowDirectChats: true, composerInputMode: 'source', reduceMotion: true })), font);
          const page = await context.newPage();
          await page.clock.setFixedTime(new Date('2026-10-30T12:00:00Z'));
          const fonts = new Map<string, number>();
          page.on('response', response => {
            if (new URL(response.url()).pathname.endsWith('.woff2')) fonts.set(new URL(response.url()).pathname.split('/').pop()!, Number(response.headers()['content-length'] ?? 0));
          });
          if (mode !== 'after') {
            // The original application had no font preloads.
            await page.route(/\/_app\/immutable\/assets\/(?:InterVariable|JetBrainsMono|DepartureMono)[^/]*\.woff2$/, route => route.abort());
            await page.route('**/*.css', async route => {
              const response = await route.fetch();
              let css = await response.text();
              if (/@font-face\s*\{[^}]*font-family:\s*["']?(?:Inter|JetBrains Mono|Departure Mono)/.test(css)) {
                css = css.replace(/@font-face\s*\{[^}]*font-family:\s*["']?(?:Inter|JetBrains Mono|Departure Mono)[^}]*\}/g, '') + originalFaces;
              }
              await route.fulfill({ response, body: css });
            });
            await page.route('**/__font_proof/*.woff2', async route => route.fulfill({ contentType: 'font/woff2', body: await readFile(join(root, 'scripts/fonts/sources', new URL(route.request().url()).pathname.split('/').pop()!)) }));
          }
          await page.goto(integration.garcon.baseUrl + path);
          if (mode !== 'after') await page.locator('link[rel="preload"][as="font"]').evaluateAll(links => links.forEach(link => link.remove()));
          await expect(page.locator('[data-chat-feed-content]')).toContainText('Font proof');
          await expect(page.locator('[data-chat-feed-content] pre')).toBeVisible();
          await expect(page.getByText('Integration Echo', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
          if (name === 'settings') {
            if (width < 640) await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Menu', exact: true }).click();
            await page.getByRole('button', { name: 'More actions', exact: true }).click();
            await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
            await page.getByRole('button', { name: /^Interface font:/i }).click();
            await expect(page.locator('[data-font-preview]')).toBeVisible();
          }
          if (name === 'editor') {
            if (width < 640) await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Files', exact: true }).click();
            await page.locator('[data-file-tree-entry-text]').filter({ hasText: 'font-proof.ts' }).click();
            await expect(page.locator('.cm-editor')).toBeVisible();
          }
          await page.waitForLoadState('networkidle');
          await page.evaluate(async () => {
            document.body.getBoundingClientRect();
            await document.fonts.ready;
            await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          });
          if (await page.locator('[data-chat-feed-content]').count()) await page.locator('[data-chat-feed-content]').evaluate(element => element.scrollTop = 0);
          if (mode !== 'after') await page.locator('link[rel="preload"][as="font"]').evaluateAll(links => links.forEach(link => link.remove()));
          const key = `${font}-${name}-${width}`;
          await page.screenshot({ path: join(output, `${key}-${mode}.png`), animations: 'disabled', caret: 'hide' });
          const preloads = await page.locator('link[rel="preload"][as="font"]').evaluateAll(links => links.map(link => (link as HTMLLinkElement).href.split('/').pop()));
          const typography = await page.locator('[data-chat-feed-content] :is(em,strong,code)').evaluateAll(elements => elements.map(element => { const css = getComputedStyle(element); return { tag: element.tagName, family: css.fontFamily, weight: css.fontWeight, style: css.fontStyle, features: css.fontFeatureSettings }; }));
          results.push({ mode, key, visibleText: await page.locator('body').innerText(), fontBytes: [...fonts.values()].reduce((a, b) => a + b, 0), fonts: Object.fromEntries(fonts), preloads, typography });
          await writeFile(join(output, 'network.json'), JSON.stringify(results, null, 2) + '\n');
          console.log(mode, key, Object.fromEntries(fonts));
          await context.close();
        }
      }
    }
  }
  await writeFile(join(output, 'network.json'), JSON.stringify(results, null, 2) + '\n');
} finally {
  await fixture.context.close();
  await browser.close();
  await integration.dispose();
}
