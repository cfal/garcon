import { RPC_V1 } from '@garcon/common/executor-contracts';
import { decodeFailure } from './rpc-failure.js';
import { parseRpcRequestV1, parseRpcResultV1 } from './rpc-values-v1.js';
import { PRODUCER_BINDING_CODEC_V1 } from './producer-protocol.js';
import { TERMINAL_ATTACHMENT_CODEC_V1 } from './terminal-protocol.js';
import type { RpcWire, RoleContracts } from './rpc-registrations.js';
import { rpcPolicyV1 } from './rpc-routing.js';
import type { RpcLane } from './rpc-lane.js';

export function rpcWireV1<const K extends keyof typeof RPC_V1>(name: K): RpcWire<(typeof RPC_V1)[K]>;
export function rpcWireV1(name: keyof typeof RPC_V1): RpcWire {
  return Object.freeze({ definition: RPC_V1[name], request: (value: unknown) => parseRpcRequestV1(name, value),
    result: (value: unknown) => parseRpcResultV1(name, value), failure: decodeFailure,
    policy: (request: unknown, lane: RpcLane, contracts: RoleContracts) => rpcPolicyV1(RPC_V1[name], request, lane, contracts.cliRegistration),
    ...(name === 'producers.bind' ? { producer: PRODUCER_BINDING_CODEC_V1 } : {}),
    ...(name === 'terminals.attach' ? { terminal: TERMINAL_ATTACHMENT_CODEC_V1 } : {}),
  });
}
