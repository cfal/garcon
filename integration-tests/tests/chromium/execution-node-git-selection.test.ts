import { expect, test } from 'bun:test';
import { expect as browserExpect, type Locator, type Page } from 'playwright/test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { effectiveNodeId } from '../../../common/execution-nodes.js';
import { withChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

function surface(page: Page, kind: string): Locator {
  return page.locator(`[data-workspace-surface-id="singleton:${kind}"][aria-hidden="false"]`);
}

async function selectNode(page: Page, panel: Locator, label: string): Promise<void> {
  await panel.locator('[data-execution-node-picker]').click();
  await page.getByRole('menuitemradio', { name: label, exact: true }).click();
  await browserExpect(panel.locator('[data-execution-node-picker]')).toHaveText(label);
}

async function selectFolder(page: Page, panel: Locator, path: string): Promise<void> {
  await panel.locator('[data-git-folder-picker]').click();
  const dialog = page.getByRole('dialog', { name: 'Git target', exact: true });
  await dialog.locator('#git-target-path-input').fill(path);
  await browserExpect(dialog.getByRole('button', { name: 'OK', exact: true })).toBeEnabled();
  await dialog.locator('#git-target-path-input').press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  await browserExpect(panel.locator('[data-git-folder-picker]')).toHaveAttribute('title', path);
}

test('Local-only Files and Git hide node selection and allow Git browsing without a chat', async () => {
  await withChromiumFixture('git-local-independent-selection', async ({ page, integration, assertNoBrowserErrors }) => {
    await initializeFixtureRepository(integration.dirs.project);
    await writeFile(join(integration.dirs.project, 'example.txt'), 'Local independent change\n');
    await page.goto(integration.garcon.baseUrl);
    await page.locator('[data-file-tree-entry-text]').getByText('example.txt', { exact: true }).waitFor();
    expect(await surface(page, 'files').locator('[data-execution-node-picker]').count()).toBe(0);
    await collapseCanonicalFilesWindow(page);
    for (const [action, kind] of [['Open Git Workbench', 'git'], ['Open Git Compare', 'git-compare']]) {
      await clickWorkspaceWindowAddAction(page, action);
      const panel = surface(page, kind);
      expect(await panel.locator('[data-execution-node-picker]').count()).toBe(0);
      await selectFolder(page, panel, integration.dirs.project);
      await panel.getByText('Local independent change', { exact: false }).first().waitFor();
    }
    assertNoBrowserErrors();
  }, undefined, { executionBackend: 'in-process' });
}, 120_000);

test('independent Git folder and node selection survives chat changes and owns Commit and PR requests', async () => {
  await withChromiumFixture('git-independent-node-selection', async ({ page, integration, assertNoBrowserErrors }, phase) => {
    const { client, dirs, executionDirs, directAgents } = integration;
    await initializeFixtureRepository(dirs.project);
    await initializeFixtureRepository(executionDirs.project);
    await writeFile(join(dirs.project, 'example.txt'), 'Local project change\n');
    await writeFile(join(executionDirs.project, 'example.txt'), 'Worker project change\n');
    await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'local-review' }));
    const alternate = join(executionDirs.project, 'alternate');
    await mkdir(alternate);
    await initializeFixtureRepository(alternate);
    await writeFile(join(alternate, 'example.txt'), 'Alternate project change\n');
    const localChat = integration.newChatId();
    const remoteChat = integration.newChatId();
    for (const [chatId, nodeId, projectPath] of [[localChat, 'local', dirs.project], [remoteChat, client.nodeId, executionDirs.project]]) {
      const started = await client.startChat({ ...client.directStartRequest({ chatId, projectPath, content: 'Synthetic selection chat', agent: directAgents.openAi }), nodeId });
      await client.waitForTurnTerminal(chatId, started.turnId);
    }
    await page.goto(`${integration.garcon.baseUrl}/chat/${localChat}`);
    await collapseCanonicalFilesWindow(page);
    await clickWorkspaceWindowAddAction(page, 'Open Git Workbench');
    const git = surface(page, 'git');
    await git.getByText('Local project change', { exact: false }).first().waitFor();
    phase('destination-base fallback and independent folder');
    await selectNode(page, git, 'Integration worker');
    await browserExpect(git.locator('[data-git-folder-picker]')).toHaveAttribute('title', executionDirs.project);
    await git.getByText('Worker project change', { exact: false }).first().waitFor();
    await selectFolder(page, git, alternate);
    await git.getByText('Alternate project change', { exact: false }).first().waitFor();
    for (const chatId of [remoteChat, localChat, remoteChat, localChat]) {
      await page.locator(`[data-sidebar-virtual-row="${chatId}"]`).click();
    }
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    await browserExpect(git.locator('[data-git-folder-picker]')).toHaveAttribute('title', alternate);
    await git.getByText('Alternate project change', { exact: false }).first().waitFor();

    phase('commit on the Workbench target rather than the chat target');
    await git.getByRole('button', { name: 'Commit', exact: true }).click();
    const commit = surface(page, 'commit');
    await browserExpect(commit.locator('[data-git-folder-picker]')).toHaveAttribute('title', alternate);
    await browserExpect(commit.locator('[data-execution-node-picker]')).toHaveText('Integration worker');
    await commit.locator('[data-commit-tree-row="example.txt"] input[type="checkbox"]').check();
    await commit.getByPlaceholder('Commit message...').fill('Independent target commit');
    const committed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/git/commit-index');
    await commit.getByRole('button', { name: 'Commit', exact: true }).click();
    const response = await committed;
    expect(response.status()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({ nodeId: client.nodeId, project: alternate });
    expect(await runFixtureGit(alternate, 'log', '-1', '--format=%s')).toBe('Independent target commit\n');
    expect(await runFixtureGit(dirs.project, 'show', ':example.txt')).toBe('initial\n');
    expect(await runFixtureGit(executionDirs.project, 'show', ':example.txt')).toBe('initial\n');

    phase('PR capability and requests follow its own selected node');
    await clickWorkspaceWindowAddAction(page, 'Open Pull Requests');
    const pr = surface(page, 'pull-requests');
    await pr.locator('[data-pr-list]').getByText('local-review', { exact: false }).first().waitFor();
    await selectNode(page, pr, 'Integration worker');
    await pr.locator('[data-pr-list]').getByText('worker-review', { exact: false }).first().waitFor();
    await browserExpect(pr.locator('[data-git-folder-picker]')).toHaveAttribute('title', executionDirs.project);

    phase('return restores the actual chat project');
    await page.getByRole('tab', { name: 'Git', exact: true }).click();
    await git.getByRole('button', { name: 'Go to chat project', exact: true }).click();
    await browserExpect(git.locator('[data-execution-node-picker]')).toHaveText('Local');
    await git.getByText('Local project change', { exact: false }).first().waitFor();
    const chat = (await client.getChatSnapshot(localChat)).chat;
    expect(effectiveNodeId(chat.nodeId)).toBe('local');
    expect(chat.projectPath).toBe(dirs.project);
    assertNoBrowserErrors();
  }, undefined, {
    executionBackend: 'remote-controller-dials', projectRoots: 'separate',
    resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'gh-bin');
      await mkdir(bin);
      await copyFile(new URL('../../../server/execution-nodes/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      await symlink(process.execPath, join(bin, 'bun'));
      await symlink(Bun.which('git')!, join(bin, 'git'));
      await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'worker-review' }));
    },
  });
}, 120_000);
