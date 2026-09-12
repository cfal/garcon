import type {
  AgentCatalogEntry,
  AgentModelOption,
} from "../../common/agents.js";
import type { ApiProviderEndpointResolver } from "../api-providers/endpoint-resolver.js";
import { executionInstanceKey, type ExecutionInstanceRef } from "../../common/execution-location.js";
import type { AgentInstanceDirectory } from "./instance-directory.js";
import { createLogger } from "../lib/log.js";

const logger = createLogger("agents:catalog-service");

export interface AgentModelQuery {
  readonly strict?: boolean;
  readonly signal?: AbortSignal;
}

function dedupeModels(models: readonly AgentModelOption[]): AgentModelOption[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.value || seen.has(model.value)) return false;
    seen.add(model.value);
    return true;
  });
}

export class AgentCatalogService {
  readonly #requiresStrictByInstance = new Map<string, boolean>();

  constructor(
    private readonly deps: {
      instances: Pick<AgentInstanceDirectory, 'catalogForInstance' | 'defaultFor' | 'metadataForInstance' | 'assertAvailableForInstance'>;
      localNodeId: string;
      defaultAgentIds: readonly string[];
      endpointResolver: ApiProviderEndpointResolver;
    },
  ) {}

  async getModels(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentModelOption[]> {
    const signal = query.signal;
    signal?.throwIfAborted();
    const ref = this.deps.instances.defaultFor(this.deps.localNodeId, agentId);
    const models = ref ? await this.getModelsForInstance(ref, query) : [];
    signal?.throwIfAborted();
    return models;
  }

  async getModelsForInstance(
    ref: ExecutionInstanceRef,
    query: AgentModelQuery = {},
  ): Promise<AgentModelOption[]> {
    const signal = query.signal;
    signal?.throwIfAborted();
    const snapshot = await this.#snapshot(ref, query);
    signal?.throwIfAborted();
    return [...snapshot.models];
  }

  async modelSupportsImages(input: {
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    const ref = this.deps.instances.defaultFor(this.deps.localNodeId, input.agentId);
    if (!ref) return false;
    const metadata = this.deps.instances.metadataForInstance(ref);
    if (!input.apiProviderId || !input.modelEndpointId)
      return metadata.descriptor.supportsImages;
    return this.deps.endpointResolver.modelSupportsImages(input);
  }

  hasEndpointModels(agentId: string): boolean {
    return this.deps.endpointResolver.getModelOptions(agentId).length > 0;
  }

  requiresStrictModelDiscovery(agentId: string): boolean {
    const ref = this.deps.instances.defaultFor(this.deps.localNodeId, agentId);
    return ref ? this.requiresStrictModelDiscoveryForInstance(ref) : false;
  }

  requiresStrictModelDiscoveryForInstance(ref: ExecutionInstanceRef): boolean {
    this.deps.instances.assertAvailableForInstance(ref);
    return this.#requiresStrictByInstance.get(executionInstanceKey(ref)) ?? false;
  }

  async getAgentCatalogEntry(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentCatalogEntry | null> {
    const signal = query.signal;
    signal?.throwIfAborted();
    const ref = this.deps.instances.defaultFor(this.deps.localNodeId, agentId);
    const entry = ref ? await this.getAgentCatalogEntryForInstance(ref, query) : null;
    signal?.throwIfAborted();
    return entry;
  }

  async getAgentCatalogEntryForInstance(
    ref: ExecutionInstanceRef,
    query: AgentModelQuery = {},
  ): Promise<AgentCatalogEntry> {
    const signal = query.signal;
    signal?.throwIfAborted();
    const metadata = this.deps.instances.metadataForInstance(ref);
    const agentId = metadata.descriptor.id;
    const snapshot = await this.#snapshot(ref, query);
    signal?.throwIfAborted();
    const endpointModels = metadata.facets.endpoints
      ? this.deps.endpointResolver.getModelOptions(agentId)
      : [];
    const models = dedupeModels([...snapshot.models, ...endpointModels]);
    return {
      id: metadata.descriptor.id,
      label: metadata.descriptor.label,
      kind: "agent",
      supportsCompact: metadata.facets.compaction !== null,
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: true,
      supportsUpdateProjectPath: metadata.descriptor.supportsProjectPathUpdate,
      supportsSteering: metadata.facets.steering !== null,
      supportsGoals: metadata.facets.goals !== null,
      supportsImages: metadata.descriptor.supportsImages,
      fileAttachmentMimeTypes: [...metadata.fileAttachmentMimeTypes],
      acceptsApiProviderEndpoints: metadata.facets.endpoints !== null,
      supportedProtocols: [...metadata.descriptor.supportedEndpointProtocols],
      authLoginSupported: metadata.authCapabilities.launchLogin,
      supportedPermissionModes: [...metadata.descriptor.supportedPermissionModes],
      supportedThinkingModes: [...metadata.descriptor.supportedThinkingModes],
      settings: structuredClone([...metadata.settings]),
      defaultSettings: structuredClone(metadata.defaultSettings),
      requiresStrictModelDiscovery: snapshot.requiresStrictModelDiscovery,
      generation: snapshot.generation,
      defaultModel: snapshot.defaultModel || models[0]?.value || "",
      models,
    };
  }

  async getAgentCatalogEntries(): Promise<AgentCatalogEntry[]> {
    const entries = (
      await Promise.all(
        this.deps.defaultAgentIds.map((agentId) => this.getAgentCatalogEntry(agentId)),
      )
    ).filter((entry): entry is AgentCatalogEntry => entry !== null);
    const priorities = new Set<number>();
    for (const entry of entries) {
      if (!entry.generation) continue;
      if (priorities.has(entry.generation.priority)) {
        throw new Error(
          `Duplicate generation priority: ${entry.generation.priority}`,
        );
      }
      priorities.add(entry.generation.priority);
    }
    return entries;
  }

  async #snapshot(ref: ExecutionInstanceRef, query: AgentModelQuery) {
    const { nodeId, instanceId } = ref;
    const key = executionInstanceKey({ nodeId, instanceId });
    const catalog = this.deps.instances.catalogForInstance({ nodeId, instanceId });
    const signal = query.signal ?? new AbortController().signal;
    const strict = query.strict ?? false;
    try {
      const snapshot = await catalog.snapshot({ strict }, signal);
      signal.throwIfAborted();
      this.#requiresStrictByInstance.set(
        key,
        snapshot.requiresStrictModelDiscovery,
      );
      return snapshot;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (strict) throw error;
      logger.warn('Agent catalog snapshot failed.', {
        code: 'CATALOG_SNAPSHOT_FAILED',
        nodeId,
        instanceId,
      });
      return {
        models: [] as AgentModelOption[],
        defaultModel: "",
        requiresStrictModelDiscovery: false,
        generation: null,
      };
    }
  }
}
