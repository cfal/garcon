import { expect, test } from 'bun:test';
import { chmod, copyFile, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_PULL_REQUEST_REVIEW_SETTINGS } from '../../../common/pull-request-reviews.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { initializeFixtureRepository } from '../../support/git-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('a connected remote repository lists its pull requests and loads a diff from its own executor', async () => {
  await withE2eFixture('executor-gh-browser', async fixture => {
    const { client, executionDirs, directAgents } = fixture.integration;
    await initializeFixtureRepository(executionDirs.project);
    await client.post('/api/v1/pull-request-reviews/repositories', {
      target: {
        type: 'new-chat', executorId: client.executorId, agentId: 'shell', model: 'sh', projectPath: executionDirs.project,
        apiProviderId: null, modelEndpointId: null, modelProtocol: null, permissionMode: 'default', thinkingMode: 'none',
        agentSettingsById: { shell: { ownerId: 'shell', schemaVersion: 1, values: {} } }, tags: [], preambleChoice: { mode: 'defaults' },
      },
      settings: DEFAULT_PULL_REQUEST_REVIEW_SETTINGS,
    });
    const chatId = fixture.integration.newChatId();
    const accepted = await client.startDirectChat({ chatId, projectPath: executionDirs.project, content: 'Synthetic remote pull request chat', agent: directAgents.openAi });
    await client.waitForTurnTerminal(chatId, accepted.turnId);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1440, 900);
    await app.openChat(chatId);
    const requests: URL[] = [];
    fixture.page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/v1/gh/')) requests.push(url);
    });
    await app.openNewWorkspaceWindow('Open Pull Requests');
    await fixture.page.waitForFunction(() => document.querySelector('[data-pr-list]')?.textContent?.includes('synthetic-worker'));
    await fixture.page.$eval('[data-pr-inbox-row]', element => (element as HTMLButtonElement).click());
    await fixture.page.$eval('[data-pr-tab="changes"]', element => (element as HTMLButtonElement).click());
    await fixture.page.waitForFunction(() => document.querySelector('[data-pr-detail]')?.textContent?.includes('changed'));
    const panel = await fixture.page.$eval('[data-pr-panel]', element => element.textContent);
    expect(panel).toContain('example.txt');
    expect(panel).toContain('synthetic comment');
    expect(requests.some(url => url.pathname === '/api/v1/gh/pull-request' && url.searchParams.get('executorId') === client.executorId)).toBe(true);
    expect(requests.every(url => url.searchParams.get('executorId') === client.executorId)).toBe(true);
    fixture.assertNoBrowserErrors();
  }, {
    executionBackend: 'remote-controller-dials', projectRoots: 'separate',
    resolveServerEnvironment: dirs => ({ PATH: join(dirs.root, 'gh-bin') }),
    prepareWorkspace: async dirs => {
      const bin = join(dirs.root, 'gh-bin');
      await mkdir(bin);
      await copyFile(new URL('../../../server/remote/__tests__/fixtures/fake-gh.js', import.meta.url), join(bin, 'gh'));
      await chmod(join(bin, 'gh'), 0o755);
      await symlink(process.execPath, join(bin, 'bun'));
      await symlink(Bun.which('git')!, join(bin, 'git'));
      await writeFile(join(dirs.project, 'gh-fixture.json'), JSON.stringify({ label: 'synthetic-worker' }));
    },
  });
}, 60_000);
