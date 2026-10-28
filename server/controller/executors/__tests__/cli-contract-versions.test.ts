import { expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_CONTRACT_HEADER, CLI_OPERATIONS } from '@garcon/common/cli-contracts';
import { CLI_SERVER_INSTANCE_HEADER } from '@garcon/common/server-runtime';
import { intersectContracts, type ContractRef } from '@garcon/common/protocol-contracts';
import { DomainError } from '../../../common/domain-error.js';
import { ControllerCliDispatcher } from '../cli-dispatcher.js';
import { CliRouteContracts, type CliRouteRegistration } from '../../lib/cli-contracts.js';
import { wrapRoutes } from '../../lib/http-route.js';
import { cliWireV1, type ControllerCliRequest, type CliRegistration } from '../../../remote/transport/cli-protocol.js';
import { CLI_GATEWAY_REGISTRATIONS, startCliGateway } from '../../../remote/server/cli-gateway.js';
import { createRoleContracts, registerRpcHandlers } from '../../../remote/transport/rpc-registrations.js';
import { rpcWireV1 } from '../../../remote/transport/rpc-wire-v1.js';
import { ExecutorRpc } from '../../../remote/transport/rpc.js';
import { RpcReplyJournal } from '../../../remote/transport/rpc-journal.js';
import { SessionTransport } from '../../../remote/transport/session-transport.js';
import { protocolProfileId } from '../../../remote/transport/protocol-compatibility.js';
import type { RpcLane } from '../../../remote/transport/rpc-lane.js';
import type { Failure } from '../../../remote/transport/rpc-failure.js';
import type { ExecutorRpcConnection } from '../../../remote/transport/rpc-connection.js';

const operation = 'GET /api/v1/chats';
const v1 = cliWireV1(operation);
const definition2 = Object.freeze({ ...v1.definition, version: 2, lane: 'primary' as const });
const v2 = Object.freeze({ ...v1, definition: definition2, policy: () => definition2,
  validateRequest(http: ControllerCliRequest['http']) {
    v1.validateRequest(http);
    if (!http.query.some(([key, value]) => key === 'shape' && value === 'second')) {
      throw new DomainError('VALIDATION_FAILED', 'Synthetic v2 selector is required', 400);
    }
  },
});

