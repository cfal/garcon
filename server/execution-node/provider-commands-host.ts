import { isExecutionIdentity, type ExecutionInstanceRef } from '../../common/execution-location.js';
import type { ProviderCommandsService } from '../execution-nodes/provider-commands.js';
import { captureNodeProviderCommandsReply, type NodeProviderCommandsCommand } from '../execution-nodes/transport/provider-commands-wire.js';
import { DomainError, ProjectUnavailableError } from '../lib/domain-error.js';
import type { NodeExecutionResources } from './execution-resources.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

/** Resolves installed workspace grants and retains native discovery capacity through settlement. */
export class NodeProviderCommandsHost {
  constructor(
    private readonly capacity: NodeProviderCapacity,
    private readonly instance: ExecutionInstanceRef,
    private readonly resources: Pick<NodeExecutionResources, 'prepare'>,
    private readonly commands: ProviderCommandsService,
  ) {
    if (!isExecutionIdentity(instance.nodeId) || !isExecutionIdentity(instance.instanceId)) throw new TypeError('Invalid command discovery instance');
    this.instance = Object.freeze({ nodeId: instance.nodeId, instanceId: instance.instanceId });
  }

  async discover(command: NodeProviderCommandsCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    const { instanceId, workspaceId } = command;
    if (instanceId !== this.instance.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    const release = this.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    let discoverySignal = signal;
    try {
      const workspace = await this.resources.prepare({ ...this.instance, workspaceId }, signal);
      discoverySignal = AbortSignal.any([signal, workspace.signal]);
      discoverySignal.throwIfAborted(); workspace.validate();
      const commands = await this.commands.discover({ projectPath: workspace.projectPath }, discoverySignal);
      discoverySignal.throwIfAborted(); workspace.validate();
      return captureNodeProviderCommandsReply(instanceId, workspaceId, commands) ?? { kind: 'rejected', code: 'VALIDATION_FAILED' };
    } catch (error) {
      discoverySignal.throwIfAborted();
      if (error instanceof ProjectUnavailableError) return { kind: 'provider-commands-unavailable', instanceId, workspaceId, reason: error.reason };
      if (error instanceof DomainError && error.code === 'NODE_UNAVAILABLE') return { kind: 'rejected', code: 'NODE_UNAVAILABLE' };
      return { kind: 'unknown' };
    } finally { release(); }
  }
}
