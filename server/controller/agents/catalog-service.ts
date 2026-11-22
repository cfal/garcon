import type {
  AgentCatalogEntry,
  AgentModelOption,
} from "../../../common/agents.js";
import { AgentCallError, AgentIntegrationError } from '@garcon/server-agent-interface';
import { DomainError } from '../../common/domain-error.js';
import type { ApiProviderEndpointResolver } from "../api-providers/endpoint-resolver.js";
import type { AgentDirectory } from "./directory.js";
import { createLogger } from "../../common/log.js";
import { effectiveExecutorId } from '../../../common/executors.js';

const logger = createLogger("agents:catalog-service");

export interface AgentModelQuery {
  executorId?: string | null;
  strict?: boolean;
  requireNativeDiscovery?: true;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatchDeadline?: number;
}

export function isCatalogExecutorFailure(error: unknown): boolean {
  return (error instanceof AgentCallError && error.outcome !== 'rejected')
    || (error instanceof DomainError && error.code === 'EXECUTOR_UNAVAILABLE');
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
    const integration = this.deps.directory.get(agentId, query.executorId);
    if (!integration) return [];
    return [...(await this.#snapshot(agentId, query)).models];
  }

  // Synchronous so queued dequeue can recheck support inside its admission block.
  modelSupportsImages(input: {
    executorId?: string | null;
    agentId: string;
    model: string;
    apiProviderId?: string | null;
    modelEndpointId?: string | null;
  }): boolean {
    const integration = this.deps.directory.get(input.agentId, input.executorId);
    if (!integration) return false;
    if (!input.apiProviderId || !input.modelEndpointId)
      return integration.descriptor.supportsImages;
    return this.deps.endpointResolver.modelSupportsImages(input);
  }

  hasEndpointModels(agentId: string, executorId?: string | null): boolean {
    return this.deps.endpointResolver.getModelOptions(agentId, effectiveExecutorId(executorId)).length > 0;
  }

  requiresStrictModelDiscovery(agentId: string, executorId?: string | null): boolean {
    return this.#requiresStrictByAgent.get(JSON.stringify([effectiveExecutorId(executorId), agentId])) ?? false;
  }

  async getAgentCatalogEntry(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentCatalogEntry | null> {
    const integration = this.deps.directory.get(agentId, query.executorId);
    if (!integration) return null;
    const snapshot = await this.#snapshot(agentId, query);
    const endpointModels = integration.endpoints
      ? this.deps.endpointResolver.getModelOptions(agentId, effectiveExecutorId(query.executorId))
      : [];
    const models = dedupeModels([...snapshot.models, ...endpointModels]);
    return {
      id: integration.descriptor.id,
      label: integration.descriptor.label,
      kind: "agent",
      executionPolicy: integration.literalExecution ? 'literal' : 'conversation',
      selectionLabel: integration.literalExecution?.selectionLabel ?? 'Model',
      inputFormatByModel: integration.literalExecution?.inputFormatByModel ?? {},
      supportsCompact: integration.compaction !== null,
      supportsFork: true,
      supportsForkAtMessage: true,
      supportsForkWhileRunning: true,
      supportsUpdateProjectPath:
        integration.descriptor.supportsProjectPathUpdate,
      supportsSteering: integration.steering !== null,
      supportsImages: integration.descriptor.supportsImages,
      fileAttachmentMimeTypes: integration.attachments?.fileMimeTypes ?? [],
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

  async getAgentCatalogEntries(executorId?: string | null, confirmingAgents: readonly string[] = []): Promise<AgentCatalogEntry[]> {
    const entries = (
      await Promise.all(
        this.deps.directory
          .list(executorId)
          .map((integration) =>
            this.getAgentCatalogEntry(integration.descriptor.id, {
              executorId,
              ...(confirmingAgents.includes(integration.descriptor.id) ? { requireNativeDiscovery: true } : {}),
            }),
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
    const integration = this.deps.directory.require(agentId, query.executorId);
    const signal = query.signal ?? new AbortController().signal;
    const strict = query.strict === true || query.requireNativeDiscovery === true;
    try {
      const snapshot = await integration.catalog.snapshot({
        strict,
        ...(query.requireNativeDiscovery ? { requireNativeDiscovery: true } : {}),
        signal,
        timeoutMs: query.timeoutMs,
        dispatchDeadline: query.dispatchDeadline,
      });
      this.#requiresStrictByAgent.set(
        JSON.stringify([effectiveExecutorId(query.executorId), agentId]),
        snapshot.requiresStrictModelDiscovery,
      );
      return snapshot;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // Unlike a failed listing, a missing or misconfigured provider is a definitive empty native catalog.
      const unavailableProvider = query.requireNativeDiscovery && error instanceof AgentIntegrationError && !error.retryable
        && (error.code === 'BINARY_NOT_FOUND' || error.code === 'INVALID_SETTINGS' || error.code === 'INVALID_ENDPOINT');
      if (isCatalogExecutorFailure(error) || (strict && !unavailableProvider)) throw error;
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
