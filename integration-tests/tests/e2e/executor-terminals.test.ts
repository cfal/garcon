import { expect, test } from 'bun:test';
import type { TerminalListResponse } from '../../../common/terminal.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('terminal host menus capture directories and preserve names across desktop/mobile', async () => {
  await withE2eFixture('executor-terminals', async fixture => {
    const { client, executionDirs, dirs, directAgents } = fixture.integration;
    await client.put(`/api/v1/api-provider-assignments?executorId=local&apiProviderId=${directAgents.openAi.provider.providerId}`, {});
    const app = new SpaDriver(fixture.page, fixture.integration);
    const list = (executorId: string) => client.get<TerminalListResponse>(`/api/v1/terminals?executorId=${executorId}`);
    await app.setViewport(1440, 900);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.startOpenAiDirectChat('synthetic-terminal-hosts');
    const windowId = await app.currentWorkspaceWindowId();

    await app.clickWorkspaceWindowAddAction('New Terminal', windowId);
    await app.waitForMenuItemEnabled('Integration worker');
    expect((await list('local')).terminals).toEqual([]);
    expect((await list(client.executorId)).terminals).toEqual([]);
    await app.clickMenuItem('Integration worker');
    await fixture.page.waitForSelector('[data-workspace-surface-id^="terminal:"] [data-terminal-host]');
    const remote = (await list(client.executorId)).terminals[0]!;
    expect(remote.initialWorkingDirectory).toBe(executionDirs.project);
    await fixture.page.waitForFunction(() => [...document.querySelectorAll('[data-window-tab-measure-id]')].some(element => element.textContent?.trim() === 'Integration worker 1'));

    await client.patch(`/api/v1/executors/${client.executorId}`, { label: 'Build Server' });
    await fixture.page.waitForFunction(() => [...document.querySelectorAll('[data-window-tab-measure-id]')].some(element => element.textContent?.trim() === 'Build Server 1'));
    await app.openWorkspaceWindowActions(windowId);
    await app.clickMenuItem('Rename');
    await app.fill('input[aria-label="Terminal name"]', 'Build logs');
    await app.clickButton('Save');
    await fixture.page.waitForFunction(() => [...document.querySelectorAll('[data-window-tab-measure-id]')].some(element => element.textContent?.trim() === 'Build logs'));

    await app.clickWorkspaceWindowAddAction('New Terminal', windowId);
    await app.waitForMenuItemEnabled('Local');
    await app.clickMenuItem('Local');
    await fixture.page.waitForFunction(() => [...document.querySelectorAll('[data-window-tab-measure-id]')].some(element => element.textContent?.trim() === 'Local 1'));
    expect((await list('local')).terminals[0]?.initialWorkingDirectory).toBe(dirs.project);
    expect((await list(client.executorId)).terminals).toMatchObject([{ terminalId: remote.terminalId, title: 'Build logs' }]);

    await app.setViewport(390, 844);
    await fixture.page.waitForSelector('.mobile-shell button[aria-label="New Terminal"]');
    await fixture.page.$eval('.mobile-shell button[aria-label="New Terminal"]', element => (element as HTMLButtonElement).click());
    await app.waitForMenuItemEnabled('Build Server');
    await app.clickMenuItem('Build Server');
    await fixture.page.waitForFunction(() => {
      const picker = document.querySelector<HTMLSelectElement>('.mobile-shell select[aria-label="Terminal session"]');
      return picker?.selectedOptions[0]?.textContent?.includes('Build Server 2');
    });
    expect((await list(client.executorId)).terminals).toHaveLength(2);
    expect((await list(client.executorId)).terminals[1]?.initialWorkingDirectory).toBe(executionDirs.project);
    expect((await list('local')).terminals).toHaveLength(1);
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-controller-dials', projectRoots: 'separate', serverEnvironment: { GARCON_TERMINAL_SHELL: '/bin/sh' } });
}, 90_000);
