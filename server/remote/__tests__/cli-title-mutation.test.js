import { expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GarconClient } from '../../../cli/garcon-client.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { ControllerCliDispatcher } from '../../controller/executors/cli-dispatcher.js';
import { wrapRoutes } from '../../controller/lib/http-route.js';
import { createWorkspaceFixture } from '../../controller/routes/__tests__/workspace-route-fixture.js';
import createWorkspaceRoutes from '../../controller/routes/workspace.js';
import { SettingsStore } from '../../controller/settings/store.js';
import { startCliGateway } from '../server/cli-gateway.js';
import { cliPair } from './cli-fixture.js';

test.each(['direct', 'gateway'])('title byte limits reject new writes before persistence (%s)', async (transport) => {
  const root = await fs.mkdtemp(join(homedir(), 'cli-title-limit-'));
  const cleanups = [() => fs.rm(root, { recursive: true, force: true })];
  try {
    const settings = new SettingsStore(root);
    await settings.init();
    const context = createWorkspaceFixture();
    context.settings.setSessionName.mockImplementation((...args) => settings.setSessionName(...args));
    const routes = createWorkspaceRoutes(context.settings, context.agents);
    let client;
    if (transport === 'direct') {
      const server = Bun.serve({ hostname: '0.0.0.0', port: 0,
        routes: wrapRoutes(routes, { localCapability: 'synthetic-capability', serverInstanceId: 'controller' }),
      });
      cleanups.push(() => server.stop(true));
      client = new GarconClient({ baseUrl: `http://127.0.0.1:${server.port}`, instanceId: 'controller',
        endpointInstanceId: 'controller', defaultExecutorId: 'local', workspaceName: null, workspaceDir: null,
        localCapability: 'synthetic-capability' });
    } else {
      const pair = cliPair(new ControllerCliDispatcher({ routes, serverInstanceId: 'controller',
        workspaceName: null, isShuttingDown: () => false }));
      cleanups.push(() => pair.close());
      const gateway = await startCliGateway({ dataDir: join(root, 'executor'), currentConnection: () => pair.connection });
      cleanups.push(() => gateway.dispose());
      client = new GarconClient(await discoverRuntime({ configDir: root, runtime: 'executor' }));
    }
    const chatId = '1785337200123456';
    const title = '\u{1f600}'.repeat(1024);
    await expect(client.updateChatTitle({ chatId, title })).resolves.toMatchObject({ title, changed: true });
    await expect(client.updateChatTitle({ chatId, title: `${title}x` })).rejects.toMatchObject({ status: 400, errorCode: 'VALIDATION_FAILED' });
    expect(context.settings.setSessionName).toHaveBeenCalledTimes(1);
    const reopened = new SettingsStore(root);
    await reopened.init();
    expect(reopened.getChatName(chatId)).toBe(title);

    const originalOpen = fs.open;
    const open = spyOn(fs, 'open').mockImplementation(async (target, flags, ...rest) => {
      if (target === root && flags === 'r') throw new Error('Synthetic post-rename sync failure');
      return originalOpen(target, flags, ...rest);
    });
    cleanups.push(() => open.mockRestore());
    await expect(client.updateChatTitle({ chatId, title: 'Committed without confirmation' }))
      .rejects.toThrow('mutation outcome is unknown');
    expect(context.settings.setSessionName).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await fs.readFile(join(root, 'project-settings.json'), 'utf8')).chatNames[chatId])
      .toBe('Committed without confirmation');
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});
