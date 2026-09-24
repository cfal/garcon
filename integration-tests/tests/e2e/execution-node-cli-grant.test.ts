import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { discoverRuntime } from '../../../cli/discovery.js';
import type { ExecutionNodeSnapshot } from '../../../common/execution-nodes.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('node editor grants and revokes workspace CLI access without replacing the worker', async () => {
  await withE2eFixture('execution-cli-grant', async (fixture) => {
    const nodeId = fixture.integration.client.nodeId;
    const snapshot = async () => (await fixture.integration.client.get<{ nodes: ExecutionNodeSnapshot[] }>('/api/v1/execution-nodes'))
      .nodes.find((node) => node.id === nodeId)!;
    const before = await snapshot();
    const directory = join(fixture.integration.executionDirs.workspace, 'run');
    const filename = (await readdir(directory)).find((name) => name.startsWith('cli-') && name.endsWith('.json'))!;
    const discover = () => discoverRuntime({ runtimeFile: join(directory, filename), configDir: '/missing', workspace: 'unused' });
    await expect(discover()).rejects.toThrow('HTTP 403');
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForButtonEnabled('Edit Integration worker');
    await app.clickButton('Edit Integration worker');
    const checkbox = 'input[aria-describedby="execution-node-cli-warning"]';
    await fixture.page.waitForSelector(checkbox);
    expect(await fixture.page.$eval(checkbox, (element) => (element as HTMLInputElement).checked)).toBe(false);
    await app.waitForText('including bypass execution');
    for (const enabled of [true, false]) {
      await fixture.page.$eval(checkbox, (element) => (element as HTMLInputElement).click());
      const saved = fixture.page.waitForResponse((response) => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === `/api/v1/execution-nodes/${nodeId}`);
      await app.clickDialogButton('Save');
      expect((await saved).status()).toBe(200);
      await app.waitForButtonEnabled('Save');
      expect(await snapshot()).toMatchObject({ allowControllerCli: enabled, instanceId: before.instanceId, availability: 'ready' });
      if (enabled) expect(await discover()).toMatchObject({ defaultNodeId: nodeId });
      else await expect(discover()).rejects.toThrow('HTTP 403');
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-node-dials', projectRoots: 'separate' });
}, 60_000);
