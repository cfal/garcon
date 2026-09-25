import { expect, test } from 'bun:test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('deleting a referenced executor preserves the transcript and draft and permits explicit handoff', async () => {
  await withE2eFixture('executor-deletion', async (fixture) => {
    const { client, directAgents, executionDirs, dirs, fakeProviders } = fixture.integration;
    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({
      chatId, agent: directAgents.openAi, projectPath: executionDirs.project,
      content: 'Synthetic saved remote input',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    const draft = 'Synthetic draft retained after executor deletion';
    await app.fill('[data-composer] textarea', draft);
    await app.waitForButtonEnabled('Send message');
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForButtonEnabled('Edit Integration worker');
    await app.clickButton('Edit Integration worker');
    await app.waitForButtonEnabled('Delete executor');
    await app.clickButton('Delete executor');
    await app.waitForText('Chats and saved settings will remain');
    await app.clickDialogButton('Delete Executor');
    await app.waitForButton('Add Executor');
    expect(await app.hasButton('Edit Integration worker')).toBe(false);
    await app.clickDialogButton('Close');
    await app.waitForText("This chat's executor is no longer configured.");
    expect(await fixture.page.$('[data-project-availability-notice]')).toBeNull();
    await app.waitForText('Synthetic saved remote input');
    expect(await fixture.page.$eval('[data-composer] textarea', (element) => (element as HTMLTextAreaElement).value)).toBe(draft);
    expect(await fixture.page.$eval('[data-composer] button[aria-label="Send message"]', (element) => (element as HTMLButtonElement).disabled)).toBe(true);
    for (const ctrlKey of [false, true]) {
      await fixture.page.$eval('[data-composer] textarea', (element, control) => element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: control, bubbles: true, cancelable: true }),
      ), ctrlKey);
    }
    expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)?.executorId).toBe(client.executorId);
    expect(fakeProviders.openAi.requests()).toHaveLength(1);
    expect(await fixture.page.$eval('[data-composer] textarea', (element) => (element as HTMLTextAreaElement).value)).toBe(draft);

    await selectExecutor(fixture.page, '[data-slot="composer-bottom-bar"] [data-executor-picker]', 'Local');
    await app.waitForText('Move to Local');
    await app.fill('[role="dialog"] input', dirs.project);
    await app.waitForButtonEnabled('Use This Executor');
    await app.clickDialogButton('Use This Executor');
    await fixture.page.waitForFunction(() => document.querySelector('[role="dialog"]') === null);
    await app.waitForButtonEnabled('Send message');
    await app.clickButton('Send message');
    await app.waitForAssistantMessageContaining(draft);
    await app.waitForChatProcessing(false);
    expect(fakeProviders.openAi.requests()).toHaveLength(2);
    const resumedInput = fakeProviders.openAi.requests()[1]!.lastUserText;
    expect(resumedInput).toContain('Synthetic saved remote input');
    expect(resumedInput.endsWith(draft)).toBe(true);
    expect((await client.listChats()).sessions.find((chat) => chat.id === chatId)?.executorId ?? 'local').toBe('local');
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);

test('executor availability and missing project notices replace each other through reconnect and repair', async () => {
  await withE2eFixture('executor-project-notices', async (fixture) => {
    const { client, directAgents, executionDirs } = fixture.integration;
    const projectPath = join(executionDirs.project, 'synthetic-project');
    await mkdir(projectPath);
    const chatId = fixture.integration.newChatId();
    const started = await client.startDirectChat({
      chatId, agent: directAgents.openAi, projectPath, content: 'Synthetic missing project input',
    });
    await client.waitForTurnTerminal(chatId, started.turnId);
    await client.waitForProcessing(chatId, false);
    await rm(projectPath, { recursive: true });
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.openChat(chatId);
    await fixture.waitForSpaWebSocket();
    const draft = '/synthetic-preserved-draft';
    await app.fill('[data-composer] textarea', draft);
    await fixture.page.waitForSelector('[data-project-availability-notice]');
    expect(await fixture.page.$('[role="listbox"]')).toBeNull();
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
    await app.waitForText('Integration worker is unavailable.');
    expect(await fixture.page.$('[data-project-availability-notice]')).toBeNull();
    expect(await fixture.page.$('[role="listbox"]')).toBeNull();
    expect(await fixture.page.$eval('[data-composer] textarea', (element) => (element as HTMLTextAreaElement).value)).toBe(draft);
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
    await fixture.page.waitForSelector('[data-project-availability-notice]');
    expect(await fixture.page.$eval('[data-composer]', (element) => element.textContent?.includes('is unavailable.'))).toBe(false);
    await mkdir(projectPath);
    await fixture.page.$eval('[data-project-availability-notice] button', (element) => (element as HTMLButtonElement).click());
    await fixture.page.waitForFunction(() => !document.querySelector('[data-project-availability-notice]'));
    await app.waitForButtonEnabled('Send message');
    expect(await fixture.page.$eval('[data-composer] textarea', (element) => (element as HTMLTextAreaElement).value)).toBe(draft);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate' });
}, 90_000);
