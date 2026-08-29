import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';

const WINDOW_SELECTOR = '[data-workspace-window-id]';

async function createChat(fixture: ChromiumFixture, content: string): Promise<string> {
  const chatId = fixture.integration.newChatId();
  const started = await fixture.integration.client.startDirectChat({
    chatId,
    content,
    projectPath: fixture.integration.dirs.project,
    agent: fixture.integration.directAgents.openAi,
  });
  await fixture.integration.client.waitForTurnTerminal(chatId, started.turnId);
  return chatId;
}

async function openChat(fixture: ChromiumFixture, chatId: string): Promise<void> {
  const response = await fixture.page.goto(
    `${fixture.integration.garcon.baseUrl}/chat/${encodeURIComponent(chatId)}`,
    { waitUntil: 'domcontentloaded' },
  );
  if (!response?.ok()) throw new Error(`SPA navigation failed with ${response?.status()}.`);
  await fixture.page.locator(WINDOW_SELECTOR).waitFor({ state: 'visible' });
  await fixture.page
    .locator(`[data-sidebar-virtual-row="${chatId}"]`)
    .waitFor({ state: 'visible' });
}

async function openNewWindow(page: Page, label: string): Promise<string> {
  const previousCount = await page.locator(WINDOW_SELECTOR).count();
  await page.locator('[data-workspace-new-window-menu]').click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  await page.waitForFunction(
    (expectedCount) =>
      document.querySelectorAll('[data-workspace-window-id]').length === expectedCount,
    previousCount + 1,
  );
  return page
    .locator('[data-workspace-window-current="true"]')
    .getAttribute('data-workspace-window-id')
    .then((windowId) => {
      if (!windowId) throw new Error(`Opening ${label} did not produce a current window.`);
      return windowId;
    });
}

async function openFile(page: Page, absolutePath: string): Promise<void> {
  await page.waitForFunction(
    (path) =>
      [...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]')].some(
        (element) => element.getAttribute('title') === path,
      ),
    absolutePath,
  );
  await page.evaluate((path) => {
    const header = [
      ...document.querySelectorAll<HTMLElement>('[data-file-tree-row] [role="rowheader"]'),
    ].find((element) => element.getAttribute('title') === path);
    const row = header?.closest<HTMLElement>('[data-file-tree-row]');
    if (!row) throw new Error(`Missing file tree row: ${path}`);
    row.click();
  }, absolutePath);
}

async function dragChatToWindow(
  page: Page,
  input: { chatId: string; windowId: string; expectBlocked?: boolean },
): Promise<void> {
  const source = page.locator(`[data-sidebar-virtual-row="${input.chatId}"][draggable="true"]`);
  const target = page.locator(`[data-workspace-window-id="${input.windowId}"]`);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Missing workspace Chat drag geometry.');

  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width - 12;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  try {
    await page.mouse.move(sourceX + 24, sourceY, { steps: 4 });
    await page.mouse.move(targetX, targetY, { steps: 20 });
    await target.locator('[data-workspace-window-drop-layer]').waitFor({ state: 'visible' });
    if (input.expectBlocked) {
      await target.getByText('4 windows max', { exact: true }).waitFor({ state: 'visible' });
    } else {
      await target
        .getByText('Open new window right', { exact: true })
        .waitFor({ state: 'visible' });
    }
  } finally {
    await page.mouse.up();
  }
}

async function resizeFirstPartition(page: Page): Promise<{ value: string; persisted: string }> {
  await page.waitForFunction(() => localStorage.getItem('workspace_layout_v2') !== null);
  const resizer = page.getByRole('separator', { name: 'Resize windows' }).first();
  const bounds = await resizer.boundingBox();
  const orientation = await resizer.getAttribute('aria-orientation');
  const initialValue = await resizer.getAttribute('aria-valuenow');
  const initialPersisted = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
  if (!bounds || !initialValue || !initialPersisted) {
    throw new Error('Missing workspace partition resize state.');
  }

  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(
    orientation === 'vertical' ? x + 80 : x,
    orientation === 'horizontal' ? y + 80 : y,
    { steps: 10 },
  );
  await page.mouse.up();
  await page.waitForFunction(
    (previousValue) =>
      document
        .querySelector('[role="separator"][aria-label="Resize windows"]')
        ?.getAttribute('aria-valuenow') !== previousValue,
    initialValue,
  );
  const value = await resizer.getAttribute('aria-valuenow');
  if (!value) throw new Error('Workspace partition resize was not committed.');
  await page.waitForFunction((expectedValue) => {
    const raw = localStorage.getItem('workspace_layout_v2');
    if (!raw) return false;
    const visit = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false;
      const candidate = node as { type?: unknown; ratio?: unknown; children?: unknown[] };
      if (candidate.type !== 'partition') return false;
      if (
        typeof candidate.ratio === 'number' &&
        Math.round(candidate.ratio * 100) === Number(expectedValue)
      )
        return true;
      return candidate.children?.some(visit) ?? false;
    };
    return visit((JSON.parse(raw) as { root?: unknown }).root);
  }, value);
  const persisted = await page.evaluate(() => localStorage.getItem('workspace_layout_v2'));
  if (!persisted || persisted === initialPersisted) {
    throw new Error('Workspace partition resize was not persisted.');
  }
  return { value, persisted };
}