function fixture(advertised: readonly number[] = [1, 2]) {
  const effects: number[] = [];
  const entries: readonly CliRouteRegistration[] = [v1, v2].map(wire => ({ ...wire, side: 'handler',
    dispatch(request, url) {
      wire.validateRequest({ operation, body: null, query: [...url.searchParams] });
      effects.push(wire.definition.version);
      return Response.json({ version: wire.definition.version, payload: url.searchParams.has('large') ? 'x'.repeat(70_000) : 'synthetic' });
    },
  }));
  const routes = { '/api/v1/chats': { GET: entries[0]!.dispatch } };
  const contracts = new CliRouteContracts(entries);
  const dispatcher = new ControllerCliDispatcher({ routes, contracts, serverInstanceId: 'synthetic-controller',
    workspaceName: null, isShuttingDown: () => false });
  const handler = registerRpcHandlers([rpcWireV1('controllerCli.describe'), rpcWireV1('controllerCli.request')],
    async (rpc: ExecutorRpc, call, signal, guard, _undelivered, capture) => {
      const access = { executorId: 'local', rpc, signal, assertCurrent() {}, assertManagement() {} };
      return call.method === 'controllerCli.describe' ? dispatcher.describe(access, guard)
        : dispatcher.request(call.request, access, guard, capture.policy.cli);
    });
  const forward = CLI_GATEWAY_REGISTRATIONS.find(entry => entry.operation === operation)!.dispatch;
  const forwarding: readonly CliRegistration[] = [v1, v2].map(wire => ({ ...wire, side: 'forwarder', dispatch: forward }));
  const controller = createRoleContracts('controller', { clients: [], handlers: [handler], resources: [], cli: contracts.entries });
  const worker = createRoleContracts('worker', { clients: [rpcWireV1('controllerCli.describe'), rpcWireV1('controllerCli.request')],
    handlers: [], resources: [], cli: forwarding });
  const profile = { bootstrap: 1, contracts: { ...intersectContracts(controller.offer.contracts, worker.offer.contracts),
    [v1.definition.name]: advertised } };
  const continuity = { executorId: 'local', controllerRuntimeId: 'synthetic-controller', workerRuntimeId: 'synthetic-worker',
    profileId: protocolProfileId(profile) };
  const journal = new RpcReplyJournal();
  const received = spyOn(journal, 'received');
  const parent = crypto.randomUUID();
  const pendingReplies = new Map<string, (failure: Failure) => void>();
  const requests: { version: number; request: ControllerCliRequest }[] = [];
  let sequence = 0;
  function lanePair(lane: RpcLane) {
    const id = lane === 'primary' ? parent : crypto.randomUUID();
    const left = new SessionTransport(id, 'synthetic-worker', { profile, continuity, contracts: controller }, () => {}, {}, 'local', lane, parent);
    const right = new SessionTransport(id, 'synthetic-controller', { profile, continuity, contracts: worker }, () => {}, {}, 'local', lane, parent);
    const a = left.attach({ send(payload) {
      const frame = JSON.parse(payload);
      pendingReplies.get(frame.id)?.(frame.error);
      b.receive(payload);
    }, close() {} });
    const b = right.attach({ send(payload) {
      const frame = JSON.parse(payload);
      if (frame.type === 'request' && frame.method === 'controllerCli.request') requests.push(frame);
      a.receive(payload);
    }, close() {} });
    const receiver = new ExecutorRpc(left, { journal });
    receiver.handle(handler.bind(receiver));
    const sender = new ExecutorRpc(right);
    return { sender, receiver,
      inject(request: ControllerCliRequest): Promise<Failure> {
        const id = crypto.randomUUID();
        const result = Promise.withResolvers<Failure>();
        pendingReplies.set(id, result.resolve);
        a.receive(JSON.stringify({ type: 'request', id, integrationId: '', seq: ++sequence,
          method: 'controllerCli.request', version: 1, request }));
        return result.promise.finally(() => pendingReplies.delete(id));
      },
      close() { left.close(); right.close(); } };
  }
  const primary = lanePair('primary');
  const bulk = lanePair('bulk');
  const connection = { primary: primary.sender,
    async acquire(lane, options) { return { rpc: lane === 'primary' ? primary.sender : bulk.sender, timeoutMs: options.timeoutMs }; },
  } satisfies Pick<ExecutorRpcConnection, 'primary' | 'acquire'>;
  const direct = wrapRoutes(routes, { localCapability: 'synthetic-capability', serverInstanceId: 'synthetic-controller', cliContracts: contracts });
  return { primary, bulk, connection, direct, effects, requests, received,
    close() { primary.close(); bulk.close(); journal.dispose(); received.mockRestore(); } };
}

function forwarded(contract: ContractRef, expectedServerInstanceId = 'synthetic-controller'): ControllerCliRequest {
  return { contract: { name: contract.name, version: contract.version }, expectedServerInstanceId,
    http: { operation, body: null, query: [['shape', 'second']] } };
}

