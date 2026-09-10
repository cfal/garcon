import type { AgentDescriptor } from '@garcon/common/agent-integration';
import type { AgentIntegrationDefinition } from '@garcon/server-agent-interface';
import { validateAgentIntegrationDefinition } from '@garcon/server-agent-interface/testing';

/** Retains provider metadata without constructing or retaining executable instances or host capabilities. */
export class AgentTypeRegistry {
  readonly #descriptors = new Map<string, AgentDescriptor>();

  constructor(definitions: readonly AgentIntegrationDefinition[]) {
    for (const definition of definitions) {
      validateAgentIntegrationDefinition(definition);
      if (this.#descriptors.has(definition.integrationId)) {
        throw new Error(`Duplicate agent integration ID: ${definition.integrationId}`);
      }
      this.#descriptors.set(definition.integrationId, snapshotDescriptor(definition.descriptor));
    }
  }

  has(agentId: string): boolean { return this.#descriptors.has(agentId); }
  get(agentId: string): AgentDescriptor | null { return this.#descriptors.get(agentId) ?? null; }
  require(agentId: string): AgentDescriptor {
    const descriptor = this.get(agentId);
    if (!descriptor) throw new Error(`Unsupported agent integration: ${agentId}`);
    return descriptor;
  }
  list(): readonly AgentDescriptor[] { return [...this.#descriptors.values()]; }
}

function snapshotDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return Object.freeze({
    id: descriptor.id, label: descriptor.label, icon: descriptor.icon,
    supportedPermissionModes: Object.freeze([...descriptor.supportedPermissionModes]),
    supportedThinkingModes: Object.freeze([...descriptor.supportedThinkingModes]),
    supportsImages: descriptor.supportsImages,
    supportsProjectPathUpdate: descriptor.supportsProjectPathUpdate,
    requiresNativePathForProjectPathUpdate: descriptor.requiresNativePathForProjectPathUpdate,
    supportedEndpointProtocols: Object.freeze([...descriptor.supportedEndpointProtocols]),
    configuration: Object.freeze(descriptor.configuration.map((entry) => Object.freeze({
      key: entry.key, source: entry.source, description: entry.description,
    }))),
  });
}
