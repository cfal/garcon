import { expect, spyOn, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs } from '../../../cli/args.js';
import { discoverRuntime } from '../../../cli/discovery.js';
import { runExecutorCommand } from '../../../cli/executor-commands.js';
import { GarconClient } from '../../../cli/garcon-client.js';
import { createCliOutput } from '../../../cli/output.js';
import { ControllerCliDispatcher } from '../../controller/executors/cli-dispatcher.js';
import { ExecutorManager } from '../../controller/executors/manager.js';
import { wrapRoutes } from '../../controller/lib/http-route.js';
import { createExecutorRoutes } from '../../controller/routes/executors.js';
import { startCliGateway } from '../server/cli-gateway.js';
import { cliPair } from './cli-fixture.js';

test.each(['direct', 'gateway'] as const)('executor creation reports a post-rename failure as unknown without resubmission (%s)', async (transport) => {
  const root = await fs.mkdtemp(join(homedir(), 'executor-cli-mutation-'));
  const cleanups: (() => unknown | Promise<unknown>)[] = [() => fs.rm(root, { recursive: true, force: true })];
  try {
    const manager = await ExecutorManager.create({
      id: 'local', workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null,
    });
    cleanups.push(() => manager.dispose());
    const routes = createExecutorRoutes(manager);
    let client: GarconClient;
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
    const originalOpen = fs.open;
    const open = spyOn(fs, 'open').mockImplementation(async (target, flags, ...rest) => {
      if (target === root && flags === 'r') throw new Error('Synthetic directory sync failure');
      return originalOpen(target, flags, ...rest);
    });
    cleanups.push(() => open.mockRestore());
    const create = spyOn(manager.config, 'create');
    cleanups.push(() => create.mockRestore());
    let stdout = '';
    const output = createCliOutput({ write(text) { stdout += text; } }, { write() {} });
    const command = parseCliArgs(['executor', 'create', '--label', 'Synthetic worker', '--direction', 'executor-connects',
      '--advertise-url', 'wss://controller.test/executor/{executorId}']);
    if (command.kind !== 'executor') throw new Error('Expected executor command');
    const error = await runExecutorCommand(command, client, output).catch((failure: unknown) => failure);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.config.list()).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(join(root, 'executors.json'), 'utf8')).executors).toHaveLength(1);
    expect(stdout).toBe('');
    expect(error).toMatchObject({ phase: 'executors', message: expect.stringContaining('outcome is unknown') });
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
});
