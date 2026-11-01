import { expect, test } from 'bun:test';
import { AgentCallError } from '@garcon/server-agent-interface';
import { TestSessionTransport, WorkerSessionTransport, testSessionProtocol } from './test-session-transport.js';
import { createRoleContracts, registerRpcHandlers } from '../transport/rpc-registrations.js';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { protocolProfileId } from '../transport/protocol-compatibility.js';
import { ExecutorRpc } from '../transport/rpc.js';
import { RemoteTerminalService } from '../client/remote-terminals.js';
import { TerminalController, terminalOperationError } from '../../controller/terminals/controller.js';
import createTerminalRoutes from '../../controller/routes/terminals.js';
import { LOCAL_SERVER_PRINCIPAL } from '../../controller/lib/http-route-types.js';

test('HTTP refuses a missing terminal leaf without disabling supported inventory', async () => {
  const terminalRuntimeId = crypto.randomUUID();
  const inventory = { success: true, terminalRuntimeId, attachmentEpoch: 'synthetic-epoch', terminals: [] };
  const wires = [rpcWireV1('terminals.list')];
  const handlers = registerRpcHandlers(wires, async () => inventory);
  const controllerContracts = createRoleContracts('controller', { clients: wires, handlers: [], resources: [], cli: [] });
  const workerContracts = createRoleContracts('worker', { clients: [], handlers: [handlers], resources: [], cli: [] });
  const protocol = role => {
    const contracts = role === 'controller' ? controllerContracts : workerContracts;
    const base = testSessionProtocol('local', role);
    return { ...base, contracts, profile: contracts.offer,
      continuity: { ...base.continuity, profileId: protocolProfileId(contracts.offer) } };
  };
  const left = new TestSessionTransport('session', 'worker', () => {}, {}, 'local', 'primary', 'session', protocol('controller'));
  const right = new WorkerSessionTransport('session', 'controller', () => {}, {}, 'local', 'primary', 'session', protocol('worker'));
  const sent = [];
  const leftSocket = left.attach({ send(body) { sent.push(JSON.parse(body)); queueMicrotask(() => rightSocket.receive(body)); }, close() {} });
  const rightSocket = right.attach({ send(body) { queueMicrotask(() => leftSocket.receive(body)); }, close() {} });
  const rpc = new ExecutorRpc(left);
  new ExecutorRpc(right).handle(handlers.bind(null));
  const service = new RemoteTerminalService({
    call: (...args) => rpc.call(...args),
    acquire: async () => ({ backing: { rpc, info: { executorId: 'local' } } }),
  });
  const controller = new TerminalController({ requireExecutor: () => ({ getTerminalService: async () => service }) });
  const routes = createTerminalRoutes(controller)['/api/v1/terminals'];
  const context = { principal: LOCAL_SERVER_PRINCIPAL };
  try {
    const url = new URL('http://localhost/api/v1/terminals?executorId=local');
    const refused = await routes.PATCH(new Request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: `local/${terminalRuntimeId}/${crypto.randomUUID()}`, title: 'Synthetic title' }),
    }), url, undefined, context);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ errorCode: 'terminal-unsupported', retryable: false });
    expect(sent).toEqual([]);
    const listed = await routes.GET(new Request(url), url, undefined, context);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(inventory);
    expect(sent.map(frame => frame.method)).toEqual(['terminals.list']);
  } finally { controller.shutdown(); left.close(); right.close(); }
});

test('an uncertain terminal failure never becomes definite unsupported', () => {
  expect(terminalOperationError(new AgentCallError('unknown', 'Lost reply', 'OPERATION_UNSUPPORTED')))
    .toMatchObject({ code: 'terminal-outcome-unknown', status: 503 });
});
