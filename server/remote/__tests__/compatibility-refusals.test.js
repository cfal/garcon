import { expect, test } from 'bun:test';
import { TERMINAL_ATTACHMENT_V1 } from '../../../common/executor-contracts.js';
import { refused, refusedTerminals } from '../../../integration-tests/support/compatibility-workflows.js';
import { GarconTestClient } from '../../../integration-tests/support/garcon-client.js';
import { TestSessionTransport, WorkerSessionTransport, testSessionProtocol } from './test-session-transport.js';
import { createRoleContracts, registerRpcHandlers } from '../transport/rpc-registrations.js';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { protocolProfileId } from '../transport/protocol-compatibility.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { RemoteFilesService } from '../client/remote-files.js';
import { RemoteGitServices } from '../client/remote-git.js';
import { RemoteTerminalService } from '../client/remote-terminals.js';
import { RemoteAgentIntegration } from '../client/remote-agent-integration.js';
import { NULLABLE_AGENT_FACETS } from '../transport/rpc-protocol.js';
import { integrationFixture } from './integration-fixture.js';
import { IntegrationRegistry } from '../../runtime/agents/integration-registry.js';
import { AgentDirectory } from '../../controller/agents/directory.js';
import { AgentCatalogService } from '../../controller/agents/catalog-service.js';
import { ModelCatalogResponseCache } from '../../controller/agents/model-catalog-cache.js';
import { TerminalController } from '../../controller/terminals/controller.js';
import { TerminalStreamHandler } from '../../controller/ws/terminal-stream.js';
import createFilesRoutes from '../../controller/routes/files.js';
import createGitRoutes from '../../controller/routes/git.js';
import createModelsRoutes from '../../controller/routes/models.js';
import createTerminalRoutes from '../../controller/routes/terminals.js';
import { LOCAL_SERVER_PRINCIPAL } from '../../controller/lib/http-route-types.js';

async function fixture(missing = []) {
  const excluded = new Set(missing);
  if (excluded.has('terminals.terminate')) excluded.add('terminals.create');
  if (excluded.has('terminals.detach')) excluded.add('terminals.attach');
  const methods = ['terminals.list', 'terminals.create', 'terminals.terminate', 'terminals.attach', 'terminals.input', 'terminals.detach'];
  const wires = methods.filter(name => !excluded.has(name)).map(rpcWireV1);
  const effects = [];
  const terminalRuntimeId = crypto.randomUUID();
  let terminal = null;
  let workerRpc;
  const handlers = registerRpcHandlers(wires, async (_context, call) => {
    effects.push(call.method);
    switch (call.method) {
      case 'terminals.list': return { success: true, terminalRuntimeId, attachmentEpoch: 'synthetic-epoch', terminals: terminal ? [terminal] : [] };
      case 'terminals.create':
        terminal = { terminalId: `local/${terminalRuntimeId}/${crypto.randomUUID()}`, displaySequence: 1, title: null,
          initialWorkingDirectory: '/synthetic', processStatus: 'running', attachmentStatus: 'detached',
          createdAt: '2026-01-01T00:00:00.000Z', exitCode: null, latestOutputSequence: 0 };
        return { success: true, terminal };
      case 'terminals.terminate':
        terminal = null;
        return { success: true, terminalId: call.request.terminalId, terminal: null };
      case 'terminals.attach':
        workerRpc.publishTerminal({ type: 'terminal', attachmentId: call.request.attachmentId,
          message: { type: 'terminal-attached', terminal: { ...terminal, attachmentStatus: 'attached' }, replay: [] } });
        return null;
      default: throw new Error(`Unexpected effect: ${call.method}`);
    }
  });
  const contracts = {
    controller: createRoleContracts('controller', { clients: wires, handlers: [], resources: [TERMINAL_ATTACHMENT_V1], cli: [] }),
    worker: createRoleContracts('worker', { clients: [], handlers: [handlers], resources: [TERMINAL_ATTACHMENT_V1], cli: [] }),
  };
  const protocol = role => {
    const base = testSessionProtocol('local', role);
    return { ...base, contracts: contracts[role], profile: contracts[role].offer,
      continuity: { ...base.continuity, profileId: protocolProfileId(contracts[role].offer) } };
  };
  const left = new TestSessionTransport('session', 'worker', () => {}, {}, 'local', 'primary', 'session', protocol('controller'));
  const right = new WorkerSessionTransport('session', 'controller', () => {}, {}, 'local', 'primary', 'session', protocol('worker'));
  const leftSocket = left.attach({ send(body) { queueMicrotask(() => rightSocket.receive(body)); }, close() {} });
  const rightSocket = right.attach({ send(body) { queueMicrotask(() => leftSocket.receive(body)); }, close() {} });
  const rpc = new ExecutorRpc(left);
  workerRpc = new ExecutorRpc(right);
  workerRpc.handle(handlers.bind(null));
  workerRpc.onTerminalDetach(async () => {});
  const backing = { rpc, info: { executorId: 'local', services: { git: true } } };
  const sessions = { call: (...args) => rpc.call(...args), acquire: async () => ({ backing }), latest: () => backing };
  const files = new RemoteFilesService(sessions);
  const git = new RemoteGitServices(sessions);
  const terminals = new RemoteTerminalService(sessions);
  const { integration, scope } = integrationFixture('/synthetic', 'local');
  const remote = new RemoteAgentIntegration({
    descriptor: integration.descriptor, scope, attachments: integration.attachments,
    settings: { descriptors: integration.settings.describe(), defaults: integration.settings.defaults() },
    capabilities: Object.fromEntries(NULLABLE_AGENT_FACETS.map(key => [key, integration[key] !== null])),
    literalExecution: null, singleQueryRunsToolsWithoutPermission: false,
    authMethods: { launchLogin: false, completeLogin: false, loginStatus: false },
  }, sessions);
  await remote.initialize(backing, () => {});
  const catalog = new AgentCatalogService({
    directory: new AgentDirectory(new IntegrationRegistry({ instances: [remote] })),
    endpointResolver: { getModelOptions: () => [] },
  });
  rpc.onTerminal(frame => terminals.receive(frame, rpc));
  const controller = new TerminalController({ requireExecutor: () => ({ getTerminalService: async () => terminals }) });
  const stream = new TerminalStreamHandler(controller);
  const routes = {
    ...createFilesRoutes({ getChat: () => null }, { files: async () => files,
      inspectProject: async path => ({ kind: 'available', effectiveProjectKey: path }) }),
    ...createGitRoutes({}, {}, async () => git.git),
    ...createModelsRoutes({ modelCatalog: { agents: { captureCatalog: executorId => catalog.capture(executorId) },
      apiProviders: { getCatalog: () => [] } }, responseCache: new ModelCatalogResponseCache() }),
    ...createTerminalRoutes(controller),
  };
  const server = Bun.serve({
    hostname: '0.0.0.0', port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/ws' && server.upgrade(request, { data: { connectionId: crypto.randomUUID(), principal: LOCAL_SERVER_PRINCIPAL } })) return;
      return routes[url.pathname]?.[request.method]?.(request, url, undefined, { principal: LOCAL_SERVER_PRINCIPAL }) ?? new Response(null, { status: 404 });
    },
    websocket: { open: socket => stream.open(socket), close: socket => stream.close(socket), drain: socket => stream.drain(socket),
      message: (socket, data) => stream.message(socket, JSON.parse(String(data))) },
  });
  const client = await GarconTestClient.connect(`http://127.0.0.1:${server.port}`);
  return { client, effects, async dispose() { await client.disconnect(); controller.shutdown(); left.close(); right.close(); await server.stop(true); } };
}

