import type { AgentIntegration } from '@garcon/server-agent-interface';
import { executionInstanceKey, type ExecutionInstanceRef } from '../../common/execution-location.js';
import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';

export interface ExecutableAgentInstance {
  readonly configuration: ConfiguredAgentInstance;
  readonly integration: AgentIntegration;
}

/** Resolves concrete executables by placement while retaining provider type as a separate identity. */
export class AgentInstanceDirectory {
  readonly #instances = new Map<string, ExecutableAgentInstance>();
  readonly #defaults = new Map<string, ExecutionInstanceRef>();

  constructor(instances: readonly ExecutableAgentInstance[]) {
    const executables = new Set<AgentIntegration>();
    const storage = new Set<string>();
    for (const { configuration, integration } of instances) {
      const ref = { nodeId: configuration.nodeId, instanceId: configuration.id };
      const key = executionInstanceKey(ref);
      const storageKey = JSON.stringify([configuration.nodeId, configuration.storageNamespace]);
      if (this.#instances.has(key)) throw new Error('Duplicate configured agent instance');
      if (integration.descriptor.id !== configuration.agentId) throw new Error('Executable provider type does not match its instance');
      if (executables.has(integration)) throw new Error('Configured instances cannot share one executable integration');
      if (storage.has(storageKey)) throw new Error('Configured instances cannot share one storage namespace');
      this.#instances.set(key, { configuration: Object.freeze({ ...configuration }), integration });
      executables.add(integration);
      storage.add(storageKey);
      if (configuration.default) {
        const providerKey = JSON.stringify([configuration.nodeId, configuration.agentId]);
        if (this.#defaults.has(providerKey)) throw new Error('Duplicate default provider instance');
        this.#defaults.set(providerKey, Object.freeze(ref));
      }
    }
  }

  get(ref: ExecutionInstanceRef): AgentIntegration | null {
    const instance = this.#instances.get(executionInstanceKey(ref));
    return instance && instance.configuration.removedAt === null ? instance.integration : null;
  }

  require(ref: ExecutionInstanceRef): AgentIntegration {
    const integration = this.get(ref);
    if (!integration) throw new Error(`Execution instance unavailable: ${ref.nodeId}/${ref.instanceId}`);
    return integration;
  }

  defaultFor(nodeId: string, agentId: string): ExecutionInstanceRef | null {
    const ref = this.#defaults.get(JSON.stringify([nodeId, agentId]));
    return ref && this.get(ref) ? { ...ref } : null;
  }

  configurations(nodeId: string): readonly ConfiguredAgentInstance[] {
    return [...this.#instances.values()].filter((entry) => entry.configuration.nodeId === nodeId)
      .map((entry) => ({ ...entry.configuration }));
  }
}
