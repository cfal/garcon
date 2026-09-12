import { isExecutionIdentity, type ExecutionInstanceRef, type ProjectWorkspaceRef } from '../../common/execution-location.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import { NodeWorkerServiceReplyError } from '../execution-node/worker/service-channel.js';
import { DomainError, ProjectUnavailableError } from '../lib/domain-error.js';
import type { ProviderCommandsRequest, ProviderCommandsService } from './provider-commands.js';
import { parseNodeProviderCommandsReply } from './transport/provider-commands-wire.js';

/** Maps controller-owned project metadata to a node grant without interpreting a foreign filesystem path. */
export class RemoteProviderCommandsService implements ProviderCommandsService {
  constructor(
    private readonly service: Pick<NodeWorkerServiceClient, 'call'>,
    private readonly instance: ExecutionInstanceRef,
    private readonly workspaceFor: (projectPath: string) => ProjectWorkspaceRef | null,
  ) {
    if (!isExecutionIdentity(instance.nodeId) || !isExecutionIdentity(instance.instanceId)) throw new TypeError('Invalid command discovery instance');
    this.instance = Object.freeze({ nodeId: instance.nodeId, instanceId: instance.instanceId });
  }

  async discover(request: ProviderCommandsRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const projectPath = request.projectPath;
    const workspace = this.workspaceFor(projectPath);
    if (!workspace || workspace.nodeId !== this.instance.nodeId || !isExecutionIdentity(workspace.workspaceId)) throw unavailable();
    const { workspaceId } = workspace;
    const { instanceId } = this.instance;
    let reply;
    try { reply = await this.service.call({ method: 'provider-commands', instanceId, workspaceId }, signal); }
    catch (error) {
      signal.throwIfAborted();
      throw error instanceof NodeWorkerServiceReplyError ? incompatible() : unavailable();
    }
    signal.throwIfAborted();
    if (reply.kind === 'rejected') {
      if (reply.code === 'NODE_CAPACITY') throw new DomainError('NODE_CAPACITY', 'Provider command discovery is at capacity.', 503, true);
      throw reply.code === 'NODE_UNAVAILABLE' ? unavailable() : incompatible();
    }
    if (reply.kind === 'unknown') throw unavailable();
    const result = parseNodeProviderCommandsReply(reply);
    if (!result || result.instanceId !== instanceId || result.workspaceId !== workspaceId) throw incompatible();
    if (result.kind === 'provider-commands-unavailable') throw new ProjectUnavailableError(projectPath, result.reason);
    return result.commands;
  }
}

function unavailable() { return new DomainError('NODE_UNAVAILABLE', 'Provider command discovery is unavailable.', 503, true); }
function incompatible() { return new DomainError('NODE_INCOMPATIBLE', 'The node returned an invalid command discovery response.', 502); }
