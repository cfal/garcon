import type { AgentIntegration } from '@garcon/server-agent-interface';
import { executionInstanceKey, type ExecutionInstanceRef, type LocatedChatOwner } from '../../common/execution-location.js';
import type { ConfiguredAgentInstance } from '../../common/execution-nodes.js';
import { DomainError } from '../lib/domain-error.js';
import { LocalProviderConfigurationService } from '../execution-node/local-provider-configuration.js';
import type { ProviderConfigurationService } from '../execution-nodes/provider-configuration.js';
import { LocalProviderCatalogService } from '../execution-node/local-provider-catalog.js';
import type { ProviderCatalogService } from '../execution-nodes/provider-catalog.js';
import { LocalProviderAuthService } from '../execution-node/local-provider-auth.js';
import type { ProviderAuthService } from '../execution-nodes/provider-auth.js';
import { LocalProviderCommandsService } from '../execution-node/local-provider-commands.js';
import type { ProviderCommandsService } from '../execution-nodes/provider-commands.js';
import { LocalProviderNativeSessionService } from '../execution-node/local-provider-native-sessions.js';
import type { ProviderNativeSessionService } from '../execution-nodes/provider-native-sessions.js';
import { LocalProviderNativeActivityService } from '../execution-node/local-provider-native-activity.js';
import type { ProviderNativeActivityService } from '../execution-nodes/provider-native-activity.js';
import { LocalProviderHistoryImportService } from '../execution-node/local-provider-history-import.js';
import type { ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import { LocalProviderNativeForkService } from '../execution-node/local-provider-native-fork.js';
import type { ProviderNativeForkService } from '../execution-nodes/provider-native-fork.js';

export interface ExecutableAgentInstance {
  readonly configuration: ConfiguredAgentInstance;
  readonly integration: AgentIntegration;
}

/** Resolves concrete executables by placement while retaining provider type as a separate identity. */
export class AgentInstanceDirectory {
  readonly #instances = new Map<string, ExecutableAgentInstance>();
  readonly #defaults = new Map<string, ExecutionInstanceRef>();
  readonly #configurationServices = new WeakMap<AgentIntegration, ProviderConfigurationService>();
  readonly #catalogServices = new Map<string, ProviderCatalogService>();
  readonly #authServices = new Map<string, ProviderAuthService>();
  readonly #commandsServices = new Map<string, ProviderCommandsService>();
  readonly #nativeSessionServices = new Map<string, ProviderNativeSessionService>();
  readonly #nativeActivityServices = new Map<string, ProviderNativeActivityService>();
  readonly #legacyHistoryImportServices = new Map<string, ProviderHistoryImportService>();
  readonly #nativeHistoryImportServices = new Map<string, ProviderHistoryImportService>();
  readonly #nativeForkServices = new Map<string, ProviderNativeForkService>();

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
    if (!integration) throw new DomainError('NODE_UNAVAILABLE', `Execution instance unavailable: ${ref.nodeId}/${ref.instanceId}`, 409);
    return integration;
  }

  requireFor(owner: LocatedChatOwner): AgentIntegration {
    const integration = this.require(owner.executionLocation);
    if (integration.descriptor.id !== owner.agentId) {
      throw new DomainError('NODE_UNAVAILABLE', 'Execution instance does not match the chat provider', 409);
    }
    return integration;
  }

  configurationFor(owner: LocatedChatOwner): ProviderConfigurationService {
    return this.#configurationService(this.requireFor(owner));
  }

  configurationForInstance(ref: ExecutionInstanceRef): ProviderConfigurationService {
    return this.#configurationService(this.require(ref));
  }

  catalogForInstance(ref: ExecutionInstanceRef): ProviderCatalogService {
    const integration = this.require(ref);
    const key = executionInstanceKey(ref);
    let service = this.#catalogServices.get(key);
    if (!service) {
      service = new LocalProviderCatalogService(integration);
      this.#catalogServices.set(key, service);
    }
    return service;
  }

  authForInstance(ref: ExecutionInstanceRef): ProviderAuthService {
    const integration = this.require(ref);
    const key = executionInstanceKey(ref);
    let service = this.#authServices.get(key);
    if (!service) {
      service = new LocalProviderAuthService(integration);
      this.#authServices.set(key, service);
    }
    return service;
  }

  commandsForInstance(ref: ExecutionInstanceRef): ProviderCommandsService {
    const integration = this.require(ref);
    const key = executionInstanceKey(ref);
    let service = this.#commandsServices.get(key);
    if (!service) {
      service = new LocalProviderCommandsService(integration);
      this.#commandsServices.set(key, service);
    }
    return service;
  }

  nativeSessionsFor(owner: LocatedChatOwner): ProviderNativeSessionService {
    const integration = this.requireFor(owner);
    const key = executionInstanceKey(owner.executionLocation);
    let service = this.#nativeSessionServices.get(key);
    if (!service) {
      service = new LocalProviderNativeSessionService(integration);
      this.#nativeSessionServices.set(key, service);
    }
    return service;
  }

  nativeActivityFor(owner: LocatedChatOwner): ProviderNativeActivityService | null {
    const integration = this.requireFor(owner);
    if (!integration.nativeActivity) return null;
    const key = executionInstanceKey(owner.executionLocation);
    let service = this.#nativeActivityServices.get(key);
    if (!service) {
      service = new LocalProviderNativeActivityService(integration);
      this.#nativeActivityServices.set(key, service);
    }
    return service;
  }

  legacyHistoryImportFor(owner: LocatedChatOwner): ProviderHistoryImportService | null {
    const integration = this.requireFor(owner);
    if (!integration.legacyHistoryImport) return null;
    const key = executionInstanceKey(owner.executionLocation);
    let service = this.#legacyHistoryImportServices.get(key);
    if (!service) {
      service = new LocalProviderHistoryImportService(integration, integration.legacyHistoryImport);
      this.#legacyHistoryImportServices.set(key, service);
    }
    return service;
  }

  nativeHistoryImportFor(owner: LocatedChatOwner): ProviderHistoryImportService | null {
    const integration = this.requireFor(owner);
    if (!integration.nativeHistoryImport) return null;
    const key = executionInstanceKey(owner.executionLocation);
    let service = this.#nativeHistoryImportServices.get(key);
    if (!service) {
      service = new LocalProviderHistoryImportService(integration, integration.nativeHistoryImport);
      this.#nativeHistoryImportServices.set(key, service);
    }
    return service;
  }

  hasAvailableNativeHistoryImportFor(owner: LocatedChatOwner): boolean {
    const integration = this.get(owner.executionLocation);
    return integration !== null && integration.descriptor.id === owner.agentId && Boolean(integration.nativeHistoryImport);
  }

  nativeForkFor(owner: LocatedChatOwner): ProviderNativeForkService | null {
    const integration = this.requireFor(owner);
    if (!integration.forking) return null;
    const key = executionInstanceKey(owner.executionLocation);
    let service = this.#nativeForkServices.get(key);
    if (!service) {
      service = new LocalProviderNativeForkService(integration, integration.forking);
      this.#nativeForkServices.set(key, service);
    }
    return service;
  }

  #configurationService(integration: AgentIntegration): ProviderConfigurationService {
    let service = this.#configurationServices.get(integration);
    if (!service) {
      service = new LocalProviderConfigurationService(integration);
      this.#configurationServices.set(integration, service);
    }
    return service;
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
