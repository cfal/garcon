import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';

test('composer grows a line at a time, shrinks, caps long drafts, and refits wrapping without losing focus', async () => {
  await withChromiumFixture('content-sized-composer', async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic sizing conversation', projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
    const input = page.getByPlaceholder('Reply...', { exact: true });
    const composer = page.locator('[data-composer]');
    const original = await composer.elementHandle();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await input.fill('');
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '52px' : '48px');
      await input.fill('Synthetic short draft');
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '52px' : '48px');
      // Every added line grows the field by one 24px line, including the first.
      await input.fill('Synthetic first line\nSynthetic second line');
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '76px' : '72px');
      await input.fill('Synthetic first line\nSynthetic second line\nSynthetic third line');
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '100px' : '96px');
      expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(false);
      await input.fill(Array.from({ length: 24 }, (_, i) => `Synthetic draft line ${i}`).join('\n'));
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '300px' : '150px');
      expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await input.fill('');
      await browserExpect(input).toHaveCSS('height', width === 1440 ? '52px' : '48px');
      expect(await page.evaluate(node => document.querySelector('[data-composer]') === node, original)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await input.fill('Review the layout while preserving keyboard focus and the current draft. '.repeat(5));
    await browserExpect.poll(() => input.evaluate(node => node.clientHeight)).toBeGreaterThan(52);
    const wideHeight = await input.evaluate(node => node.clientHeight);
    await page.setViewportSize({ width: 1100, height: 900 });
    await browserExpect.poll(() => input.evaluate(node => node.clientHeight)).toBeGreaterThan(wideHeight);
    expect(await input.evaluate(node => document.activeElement === node)).toBe(true);
    assertNoBrowserErrors();
  });
}, 180_000);

test('New Chat rests at one line and a scheduled prompt at three, and both fit their content', async () => {
  await withChromiumFixture('content-sized-prompt-forms', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'New Chat', exact: true }).first().click();
    await page.getByRole('status', { name: 'Loading chat defaults...' }).waitFor({ state: 'detached' });
    const input = page.locator('[data-slot="new-chat-composer"] textarea');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await browserExpect.poll(() => input.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(52);
      await input.fill(Array.from({ length: 24 }, () => 'Synthetic prompt line').join('\n'));
      await browserExpect(input).toHaveCSS('height', '300px');
      await input.fill('');
      await browserExpect.poll(() => input.evaluate(node => node.clientHeight)).toBeLessThanOrEqual(52);
    }
    const chatId = integration.newChatId();
    const turn = await integration.client.startDirectChat({ chatId, content: 'Synthetic schedule target', projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(chatId, turn.turnId);
    const snapshot = await integration.client.getScheduledPrompts();
    await integration.client.createScheduledPrompt({ expectedRevision: snapshot.revision, scheduledPrompt: {
      target: { type: 'existing-chat', chatId, busyBehavior: 'skip' },
      prompt: 'Synthetic restored prompt',
      schedule: { type: 'recurring', firstRunAtUtc: new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000).toISOString(), intervalMinutes: 1440, endAtUtc: null },
    } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(integration.garcon.baseUrl);
    await page.getByRole('button', { name: 'More actions', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Scheduled prompts', exact: true }).click();
    await page.getByRole('dialog', { name: 'Scheduled Prompts', exact: true }).getByRole('button', { name: 'Edit prompt', exact: true }).first().click();
    const prompt = page.getByRole('dialog', { name: 'Edit Scheduled Prompt', exact: true }).getByLabel('Prompt', { exact: true });
    await browserExpect(prompt).toHaveValue('Synthetic restored prompt');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      // A long-form field rests at three lines so it reads as a multiline editor.
      await browserExpect(prompt).toHaveCSS('height', '90px');
      await prompt.fill(Array.from({ length: 4 }, () => 'Synthetic scheduled line').join('\n'));
      await browserExpect(prompt).toHaveCSS('height', '114px');
      await prompt.fill(Array.from({ length: 24 }, () => 'Synthetic scheduled line').join('\n'));
      await browserExpect(prompt).toHaveCSS('height', '300px');
      await prompt.fill('Synthetic restored prompt');
      await browserExpect(prompt).toHaveCSS('height', '90px');
    }
    assertNoBrowserErrors();
  });
}, 180_000);

test('ticket descriptions rest at three lines, grow with typing, and shrink on clear', async () => {
  await withChromiumFixture('content-sized-ticket-text', async ({ page, integration, assertNoBrowserErrors }) => {
    await page.goto(integration.garcon.baseUrl);
    await collapseCanonicalFilesWindow(page);
    await clickWorkspaceWindowAddAction(page, 'Open Tickets');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole('button', { name: 'New ticket', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const input = dialog.getByLabel('Description', { exact: true });
      await browserExpect(input).toHaveCSS('height', '76px');
      await input.fill(Array.from({ length: 4 }, () => 'Synthetic description line').join('\n'));
      await browserExpect(input).toHaveCSS('height', '96px');
      await input.fill(Array.from({ length: 30 }, () => 'Synthetic description line').join('\n'));
      await browserExpect(input).toHaveCSS('height', '300px');
      expect(await input.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      await input.fill('');
      await browserExpect(input).toHaveCSS('height', '76px');
      if (width === 390) expect(await input.evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    assertNoBrowserErrors();
  });
}, 180_000);

test('the latest message stays in view while the composer grows over a long transcript', async () => {
  await withChromiumFixture('content-sized-composer-transcript', async ({ page, integration, assertNoBrowserErrors }) => {
    const chatId = integration.newChatId();
    const content = Array.from({ length: 14 }, (_, i) => `Synthetic transcript paragraph ${i + 1}.`).join('\n\n');
    const first = await integration.client.startDirectChat({ chatId, content, projectPath: integration.dirs.project, agent: integration.directAgents.anthropic });
    await integration.client.waitForTurnTerminal(chatId, first.turnId);
    for (let turn = 0; turn < 2; turn += 1) {
      const next = await integration.client.runDirectChat({ chatId, content: `${content}\n\nSynthetic turn ${turn}`, agent: integration.directAgents.anthropic });
      await integration.client.waitForTurnTerminal(chatId, next.turnId);
    }
    await integration.client.waitForProcessing(chatId, false);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
      const input = page.getByPlaceholder('Reply...', { exact: true });
      const viewport = page.locator('[data-chat-scroll-viewport]').first();
      const distanceFromBottom = () => viewport.evaluate(node => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight));
      await input.waitFor();
      expect(await viewport.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
      // The draft is saved per chat, so each pass starts from an empty composer.
      await input.fill('');
      await browserExpect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
      await input.click();
      for (let line = 1; line <= 5; line += 1) {
        const height = await input.evaluate(node => node.clientHeight);
        await page.keyboard.type(`Synthetic typed line ${line}`);
        await page.keyboard.press('Shift+Enter');
        await browserExpect.poll(() => input.evaluate(node => node.clientHeight)).toBeGreaterThan(height);
        await browserExpect.poll(distanceFromBottom).toBeLessThanOrEqual(1);
      }
    }
    assertNoBrowserErrors();
  });
}, 180_000);
