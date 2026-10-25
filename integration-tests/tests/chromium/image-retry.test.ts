import { expect, test } from 'bun:test';
import { expect as browserExpect, type Page } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { Deferred } from '../../support/deferred.js';

const EXPECTED_NOT_FOUND =
  'console.error: Failed to load resource: the server responded with a status of 404 (Not Found)';
const EXTERNAL_IMAGE_URL = 'https://images.example.test/capture.png';

async function createPngBuffer(page: Page): Promise<Buffer> {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#238636';
    context.fillRect(0, 0, 1, 1);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(encoded, 'base64');
}

for (const executionBackend of ['in-process', 'remote-executor-dials', 'remote-controller-dials'] as const) {
  test(`retries missing and partially written images in place: ${executionBackend}`, async () => {
    await withChromiumFixture(
      `image-retry-${executionBackend}`,
      async ({ page, integration, browserErrors, failedResponses }) => {
        const { client, executionDirs, directAgents, garcon } = integration;
        const png = await createPngBuffer(page);
        await writeFile(join(executionDirs.project, 'partial.png'), png.subarray(0, 24));
        await writeFile(join(executionDirs.project, 'good.png'), png);
        await writeFile(join(executionDirs.project, 'linked.md'), '# Linked document');
        const longName = 'Partial-capture-with-an-unbroken-name-that-must-fit-on-narrow-screens';
        const chatId = integration.newChatId();
        const started = await client.startDirectChat({
          chatId,
          content: `Images ready soon.\n\n![Pending capture](pending.png)\n\n[![Linked capture](linked.png)](linked.md)\n\n![${longName}](partial.png)\n\n![Retained capture](good.png)`,
          projectPath: executionDirs.project,
          agent: directAgents.openAi,
        });
        await client.waitForTurnTerminal(chatId, started.turnId);
        const otherChatId = integration.newChatId();
        const other = await client.startDirectChat({
          chatId: otherChatId,
          content: 'Other conversation',
          projectPath: executionDirs.project,
          agent: directAgents.openAi,
        });
        await client.waitForTurnTerminal(otherChatId, other.turnId);
        const requests: string[] = [];
        page.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname !== '/api/v1/files/content') return;
          expect(url.searchParams.get('executorId')).toBe(client.executorId);
          expect(url.searchParams.get('projectPath')).toBe(executionDirs.project);
          expect(request.headers().authorization).toBe(`Bearer ${garcon.authToken}`);
          requests.push(url.searchParams.get('path')!);
        });
        await page.goto(`${garcon.baseUrl}/chat/${chatId}`);
        const assistant = page.locator('[data-chat-message-type="assistant-message"]');
        const retryPending = assistant.getByRole('button', {
          name: 'Retry image Pending capture',
          exact: true,
        });
        const retryLinked = assistant.getByRole('button', {
          name: 'Retry image Linked capture',
          exact: true,
        });
        const retryPartial = assistant.getByRole('button', {
          name: `Retry image ${longName}`,
          exact: true,
        });
        const retained = assistant.getByRole('img', {
          name: 'Retained capture',
          exact: true,
        });
        await browserExpect(retained).toHaveJSProperty('naturalWidth', 1);
        await browserExpect(assistant.locator('.markdown-image[tabindex]')).toHaveCount(0);
        const retainedSource = await retained.getAttribute('src');
        const artifactDirectory = new URL('../../artifacts/chromium/', import.meta.url).pathname;
        await mkdir(artifactDirectory, { recursive: true });
        for (const width of [1440, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await browserExpect(page.locator('.mobile-shell')).toHaveCount(width === 320 ? 1 : 0);
          for (const retry of [retryPending, retryLinked, retryPartial]) {
            await retry.scrollIntoViewIfNeeded();
            await browserExpect(retry).toBeVisible();
            expect(await retry.evaluate((element) => element.closest('a') === null)).toBe(true);
          }
          for (const row of await page.locator('.markdown-image-error').all()) {
            const fits = await row.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const markdown = element.closest('.markdown-body')!.getBoundingClientRect();
              const canvas = document.createElement('canvas');
              canvas.width = canvas.height = 1;
              const context = canvas.getContext('2d')!;
              context.fillStyle = getComputedStyle(element).backgroundColor;
              context.fillRect(0, 0, 1, 1);
              const opaque = context.getImageData(0, 0, 1, 1).data[3] === 255;
              return (
                opaque &&
                element.scrollWidth <= element.clientWidth + 1 &&
                bounds.left >= markdown.left - 1 &&
                bounds.right <= markdown.right + 1
              );
            });
            expect(fits).toBe(true);
          }
          if (executionBackend === 'in-process') {
            await page.screenshot({
              path: join(artifactDirectory, `image-retry-${width}.png`),
            });
          }
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await browserExpect(page.locator('.mobile-shell')).toHaveCount(0);
        await browserExpect(retryPending).toBeVisible();
        await browserExpect(retryLinked).toBeVisible();
        await browserExpect(retryPartial).toBeVisible();
        await browserExpect(assistant.getByRole('alert')).toHaveCount(0);
        await retryPending.press('Enter');
        await browserExpect(retryPending).toBeVisible();
        await browserExpect(retryPending).toBeFocused();
        await browserExpect(assistant.getByRole('alert')).toHaveCount(1);
        const originalMarkdown = await assistant.locator('.markdown-body').elementHandle();
        const originalRetained = await retained.elementHandle();
        const pendingReads = requests.filter((path) => path === 'pending.png').length;
        const releaseRetry = new Deferred<void>();
        await page.route('**/api/v1/files/content?**', async (route) => {
          if (new URL(route.request().url()).searchParams.get('path') === 'pending.png') {
            await releaseRetry.promise;
          }
          await route.continue();
        });
        try {
          await retryPending.press('Enter');
          await browserExpect(assistant.getByRole('status', { name: 'Loading image...' })).toBeVisible();
          await browserExpect(assistant.locator('.markdown-image').first()).toBeFocused();
          await browserExpect(retryPending).toHaveCount(0);
          await browserExpect
            .poll(() => requests.filter((path) => path === 'pending.png').length)
            .toBe(pendingReads + 1);
          await writeFile(join(executionDirs.project, 'pending.png'), png);
        } finally {
          releaseRetry.resolve();
        }
        const recovered = assistant.getByRole('img', {
          name: 'Pending capture',
          exact: true,
        });
        await browserExpect(recovered).toHaveJSProperty('naturalWidth', 1);
        expect(
          await assistant
            .locator('.markdown-body')
            .evaluate((element, original) => element === original, originalMarkdown),
        ).toBe(true);
        await originalMarkdown?.dispose();

        await writeFile(join(executionDirs.project, 'linked.png'), png);
        await retryLinked.click();
        await browserExpect(assistant.getByRole('img', { name: 'Linked capture', exact: true })).toHaveJSProperty(
          'naturalWidth',
          1,
        );
        expect(page.url()).toBe(`${garcon.baseUrl}/chat/${chatId}`);
        await browserExpect(page.getByRole('heading', { name: 'Linked document', exact: true })).toHaveCount(0);
        await writeFile(join(executionDirs.project, 'partial.png'), png);
        await retryPartial.press('Space');
        await browserExpect(assistant.getByRole('img', { name: longName, exact: true })).toHaveJSProperty(
          'naturalWidth',
          1,
        );
        await browserExpect(assistant.locator('.markdown-image-error')).toHaveCount(0);
        await browserExpect(retained).toHaveAttribute('src', retainedSource!);
        expect(await retained.evaluate((element, original) => element === original, originalRetained)).toBe(true);
        expect(requests.filter((path) => path === 'good.png')).toHaveLength(1);
        await originalRetained?.dispose();

        const composer = page.locator('[data-conversation-composer-host] textarea[placeholder="Reply..."]');
        await composer.focus();
        const originalComposer = await composer.elementHandle();
        const composerBounds = await composer.boundingBox();
        const recoveredSource = await recovered.getAttribute('src');
        const readsBeforeSwitch = requests.length;
        for (const target of [otherChatId, chatId, otherChatId, chatId]) {
          await page
            .locator(`[data-sidebar-virtual-row="${target}"] [data-slot="sidebar-chat-summary"]`)
            .evaluate((element) => element.closest('button')!.click());
          await page.locator(`[data-conversation-panel-chat-id="${target}"]`).waitFor({ state: 'visible' });
        }
        await browserExpect(recovered).toHaveAttribute('src', recoveredSource!);
        await browserExpect(assistant.getByRole('status')).toHaveCount(0);
        expect(requests).toHaveLength(readsBeforeSwitch);
        expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
        await browserExpect(composer).toBeFocused();
        expect(Math.abs((await composer.boundingBox())!.y - composerBounds!.y)).toBeLessThan(1);
        await originalComposer?.dispose();
        await assistant.getByRole('link', { name: 'Linked capture', exact: true }).click();
        await browserExpect(page.getByRole('heading', { name: 'Linked document', exact: true })).toBeVisible();
        expect(failedResponses.length).toBeGreaterThan(0);
        expect(
          failedResponses.every((response) => {
            if (!response.startsWith('404 GET ')) return false;
            const url = new URL(response.slice('404 GET '.length));
            return (
              url.pathname === '/api/v1/files/content' &&
              ['pending.png', 'linked.png'].includes(url.searchParams.get('path')!)
            );
          }),
        ).toBe(true);
        expect(browserErrors.filter((error) => error !== EXPECTED_NOT_FOUND)).toEqual([]);
      },
      undefined,
      { executionBackend, projectRoots: 'separate' },
    );
  }, 180_000);
}

