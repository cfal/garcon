import { expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PreamblesSnapshot } from '../../../common/preambles.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { selectExecutor } from '../../support/executor-ui.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('scheduled chat and preamble directory pickers browse the selected worker', async () => {
  await withE2eFixture('remote-directory-pickers', async (fixture) => {
    const { client, executionDirs } = fixture.integration;
    const directory = join(executionDirs.project, 'worker-only');
    await mkdir(directory);
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.setViewport(1440, 1100);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.clickMenuItem('Scheduled prompts');
    await app.waitForButtonEnabled('Add Prompt');
    await app.clickButton('Add Prompt');
    await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Integration worker');
    await app.fill('#scheduled-project-path', executionDirs.project);
    const browsed = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/files/browse'
      && new URL(response.url()).searchParams.get('executorId') === client.executorId);
    await fixture.page.$eval('#scheduled-project-path', element => (element as HTMLInputElement).focus());
    expect((await browsed).status()).toBe(200);
    await app.waitForText('worker-only');
    await fixture.page.$eval('[data-slot="directory-browser-dismiss"]', element => (element as HTMLElement).click());
    await app.clickButton('Cancel');
    await fixture.page.waitForFunction(() => document.querySelector('#scheduled-project-path') === null);
    await app.clickButton('Close');

    await app.clickButton('More actions');
    await app.clickMenuItem('Preambles');
    await app.waitForButtonEnabled('Add preamble');
    await app.clickButton('Add preamble');
    await app.fill('#preamble-title', 'Synthetic worker rules');
    await app.fill('textarea[placeholder="Write preamble instructions..."]', 'Synthetic worker instructions');
    await fixture.page.$$eval('input[type="radio"][name="preamble-scope"]', elements => (elements[1] as HTMLInputElement).click());
    await app.clickButton('Add project path');
    await fixture.page.$eval('[data-slot="directory-browser-dismiss"]', element => (element as HTMLElement).click());
    await selectExecutor(fixture.page, '[role="dialog"] [data-executor-picker]', 'Integration worker');
    await app.fill('input[aria-label="Project path"]', executionDirs.project);
    const ruleBrowse = fixture.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/files/browse'
      && new URL(response.url()).searchParams.get('executorId') === client.executorId);
    await app.clickButton('Browse project paths');
    expect((await ruleBrowse).status()).toBe(200);
    await app.waitForText('worker-only');
    await app.clickButton('worker-only');
    await fixture.page.$eval('[data-slot="directory-browser-dismiss"]', element => (element as HTMLElement).click());
    await app.clickButton('Save Preamble');
    await app.waitForText('Synthetic worker rules');
    const snapshot = await client.get<PreamblesSnapshot>('/api/v1/preambles');
    expect(snapshot.preambles.find(item => item.title === 'Synthetic worker rules')?.scope)
      .toEqual({ type: 'project-paths', rules: [{ executorId: client.executorId, projectPath: directory, includeNested: false }] });
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-executor-dials', projectRoots: 'separate' });
}, 90_000);
