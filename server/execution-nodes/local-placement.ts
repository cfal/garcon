import type { ExecutionLocation, LocatedChatOwner } from '../../common/execution-location.js';
import { DomainError } from '../lib/domain-error.js';
import { ExecutionNodesStore } from './store.js';

export interface PlacedProject extends LocatedChatOwner {
  readonly projectPath: string;
}

/** Prepares the existing in-process execution path without manufacturing remote defaults. */
export class LocalExecutionPlacement {
  constructor(private readonly nodes: ExecutionNodesStore) {}

  async prepare(agentId: string, projectPath: string, signal?: AbortSignal): Promise<ExecutionLocation> {
    signal?.throwIfAborted();
    const [location] = await this.nodes.prepareLocalTargets([{ agentId, projectPath }]);
    signal?.throwIfAborted();
    return location!;
  }

  async prepareHandoff(source: PlacedProject, agentId: string): Promise<ExecutionLocation> {
    this.assertAvailable(source);
    return this.prepare(agentId, source.projectPath);
  }

  async prepareRelocation(source: PlacedProject, projectPath: string): Promise<ExecutionLocation> {
    this.assertAvailable(source);
    const target = await this.prepare(source.agentId, projectPath);
    return { ...target, instanceId: source.executionLocation.instanceId };
  }

  assertAvailable(source: PlacedProject): void {
    const { instance, workspace } = this.nodes.requireLocation(source.executionLocation, source.agentId);
    if (source.executionLocation.nodeId !== this.nodes.localNodeId || !instance.default) {
      throw new DomainError('NODE_UNAVAILABLE', 'This execution instance is not available through local execution.', 409);
    }
    if (workspace.projectPath !== source.projectPath) {
      throw new DomainError('NODE_UNAVAILABLE', 'The chat project does not match its registered execution workspace.', 409);
    }
  }
}