test('compatibility Files, Git and catalog probes retain their nonretryable HTTP 501 refusal', async () => {
  const { client, effects, dispose } = await fixture();
  try {
    const query = new URLSearchParams({ executorId: 'local', projectPath: '/synthetic', path: 'synthetic.txt' });
    const actions = [
      () => client.get(`/api/v1/files/text?${query}`),
      () => client.put(`/api/v1/files/text?${query}`, { content: 'Synthetic replacement\n', expectedRevision: 'v1:synthetic-revision', conflictResolution: 'overwrite' }),
      () => client.get(`/api/v1/files/list?${query}`),
      () => client.post('/api/v1/files/directories?executorId=local&path=/synthetic', { name: 'synthetic-directory' }),
      () => client.post('/api/v1/git/quick-summary', { executorId: 'local', project: '/synthetic' }),
      () => client.post('/api/v1/git/workbench/snapshot', { executorId: 'local', project: '/synthetic', mode: 'working', context: 3 }),
      () => client.get('/api/v1/models?executorId=local'),
    ];
    for (const action of actions) await refused(action, 501);
    await refused(() => client.get('/api/v1/models?executorId=local&agent=test'), 501);
    expect(effects).toEqual([]);
    expect((await client.get('/api/v1/terminals?executorId=local')).terminals).toEqual([]);
    expect(effects).toEqual(['terminals.list']);
  } finally { await dispose(); }
});

for (const missing of ['terminals.list', 'terminals.create', 'terminals.terminate', 'terminals.attach', 'terminals.detach', 'terminals.input']) {
  test(`compatibility terminal refusal probe exercises missing ${missing}`, async () => {
    const { client, effects, dispose } = await fixture([missing]);
    try {
      await refusedTerminals(client, 'local', '/synthetic', [{ surface: 'executor', name: missing }]);
      expect(effects).not.toContain(missing);
      const creates = effects.filter(name => name === 'terminals.create').length;
      const terminates = effects.filter(name => name === 'terminals.terminate').length;
      expect(creates).toBe(['terminals.attach', 'terminals.detach', 'terminals.input'].includes(missing) ? 1 : 0);
      expect(terminates).toBe(creates);
      if (missing === 'terminals.input') expect(effects).toContain('terminals.attach');
      else expect(effects).not.toContain('terminals.attach');
    } finally { await dispose(); }
  });
}