for (const linked of [false, true]) {
  test(`retries an external image without authentication or URL rewriting (linked: ${linked})`, async () => {
    await withChromiumFixture(`external-image-retry-${linked}`, async ({ page, integration, browserErrors }) => {
      const { client, executionDirs, directAgents, garcon } = integration;
      const png = await createPngBuffer(page);
      const chatId = integration.newChatId();
      const imageMarkdown = `![External capture](${EXTERNAL_IMAGE_URL})`;
      const started = await client.startDirectChat({
        chatId,
        content: linked ? `[${imageMarkdown}](C:/workspace/guide.md)` : imageMarkdown,
        projectPath: executionDirs.project,
        agent: directAgents.openAi,
      });
      await client.waitForTurnTerminal(chatId, started.turnId);
      let ready = false;
      const releaseRetry = new Deferred<void>();
      await page.route(EXTERNAL_IMAGE_URL, async (route) => {
        expect(route.request().headers().authorization).toBeUndefined();
        expect(route.request().headers().referer).toBeUndefined();
        if (ready) await releaseRetry.promise;
        await route.fulfill({
          status: ready ? 200 : 404,
          contentType: 'image/png',
          body: ready ? png : '',
        });
      });
      await page.goto(`${garcon.baseUrl}/chat/${chatId}`);
      const assistant = page.locator('[data-chat-message-type="assistant-message"]');
      const retry = assistant.getByRole('button', {
        name: 'Retry image External capture',
        exact: true,
      });
      await browserExpect(retry).toBeVisible();
      await browserExpect(assistant.locator('.markdown-image[tabindex]')).toHaveCount(0);
      await browserExpect(assistant.getByRole('alert')).toHaveCount(0);
      await retry.press('Enter');
      await browserExpect(assistant.getByRole('alert')).toHaveCount(1);
      await browserExpect(retry).toBeFocused();
      ready = true;
      try {
        await retry.press('Enter');
        await browserExpect(assistant.getByRole('status', { name: 'Loading image...' })).toBeVisible();
        const focusTarget = assistant.locator(linked ? 'a' : '.markdown-image');
        await browserExpect(focusTarget).toBeFocused();
        if (linked) await browserExpect(focusTarget).not.toHaveAttribute('href');
        await browserExpect(assistant.locator('a [tabindex]')).toHaveCount(0);
      } finally {
        releaseRetry.resolve();
      }
      const image = assistant.getByRole('img', {
        name: 'External capture',
        exact: true,
      });
      await browserExpect(image).toBeVisible();
      await browserExpect(image).toHaveJSProperty('naturalWidth', 1);
      await browserExpect(image).toHaveAttribute('src', EXTERNAL_IMAGE_URL);
      await browserExpect(assistant.getByRole('status')).toHaveCount(0);
      await page.locator('[data-conversation-composer-host] textarea[placeholder="Reply..."]').focus();
      await browserExpect(assistant.locator('.markdown-image[tabindex], a[tabindex]')).toHaveCount(0);
      expect(browserErrors.filter((error) => error !== EXPECTED_NOT_FOUND)).toEqual([]);
    });
  }, 180_000);
}

