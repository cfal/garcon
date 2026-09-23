import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import type { Request } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { Deferred } from '../../support/deferred.js';

test('chat host selectors fit narrow containers and stage complete cancellable handoffs', async () => {
  const failedResponses: Promise<{ url: string; status: number; body: string; beforeHandoff: boolean }>[] = [];
  await withChromiumFixture('chat-host-selection', async ({ page, integration, browserErrors }, phase) => {
    const requestsBeforeHandoff = new WeakSet<Request>();
    const consoleErrorUrls: string[] = [];
    let handoffSubmitted = false;
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/v1/chats/run') handoffSubmitted = true;
      if (!handoffSubmitted) requestsBeforeHandoff.add(request);
    });
    page.on('console', message => {
      if (message.type() === 'error') consoleErrorUrls.push(message.location().url);
    });
    page.on('response', response => {
      if (response.status() >= 400) failedResponses.push(response.text().then(body => ({
        url: response.url(), status: response.status(), body,
        beforeHandoff: requestsBeforeHandoff.has(response.request()),
      })).catch(() => ({ url: response.url(), status: response.status(), body: 'unavailable', beforeHandoff: false })));
    });
    const { client, executionDirs, directAgents } = integration;
    await client.put(`/api/v1/api-provider-assignments?nodeId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    const label = 'Production build and review execution host';
    await client.patch(`/api/v1/execution-nodes/${client.nodeId}`, { label });
    await mkdir(join(executionDirs.project, 'destination'));
    const chatId = integration.newChatId();
    const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project,
      content: 'Synthetic host selection', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    await collapseCanonicalFilesWindow(page);
    const controls = () => page.locator('[data-slot="composer-bottom-bar"]:visible');
    const host = () => controls().getByRole('button', { name: `Execution node: ${label}`, exact: true });
    await browserExpect(host()).toBeVisible();
    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 850, 390]) {
      phase(`composer controls at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(host()).toBeVisible();
      expect(await controls().evaluate(element => {
        const outer = element.getBoundingClientRect();
        const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')]
          .filter(button => button.checkVisibility({ checkVisibilityCSS: true }));
        const rectangles = buttons.map(button => button.getBoundingClientRect());
        return rectangles.every((rect, index) => rect.left >= outer.left && rect.right <= outer.right
          && rectangles.slice(index + 1).every(other => rect.right <= other.left || rect.left >= other.right
            || rect.bottom <= other.top || rect.top >= other.bottom));
      })).toBe(true);
      if (width < 900) expect(await host().evaluate(element => element.getBoundingClientRect().width)).toBe(36);
      await host().click();
      await browserExpect(page.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: join(artifacts, `chat-host-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    phase('cancelled handoff');
    const composer = page.locator('[data-composer] textarea:visible');
    await composer.fill('Synthetic retained handoff input');
    await host().click();
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await browserExpect(page.getByRole('heading', { name: 'Move to Local' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await browserExpect(composer).toHaveValue('Synthetic retained handoff input');
    await browserExpect(host()).toBeVisible();
    expect((await client.getChatSnapshot(chatId)).chat.nodeId).toBe(client.nodeId);
    phase('destination confirmation');
    await host().click();
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await page.getByLabel('Destination project folder').fill(integration.dirs.project);
    await page.getByRole('button', { name: 'Use This Node', exact: true }).click();
    await browserExpect(controls().getByRole('button', { name: 'Execution node: Local', exact: true })).toBeVisible();
    expect((await client.getChatSnapshot(chatId)).chat.nodeId).toBe(client.nodeId);
    const destinationResolution = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/v1/projects/resolve' && url.searchParams.get('chatId') === chatId
        && url.searchParams.get('nodeId') === 'local' && response.status() === 200;
    });
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await browserExpect(composer).toHaveValue('');
    await browserExpect.poll(async () => (await client.getChatSnapshot(chatId)).chat.nodeId ?? 'local').toBe('local');
    expect(await (await destinationResolution).json()).toMatchObject({
      target: { kind: 'chat', chatId, nodeId: 'local', projectPath: integration.dirs.project },
      resolution: { kind: 'available' },
    });
    await browserExpect(controls().getByRole('button', { name: 'Execution node: Local', exact: true })).toBeVisible();
    await browserExpect(page.getByText('The chat project changed', { exact: true })).toHaveCount(0);

    phase('new-chat project target');
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('[data-execution-node-picker]').click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    await browserExpect(dialog.getByLabel('Project Path', { exact: true })).toHaveValue(executionDirs.project);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const picker = dialog.locator('[data-execution-node-picker]');
      const path = dialog.getByLabel('Project Path', { exact: true });
      const pickerRect = (await picker.boundingBox())!;
      const pathRect = (await path.boundingBox())!;
      expect(pickerRect.height).toBe(pathRect.height);
      expect(width === 390 ? pickerRect.y + pickerRect.height <= pathRect.y : pickerRect.x + pickerRect.width <= pathRect.x).toBe(true);
      expect(await picker.locator('.node-label').evaluate(element => getComputedStyle(element).display)).not.toBe('none');
      await page.screenshot({ path: join(artifacts, `new-chat-host-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const modelTrigger = dialog.locator('[data-slot="composer-bottom-bar"] button').filter({ has: page.locator('[data-slot="model-selector-trigger-secondary"]') });
    await modelTrigger.click();
    expect(await page.locator('[data-slot="model-selector-nodes"]').count()).toBe(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    phase('one-shot host column');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Server Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const generation = page.getByRole('dialog').locator('button').filter({ has: page.locator('[data-slot="model-selector-trigger-secondary"]') }).first();
    await generation.click();
    const columns = page.locator('[data-slot="model-selector-columns"]');
    await browserExpect(columns.locator('[data-slot="model-selector-nodes"]')).toBeVisible();
    expect(await columns.evaluate(element => Boolean(element.firstElementChild?.querySelector('[data-slot="model-selector-nodes"]')))).toBe(true);
    await page.screenshot({ path: join(artifacts, 'generation-host-columns.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 900 });
    await generation.click();
    const compact = page.locator('[data-slot="model-selector-compact"]');
    await browserExpect(compact).toBeVisible();
    await page.screenshot({ path: join(artifacts, 'generation-host-compact.png') });
    const failures = await Promise.all(failedResponses);
    for (const failure of failures) {
      const url = new URL(failure.url);
      expect(failure.beforeHandoff).toBe(true);
      expect(url.pathname).toBe('/api/v1/projects/resolve');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        chatId, expectedProjectPath: executionDirs.project, nodeId: client.nodeId,
      });
      expect(failure.status).toBe(409);
      expect(JSON.parse(failure.body)).toMatchObject({ success: false, errorCode: 'PROJECT_PATH_CHANGED' });
    }
    expect(consoleErrorUrls.sort()).toEqual(failures.map(failure => failure.url).sort());
    expect(browserErrors).toEqual(failures.map(() =>
      'console.error: Failed to load resource: the server responded with a status of 409 (Conflict)',
    ));
  }, async () => ({ failedResponses: await Promise.all(failedResponses) }),
  { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 180_000);

test('accepted node handoffs update the Files target before background chat refresh', async () => {
  await withChromiumFixture('chat-host-handoff-project', async ({ page, integration, assertNoBrowserErrors }) => {
    const { client, executionDirs, directAgents } = integration;
    await client.put(`/api/v1/api-provider-assignments?nodeId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    const chatId = integration.newChatId();
    const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project,
      content: 'Synthetic handoff binding', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const project = page.locator('[data-file-tree-breadcrumbs]:visible [aria-current="location"]');
    await browserExpect(project).toHaveAttribute('title', executionDirs.project);
    const controls = page.locator('[data-slot="composer-bottom-bar"]:visible');
    await controls.getByRole('button', { name: 'Execution node: Integration worker', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Local', exact: true }).click();
    await page.getByLabel('Destination project folder').fill(integration.dirs.project);
    await page.getByRole('button', { name: 'Use This Node', exact: true }).click();
    await browserExpect(controls.getByRole('button', { name: 'Execution node: Local', exact: true })).toBeVisible();
    const refreshGate = new Deferred<void>();
    await page.route('**/api/v1/chats', async route => {
      await refreshGate.promise;
      await route.continue();
    });
    try {
      await page.locator('[data-composer] textarea:visible').fill('Synthetic handoff destination');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await browserExpect(project).toHaveAttribute('title', integration.dirs.project);
      assertNoBrowserErrors();
    } finally {
      refreshGate.resolve();
      await page.unrouteAll({ behavior: 'wait' });
    }
  }, undefined, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 180_000);
