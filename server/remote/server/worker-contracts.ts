import { HISTORY_READER_V1 } from '@garcon/common/executor-contracts';
import { createRoleContracts } from '../transport/rpc-registrations.js';
import { rpcWireV1 } from '../transport/rpc-wire-v1.js';
import { TRANSPORT_RPC_CLIENTS, TRANSPORT_RPC_HANDLERS } from '../transport/rpc.js';
import { WORKER_RPC_HANDLERS } from './executor-rpc-server.js';
import { CLI_GATEWAY_REGISTRATIONS, CLI_GATEWAY_RPC_CLIENTS } from './cli-gateway.js';

export const WORKER_CONTRACTS = createRoleContracts('worker', {
  clients: [...TRANSPORT_RPC_CLIENTS, ...CLI_GATEWAY_RPC_CLIENTS, rpcWireV1('credentials.resolve')],
  handlers: [TRANSPORT_RPC_HANDLERS, WORKER_RPC_HANDLERS], resources: [HISTORY_READER_V1], cli: CLI_GATEWAY_REGISTRATIONS,
});
