import type { ExecutionInstanceRef, ProjectWorkspaceRef } from '../../common/execution-location.js';
import { isExecutionIdentity } from '../../common/execution-location.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderNativeReleaseRequest, ProviderNativeSessionRequest, ProviderNativeSessionService } from './provider-native-sessions.js';
import { parseNodeProviderNativeCommand, parseNodeProviderNativeReply, type NodeProviderNativeCommand } from './transport/provider-native-wire.js';

/** Captures an instance and workspace grant; native paths remain opaque provider data. */
export class RemoteProviderNativeSessionService implements ProviderNativeSessionService {
  constructor(
    private readonly service: Pick<NodeWorkerServiceClient, 'call'>,
    private readonly instance: ExecutionInstanceRef,
    private readonly workspaceFor: (projectPath: string) => ProjectWorkspaceRef | null,
  ) {
    if (!isExecutionIdentity(instance.nodeId) || !isExecutionIdentity(instance.instanceId)) throw new TypeError('Invalid native instance');
    this.instance = Object.freeze({ ...instance });
  }

  async resolve(request: ProviderNativeSessionRequest, signal: AbortSignal) {
    const agentId = request.chat.agentId;
    const result = await this.#call(request, { operation: 'resolve' }, signal);
    if (result.operation !== 'resolve' || result.reference !== null && result.reference.ownerId !== agentId) throw incompatible();
    return result.reference;
  }

  async describe(request: ProviderNativeSessionRequest, signal: AbortSignal) {
    const result = await this.#call(request, { operation: 'describe' }, signal);
    if (result.operation !== 'describe') throw incompatible();
    return result.source;
  }

  async release(request: ProviderNativeReleaseRequest, signal: AbortSignal): Promise<void> {
    const result = await this.#call(request, { operation: 'release', reason: request.reason }, signal);
    if (result.operation !== 'release') throw unknown();
  }

  async #call(request: ProviderNativeSessionRequest, operation: Pick<NodeProviderNativeCommand, 'operation'> & { reason?: 'deleted' | 'transferred' }, signal: AbortSignal) {
    signal.throwIfAborted();
    const { projectPath, ...chat } = request.chat;
    const workspace = this.workspaceFor(projectPath);
    if (!workspace || workspace.nodeId !== this.instance.nodeId || !isExecutionIdentity(workspace.workspaceId)) throw unavailable();
    const command = parseNodeProviderNativeCommand({ method: 'provider-native-sessions', instanceId: this.instance.instanceId,
      workspaceId: workspace.workspaceId, chat, ...operation });
    if (!command) throw new DomainError('VALIDATION_FAILED', 'Invalid native session request.', 400);
    let result;
    try { result = await this.service.call(command, signal); }
    catch { signal.throwIfAborted(); throw command.operation === 'release' ? unknown() : unavailable(); }
    signal.throwIfAborted();
    if (result.kind === 'rejected') {
      if (result.code === 'NODE_CAPACITY') throw new DomainError('NODE_CAPACITY', 'Native session service is at capacity.', 503, true);
      throw unavailable();
    }
    if (result.kind === 'unknown') throw command.operation === 'release' ? unknown() : unavailable();
    const reply = parseNodeProviderNativeReply(result);
    if (!reply || reply.instanceId !== command.instanceId || reply.workspaceId !== command.workspaceId || reply.operation !== command.operation) {
      throw command.operation === 'release' ? unknown() : incompatible();
    }
    return reply;
  }
}

function unavailable() { return new DomainError('NODE_UNAVAILABLE', 'Native session service is unavailable.', 503, true); }
function incompatible() { return new DomainError('NODE_INCOMPATIBLE', 'The node returned an invalid native session response.', 502); }
function unknown() { return new DomainError('NODE_OPERATION_UNKNOWN', 'Native cleanup is unconfirmed; the exact release remains pending.', 503); }
