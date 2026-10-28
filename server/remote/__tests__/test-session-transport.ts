import { SessionTransport } from '../transport/session-transport.js';
import { protocolProfileId, type SessionProtocol } from '../transport/protocol-compatibility.js';
import type { MessageSessionOptions } from '../transport/message-session.js';
import type { RpcLane } from '../transport/rpc-lane.js';
import { WORKER_CONTRACTS } from '../server/worker-contracts.js';
import { WORKER_RPC_HANDLERS } from '../server/executor-rpc-server.js';
import { controllerContracts } from '../../controller/executors/controller-contracts.js';
import { CLI_GATEWAY_REGISTRATIONS } from '../server/cli-gateway.js';
import { registerRpcHandlers, type RpcHandler } from '../transport/rpc-registrations.js';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import type { ExecutorRpc } from '../transport/rpc.js';
import { WebSocketLink, type WebSocketLinkOptions } from '../transport/websocket-link.js';

const reverse = registerRpcHandlers([
  rpcWireV1('controllerCli.describe'), rpcWireV1('controllerCli.request'), rpcWireV1('credentials.resolve'),
], async (handler: RpcHandler, ...args) => handler(...args));
const controller = controllerContracts(reverse, CLI_GATEWAY_REGISTRATIONS.map(entry => ({ ...entry,
  side: 'handler' as const, dispatch: () => { throw new Error('Synthetic CLI route is not installed'); } })));

export function testRoleContracts(role: 'controller' | 'worker') {
  return role === 'controller' ? controller : WORKER_CONTRACTS;
}

export function handleTestRpc(rpc: ExecutorRpc, handle: RpcHandler): void {
  rpc.handle({ registration: rpc.transport.protocol.contracts.role === 'worker' ? WORKER_RPC_HANDLERS : reverse, handle });
}

export class TestWebSocketLink extends WebSocketLink {
  constructor(options: Omit<WebSocketLinkOptions, 'contracts'> & Partial<Pick<WebSocketLinkOptions, 'contracts'>>) {
    super({ ...options, contracts: options.contracts ?? testRoleContracts(options.role) });
  }
}

export function testSessionProtocol(executorId = 'local', role: 'controller' | 'worker' = 'controller'): SessionProtocol {
  const contracts = testRoleContracts(role);
  const profile = contracts.offer;
  return Object.freeze({ contracts, profile, continuity: Object.freeze({ executorId,
    controllerRuntimeId: 'synthetic-controller', workerRuntimeId: 'synthetic-worker', profileId: protocolProfileId(profile) }) });
}

export class WorkerSessionTransport extends SessionTransport {
  constructor(id: string, peerRuntimeId: string, retired: (error: Error) => void,
    limits: Pick<MessageSessionOptions, 'maxQueuedBytes' | 'maxQueuedFrames' | 'budget'> = {},
    executorId = 'local', lane: RpcLane = 'primary', primarySessionId = id,
    protocol = testSessionProtocol(executorId, 'worker')) {
    super(id, peerRuntimeId, protocol, retired, limits, executorId, lane, primarySessionId);
  }
}

export class TestSessionTransport extends SessionTransport {
  constructor(id: string, peerRuntimeId: string, retired: (error: Error) => void,
    limits: Pick<MessageSessionOptions, 'maxQueuedBytes' | 'maxQueuedFrames' | 'budget'> = {},
    executorId = 'local', lane: RpcLane = 'primary', primarySessionId = id,
    protocol = testSessionProtocol(executorId)) {
    super(id, peerRuntimeId, protocol, retired, limits, executorId, lane, primarySessionId);
  }
}
