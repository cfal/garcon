import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withChromiumFixture, type ChromiumFixture } from '../../support/chromium-fixture.js';
import { clickWorkspaceWindowAddAction, collapseCanonicalFilesWindow } from '../../support/chromium-workspace.js';
import { initializeFixtureRepository, runFixtureGit } from '../../support/git-fixture.js';

const remoteOptions = { executionBackend: 'remote-controller-dials', projectRoots: 'separate' } as const;

async function openChat(fixture: ChromiumFixture) {
  const { client, executionDirs, directAgents } = fixture.integration;
  const chatId = fixture.integration.newChatId();
  const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic failure handling chat', agent: directAgents.openAi });
  await client.waitForTurnTerminal(chatId, accepted.turnId);
  await fixture.page.goto(`${fixture.integration.garcon.baseUrl}/chat/${chatId}`);
  await collapseCanonicalFilesWindow(fixture.page);
}

function assertOnlyExpectedHttpErrors(fixture: ChromiumFixture) {
  expect(fixture.browserErrors.filter(error => error !== 'console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)')).toEqual([]);
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
    await clickWorkspaceWindowAddAction(page, 'Open Git Workbench');
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
      await panel.getByText('Git is unavailable on this executor.', { exact: true }).waitFor();
      release.resolve();
      await page.getByText(`Integration worker: ${project}: Push outcome unknown; inspect the remote.`, { exact: true }).waitFor();
      expect(calls).toBe(1);
      expect(await runFixtureGit(remote, 'rev-parse', 'refs/heads/main')).toBe(head);
      assertOnlyExpectedHttpErrors(fixture);
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
    await clickWorkspaceWindowAddAction(page, 'Open Git Workbench');
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
      await page.getByRole('button', { name: 'Select a different worktree', exact: true }).click();
      await page.getByRole('option', { name: /main/ }).waitFor();
      await page.getByRole('button', { name: 'New worktree', exact: true }).click();
      await page.getByPlaceholder('Branch name (e.g. fix/login-bug)').fill('feature');
      await page.getByRole('button', { name: 'Advanced', exact: true }).click();
      await page.getByPlaceholder('Path override').fill(join(project, 'feature'));
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await dispatched.promise;
      const count = lists;
      const refresh = page.getByRole('button', { name: 'Refresh worktrees', exact: true });
      expect(await refresh.isDisabled()).toBe(true);
      await refresh.evaluate(element => (element as HTMLButtonElement).click());
      expect(lists).toBe(count);
      phase('disconnect after worktree creation');
      await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
      await panel.getByText('Git is unavailable on this executor.', { exact: true }).waitFor();
      release.resolve();
      await page.getByText(`Integration worker: ${project}: Worktree outcome unknown; inspect the repository.`, { exact: true }).waitFor();
      expect(calls).toBe(1);
      expect(await runFixtureGit(project, 'worktree', 'list', '--porcelain')).toContain(`worktree ${join(project, 'feature')}`);
      assertOnlyExpectedHttpErrors(fixture);
    } finally { release.resolve(); }
  }, undefined, remoteOptions);
}, 120_000);

test('failed PR detail refresh on reconnect waits for an explicit retry', async () => {
  await withChromiumFixture('git-pr-detail-retry', async (fixture, phase) => {
    const { page, integration } = fixture;
    const { client, executionDirs } = integration;
    await initializeFixtureRepository(executionDirs.project);
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
    await panel.locator('[data-pr-list] button').filter({ hasText: 'synthetic-worker' }).click();
    await panel.locator('[data-pr-detail]').getByText('+changed', { exact: true }).waitFor();
    phase('replace executor session');
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: false });
    await panel.locator('[aria-busy="true"]').waitFor();
    failing = true;
    await client.patch(`/api/v1/executors/${client.executorId}`, { enabled: true });
    await page.getByText('Synthetic PR detail unavailable', { exact: true }).waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(requests).toBe(2);
    phase('explicit detail retry');
    failing = false;
    const retried = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/gh/pull-request');
    await panel.locator('[data-pr-detail]').getByRole('button', { name: 'Refresh', exact: true }).click();
    expect((await retried).status()).toBe(200);
    expect(requests).toBe(3);
    assertOnlyExpectedHttpErrors(fixture);
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
