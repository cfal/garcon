import { expect, test } from 'bun:test';
import { expect as browserExpect } from 'playwright/test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../common/pull-request-reviews.js';
import type { PreambleSelectionPreviewResponse } from '../../../common/chat-preamble-selection-contracts.js';

const remoteOptions = { executionBackend: 'remote-controller-dials', projectRoots: 'separate' } as const;

async function openChat(fixture: ChromiumFixture) {
  const { client, executionDirs, directAgents } = fixture.integration;
  const chatId = fixture.integration.newChatId();
  const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic failure handling chat', agent: directAgents.openAi });
  await client.waitForTurnTerminal(chatId, accepted.turnId);
  await fixture.page.goto(`${fixture.integration.garcon.baseUrl}/chat/${chatId}`);
  await collapseCanonicalFilesWindow(fixture.page);
}

// Connects the worker checkout so the inbox lists its pull requests.
async function connectReviewRepository(fixture: ChromiumFixture) {
  const { client, executionDirs } = fixture.integration;
  await client.post('/api/v1/pull-request-reviews/repositories', {
    target: {
      type: 'new-chat', executorId: client.executorId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
      apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
      agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
    },
    settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
  });
}

function assertOnlyExpectedHttpErrors(fixture: ChromiumFixture, failures: number) {
  fixture.consumeExpectedBrowserErrors(Array(failures).fill('console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)'));
}

