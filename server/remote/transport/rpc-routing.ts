import { AgentCallError } from '@garcon/server-agent-interface';
import { CLI_OPERATIONS, cliPolicy, parseControllerCliRequest } from './cli-protocol.js';
import { isGitRpcMethod, type GitRpcMethods } from './git-protocol.js';
import type { ExecutorRpcMethods } from './rpc-protocol.js';
import type { RpcLane } from './rpc-lane.js';
import { PRIMARY_SMALL_RPC_BYTES } from './limits.js';
import { GitServiceError } from '../../../common/git-error.js';
import { DomainError } from '../../common/domain-error.js';

type FixedMethod = Exclude<keyof ExecutorRpcMethods, keyof GitRpcMethods | 'controllerCli.request' | 'calls.reconcile'>;

const METHOD_LANES = {
  'executor.describe': 'primary',
  'apiProviders.discoverModels': 'primary',
  'projects.inspect': 'primary',
  'projects.ticketProjectDefault': 'primary',
  'projects.resolveFileMentions': 'primary',
  'producers.bind': 'primary',
  'producers.close': 'primary',
  'producers.cancelLaunch': 'primary',
  'producers.resume': 'primary',
  'permissions.respond': 'primary',
  'execution.start': 'primary',
  'execution.resume': 'primary',
  'execution.abort': 'primary',
  'execution.runningSessions': 'primary',
  'catalog.snapshot': 'primary',
  'settings.migrate': 'primary',
  'lifecycle.start': 'primary',
  'lifecycle.stop': 'primary',
  'lifecycle.migrateOwnedStorage': 'primary',
  'migration.translateLegacyModel': 'primary',
  'migration.translateLegacyNativeSession': 'primary',
  'migration.translateLegacySettings': 'primary',
  'auth.status': 'primary',
  'auth.launchLogin': 'primary',
  'auth.completeLogin': 'primary',
  'auth.loginStatus': 'primary',
  'commands.discover': 'primary',
  'compaction.compact': 'primary',
  'forking.fork': 'primary',
  'forking.discard': 'primary',
  'steering.captureTarget': 'primary',
  'steering.steer': 'primary',
  'endpoints.validate': 'primary',
  'singleQuery.run': 'primary',
  'history.open': 'bulk',
  'history.next': 'bulk',
  'history.close': 'bulk',
  'nativeActivity.lastActivity': 'primary',
  'nativeSessions.resolveNativeSession': 'primary',
  'nativeSessions.describeSource': 'primary',
  'nativeSessions.release': 'primary',
  'configurationValidation.validate': 'primary',
  'sessionConfiguration.apply': 'primary',
  'projectPathUpdates.prepare': 'primary',
  'projectPathUpdates.commit': 'primary',
  'projectPathUpdates.rollback': 'primary',
  'credentials.resolve': 'primary',
  'terminals.list': 'primary',
  'terminals.create': 'primary',
  'terminals.rename': 'primary',
  'terminals.terminate': 'primary',
  'terminals.attach': 'primary',
  'terminals.input': 'primary',
  'terminals.resize': 'primary',
  'terminals.detach': 'primary',
  'controllerCli.describe': 'primary',
  'files.identity': 'primary',
  'files.revision': 'primary',
  'files.tree': 'bulk',
  'files.browse': 'bulk',
  'files.list': 'bulk',
  'files.read': 'bulk',
  'files.save': 'bulk',
} as const satisfies Record<FixedMethod, RpcLane>;

export function rpcLane(method: string, request: unknown, callingLane: RpcLane = 'primary'): RpcLane {
  if (isGitRpcMethod(method)) return method === 'git.getQuickSummary' ? 'primary' : 'bulk';
  if (method === 'calls.reconcile') return callingLane;
  if (method === 'controllerCli.request') return CLI_OPERATIONS[parseControllerCliRequest(request).http.operation].lane;
  if (Object.hasOwn(METHOD_LANES, method)) return METHOD_LANES[method as FixedMethod];
  throw new AgentCallError('rejected', 'Unknown executor RPC method');
}

export function assertRpcLane(method: string, request: unknown, lane: RpcLane): void {
  if (rpcLane(method, request, lane) !== lane) throw new AgentCallError('not-dispatched', 'Executor request arrived on the wrong lane');
}

export function assertRpcRequestSize(method: string, lane: RpcLane, bytes: number): void {
  if (lane !== 'primary' || bytes <= PRIMARY_SMALL_RPC_BYTES) return;
  if (method === 'git.getQuickSummary') throw new GitServiceError('GIT_REQUEST_TOO_LARGE', 'Git summary request exceeds 64 KiB');
  if (method === 'controllerCli.request' || method === 'controllerCli.describe') {
    throw new DomainError('CLI_REQUEST_TOO_LARGE', 'Primary CLI request exceeds 64 KiB', 413);
  }
}

export function assertRpcReplySize(method: string, request: unknown, lane: RpcLane, bytes: number): void {
  if (lane !== 'primary' || bytes <= PRIMARY_SMALL_RPC_BYTES) return;
  if (method === 'git.getQuickSummary') throw new GitServiceError('GIT_RESULT_TOO_LARGE', 'Git summary result exceeds 64 KiB');
  if (method === 'controllerCli.describe') throw new DomainError('CLI_RESULT_TOO_LARGE', 'Primary CLI result exceeds 64 KiB', 413);
  if (method === 'controllerCli.request') {
    const { mutation } = cliPolicy(parseControllerCliRequest(request).http);
    if (mutation) throw new DomainError('CLI_OUTCOME_UNKNOWN', 'Primary CLI mutation reply exceeded 64 KiB; its outcome is unknown', 503);
    throw new DomainError('CLI_RESULT_TOO_LARGE', 'Primary CLI result exceeds 64 KiB', 413);
  }
}