test('keeps shared-link retry focus and button order tied to the active image', async () => {
  await withChromiumFixture('shared-link-image-retry', async ({ page, integration, browserErrors }) => {
    const { client, executionDirs, directAgents, garcon } = integration;
    const png = await createPngBuffer(page);
    const firstUrl = new URL('first.png', EXTERNAL_IMAGE_URL).href;
    const secondUrl = new URL('second.png', EXTERNAL_IMAGE_URL).href;
    const firstRelease = new Deferred<void>();
    const secondRelease = new Deferred<void>();
    let holdRetries = false;
    let ready = false;
    await page.route('https://images.example.test/*.png', async (route) => {
      if (holdRetries) {
        const release = route.request().url() === firstUrl ? firstRelease : secondRelease;
        await release.promise;
      }
      await route.fulfill({
        status: ready ? 200 : 404,
        contentType: 'image/png',
        body: ready ? png : '',
      });
    });
    const chatId = integration.newChatId();
    const started = await client.startDirectChat({
      chatId,
      content: `[![First](${firstUrl}) ![Second](${secondUrl})](https://docs.example.test/guide)`,
      projectPath: executionDirs.project,
      agent: directAgents.openAi,
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await page.goto(`${garcon.baseUrl}/chat/${chatId}`);
    const assistant = page.locator('[data-chat-message-type="assistant-message"]');
    const firstRetry = assistant.getByRole('button', { name: 'Retry image First', exact: true });
    const secondRetry = assistant.getByRole('button', { name: 'Retry image Second', exact: true });
    const link = assistant.getByRole('link');
    await browserExpect(firstRetry).toBeVisible();
    await browserExpect(secondRetry).toBeVisible();
    holdRetries = true;
    try {
      await firstRetry.press('Enter');
      await secondRetry.press('Enter');
      await browserExpect(link).toBeFocused();
      await link.dispatchEvent('blur');
      firstRelease.resolve();
      await browserExpect(firstRetry).toBeVisible();
      await browserExpect(link).toBeFocused();
      secondRelease.resolve();
      await browserExpect(secondRetry).toBeFocused();
      const retryLabels = await assistant
        .getByRole('button', { name: /^Retry image / })
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
      expect(retryLabels).toEqual(['Retry image First', 'Retry image Second']);
      ready = true;
      await firstRetry.press('Enter');
      const recovered = assistant.getByRole('img', { name: 'First', exact: true });
      await browserExpect(recovered).toHaveJSProperty('naturalWidth', 1);
      await browserExpect(link).toBeFocused();
      await recovered.dispatchEvent('error');
      await browserExpect(firstRetry).toBeVisible();
      await browserExpect(assistant.locator('.markdown-image-error').first()).not.toHaveAttribute('role', 'alert');
      await browserExpect(link).toBeFocused();
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
    }
    expect(browserErrors.filter((error) => error !== EXPECTED_NOT_FOUND)).toEqual([]);
  });
}, 180_000);
