import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { codexAssistantMessage } from '../../support/fake-codex-model.js';
import { liveCodexStartRequest } from '../../support/live-codex.js';
import { startScriptedCodexTestEnvironment } from '../../support/scripted-codex.js';
import { prepareScriptedCodexSpeed, STANDARD_ONLY_MODEL } from '../../support/scripted-codex-speed.js';

test('the speed picker persists per chat and rolls back a rejected tier', async () => {
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
      const picker = (speed: string) => page.getByRole('button', { name: `Selected speed: ${speed}`, exact: true });
      const chooseUltrafast = async () => {
        await picker('Standard').click();
        await browserExpect(page.getByRole('menuitemradio')).toHaveCount(3);
        await page.getByRole('menuitemradio', { name: /^Ultrafast/ }).click();
      };
      await chooseUltrafast();
      await browserExpect.poll(async () => (await client.listChats()).sessions.find(({ id }) => id === first)?.agentSettings.values.speed).toBe('ultrafast');
      await page.reload();
      await browserExpect(picker('Ultrafast')).toBeVisible();
      const editor = page.locator('[data-composer]:visible textarea');
      const startY = (await editor.boundingBox())!.y;
      for (const [id, speed] of [[second, 'Standard'], [first, 'Ultrafast'], [second, 'Standard']] as const) {
        await page.locator(`[data-sidebar-virtual-row="${id}"] button`).first().click();
        await browserExpect(picker(speed)).toBeVisible();
        expect(Math.abs((await editor.boundingBox())!.y - startY)).toBeLessThan(2);
      }
      await withExpectedConsoleErrors([/Failed to load resource: the server responded with a status of 422 .*/], async () => {
        await chooseUltrafast();
        await browserExpect(page.getByText(/Ultrafast speed is unavailable/)).toBeVisible();
        await browserExpect(picker('Standard')).toBeVisible();
      });
      expect((await client.listChats()).sessions.find(({ id }) => id === second)?.agentSettings.values.speed ?? 'standard').toBe('standard');
      expect(environment.model.requests()).toHaveLength(2);
      environment.model.assertSettled();
      assertNoBrowserErrors();
    }, undefined, { serverEnvironment: environment.serverEnvironment,
      prepareWorkspace: (dirs) => prepareScriptedCodexSpeed(environment, dirs) });
  } finally {
    await environment.dispose();
  }
}, 120_000);
