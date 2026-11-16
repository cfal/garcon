import { test } from "bun:test";
import { expect as browserExpect } from "playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { withChromiumFixture } from "../../support/chromium-fixture.js";
import { initializeFixtureRepository } from "../../support/git-fixture.js";

for (const executionBackend of [
  "in-process",
  "remote-controller-dials",
  "remote-executor-dials",
] as const) {
  test(`response choices stay above the composer and preserve drafts (${executionBackend})`, async () => {
    await withChromiumFixture(
      `question-choices-${executionBackend}`,
      async ({ page, integration, assertNoBrowserErrors }, phase) => {
        const { client, directAgents, fakeProviders, executionDirs } =
          integration;
        await initializeFixtureRepository(executionDirs.project);
        const seed = "Synthetic choice question";
        const held = fakeProviders.openAi.holdNext({ lastUserText: seed });
        const chatId = integration.newChatId();
        const started = await client.startDirectChat({
          chatId,
          content: seed,
          projectPath: executionDirs.project,
          agent: directAgents.openAi,
        });
        await held.received;
        const responseBlocks = [
          "Pick a preferred way to review the sample.",
          "How would you most like to review the sample?\n- Read a short outline (Recommended)\n- Inspect a detailed diagram\n- /compact",
          "Choose an option above, or type your own answer.",
        ];
        held.releaseText(responseBlocks.join('\n\n'));
        await client.waitForTurnTerminal(chatId, started.turnId);
        await client.waitForProcessing(chatId, false);
        const otherChatId = integration.newChatId();
        const other = await client.startDirectChat({
          chatId: otherChatId,
          content: "Synthetic other chat",
          projectPath: executionDirs.project,
          agent: directAgents.openAi,
        });
        await client.waitForTurnTerminal(otherChatId, other.turnId);
        await page.addInitScript(() => {
			if (location.hostname !== '127.0.0.1') return;
			const stored = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
			localStorage.setItem('pref_local_settings', JSON.stringify({
				composerStatusBarGitProjects: false,
				composerStatusBarNonGitProjects: false,
				...stored,
			}));
		});
        await page.goto(`${integration.garcon.baseUrl}/chat/${chatId}`);
        const composer = page.locator("[data-composer]");
        const editor = composer.locator("textarea");
        const dock = page.locator("[data-composer-question-dock]");
        await browserExpect(dock).toBeVisible();
        await browserExpect(dock.getByRole('group', { name: 'How would you most like to review the sample?' })).toBeVisible();
        await browserExpect(dock.getByRole('button', { name: 'Inspect a detailed diagram', exact: true })).toBeVisible();
        await browserExpect(dock.getByText('1/1', { exact: true })).toBeVisible();
        await browserExpect(dock.getByText('Question - Select one answer', { exact: true })).toBeVisible();
        await browserExpect(dock.locator('input')).toHaveCount(0);
        await browserExpect(page.locator('[data-chat-feed-content]').getByText('Inspect a detailed diagram', { exact: true })).toHaveCount(0);
        await browserExpect(dock.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
        await browserExpect(dock.getByRole('button', { name: 'Write my own answer', exact: true })).toHaveCount(0);
        const draft = "Synthetic retained draft";
        await editor.fill(draft);
        await editor.evaluate((element) =>
          element.setAttribute("data-retained-editor", "true"),
        );
        const artifacts = join(import.meta.dirname, "../../artifacts/chromium");
        await mkdir(artifacts, { recursive: true });
        phase("desktop and mobile layout");
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await browserExpect(dock).toBeVisible();
          await browserExpect(composer).toBeVisible();
          await browserExpect.poll(() => page.evaluate(() => {
            const choicesBox = document.querySelector('[data-composer-question-dock]')?.getBoundingClientRect();
            const inputBox = document.querySelector('[data-composer]')?.getBoundingClientRect();
            if (!choicesBox?.height || !inputBox?.height) return null;
            return {
              above: choicesBox.bottom <= inputBox.top + 1,
              contained: inputBox.bottom <= innerHeight,
              noOverflow: document.documentElement.scrollWidth <= innerWidth,
            };
          })).toEqual({ above: true, contained: true, noOverflow: true });
          await browserExpect.poll(() => page.evaluate(() => {
            const panelBox = document.querySelector('[data-question-choices-panel]')?.getBoundingClientRect();
            const inputBox = document.querySelector('[data-composer]')?.getBoundingClientRect();
            if (!panelBox?.height || !inputBox?.height) return false;
            const gap = inputBox.top - panelBox.bottom;
            return gap >= 0 && gap <= 20;
          })).toBe(true);
          await browserExpect.poll(() => dock.getByRole('button', { name: 'Inspect a detailed diagram', exact: true }).evaluate(element => {
            const style = getComputedStyle(element);
            return { equalPadding: style.paddingTop === style.paddingBottom, align: style.alignItems };
          })).toEqual({ equalPadding: true, align: 'center' });
          await page.screenshot({
            path: join(
              artifacts,
              `question-choices-${executionBackend}-${width}.png`,
            ),
          });
        }
        phase("rapid chat switching retains the composer and its draft");
        await page.setViewportSize({ width: 1440, height: 900 });
        for (const selected of [otherChatId, chatId, otherChatId, chatId]) {
          await page
            .locator(`[data-sidebar-virtual-row="${selected}"]`)
            .click();
          await browserExpect(editor).toHaveAttribute(
            "data-retained-editor",
            "true",
          );
          await browserExpect(editor).toHaveValue(
            selected === chatId ? draft : "",
          );
          await browserExpect(dock).toHaveCount(selected === chatId ? 1 : 0);
        }
        phase("keyboard selection sends slash-prefixed labels as text");
        await dock.getByRole('button', { name: '/compact', exact: true }).focus();
        await page.keyboard.press("Enter");
        await fakeProviders.openAi.waitForRequest({ lastUserText: "/compact" });
        await browserExpect(editor).toHaveValue(draft);
        await browserExpect(dock).toHaveCount(0);
        await page.evaluate(() => {
          const stored = JSON.parse(localStorage.getItem('pref_local_settings') ?? '{}');
          localStorage.setItem('pref_local_settings', JSON.stringify({
            ...stored, composerStatusBarGitProjects: true, composerStatusBarNonGitProjects: true,
          }));
        });
        phase('multiple questions and multiple selections submit together');
        const multiSeed = 'Synthetic multiple choice questions';
        const multiHeld = fakeProviders.openAi.holdNext({ lastUserText: multiSeed });
        const multiChatId = integration.newChatId();
        const multiStarted = await client.startDirectChat({
          chatId: multiChatId, content: multiSeed, projectPath: executionDirs.project, agent: directAgents.openAi,
        });
        await multiHeld.received;
        multiHeld.releaseText('Which features do you want? Select all that apply.\n- Outline\n- Diagram\n- Example\n\nWhich format do you prefer?\n- Short\n- Detailed');
        await client.waitForTurnTerminal(multiChatId, multiStarted.turnId);
        await client.waitForProcessing(multiChatId, false);
        await page.goto(`${integration.garcon.baseUrl}/chat/${multiChatId}`);
        await browserExpect(dock.getByText('1/2', { exact: true })).toBeVisible();
        await browserExpect(dock.getByText('Question - Select multiple answers', { exact: true })).toBeVisible();
        await browserExpect(page.locator('[data-composer-status-bar]')).toBeVisible();
        await browserExpect.poll(() => page.evaluate(() => {
          const panelBox = document.querySelector('[data-question-choices-panel]')?.getBoundingClientRect();
          const statusBox = document.querySelector('[data-composer-status-bar]')?.getBoundingClientRect();
          return Boolean(panelBox?.height && statusBox?.height && panelBox.bottom <= statusBox.top + 1);
        })).toBe(true);
        await dock.getByRole('button', { name: 'Outline', exact: true }).click();
        await dock.getByRole('button', { name: 'Diagram', exact: true }).click();
        await browserExpect(dock.getByRole('button', { name: 'Outline', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await browserExpect(dock.getByRole('button', { name: 'Diagram', exact: true })).toHaveAttribute('aria-pressed', 'true');
        await page.screenshot({ path: join(artifacts, `question-choices-${executionBackend}-multiple.png`) });
        await dock.getByRole('button', { name: 'Next question', exact: true }).click();
        await browserExpect(dock.getByText('2/2', { exact: true })).toBeVisible();
        await browserExpect(dock.getByText('Question - Select one answer', { exact: true })).toBeVisible();
        await browserExpect(dock.getByRole('button', { name: 'Send answer', exact: true })).toHaveCount(0);
        await dock.getByRole('button', { name: 'Short', exact: true }).click();
        const multiRequest = await fakeProviders.openAi.waitForRequest({ lastUserText: 'Which features do you want? Select all that apply.\n- Outline\n- Diagram\n\nWhich format do you prefer?\nShort' });
        browserExpect(multiRequest).toBeDefined();
        await browserExpect(dock).toHaveCount(0);
        assertNoBrowserErrors();
        console.log(
          `Question choices browser assertions complete: ${executionBackend}`,
        );
      },
      undefined,
      {
        executionBackend,
        serverEnvironment: process.platform === 'win32' ? {
          PATH: process.env.PATH ?? '',
          PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
          SystemRoot: process.env.SystemRoot ?? 'C:/Windows',
        } : undefined,
      },
    );
  }, 120_000);
}
