import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAgentResourceRef, type ExecutionRuntimeApi } from '@garcon/server-agent-interface';
import { HISTORY_READER_V1 } from '@garcon/common/executor-contracts';
import { ExecutionRuntime } from '../../runtime/execution-runtime.js';
import { FILES_RPC_CLIENTS } from '../client/remote-files.js';
import { GIT_RPC_CLIENTS } from '../client/remote-git.js';
import { TERMINAL_RPC_CLIENTS } from '../client/remote-terminals.js';
import { INTEGRATION_RPC_CLIENTS } from '../client/remote-agent-integration.js';
import { EXECUTOR_RPC_CLIENTS } from '../client/executor-client.js';
import { PROJECT_RPC_CLIENTS } from '../client/executor-generation.js';
import { TRANSPORT_RPC_CLIENTS, TRANSPORT_RPC_HANDLERS } from '../transport/rpc.js';
import { createRoleContracts } from '../transport/rpc-registrations.js';
import { ProducerRelay } from '../server/producer-relay.js';
import { RpcReplyJournal } from '../transport/rpc-journal.js';
import { TestWebSocketLink } from './test-session-transport.js';
import { connectRemoteExecutor, servePairedRuntime } from './runtime-adapter.js';
import { integrationFixture, linkOptions } from './integration-fixture.js';

const executorId = '22222222-2222-4222-8222-222222222222';
const independentProviderMethods = new Set([
  'lifecycle.migrateOwnedStorage', 'lifecycle.start', 'lifecycle.stop',
  'catalog.snapshot', 'singleQuery.run', 'history.open', 'history.next', 'history.close',
]);

for (const dialer of ['controller', 'worker'] as const) {
  test.each(['lifecycle', 'execution'] as const)(`host services publish without %s support with ${dialer} dialing`, async missing => {
    const root = await mkdtemp(join(homedir(), 'tmp', 'garcon-partial-support-'));
    const provider = integrationFixture(root, executorId);
    provider.hooks.initialize = async () => { throw new Error('Unsupported provider must not initialize'); };
    const host = new ExecutionRuntime({ id: executorId, instanceId: provider.scope.instanceId,
      workspaceDir: root, projectBasePath: root, integrations: [], resolveCredential: async () => null });
    const runtime = { ...provider.executor,
      getInfo: async () => ({ ...await host.getInfo(), integrationIds: ['test'] }),
      getFilesService: () => host.getFilesService(), getGitService: () => host.getGitService(),
      getGhService: () => host.getGhService(), getTerminalService: () => host.getTerminalService(),
    } satisfies ExecutionRuntimeApi;
    const contracts = createRoleContracts('controller', {
      clients: [...TRANSPORT_RPC_CLIENTS, ...EXECUTOR_RPC_CLIENTS, ...PROJECT_RPC_CLIENTS,
        ...FILES_RPC_CLIENTS.filter(wire => wire.definition.name !== 'files.read'),
        ...GIT_RPC_CLIENTS, ...TERMINAL_RPC_CLIENTS,
        ...INTEGRATION_RPC_CLIENTS.filter(wire => missing === 'lifecycle'
          ? !wire.definition.name.startsWith('lifecycle.')
          : independentProviderMethods.has(wire.definition.name))],
      handlers: [TRANSPORT_RPC_HANDLERS], resources: [HISTORY_READER_V1], cli: [],
    });
    const controller = new TestWebSocketLink({ ...linkOptions, executorId, role: 'controller', contracts });
    const worker = new TestWebSocketLink({ ...linkOptions, executorId, role: 'worker' });
    const relay = new ProducerRelay();
    const journal = new RpcReplyJournal();
    const scopes: ReturnType<typeof servePairedRuntime>[] = [];
    worker.onSession(transport => scopes.push(servePairedRuntime(worker, transport, runtime, relay, journal)));
    const connected = connectRemoteExecutor(controller);
    if (dialer === 'controller') controller.dial(worker.listen());
    else worker.dial(controller.listen());
    try {
      const client = await connected;
      expect(client.availability).toBe('ready');
      expect(provider.calls.migrate).toBe(0);
      expect(provider.calls.initialize).toBe(0);
      const integration = await client.runtime.getAgentIntegration('test');
      await expect(integration.catalog.snapshot({ strict: false, signal: new AbortController().signal }))
        .rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
      const binding = createAgentResourceRef(integration.producers.scope, 'producer', 'synthetic-binding');
      await expect(integration.producers.bind({ binding, chatId: '1783725900000400' }))
        .rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED', outcome: 'not-dispatched' });
      expect(provider.nativePublishers).toHaveLength(0);

      await writeFile(join(root, 'synthetic.txt'), 'Synthetic file');
      const files = await client.runtime.getFilesService();
      expect((await files.list({ projectPath: root })).files).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'synthetic.txt' }),
      ]));
      await expect(files.read({ projectPath: root, filePath: 'synthetic.txt' }))
        .rejects.toMatchObject({ code: 'OPERATION_UNSUPPORTED' });
      const git = await client.runtime.getGitService();
      expect(await git.getQuickSummary({ projectPath: root })).toMatchObject({ status: 'not-git-repository' });
      const terminals = await client.runtime.getTerminalService();
      expect(await terminals.list({ key: 'synthetic-user', expiresAtMs: null })).toMatchObject({ terminals: [] });
      expect(client.availability).toBe('ready');
      expect(controller.current?.channel.connected).toBe(true);
    } finally {
      await controller.dispose(); await worker.dispose();
      for (const scope of scopes) await scope.dispose();
      relay.dispose(); journal.dispose();
      await host.dispose(); await provider.executor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
}
