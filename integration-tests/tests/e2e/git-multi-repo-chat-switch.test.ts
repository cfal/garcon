import { describe, expect, test } from 'bun:test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

const GIT_PANEL =
  '[role="tabpanel"][data-workspace-surface-id="singleton:git"][aria-hidden="false"]';

async function runGit(projectPath: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], {
    cwd: projectPath,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}

async function createRepo(projectPath: string, prefix: string): Promise<void> {
  await runGit(projectPath, ['init', '-b', 'main']);
  await runGit(projectPath, ['config', 'user.email', 'test@example.com']);
  await runGit(projectPath, ['config', 'user.name', 'E2E Test']);
  await writeFile(join(projectPath, `${prefix}-notes.txt`), `${prefix} base\n`, 'utf8');
  await runGit(projectPath, ['add', `${prefix}-notes.txt`]);
  await runGit(projectPath, ['commit', '-m', `${prefix} base`]);
  await writeFile(
    join(projectPath, `${prefix}-notes.txt`),
    `${prefix} base\n${prefix} change\n`,
    'utf8',
  );
  await writeFile(join(projectPath, `${prefix}-untracked.txt`), `${prefix} untracked\n`, 'utf8');
}

describe('Lightpanda Git multi-repo chat switching', () => {
  test('keeps listings, targets, and commenting coherent across repo and chat switches', async () => {
    await withE2eFixture('git-multi-repo-chat-switch', async (fixture) => {
      // Both repos live under the fixture's project-base boundary.
      const repoA = join(fixture.integration.dirs.project, 'repo-a');
      const repoB = join(fixture.integration.dirs.project, 'repo-b');
      await mkdir(repoA, { recursive: true });
      await mkdir(repoB, { recursive: true });
      await createRepo(repoA, 'alpha');
      await createRepo(repoB, 'beta');

      const app = new SpaDriver(fixture.page, fixture.integration);
      await app.setViewport(1_440, 900);
      await app.open();
      await fixture.waitForSpaWebSocket();
      await app.startOpenAiDirectChat('multi-repo-chat-a', {
        projectPath: repoA,
      });
      await app.waitForText('echo:multi-repo-chat-a');
      await app.startOpenAiDirectChat('multi-repo-chat-b', {
        projectPath: repoB,
      });
      await app.waitForText('echo:multi-repo-chat-b');

      const chats = (await fixture.integration.client.listChats()).sessions;
      const chatA = chats.find((chat) => chat.preview.firstMessage === 'multi-repo-chat-a');
      const chatB = chats.find((chat) => chat.preview.firstMessage === 'multi-repo-chat-b');
      if (!chatA || !chatB) throw new Error('Both project chats must be listed in the sidebar.');
      expect(chatA.projectPath).toBe(repoA);
      expect(chatB.projectPath).toBe(repoB);

      // Chat A: open the Git workbench and confirm repo A listings.
      await app.clickSidebarChatContaining('multi-repo-chat-a');
      await app.waitForSelectedChat(chatA.id);
      await switchToGitSurface(fixture);
      const gitWindowId = await app.workspaceWindowIdForSurface('singleton:git');
      await waitForPanelFiles(
        fixture,
        ['alpha-notes.txt', 'alpha-untracked.txt'],
        ['beta-notes.txt'],
      );

      // Switch the workbench target to repo B from within chat A.
      await app.waitForButton(repoA);
      await app.clickButton(repoA);
      await fixture.page.waitForSelector('[role="dialog"][aria-label="Git target"]');
      await app.fill('#git-target-path-input', repoB);
      await fixture.page.waitForFunction(
        () => {
          const dialog = document.querySelector('[role="dialog"][aria-label="Git target"]');
          const button = [...(dialog?.querySelectorAll('button') ?? [])].find(
            (element) => element.textContent?.trim() === 'OK',
          );
          return button instanceof HTMLButtonElement && !button.disabled;
        },
        { timeout: 20_000 },
      );
      await app.clickButton('OK');
      await waitForPanelFiles(
        fixture,
        ['beta-notes.txt', 'beta-untracked.txt'],
        ['alpha-notes.txt'],
      );

      // Chat B defaults to its own project, the same physical repo chat A's
      // workbench just selected; the listing must stay coherent for the new
      // chat identity. Selecting a chat focuses the Chat surface, so reopen
      // the Git view the way a user does after every switch.
      await app.clickSidebarChatContaining('multi-repo-chat-b');
      await app.waitForSelectedChat(chatB.id);
      await switchToGitSurface(fixture);
      await waitForPanelFiles(
        fixture,
        ['beta-notes.txt', 'beta-untracked.txt'],
        ['alpha-notes.txt'],
      );

      // Change repo B's git state on disk while chat B is active, then refresh.
      await writeFile(join(repoB, 'beta-extra.txt'), 'beta extra untracked\n', 'utf8');
      await appendFile(join(repoB, 'beta-notes.txt'), 'beta second change\n', 'utf8');
      await clickPanelButton(fixture, 'Refresh');
      await waitForPanelFiles(fixture, ['beta-extra.txt'], []);

      // Back to chat A: its remembered target is repo B and must show repo B's
      // current state, with the target selector reporting repo B.
      await app.clickSidebarChatContaining('multi-repo-chat-a');
      await app.waitForSelectedChat(chatA.id);
      await switchToGitSurface(fixture);
      await waitForPanelFiles(
        fixture,
        ['beta-notes.txt', 'beta-untracked.txt', 'beta-extra.txt'],
        ['alpha-notes.txt'],
      );
      await fixture.page.waitForFunction(
        ({ panelSelector, expectedPath }) => {
          const panel = document.querySelector(panelSelector);
          return [...(panel?.querySelectorAll('button') ?? [])].some(
            (element) => element.getAttribute('aria-label') === expectedPath,
          );
        },
        { timeout: 20_000 },
        { panelSelector: GIT_PANEL, expectedPath: repoB },
      );
      // A refresh round-trip settles the retained surface's async target
      // application before user-level review interactions begin.
      await clickPanelButton(fixture, 'Refresh');
      await waitForPanelFiles(fixture, ['beta-notes.txt', 'beta-extra.txt'], []);

      // The review comment flow must still work after the switch sequence.
      // Re-query and click fresh on each attempt: virtual rows re-render while
      // refreshes settle, which can orphan a previously queried button node.
      await fixture.page.waitForSelector(
        '[data-git-virtual-diff-root] button[aria-label="Add to chat"]',
        { timeout: 20_000 },
      );
      let composerOpen = false;
      for (let attempt = 0; attempt < 5 && !composerOpen; attempt += 1) {
        await fixture.page.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-git-virtual-diff-root] button[aria-label="Add to chat"]',
          );
          if (!button) throw new Error('Missing Changes comment affordance.');
          button.click();
        });
        composerOpen = await fixture.page
          .waitForFunction(
            () => document.querySelector('[data-git-comment-composer] textarea') !== null,
            { timeout: 4_000 },
          )
          .then(() => true)
          .catch(() => false);
      }
      if (!composerOpen)
        throw new Error('Comment composer did not open after clicking Add to chat.');
      await app.fill('[data-git-comment-composer] textarea', 'Cross-repo review comment.');
      await fixture.page.evaluate(() => {
        const composer = document.querySelector('[data-git-comment-composer]');
        const button = [...(composer?.querySelectorAll('button') ?? [])].find(
          (candidate) => candidate.textContent?.trim() === 'Add to chat',
        );
        if (!button) throw new Error('Missing Changes Add to chat submit action.');
        button.click();
      });
      await app.waitForText('Added to the Chat composer.');
      const storedDrafts = await fixture.page.evaluate(
        ({ chatAId, chatBId }) => ({
          chatA: localStorage.getItem(`chat_draft_${chatAId}`),
          chatB: localStorage.getItem(`chat_draft_${chatBId}`),
        }),
        { chatAId: chatA.id, chatBId: chatB.id },
      );
      expect(storedDrafts.chatA).toContain('Git review comment');
      expect(storedDrafts.chatA).toContain('Cross-repo review comment.');
      expect(storedDrafts.chatB).toBeNull();
      await app.selectWorkspaceWindowSurfaceById(`chat-view:${gitWindowId}`, gitWindowId);
      await fixture.page.waitForFunction(
        () => {
          const textarea = document.querySelector<HTMLTextAreaElement>(
            '[data-conversation-workspace-layer] textarea[placeholder="Reply..."]',
          );
          return (
            textarea?.value.includes('Git review comment') === true &&
            textarea.value.includes('Cross-repo review comment.')
          );
        },
        { timeout: 20_000 },
      );
      const draft = await fixture.page.$eval(
        '[data-conversation-workspace-layer] textarea[placeholder="Reply..."]',
        (element) => (element as HTMLTextAreaElement).value,
      );
      expect(draft).toContain('Git review comment');
      expect(draft).toContain('Cross-repo review comment.');
      fixture.assertNoBrowserErrors();
    });
  });
});