test('direct HTTP and one gateway dispatch concurrent nested versions through the same outer contract', async () => {
  const harness = fixture();
  const scratch = join(homedir(), 'tmp');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'cli-contract-versions-'));
  const gateway = await startCliGateway({ dataDir: root, currentConnection: () => harness.connection });
  try {
    for (const version of [1, 2]) {
      const headers = { Authorization: 'Bearer synthetic-capability', [CLI_CONTRACT_HEADER]: `${v1.definition.name}@${version}`,
        [CLI_SERVER_INSTANCE_HEADER]: 'synthetic-controller' };
      const response = await harness.direct['/api/v1/chats']!.GET!(new Request('http://localhost/api/v1/chats?shape=second', { headers }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ version, payload: 'synthetic' });
    }
    const request = (version: number, suffix = '') => fetch(`${gateway.descriptor.baseUrl}/api/v1/chats?shape=second${suffix}`, {
      headers: { Authorization: `Bearer ${gateway.descriptor.localCapability}`, [CLI_CONTRACT_HEADER]: `${v1.definition.name}@${version}`,
        [CLI_SERVER_INSTANCE_HEADER]: 'synthetic-controller' },
    });
    const replies = await Promise.all([request(1), request(2)]);
    for (const [index, reply] of replies.entries()) {
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual({ version: index + 1, payload: 'synthetic' });
    }
    expect(harness.requests.map(call => [call.version, call.request.contract.version]).sort()).toEqual([[1, 1], [1, 2]]);
    expect((await request(1, '&large=1')).status).toBe(200);
    const oversized = await request(2, '&large=1');
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ errorCode: 'CLI_RESULT_TOO_LARGE' });
    const context = await fetch(`${gateway.descriptor.baseUrl}/api/v1/cli/context`, { headers: {
      Authorization: `Bearer ${gateway.descriptor.localCapability}`,
    } });
    expect((await context.json()).protocol.contracts).toEqual({ [v1.definition.name]: [1, 2] });
  } finally { await gateway.dispose(); harness.close(); await rm(root, { recursive: true, force: true }); }
});

test('nested lookup and transport validation precede receipt; controller identity precedes profile support', async () => {
  const harness = fixture([1]);
  try {
    expect(await harness.primary.inject(forwarded({ ...definition2, version: 3 }, 'old-controller')))
      .toMatchObject({ code: 'OPERATION_UNSUPPORTED', status: 422 });
    expect(harness.received).not.toHaveBeenCalled();
    expect(await harness.bulk.inject(forwarded(definition2, 'old-controller')))
      .toMatchObject({ code: 'UNAVAILABLE', outcome: 'not-dispatched' });
    expect(harness.received).not.toHaveBeenCalled();
    const invalid = forwarded(definition2, 'old-controller');
    expect(await harness.primary.inject({ ...invalid, http: { ...invalid.http, query: [] } }))
      .toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect(harness.received).not.toHaveBeenCalled();
    const oversized = { ...invalid, http: { ...invalid.http, query: [...invalid.http.query,
      ...Array.from({ length: 10 }, () => ['padding', 'x'.repeat(8192)] as const)] } };
    expect(await harness.primary.inject(oversized)).toMatchObject({ code: 'CLI_REQUEST_TOO_LARGE', status: 413 });
    expect(harness.received).not.toHaveBeenCalled();
    expect(await harness.primary.inject(forwarded(definition2, 'old-controller')))
      .toMatchObject({ code: 'CLI_CONTROLLER_CHANGED', status: 409 });
    expect(harness.received).toHaveBeenCalledTimes(1);
    expect(await harness.primary.inject(forwarded(definition2)))
      .toMatchObject({ code: 'OPERATION_UNSUPPORTED', status: 422 });
    expect(harness.received).toHaveBeenCalledTimes(2);
    expect(harness.effects).toEqual([]);
    expect(harness.primary.sender.active && harness.bulk.sender.active).toBe(true);
  } finally { harness.close(); }
});

test('CLI advertisements require the role implementation and forwarding envelope', () => {
  const wire = cliWireV1(operation);
  expect(() => createRoleContracts('worker', { clients: [], handlers: [], resources: [],
    cli: [{ ...wire, side: 'handler', dispatch: () => Response.json(null) }] })).toThrow('Invalid CLI implementation');
  expect(() => createRoleContracts('worker', { clients: [], handlers: [], resources: [],
    cli: [CLI_GATEWAY_REGISTRATIONS.find(entry => entry.operation === operation)!] })).toThrow('forwarding envelope implementation');
  expect(CLI_OPERATIONS[operation][1].version).toBe(1);
});
