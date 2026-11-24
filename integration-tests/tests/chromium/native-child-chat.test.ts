import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { seedLocalSettings } from '../../support/local-settings-seed.js';
import { codexAssistantMessage, codexCollaborationCall, codexFinalAnswerMessage } from '../../support/fake-codex-model.js';

test('[TLV5-OBSERVE.05-CHROMIUM-01] native children hide the composer, show only active status, and preserve executable drafts across switches', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  environment.model.scriptTurn([codexCollaborationCall('spawn_ui_child', 'spawn_agent', {
    message: 'Synthetic child UI kickoff', task_name: 'ui_worker', fork_turns: 'none',
  })]);
  const held = environment.model.scriptHeldTurnMatching('child request', request =>
    JSON.stringify(request.body).includes('Synthetic child UI kickoff')
      && !request.functionCallOutputs.some(output => output.callId === 'spawn_ui_child'),
  [codexFinalAnswerMessage('Synthetic child UI answer')]);
  environment.model.scriptTurnMatching('parent continuation', request =>
    request.functionCallOutputs.some(output => output.callId === 'spawn_ui_child'),
  [codexAssistantMessage(Array.from({ length: 60 }, (_, index) => `Synthetic parent UI answer ${index + 1}.`).join('\n\n'))]);
  try {
    await withChromiumFixture('native-child-chat', async ({ page, context, integration }, phase) => {
      await context.addInitScript(seedLocalSettings, { collapseDelegatedChatsByDefault: false });
      const { client } = integration;
      const parentId = integration.newChatId();
      const started = await client.startChat(liveCodexStartRequest({
        chatId: parentId, projectPath: integration.executionDirs.project,
        command: 'Synthetic parent UI request', permissionMode: 'bypassPermissions',
      }));
      await held.requested;
      await client.waitForTurnTerminal(parentId, started.turnId);
      const child = (await client.listChats()).sessions.find(chat => chat.parentChatId === parentId);
      if (!child) throw new Error('Missing native child');
      await page.goto(`${integration.garcon.baseUrl}/chat/${parentId}`);
      const editor = page.locator('[data-composer] textarea');
      await editor.fill('Synthetic preserved parent draft');
      const originalEditor = await editor.elementHandle();
      await collapseCanonicalFilesWindow(page);
      const host = page.locator('[data-conversation-composer-host]');
      const tray = page.locator('[data-native-child-status-tray]:visible');
      const viewport = page.locator('[data-chat-scroll-viewport]:visible');
      const screenshots = process.env.GARCON_SCREENSHOT_DIR;
      if (screenshots) await mkdir(screenshots, { recursive: true });

      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const select = async (id: string, history = false) => {
          if (width === 390) await page.getByRole('button', { name: 'Menu', exact: true }).click();
          const target = page.locator(`[data-sidebar-virtual-row="${id}"] button`).first();
          if (history) await page.goBack();
          else await target.click();
          await page.waitForURL(`**/chat/${id}`);
          await browserExpect(page.locator('[data-conversation-panel-composer-anchor="true"]'))
            .toHaveAttribute('data-conversation-panel-chat-id', id);
          if (width === 390) await browserExpect(page.getByRole('dialog', { name: 'Chats', exact: true })).toBeHidden();
          await browserExpect(page.getByText('Loading messages...', { exact: true })).toBeHidden();
        };
        phase(`rapid chat switching at ${width}px`);
        await browserExpect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
        await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await browserExpect.poll(() => viewport.evaluate(element =>
          element.scrollHeight - element.clientHeight > 200
            && element.scrollHeight - element.scrollTop - element.clientHeight < 4)).toBe(true);
        for (let index = 0; index < 3; index++) {
          const withSettings = width === 1440 && index === 1;
          if (withSettings) {
            await host.getByRole('button', { name: /Codex/ }).first().click();
            await browserExpect(page.locator('[data-slot="popover-content"]')).toBeVisible();
          }
          await select(child.id, withSettings);
          await browserExpect(page.locator('[data-slot="popover-content"]')).toHaveCount(0);
          await browserExpect(host).toBeHidden();
          expect(await host.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
          await browserExpect(tray).toBeVisible();
          await browserExpect(page.locator('[data-conversation-panel-chat-id="' + child.id + '"] [data-conversation-panel-composer-spacer]'))
            .toHaveCount(0);
          await browserExpect(tray.getByRole('button')).toHaveCount(0);
          await viewport.click({ position: { x: 10, y: 10 } });
          await page.keyboard.press('Enter');
          await page.keyboard.press('Control+Enter');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (screenshots && index === 0) await page.screenshot({ path: join(screenshots, `native-child-working-${width}.png`) });
          await select(parentId);
          await browserExpect(editor).toBeVisible();
          await browserExpect(editor).toHaveValue('Synthetic preserved parent draft');
          expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true);
          await browserExpect.poll(() => viewport.evaluate(element =>
            element.scrollHeight - element.clientHeight > 200
              && element.scrollHeight - element.scrollTop - element.clientHeight < 4)).toBe(true);
          await browserExpect(tray).toHaveCount(0);
        }
      }

      phase('background completion without stealing parent focus');
      await editor.focus();
      await editor.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(5, 5));
      const peer = await context.newPage();
      await peer.setViewportSize({ width: 390, height: 900 });
      await peer.goto(`${integration.garcon.baseUrl}/chat/${child.id}`);
      await browserExpect(peer.locator('[data-native-child-status-tray]:visible')).toBeVisible();
      held.release();
      await browserExpect(peer.locator('[data-native-child-status-tray]')).toHaveCount(0);
      await browserExpect(peer.locator('[data-chat-scroll-viewport]:visible')).toContainText('Synthetic child UI answer');
      await browserExpect(editor).toBeFocused();
      expect(await editor.evaluate(element => (element as HTMLTextAreaElement).selectionStart)).toBe(5);
      await browserExpect(viewport).not.toContainText('Synthetic child UI answer');
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator(`[data-sidebar-virtual-row="${child.id}"] button`).first().click();
      await page.waitForURL(`**/chat/${child.id}`);
      await browserExpect(viewport).toContainText('Synthetic child UI answer');
      await browserExpect(page.getByText('Loading messages...', { exact: true })).toBeHidden();
      await browserExpect(host).toBeHidden();
      await browserExpect(tray).toHaveCount(0);
      if (screenshots) await page.screenshot({ path: join(screenshots, 'native-child-complete-mobile.png') });
      await page.setViewportSize({ width: 1440, height: 900 });
      if (screenshots) await page.screenshot({ path: join(screenshots, 'native-child-complete-desktop.png') });

      phase('replacement invalidation in both browser clients');
      await client.reloadChat(child.id);
      for (const browserPage of [page, peer]) {
        await browserExpect(browserPage.locator('[data-chat-scroll-viewport]:visible')).toContainText('Native history snapshot. Live capture has ended.');
        await browserExpect(browserPage.locator('[data-conversation-composer-host]')).toBeHidden();
      }
      await peer.close();
      environment.model.assertSettled();
    }, async () => ({ modelRequests: environment.model.requests(), modelIssues: environment.model.issues() }), { serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: dirs => environment.prepareWorkspace(dirs, { multiAgentVersion: 'v2' }) });
  } finally { held.release(); await environment.dispose(); }
}, 180_000);
