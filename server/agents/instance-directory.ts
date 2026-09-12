import { executionInstanceKey, type ExecutionInstanceRef, type LocatedChatOwner } from '../../common/execution-location.js';
import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';
import type { ProviderInstanceRegistration, ProviderInstanceServices } from '../execution-nodes/provider-instance.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderConfigurationService } from '../execution-nodes/provider-configuration.js';
import type { ProviderCatalogService } from '../execution-nodes/provider-catalog.js';
import type { ProviderAuthService } from '../execution-nodes/provider-auth.js';
import type { ProviderCommandsService } from '../execution-nodes/provider-commands.js';
import type { ProviderNativeSessionService } from '../execution-nodes/provider-native-sessions.js';
import type { ProviderNativeActivityService } from '../execution-nodes/provider-native-activity.js';
import type { ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import type { ProviderNativeForkService } from '../execution-nodes/provider-native-fork.js';
import type { ProviderSingleQueryService } from '../execution-nodes/provider-single-query.js';
import type { ProviderTextGenerationService } from '../execution-nodes/provider-text-generation.js';
import type { ProviderExecutionService } from '../execution-nodes/provider-execution.js';
import type { ProviderProjectPathUpdateService } from '../execution-nodes/provider-project-path.js';
import type { ProviderInstanceMetadata } from '../execution-nodes/provider-metadata.js';

/** Resolves instance-bound services by placement without retaining executable provider integrations. */
export class AgentInstanceDirectory {
  readonly #instances = new Map<string, ProviderInstanceRegistration>();
  readonly #defaults = new Map<string, ExecutionInstanceRef>();

  constructor(instances: readonly ProviderInstanceRegistration[]) {
    const registrations = new Set<object>();
    const storage = new Set<string>();
    for (const { configuration, services } of instances) {
      const ref = { nodeId: configuration.nodeId, instanceId: configuration.id };
      const key = executionInstanceKey(ref);
      const storageKey = JSON.stringify([configuration.nodeId, configuration.storageNamespace]);
      if (this.#instances.has(key)) throw new Error('Duplicate configured agent instance');
      if (services.agentId !== configuration.agentId) throw new Error('Service provider type does not match its instance');
      const binding = services.binding;
      if (!binding || typeof binding !== 'object') throw new Error('Service registration requires an opaque binding');
      if (registrations.has(binding)) throw new Error('Configured instances cannot share one service binding');
      if (storage.has(storageKey)) throw new Error('Configured instances cannot share one storage namespace');
      this.#instances.set(key, { configuration: Object.freeze({ ...configuration }), services });
      registrations.add(binding);
      storage.add(storageKey);
      if (configuration.default) {
        const providerKey = JSON.stringify([configuration.nodeId, configuration.agentId]);
        if (this.#defaults.has(providerKey)) throw new Error('Duplicate default provider instance');
        this.#defaults.set(providerKey, Object.freeze(ref));
      }
    }
  }

  get(ref: ExecutionInstanceRef): ProviderInstanceServices | null {
    const instance = this.#instances.get(executionInstanceKey(ref));
    return instance && instance.configuration.removedAt === null ? instance.services : null;
  }

  require(ref: ExecutionInstanceRef): ProviderInstanceServices {
    const services = this.get(ref);
    if (!services) throw new DomainError('NODE_UNAVAILABLE', `Execution instance unavailable: ${ref.nodeId}/${ref.instanceId}`, 409);
    return services;
  }

  requireFor(owner: LocatedChatOwner): ProviderInstanceServices {
    const services = this.require(owner.executionLocation);
    if (services.agentId !== owner.agentId) {
      throw new DomainError('NODE_UNAVAILABLE', 'Execution instance does not match the chat provider', 409);
    }
    return services;
  }

  metadataForInstance(ref: ExecutionInstanceRef): ProviderInstanceMetadata {
    const services = this.require(ref);
    const agentId = this.#instances.get(executionInstanceKey(ref))!.configuration.agentId;
    const metadata = services.metadata;
    if (metadata.descriptor.id !== agentId || metadata.defaultSettings.ownerId !== agentId) {
      throw new DomainError('NODE_UNAVAILABLE', 'Execution instance metadata does not match its provider', 409);
    }
    return metadata;
  }

  metadataFor(owner: LocatedChatOwner): ProviderInstanceMetadata {
    this.requireFor(owner);
    return this.metadataForInstance(owner.executionLocation);
  }

  assertAvailableForInstance(ref: ExecutionInstanceRef): void {
    this.require(ref);
  }

  assertAvailableFor(owner: LocatedChatOwner): void {
    this.requireFor(owner);
  }

  configurationFor(owner: LocatedChatOwner): ProviderConfigurationService {
    return this.requireFor(owner).configuration;
  }

  executionFor(owner: LocatedChatOwner): ProviderExecutionService {
    return this.requireFor(owner).execution;
  }

  catalogForInstance(ref: ExecutionInstanceRef): ProviderCatalogService {
    return this.require(ref).catalog;
  }

  authForInstance(ref: ExecutionInstanceRef): ProviderAuthService {
    return this.require(ref).auth;
  }

  commandsForInstance(ref: ExecutionInstanceRef): ProviderCommandsService {
    return this.require(ref).commands;
  }

  nativeSessionsFor(owner: LocatedChatOwner): ProviderNativeSessionService {
    return this.requireFor(owner).nativeSessions;
  }

  nativeActivityFor(owner: LocatedChatOwner): ProviderNativeActivityService | null {
    return this.requireFor(owner).nativeActivity;
  }

  legacyHistoryImportFor(owner: LocatedChatOwner): ProviderHistoryImportService | null {
    return this.requireFor(owner).legacyHistoryImport;
  }

  nativeHistoryImportFor(owner: LocatedChatOwner): ProviderHistoryImportService | null {
    return this.requireFor(owner).nativeHistoryImport;
  }

  nativeForkFor(owner: LocatedChatOwner): ProviderNativeForkService | null {
    return this.requireFor(owner).nativeFork;
  }

  singleQueryForInstance(ref: ExecutionInstanceRef): ProviderSingleQueryService | null {
    return this.require(ref).singleQuery;
  }

  projectPathUpdatesFor(owner: LocatedChatOwner): ProviderProjectPathUpdateService | null {
    return this.requireFor(owner).projectPathUpdates;
  }

  textGenerationForInstance(ref: ExecutionInstanceRef): ProviderTextGenerationService | null {
    return this.require(ref).textGeneration;
  }

  hasAvailableNativeHistoryImportFor(owner: LocatedChatOwner): boolean {
    const services = this.get(owner.executionLocation);
    return services !== null && services.agentId === owner.agentId && services.nativeHistoryImport !== null;
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
