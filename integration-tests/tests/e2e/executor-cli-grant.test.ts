import { expect, test } from 'bun:test';
import { discoverRuntime } from '../../../cli/discovery.js';
import type { ExecutorSnapshot } from '../../../common/executors.js';
import { withE2eFixture } from '../../support/e2e-fixture.js';
import { SpaDriver } from '../../support/spa-driver.js';

test('executor editor grants and revokes workspace CLI access without replacing the worker', async () => {
  await withE2eFixture('execution-cli-grant', async (fixture) => {
    const executorId = fixture.integration.client.executorId;
    const snapshot = async () => (await fixture.integration.client.get<{ executors: ExecutorSnapshot[] }>('/api/v1/executors'))
      .executors.find((executor) => executor.id === executorId)!;
    const before = await snapshot();
    const discover = () => discoverRuntime({ configDir: fixture.integration.executionDirs.config, runtime: 'executor' });
    await expect(discover()).rejects.toThrow('HTTP 403');
    const app = new SpaDriver(fixture.page, fixture.integration);
    await app.open();
    await fixture.waitForSpaWebSocket();
    await app.clickButton('More actions');
    await app.waitForMenuItemEnabled('Server Settings');
    await app.clickMenuItem('Server Settings');
    await app.waitForButtonEnabled('Edit Integration worker');
    await app.clickButton('Edit Integration worker');
    const checkbox = 'input[aria-describedby="executor-cli-warning"]';
    await fixture.page.waitForSelector(checkbox);
    expect(await fixture.page.$eval(checkbox, (element) => (element as HTMLInputElement).checked)).toBe(false);
    await app.waitForText('including bypass execution');
    for (const enabled of [true, false]) {
      await fixture.page.$eval(checkbox, (element) => (element as HTMLInputElement).click());
      const saved = fixture.page.waitForResponse((response) => response.request().method() === 'PATCH'
        && new URL(response.url()).pathname === `/api/v1/executors/${executorId}`);
      await app.clickDialogButton('Save');
      expect((await saved).status()).toBe(200);
      await app.waitForButtonEnabled('Save');
      expect(await snapshot()).toMatchObject({ allowControllerCli: enabled, instanceId: before.instanceId, availability: 'ready' });
      if (enabled) expect(await discover()).toMatchObject({ defaultExecutorId: executorId });
      else await expect(discover()).rejects.toThrow('HTTP 403');
    }
    fixture.assertNoBrowserErrors();
  }, { executionBackend: 'remote-executor-dials', projectRoots: 'separate' });
}, 60_000);
