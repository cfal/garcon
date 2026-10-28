import { AgentCallError } from '@garcon/server-agent-interface';
import type { RpcContractDefinition } from '@garcon/common/executor-contracts';
import { resolveCliRequest, type CliLookup, type ResolvedCliRequest } from './cli-protocol.js';
import type { RpcLane } from './rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from './limits.js';
import { GitServiceError } from '../../../common/git-error.js';
import { DomainError } from '../../common/domain-error.js';

export function rpcLane(definition: RpcContractDefinition, request: unknown, callingLane: RpcLane = 'primary', cli?: CliLookup): RpcLane {
  if (definition.lane === 'calling') return callingLane;
  if (definition.lane === 'cli') {
    if (!cli) throw new Error('CLI routing requires registered operation codecs');
    return resolveCliRequest(request, cli).policy.lane;
  }
  return definition.lane;
}

export function assertRpcRequestSize(contract: RpcContractDefinition, lane: RpcLane, bytes: number): void {
  if (lane !== 'primary' || bytes <= PRIMARY_SMALL_RPC_BYTES) return;
  if (contract.name === 'git.getQuickSummary') throw new GitServiceError('GIT_REQUEST_TOO_LARGE', 'Git summary request exceeds 64 KiB');
  if (contract.name === 'controllerCli.request' || contract.name === 'controllerCli.describe') {
    throw new DomainError('CLI_REQUEST_TOO_LARGE', 'Primary CLI request exceeds 64 KiB', 413);
  }
}

export function assertRpcReplySize(contract: RpcContractDefinition, lane: RpcLane, bytes: number): void {
  if (lane !== 'primary' || bytes <= PRIMARY_SMALL_RPC_BYTES) return;
  if (contract.name === 'git.getQuickSummary') throw new GitServiceError('GIT_RESULT_TOO_LARGE', 'Git summary result exceeds 64 KiB');
  if (contract.name === 'controllerCli.describe') throw new DomainError('CLI_RESULT_TOO_LARGE', 'Primary CLI result exceeds 64 KiB', 413);
}

export interface RpcPolicy {
  readonly lane: RpcLane;
  readonly cli?: ResolvedCliRequest;
  requestSize(bytes: number): void;
  replySize(bytes: number): void;
}

export function rpcPolicyV1(definition: RpcContractDefinition, request: unknown, lane: RpcLane, lookup?: CliLookup): RpcPolicy {
  if (definition.lane === 'cli' && !lookup) throw new Error('CLI routing requires registered operation codecs');
  const cli = definition.lane === 'cli' ? resolveCliRequest(request, lookup!) : undefined;
  const nested = cli?.policy;
  const allowedLane = nested?.lane ?? (definition.lane === 'calling' ? lane : definition.lane);
  if (allowedLane !== lane) throw new AgentCallError('not-dispatched', 'Executor request arrived on the wrong lane');
  return Object.freeze({ lane, ...(cli ? { cli } : {}),
    requestSize: (bytes: number) => assertRpcRequestSize(definition, lane, bytes),
    replySize: (bytes: number) => {
      if (!nested) { assertRpcReplySize(definition, lane, bytes); return; }
      if (lane !== 'primary' || bytes <= PRIMARY_SMALL_RPC_BYTES) return;
      if (nested.mutation) throw new DomainError('CLI_OUTCOME_UNKNOWN', 'Primary CLI mutation reply exceeded 64 KiB; its outcome is unknown', 503);
      throw new DomainError('CLI_RESULT_TOO_LARGE', 'Primary CLI result exceeds 64 KiB', 413);
    },
  });
}
