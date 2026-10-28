import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { Deferred } from '../../support/deferred.js';
import { canonicalWorkspaceSnapshot } from '../../../web/src/lib/workspace/canonical-layout.js';
import { serializeWorkspaceLayout } from '../../../web/src/lib/workspace/layout-schema.js';
import { reduceWorkspaceLayout } from '../../../web/src/lib/workspace/workspace-layout.svelte.js';

test('Composer status bar path responds to its container and opens the owning chat path dialog', async () => {
  await withChromiumFixture('composer-status-bar-path', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const root = integration.executionDirs.project;
    await initializeFixtureRepository(root);
    await runFixtureGit(root, 'branch', '-m', 'feature/a-long-branch-name-for-responsive-bar-coverage');
    await writeFile(join(root, 'example.txt'), 'Synthetic changed line\n'.repeat(42));
    const projects = ['project-alpha', 'project-beta'].map(name => join(root, 'clients/products/worktrees', name));
    const chats: string[] = [];
    for (const projectPath of projects) {
      await mkdir(projectPath, { recursive: true });
      const chatId = integration.newChatId();
      const started = await integration.client.startDirectChat({
        chatId, content: 'Synthetic project path test', projectPath, agent: integration.directAgents.openAi,
      });
      await integration.client.waitForTurnTerminal(chatId, started.turnId);
      chats.push(chatId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${chats[0]}`);
    const pathButton = page.locator('[data-composer-project-path]:visible');
    const pathLabel = pathButton.locator('[data-composer-project-path-label]');
    const branch = page.getByRole('button', { name: /current ref feature\/a-long-branch/ });
    const commit = page.locator('[data-git-summary-button] button:visible');
    const composer = page.locator('[data-composer]:visible');
    const dialog = page.getByRole('dialog', { name: 'Change project path', exact: true });
    const pathInput = dialog.locator('#sidebar-project-path-input');
    const update = dialog.getByRole('button', { name: 'Update path', exact: true });
    await browserExpect(branch).toBeVisible();
    await browserExpect(commit).toHaveAccessibleName(/Commit.*\+42.*-1/);
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${projects[0]}`);
    await browserExpect(pathButton).toBeEnabled();

    const artifacts = join(import.meta.dirname, '../../artifacts/chromium');
    await mkdir(artifacts, { recursive: true });
    for (const width of [1440, 900, 600, 390, 320]) {
      phase(`checking path, branch and Commit geometry at ${width}px`);
      await page.setViewportSize({ width, height: 900 });
      await browserExpect(page.locator('.mobile-shell')).toHaveCount(width <= 768 ? 1 : 0);
      await browserExpect.poll(async () => {
        const boxes = await Promise.all([pathButton, branch, commit].map(control => control.boundingBox()));
        return boxes.every((box, index) => box && box.width > 0 &&
          (index === 0 || boxes[index - 1]!.x + boxes[index - 1]!.width <= box.x) &&
          box.y === boxes[0]!.y);
      }).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const targetsWidth = await pathButton.evaluate(element => element.parentElement!.getBoundingClientRect().width);
      if (targetsWidth >= 288) {
        await browserExpect(pathLabel).toBeVisible();
        expect(await pathLabel.locator('span').first().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        expect(await pathLabel.locator('span').last().evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      } else {
        await browserExpect(pathLabel).toBeHidden();
        expect((await pathButton.boundingBox())!.width).toBe(32);
      }
      await page.screenshot({ path: join(artifacts, `composer-status-bar-path-${width}.png`) });

      phase(`opening the shared path dialog at ${width}px`);
      await pathButton.focus();
      await pathButton.press('Enter');
      await browserExpect(pathInput).toHaveValue(projects[0]!);
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(pathButton).toBeFocused();
    }

    phase('checking narrow panes on a wide viewport');
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = page.locator('[data-workspace-window-id="window-main"] [data-conversation-panel]:visible');
    await panel.evaluate(element => { element.style.width = '320px'; });
    expect((await panel.boundingBox())!.width).toBe(320);
    await browserExpect(pathLabel).toBeHidden();
    const [pathBox, branchBox, commitBox] = await Promise.all(
      [pathButton, branch, commit].map(control => control.boundingBox()),
    );
    expect(pathBox!.width).toBe(32);
    expect(pathBox!.x + pathBox!.width).toBeLessThan(branchBox!.x);
    expect(branchBox!.x + branchBox!.width).toBeLessThan(commitBox!.x);
    await panel.evaluate(element => { element.style.removeProperty('width'); });

    phase('checking content-sized allocation with short paths and branches');
    // Cloned controls isolate text sizing from the fixture's generated absolute project path.
    for (const sizing of [
      { width: 460, parent: '/workspace/products/clients', name: '/project-alpha', branch: 'main', fullPathFits: true },
      { width: 288, parent: '/app', name: '/proj', branch: 'feature/a-long-branch-name-for-responsive-bar-coverage', fullPathFits: false },
    ]) {
      const geometry = await pathButton.evaluate((button, sizing) => {
        const targets = button.parentElement!.cloneNode(true) as HTMLElement;
        targets.style.cssText = `position:fixed;left:0;top:0;width:${sizing.width}px`;
        const path = targets.querySelector<HTMLElement>('[data-composer-project-path]')!;
        const label = path.querySelector<HTMLElement>('[data-composer-project-path-label]')!;
        const parent = label.firstElementChild as HTMLElement;
        const name = label.lastElementChild as HTMLElement;
        const branch = targets.querySelector<HTMLElement>('button:not([data-composer-project-path])')!;
        parent.textContent = sizing.parent;
        name.textContent = sizing.name;
        branch.querySelector('span')!.textContent = sizing.branch;
        document.body.append(targets);
        try {
          return {
            parentFits: parent.scrollWidth <= parent.clientWidth + 1,
            basenameFits: name.scrollWidth <= name.clientWidth + 1,
            pathRight: path.getBoundingClientRect().right,
            branchLeft: branch.getBoundingClientRect().left,
            branchRight: branch.getBoundingClientRect().right,
            targetsRight: targets.getBoundingClientRect().right,
          };
        } finally {
          targets.remove();
        }
      }, sizing);
      expect(geometry.basenameFits).toBe(true);
      if (sizing.fullPathFits) expect(geometry.parentFits).toBe(true);
      expect(geometry.pathRight).toBeLessThan(geometry.branchLeft);
      expect(geometry.branchRight).toBeLessThanOrEqual(geometry.targetsRight);
    }

    phase('rapid chat switching preserves composer position and per-chat project identity');
    const originalComposer = await composer.elementHandle();
    const composerTop = (await composer.boundingBox())!.y;
    for (const index of [1, 0, 1, 0]) {
      await page.locator(`[data-sidebar-virtual-row="${chats[index]}"] button`).first().click();
      await page.waitForURL(`**/chat/${chats[index]}`);
      await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${projects[index]}`);
      expect(await composer.evaluate((element, original) => element === original, originalComposer)).toBe(true);
      expect((await composer.boundingBox())!.y).toBe(composerTop);
      await pathButton.click();
      await browserExpect(pathInput).toHaveValue(projects[index]!);
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toHaveCount(0);
    }

    phase('applying a path change through the shared dialog updates the status bar');
    await pathButton.click();
    await pathInput.fill(projects[1]!);
    await browserExpect(update).toBeEnabled();
    await update.click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${projects[1]}`);

    phase('returning focus to the chat while a new path is still unclassified');
    const uncheckedPath = join(root, 'unchecked-project');
    await mkdir(uncheckedPath);
    const summaryGate = new Deferred<void>();
    await page.route('**/api/v1/git/quick-summary', async route => {
      if (route.request().postDataJSON()?.project === uncheckedPath) await summaryGate.promise;
      await route.continue();
    });
    try {
      await pathButton.click();
      await pathInput.fill(uncheckedPath);
      await browserExpect(update).toBeEnabled();
      await update.click();
      await browserExpect(dialog).toHaveCount(0);
      await browserExpect(pathButton).toHaveCount(0);
      await browserExpect(panel.locator('[data-chat-scroll-viewport]')).toBeFocused();
    } finally {
      summaryGate.resolve();
    }
    await browserExpect(pathButton).toHaveAccessibleName(`Change project path: ${uncheckedPath}`);
    await page.unroute('**/api/v1/git/quick-summary');

    phase('opening the path dialog from a non-command-owner split panel');
    const layout = reduceWorkspaceLayout(canonicalWorkspaceSnapshot(), [
      { type: 'close-window', windowId: 'window-files' },
      { type: 'set-window-chat', windowId: 'window-main', chatId: chats[0]! },
      { type: 'open-chat-in-new-window', chatId: chats[1]!, targetWindowId: 'window-main',
        edge: 'right', newWindowId: 'window-right', partitionId: 'partition-status-bar' },
    ]);
    await page.evaluate(persisted => localStorage.setItem('workspace_layout_v2', JSON.stringify(persisted)), serializeWorkspaceLayout(layout));
    await page.reload();
    const left = page.locator('[data-conversation-panel="chat-view:window-main"]');
    const right = page.locator('[data-conversation-panel="chat-view:window-right"]');
    await browserExpect(left.locator('[data-composer-project-path]')).toBeVisible();
    await browserExpect(right.locator('[data-composer-project-path]')).toBeVisible();
    await left.locator('[data-chat-scroll-viewport]').click();
    await browserExpect(left).toHaveAttribute('data-conversation-panel-command-owner', 'true');
    await browserExpect(right).not.toHaveAttribute('data-conversation-panel-command-owner', 'true');
    await right.locator('[data-composer-project-path]').click();
    await browserExpect(pathInput).toHaveValue(projects[1]!);
    await pathInput.fill(root);
    await browserExpect(update).toBeEnabled();
    await update.click();
    await browserExpect(dialog).toHaveCount(0);
    await browserExpect(right.locator('[data-composer-project-path]')).toHaveAccessibleName(`Change project path: ${root}`);
    await browserExpect(left.locator('[data-composer-project-path]')).toHaveAccessibleName(`Change project path: ${uncheckedPath}`);
    assertNoBrowserErrors();
  });
}, 120_000);
