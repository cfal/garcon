import type {
  AgentCatalogEntry,
  AgentModelOption,
} from "../../common/agents.js";
import type { ApiProviderEndpointResolver } from "../api-providers/endpoint-resolver.js";
import type { AgentDirectory } from "./directory.js";
import { createLogger } from "../lib/log.js";
import { effectiveNodeId } from '../../common/execution-nodes.js';

const logger = createLogger("agents:catalog-service");

export interface AgentModelQuery {
  nodeId?: string | null;
  strict?: boolean;
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
  readonly #requiresStrictByAgent = new Map<string, boolean>();

  constructor(
    private readonly deps: {
      directory: AgentDirectory;
      endpointResolver: ApiProviderEndpointResolver;
    },
  ) {}

  async getModels(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentModelOption[]> {
    const integration = this.deps.directory.get(agentId, query.nodeId);
    if (!integration) return [];
    return [...(await this.#snapshot(agentId, query)).models];
  }

  async modelSupportsImages(input: {
    nodeId?: string | null;
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): Promise<boolean> {
    const integration = this.deps.directory.get(input.agentId, input.nodeId);
    if (!integration) return false;
    if (!input.apiProviderId || !input.modelEndpointId)
      return integration.descriptor.supportsImages;
    return this.deps.endpointResolver.modelSupportsImages(input);
  }

  hasEndpointModels(agentId: string, nodeId?: string | null): boolean {
    return this.deps.endpointResolver.getModelOptions(agentId, effectiveNodeId(nodeId)).length > 0;
  }

  requiresStrictModelDiscovery(agentId: string, nodeId?: string | null): boolean {
    return this.#requiresStrictByAgent.get(JSON.stringify([effectiveNodeId(nodeId), agentId])) ?? false;
  }

  async getAgentCatalogEntry(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentCatalogEntry | null> {
    const integration = this.deps.directory.get(agentId, query.nodeId);
    if (!integration) return null;
    const snapshot = await this.#snapshot(agentId, query);
    const endpointModels = integration.endpoints
      ? this.deps.endpointResolver.getModelOptions(agentId, effectiveNodeId(query.nodeId))
      : [];
    const models = dedupeModels([...snapshot.models, ...endpointModels]);
    return {
      id: integration.descriptor.id,
      label: integration.descriptor.label,
      kind: "agent",
      supportsCompact: integration.compaction !== null,
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: true,
      supportsUpdateProjectPath:
        integration.descriptor.supportsProjectPathUpdate,
      supportsSteering: integration.steering !== null,
      supportsImages: integration.descriptor.supportsImages,
      fileAttachmentMimeTypes: [...(integration.attachments?.fileMimeTypes ?? [])],
      acceptsApiProviderEndpoints: integration.endpoints !== null,
      supportedProtocols: [...integration.descriptor.supportedEndpointProtocols],
      authLoginSupported: Boolean(integration.auth?.launchLogin),
      supportedPermissionModes: [...integration.descriptor.supportedPermissionModes],
      supportedThinkingModes: [...integration.descriptor.supportedThinkingModes],
      settings: [...integration.settings.describe()],
      defaultSettings: integration.settings.defaults(),
      requiresStrictModelDiscovery: snapshot.requiresStrictModelDiscovery,
      generation: snapshot.generation,
      defaultModel: snapshot.defaultModel || models[0]?.value || "",
      models,
    };
  }

  async getAgentCatalogEntries(nodeId?: string | null): Promise<AgentCatalogEntry[]> {
    const entries = (
      await Promise.all(
        this.deps.directory
          .list(nodeId)
          .map((integration) =>
            this.getAgentCatalogEntry(integration.descriptor.id, { nodeId }),
          ),
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

  async #snapshot(agentId: string, query: AgentModelQuery) {
    const integration = this.deps.directory.require(agentId, query.nodeId);
    const signal = new AbortController().signal;
    try {
      const snapshot = await integration.catalog.snapshot({
        strict: query.strict ?? false,
        signal,
      });
      this.#requiresStrictByAgent.set(
        JSON.stringify([effectiveNodeId(query.nodeId), agentId]),
        snapshot.requiresStrictModelDiscovery,
      );
      return snapshot;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (query.strict) throw error;
      logger.warn('Agent catalog snapshot failed.', {
        code: 'CATALOG_SNAPSHOT_FAILED',
        integrationId: agentId,
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