async function switchToGitSurface(
  fixture: Awaited<Parameters<Parameters<typeof withE2eFixture>[1]>[0]>,
): Promise<void> {
  const alreadyVisible = await fixture.page.evaluate(
    (panelSelector) => document.querySelector(panelSelector) !== null,
    GIT_PANEL,
  );
  if (alreadyVisible) return;
  await fixture.page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }));
  });
  await fixture.page.waitForSelector('[role="dialog"][aria-label="Command palette"]');
  await fixture.page.evaluate(() => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent?.includes('Switch to Git'),
    );
    if (!option) throw new Error('Missing Switch to Git command.');
    option.click();
  });
  await fixture.page.waitForFunction(
    (panelSelector) => document.querySelector(panelSelector) !== null,
    { timeout: 20_000 },
    GIT_PANEL,
  );
}

async function waitForPanelFiles(
  fixture: Awaited<Parameters<Parameters<typeof withE2eFixture>[1]>[0]>,
  presentFiles: string[],
  absentFiles: string[],
): Promise<void> {
  await fixture.page.waitForFunction(
    ({ panelSelector, present, absent }) => {
      const panel = document.querySelector(panelSelector);
      const text = panel?.textContent ?? '';
      return (
        present.every((name) => text.includes(name)) && absent.every((name) => !text.includes(name))
      );
    },
    { timeout: 20_000 },
    { panelSelector: GIT_PANEL, present: presentFiles, absent: absentFiles },
  );
}

