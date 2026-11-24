import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed, STANDARD_ONLY_MODEL } from '../../support/scripted-codex-speed.js';

test('the speed picker persists per chat and defers unavailable-tier errors until activation', async () => {
  const environment = await startScriptedCodexTestEnvironment();
  try {
    await withChromiumFixture('codex-speed-picker', async ({ page, integration, withExpectedConsoleErrors, assertNoBrowserErrors }) => {
      const { client } = integration;
      const seed = async (model?: string) => {
        const chatId = integration.newChatId();
        environment.model.scriptTurn([codexAssistantMessage('Synthetic reply.')]);
        const turn = await client.startChat({ ...liveCodexStartRequest({ chatId, projectPath: integration.executionDirs.project,
          command: 'Synthetic picker check.' }), ...(model ? { model } : {}) });
        await client.waitForTurnTerminal(chatId, turn.turnId);
        await client.waitForProcessing(chatId, false);
        return chatId;
      };
      const first = await seed();
      const second = await seed(STANDARD_ONLY_MODEL);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${integration.garcon.baseUrl}/chat/${first}`);
      const composer = page.locator('[data-composer]:visible');
      const speedTrigger = composer.locator('button[data-composer-control="agent:speed"]');
      const speedControl = async (speed: string) => {
        const name = `Selected speed: ${speed}`;
        await browserExpect(speedTrigger).toHaveAttribute('aria-label', name);
        if (await speedTrigger.isVisible()) return { control: speedTrigger, folded: false };
        await composer.locator('[data-composer-overflow="settings"]').click();
        return { control: page.getByRole('menuitem', { name, exact: true }), folded: true };
      };
      const expectSpeed = async (speed: string) => {
        const { control, folded } = await speedControl(speed);
        await browserExpect(control).toBeVisible();
        if (folded) await page.keyboard.press('Escape');
      };
      const chooseSpeed = async (from: string, to: string) => {
        const { control, folded } = await speedControl(from);
        if (folded) await control.press('ArrowRight');
        else await control.click();
        await browserExpect(page.getByRole('menuitemradio')).toHaveCount(3);
        await page.getByRole('menuitemradio', { name: new RegExp(`^${to}`) }).click();
      };
      const committed = Promise.withResolvers<void>();
      const releaseReply = Promise.withResolvers<void>();
      await page.route('**/api/v1/chats/execution-settings', async (route) => {
        const response = await route.fetch();
        committed.resolve();
        await releaseReply.promise;
        await route.fulfill({ response });
      }, { times: 1 });
      try {
        await chooseSpeed('Standard', 'Fast');
        await committed.promise;
        await chooseSpeed('Fast', 'Ultrafast');
        await page.locator(`[data-sidebar-virtual-row="${first}"] button`).first().click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Fork', exact: true }).click();
        await browserExpect(page.getByText('Forking chat...', { exact: true })).toBeVisible();
        const pending = (await client.listChats()).sessions;
        expect(pending).toHaveLength(2);
        expect(pending.find(({ id }) => id === first)?.agentSettings.values.speed).toBe('fast');
      } finally {
        releaseReply.resolve();
      }
      await browserExpect.poll(async () => (await client.listChats()).sessions.length).toBe(3);
      const forked = (await client.listChats()).sessions.find(({ id }) => id !== first && id !== second);
      expect(forked?.agentSettings.values.speed).toBe('ultrafast');
      await browserExpect.poll(async () => (await client.listChats()).sessions.find(({ id }) => id === first)?.agentSettings.values.speed).toBe('ultrafast');
      await page.goto(`${integration.garcon.baseUrl}/chat/${first}`);
      await page.reload();
      await expectSpeed('Ultrafast');
      const editor = composer.locator('textarea');
      const startY = (await editor.boundingBox())!.y;
      for (const [id, speed] of [[second, 'Standard'], [first, 'Ultrafast'], [second, 'Standard']] as const) {
        await page.locator(`[data-sidebar-virtual-row="${id}"] button`).first().click();
        await expectSpeed(speed);
        expect(Math.abs((await editor.boundingBox())!.y - startY)).toBeLessThan(2);
      }
      await withExpectedConsoleErrors([
        /Failed to load resource: the server responded with a status of 422 .*/,
        /Failed to fork chat: ApiError: Codex Ultrafast speed is unavailable for integration-standard-only on this executor\. Check the model and workspace settings or choose Standard\.[\s\S]*/,
      ], async () => {
        const received = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        await page.route('**/api/v1/chats/execution-settings', async (route) => {
          received.resolve();
          await release.promise;
          await route.continue();
        }, { times: 1 });
        try {
          await chooseSpeed('Standard', 'Ultrafast');
          await received.promise;
          await page.locator(`[data-sidebar-virtual-row="${second}"] button`).first().click({ button: 'right' });
          await page.getByRole('menuitem', { name: 'Fork', exact: true }).click();
          await browserExpect(page.getByText('Forking chat...', { exact: true })).toBeVisible();
        } finally {
          release.resolve();
        }
        await browserExpect(page.getByText(/Ultrafast speed is unavailable/)).toBeVisible();
        await expectSpeed('Ultrafast');
        await browserExpect(page.getByText('Forking chat...', { exact: true })).toHaveCount(0);
        expect((await client.listChats()).sessions).toHaveLength(3);
      });
      expect((await client.listChats()).sessions.find(({ id }) => id === second)?.agentSettings.values.speed).toBe('ultrafast');
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
      assertNoBrowserErrors();
    }, undefined, { serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (dirs) => prepareScriptedCodexSpeed(environment, dirs) });
  } finally {
    await environment.dispose();
  }
}, 120_000);
