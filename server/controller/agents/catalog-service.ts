import type {
  AgentCatalogEntry,
  AgentModelOption,
} from "../../../common/agents.js";
import type { ApiProviderEndpointResolver } from "../api-providers/endpoint-resolver.js";
import type { AgentDirectory } from "./directory.js";
import { createLogger } from "../../common/log.js";
import { effectiveExecutorId } from '../../../common/executors.js';
import type { AgentIntegration } from '@garcon/server-agent-interface';

const logger = createLogger("agents:catalog-service");

export interface AgentModelQuery {
  executorId?: string | null;
  strict?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  dispatchDeadline?: number;
}

export interface AgentCatalogCapture {
  readonly executorInstanceId: string;
  assertCurrent(): void;
  getAgentCatalogEntry(agentId: string, query?: AgentModelQuery): Promise<AgentCatalogEntry | null>;
  getAgentCatalogEntries(): Promise<AgentCatalogEntry[]>;
  requiresStrictModelDiscovery(agentId: string): boolean;
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
  readonly #requiresStrictByAgent = new WeakMap<AgentIntegration, boolean>();

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
    const inventory = this.deps.directory.captureInventory(query.executorId);
    const integration = inventory.integrations.find(value => value.descriptor.id === agentId);
    return integration ? [...(await this.#snapshot(integration, query, () => inventory.assertCurrent())).models] : [];
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

  capture(executorId?: string | null): AgentCatalogCapture {
    const inventory = this.deps.directory.captureInventory(executorId);
    const byId = new Map(inventory.integrations.map(integration => [integration.descriptor.id, integration]));
    const assertCurrent = () => inventory.assertCurrent();
    return {
      executorInstanceId: inventory.instanceId,
      assertCurrent,
      getAgentCatalogEntry: async (agentId, query = {}) => {
        inventory.assertCurrent();
        const integration = byId.get(agentId);
        return integration ? this.#entry(integration, { ...query, executorId }, assertCurrent) : null;
      },
      getAgentCatalogEntries: async () => {
        inventory.assertCurrent();
        const entries = await Promise.all(inventory.integrations.map(integration => this.#entry(integration, { executorId }, assertCurrent)));
        inventory.assertCurrent();
        const priorities = new Set<number>();
        for (const entry of entries) {
          if (!entry.generation) continue;
          if (priorities.has(entry.generation.priority)) throw new Error(`Duplicate generation priority: ${entry.generation.priority}`);
          priorities.add(entry.generation.priority);
        }
        return entries;
      },
      requiresStrictModelDiscovery: agentId => {
        inventory.assertCurrent();
        const integration = byId.get(agentId);
        return integration ? this.#requiresStrictByAgent.get(integration) ?? false : false;
      },
    };
  }

  async getAgentCatalogEntry(
    agentId: string,
    query: AgentModelQuery = {},
  ): Promise<AgentCatalogEntry | null> {
    return this.capture(query.executorId).getAgentCatalogEntry(agentId, query);
  }

  async #entry(integration: AgentIntegration, query: AgentModelQuery, assertCurrent: () => void): Promise<AgentCatalogEntry> {
    const agentId = integration.descriptor.id;
    const snapshot = await this.#snapshot(integration, query, assertCurrent);
    assertCurrent();
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

  async getAgentCatalogEntries(executorId?: string | null): Promise<AgentCatalogEntry[]> {
    return this.capture(executorId).getAgentCatalogEntries();
  }

  async #snapshot(integration: AgentIntegration, query: AgentModelQuery, assertCurrent: () => void) {
    assertCurrent();
    const signal = query.signal ?? new AbortController().signal;
    try {
      const snapshot = await integration.catalog.snapshot({
        strict: query.strict ?? false,
        signal,
        timeoutMs: query.timeoutMs,
        dispatchDeadline: query.dispatchDeadline,
      });
      assertCurrent();
      this.#requiresStrictByAgent.set(integration, snapshot.requiresStrictModelDiscovery);
      return snapshot;
    } catch (error) {
      assertCurrent();
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (query.strict) throw error;
      logger.warn('Agent catalog snapshot failed.', {
        code: 'CATALOG_SNAPSHOT_FAILED',
        integrationId: integration.descriptor.id,
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