describe('Chromium workspace windows', () => {
  test('drags Chat onto any window, blocks the cap, and persists pointer resizing', async () => {
    await withChromiumFixture('workspace-window-native-dnd-resize', async (fixture, markPhase) => {
      markPhase('creating source chats');
      const chatA = await createChat(fixture, 'workspace-window-chat-a');
      const chatB = await createChat(fixture, 'workspace-window-chat-b');
      await openChat(fixture, chatA);
      await fixture.page
        .locator(`[data-sidebar-virtual-row="${chatB}"]`)
        .waitFor({ state: 'visible' });

      markPhase('opening a non-Chat target window');
      const filesWindowId = await openNewWindow(fixture.page, 'Open Files');
      await fixture.page
        .locator(`[data-workspace-window-id="${filesWindowId}"]`)
        .waitFor({ state: 'visible' });
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);

      markPhase('dragging a sidebar Chat onto the Files window');
      await dragChatToWindow(fixture.page, { chatId: chatB, windowId: filesWindowId });
      await fixture.page.waitForFunction(
        () => document.querySelectorAll('[data-workspace-window-id]').length === 3,
      );
      await fixture.page
        .getByLabel('Chat messages')
        .getByText('echo:workspace-window-chat-b', { exact: true })
        .waitFor();
      expect(
        await fixture.page
          .locator(`[data-workspace-window-id="${filesWindowId}"]`)
          .getAttribute('data-workspace-window-active-surface'),
      ).toBe('singleton:files');

      markPhase('resizing and restoring the partition');
      const resized = await resizeFirstPartition(fixture.page);
      await fixture.page.reload({ waitUntil: 'domcontentloaded' });
      await fixture.page.waitForFunction(
        () => document.querySelectorAll('[data-workspace-window-id]').length === 3,
      );
      expect(await fixture.page.evaluate(() => localStorage.getItem('workspace_layout_v2'))).toBe(
        resized.persisted,
      );
      expect(
        await fixture.page
          .getByRole('separator', { name: 'Resize windows' })
          .first()
          .getAttribute('aria-valuenow'),
      ).toBe(resized.value);

      markPhase('blocking Chat drag at four windows');
      await openNewWindow(fixture.page, 'New Terminal');
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
      await dragChatToWindow(fixture.page, {
        chatId: chatA,
        windowId: filesWindowId,
        expectBlocked: true,
      });
      expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(4);
      await fixture.page.waitForFunction(
        () =>
          document.querySelector<HTMLButtonElement>('[data-workspace-new-window-menu]')
            ?.disabled === true,
      );
      fixture.assertNoBrowserErrors();
    });
  });

  test('cancels destructive fullscreen atomically for a dirty file', async () => {
    await withChromiumFixture(
      'workspace-window-fullscreen-file-guard',
      async (fixture, markPhase) => {
        const project = fixture.integration.dirs.project;
        const filePath = join(project, 'dirty-fullscreen.txt');
        await writeFile(filePath, 'original\n', 'utf8');

        markPhase('opening Chat and Files windows');
        const chatId = await createChat(fixture, 'workspace-window-file-guard');
        await openChat(fixture, chatId);
        const chatWindow = fixture.page.locator('[data-workspace-window-current="true"]');
        const chatWindowId = await chatWindow.getAttribute('data-workspace-window-id');
        if (!chatWindowId) throw new Error('Missing current Chat window.');
        await openNewWindow(fixture.page, 'Open Files');
        await openFile(fixture.page, filePath);
        await fixture.page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLElement>('[data-workspace-window-id]')].some(
            (element) => element.dataset.workspaceWindowActiveSurface?.startsWith('file:'),
          ),
        );

        markPhase('editing the file');
        const editor = fixture.page.locator('.cm-content[contenteditable="true"]');
        await editor.click();
        await editor.pressSequentially('dirty edit');
        await fixture.page.locator('[aria-label="Unsaved"]').waitFor({ state: 'visible' });

        markPhase('cancelling fullscreen destruction');
        await fixture.page.locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`).click();
        await fixture.page.getByRole('dialog').waitFor({ state: 'visible' });
        await fixture.page.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(await fixture.page.locator(WINDOW_SELECTOR).count()).toBe(2);
        await fixture.page.locator('[aria-label="Unsaved"]').waitFor({ state: 'visible' });

        markPhase('confirming fullscreen destruction');
        await fixture.page.locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`).click();
        await fixture.page.getByRole('dialog').waitFor({ state: 'visible' });
        await fixture.page.getByRole('button', { name: 'Discard', exact: true }).click();
        await fixture.page.waitForFunction(
          () => document.querySelectorAll('[data-workspace-window-id]').length === 1,
        );
        expect(
          await fixture.page
            .locator(`[data-workspace-window-fullscreen="${chatWindowId}"]`)
            .getAttribute('aria-label'),
        ).toBe('Exit fullscreen');
        fixture.assertNoBrowserErrors();
      },
    );
  });
});