test('uncertain push reports its captured executor after disconnection without replay', async () => {
  await withChromiumFixture('git-push-uncertainty', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client, executionDirs, dirs } = integration;
    const project = executionDirs.project;
    await initializeFixtureRepository(project);
    const remote = join(dirs.root, 'origin.git');
    await runFixtureGit(project, 'init', '--bare', remote);
    await runFixtureGit(project, 'remote', 'add', 'origin', remote);
    await runFixtureGit(project, 'push', '-u', 'origin', 'main');
    await writeFile(join(project, 'example.txt'), 'pending push\n');
    await runFixtureGit(project, 'commit', '-am', 'Pending push');
    const head = await runFixtureGit(project, 'rev-parse', 'HEAD');
    await openChat(fixture);
    await clickWorkspaceWindowAddAction(page, 'Open Workbench');
    const panel = page.locator('[data-workspace-surface-id="singleton:git"][aria-hidden="false"]');
    const dispatched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    await page.route('**/api/v1/git/push', async route => {
      calls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      dispatched.resolve();
      await release.promise;
      await route.fulfill({ status: 503, json: { error: 'Push outcome unknown; inspect the remote.', errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN' } });
    });
    try {
      phase('push confirmation');
      await panel.getByRole('button', { name: 'Push to remote', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Push', exact: true }).click();
      await dispatched.promise;
      phase('disconnect after side effect');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await panel.getByText('Integration worker is unavailable.', { exact: true }).waitFor();
      release.resolve();
      await page.getByText(`Integration worker: ${project}: Push outcome unknown; inspect the remote.`, { exact: true }).waitFor();
      expect(calls).toBe(1);
      expect(await runFixtureGit(remote, 'rev-parse', 'refs/heads/main')).toBe(head);
      assertOnlyExpectedHttpErrors(fixture, calls);
    } finally { release.resolve(); }
  }, undefined, remoteOptions);
}, 120_000);

test('worktree creation blocks Refresh and reports uncertainty after dialog disconnection', async () => {
  await withChromiumFixture('git-worktree-uncertainty', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client, executionDirs } = integration;
    const project = executionDirs.project;
    await initializeFixtureRepository(project);
    await openChat(fixture);
    await clickWorkspaceWindowAddAction(page, 'Open Workbench');
    const panel = page.locator('[data-workspace-surface-id="singleton:git"][aria-hidden="false"]');
    await panel.getByRole('button', { name: project, exact: true }).click();
    const release = Promise.withResolvers<void>();
    const dispatched = Promise.withResolvers<void>();
    let calls = 0;
    let lists = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/git/worktrees') lists++; });
    await page.route('**/api/v1/git/worktrees/create', async route => {
      calls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      dispatched.resolve();
      await release.promise;
      await route.fulfill({ status: 503, json: { error: 'Worktree outcome unknown; inspect the repository.', errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN' } });
    });
    try {
      phase('worktree picker');
      const openPicker = page.getByRole('button', { name: 'Select a different worktree', exact: true });
      await openPicker.click();
      await page.getByRole('option', { name: /main/ }).waitFor();
      await page.getByRole('button', { name: 'New worktree', exact: true }).click();
      await page.getByPlaceholder('Branch name (e.g. fix/login-bug)').fill('feature');
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      await page.getByRole('textbox', { name: 'Location', exact: true }).fill(join(project, 'feature'));
      await page.getByRole('button', { name: 'Create worktree', exact: true }).click();
      await dispatched.promise;
      const count = lists;
      const refresh = page.getByRole('button', { name: 'Refresh worktrees', exact: true });
      expect(await refresh.count()).toBe(0);
      await page.getByRole('dialog', { name: 'New worktree' }).getByRole('button', { name: 'Close' }).click();
      await openPicker.click();
      await browserExpect(page.getByRole('listbox', { name: 'Select worktree' })).toHaveAttribute('aria-busy', 'true');
      await browserExpect(refresh).toBeDisabled();
      expect(lists).toBe(count);
      phase('disconnect after worktree creation');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await panel.getByText('Integration worker is unavailable.', { exact: true }).waitFor();
      release.resolve();
      await page.getByText(`Integration worker: ${project}: Worktree outcome unknown; inspect the repository.`, { exact: true }).waitFor();
      expect(calls).toBe(1);
      expect(await runFixtureGit(project, 'worktree', 'list', '--porcelain')).toContain(`worktree ${join(project, 'feature')}`);
      assertOnlyExpectedHttpErrors(fixture, calls);
    } finally { release.resolve(); }
  }, undefined, remoteOptions);
}, 120_000);

test('repository reconnect preserves the worktree result and filter focus', async () => {
  await withChromiumFixture('worktree-reconnect-error-focus', async ({ page, integration, consumeExpectedBrowserErrors }) => {
    const { client } = integration;
    const project = integration.executionDirs.project;
    const setEnabled = (enabled: boolean) => client.patch(`/api/v1/executors/${client.executorId}`, { enabled });
    await initializeFixtureRepository(project);
    // New Chat also requests a preamble preview while the repository executor is disconnected.
    await page.route('**/api/v1/preambles/selection-preview', route => {
      const { executorId, projectPath } = route.request().postDataJSON();
      return route.fulfill({ json: {
        success: true, executorId, canonicalProjectPath: projectPath, orderedPreambleIds: [],
        projection: { catalogRevision: 0, eligiblePreambles: [], unavailable: [] },
      } satisfies PreambleSelectionPreviewResponse });
    });
    await page.goto(integration.garcon.baseUrl);
    const landing = page.getByRole('dialog', { name: 'New Chat', exact: true });
    await browserExpect(landing).toBeVisible();
    await landing.locator('[data-executor-picker]').click();
    await page.getByRole('menuitemradio', { name: 'Integration worker', exact: true }).click();
    await landing.getByRole('button', { name: 'Choose folder', exact: true }).click();
    const input = landing.getByRole('textbox', { name: 'Project Path', exact: true });
    await input.fill(project);
    await page.locator('[data-slot="project-path-field"] .text-status-success-foreground').waitFor();
    await input.press('Enter');
    await landing.getByRole('region', { name: 'Worktrees', exact: true }).getByRole('button', { name: 'New worktree', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Select worktree', exact: true });
    const newWorktree = picker.getByRole('button', { name: 'New worktree', exact: true });
    await newWorktree.click();
    const create = page.getByRole('dialog', { name: 'New worktree', exact: true });
    const name = create.getByRole('textbox', { name: /branch name/i });
    const submit = create.getByRole('button', { name: 'Create worktree', exact: true });
    const message = 'Worktree outcome unknown; inspect the repository.';
    const dispatched = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let creates = 0;
    await page.route('**/api/v1/git/worktrees/create', async route => {
      creates++;
      dispatched.resolve();
      await release.promise;
      await route.fulfill({ status: 503, json: { error: message, errorCode: 'GIT_MUTATION_OUTCOME_UNKNOWN' } });
    });
    const alert = create.getByRole('alert').filter({ hasText: message });
    try {
      await name.fill('keyboard-reconnect');
      await submit.focus();
      await submit.press('Enter');
      await dispatched.promise;
      await setEnabled(false);
      await create.getByText('Executor unavailable').waitFor();
      release.resolve();
      await browserExpect(alert).toBeVisible();
      await browserExpect(submit).toBeFocused();
    } finally { release.resolve(); }
    await setEnabled(true);
    await browserExpect(submit).toBeEnabled({ timeout: 30_000 });
    await browserExpect(submit).toBeFocused();
    const errorRetained = await alert.isVisible();
    await create.getByRole('button', { name: 'Back', exact: true }).click();
    const filter = page.getByRole('combobox', { name: 'Filter worktrees' });
    await browserExpect(filter).toBeFocused();
    await filter.fill('main');
    await setEnabled(false);
    await page.getByRole('dialog', { name: 'Select worktree' }).getByText('Executor unavailable').waitFor();
    await setEnabled(true);
    await browserExpect(newWorktree).toBeEnabled({ timeout: 30_000 });
    expect(await filter.inputValue()).toBe('main');
    const filterFocused = await filter.evaluate(element => document.activeElement === element);
    consumeExpectedBrowserErrors(['console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)']);
    expect({ errorRetained, filterFocused, creates }).toEqual({ errorRetained: true, filterFocused: true, creates: 1 });
  }, undefined, remoteOptions);
}, 120_000);

test('failed PR detail refresh waits for an explicit retry', async () => {
  await withChromiumFixture('git-pr-detail-retry', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client, executionDirs } = integration;
    await initializeFixtureRepository(executionDirs.project);
    await connectReviewRepository(fixture);
    await openChat(fixture);
    await clickWorkspaceWindowAddAction(page, 'Open Pull Requests');
    const panel = page.locator('[data-workspace-surface-id="singleton:pull-requests"][aria-hidden="false"]');
    let requests = 0;
    let failing = false;
    await page.route('**/api/v1/gh/pull-request?**', async route => {
      requests++;
      if (failing) await route.fulfill({ status: 503, json: { error: 'Synthetic PR detail unavailable', errorCode: 'GH_OPERATION_FAILED' } });
      else await route.continue();
    });
    await panel.locator('[data-pr-list] [data-pr-inbox-row]').first().click();
    await panel.locator('[data-pr-tab="changes"]').click();
    await panel.locator('[data-pr-detail]').getByText('+changed', { exact: true }).waitFor();
    phase('failed refresh');
    failing = true;
    await panel.locator('[data-pr-detail]').getByRole('button', { name: 'Refresh', exact: true }).click();
    await panel.locator('[data-pr-detail]').getByText('Synthetic PR detail unavailable', { exact: true }).waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toBe(2);
    phase('explicit detail retry');
    failing = false;
    const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/gh/pull-request');
    await panel.locator('[data-pr-detail]').getByRole('button', { name: 'Retry', exact: true }).click();
    expect((await retried).status()).toBe(200);
    expect(requests).toBe(3);
    assertOnlyExpectedHttpErrors(fixture, 1);
  }, undefined, {
    ...remoteOptions,
    resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'gh-bin');
      await mkdir(bin);
      await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      await symlink(process.execPath, join(bin, 'bun'));
      await symlink(Bun.which('git')!, join(bin, 'git'));
      await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic-worker', commentsFail: true }));
    },
  });
}, 120_000);