async function clickPanelButton(
  fixture: Awaited<Parameters<Parameters<typeof withE2eFixture>[1]>[0]>,
  name: string,
): Promise<void> {
  await fixture.page.waitForFunction(
    ({ panelSelector, label }) => {
      const panel = document.querySelector(panelSelector);
      const button = [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (element) => {
          if (element.hasAttribute('data-surface-action-measure')) return false;
          const accessible =
            element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return accessible === label;
        },
      );
      if (button) return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
      const menuTrigger = panel?.querySelector<HTMLButtonElement>(
        '[data-responsive-surface-menu-trigger]',
      );
      return Boolean(menuTrigger && !menuTrigger.disabled);
    },
    { timeout: 20_000 },
    { panelSelector: GIT_PANEL, label: name },
  );
  const destination = await fixture.page.evaluate(
    ({ panelSelector, label }) => {
      const panel = document.querySelector(panelSelector);
      const button = [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (element) => {
          if (element.hasAttribute('data-surface-action-measure')) return false;
          const accessible =
            element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return accessible === label;
        },
      );
      if (button) {
        button.click();
        return 'direct';
      }
      const menuTrigger = panel?.querySelector<HTMLButtonElement>(
        '[data-responsive-surface-menu-trigger]',
      );
      if (!menuTrigger) throw new Error(`Missing panel action: ${label}`);
      menuTrigger.click();
      return 'menu';
    },
    { panelSelector: GIT_PANEL, label: name },
  );
  if (destination === 'direct') return;

  await fixture.page.waitForFunction(
    (label) => {
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (element) => {
          const accessible =
            element.getAttribute('aria-label') || element.textContent?.trim() || '';
          return accessible === label;
        },
      );
      return Boolean(
        item &&
        !item.hasAttribute('data-disabled') &&
        item.getAttribute('aria-disabled') !== 'true',
      );
    },
    { timeout: 20_000 },
    name,
  );
  await fixture.page.evaluate((label) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (element) => {
        const accessible = element.getAttribute('aria-label') || element.textContent?.trim() || '';
        return accessible === label;
      },
    );
    if (!item) throw new Error(`Missing panel menu action: ${label}`);
    item.click();
  }, name);
}
