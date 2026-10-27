import crypto from 'crypto';
import type { ModelCatalogResponse } from '../../../common/model-catalog.js';
import { effectiveExecutorId } from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import type { ApiProviderService } from '../api-providers/service.js';
import type { AgentRegistryServiceContract } from './registry.js';
import type { AgentCatalogCapture } from './catalog-service.js';


const MODEL_CATALOG_RESPONSE_CACHE_TTL_MS = 60_000;

export interface ModelCatalog {
  agents: AgentRegistryServiceContract;
  apiProviders: ApiProviderService;
}

export type ModelCatalogResponseBody = ModelCatalogResponse;

export interface ModelCatalogSnapshot {
  body: ModelCatalogResponseBody;
  etag: string;
  createdAt: number;
  assertCurrent(): void;
}

function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (!isRecord(value)) {
    return value;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableObject(value[key]);
  }
  return sorted;
}

function sortedByStringField<T>(items: T[], field: keyof T): T[] {
  return [...items].sort((left, right) =>
    String(left?.[field] ?? '').localeCompare(String(right?.[field] ?? ''))
  );
}

function catalogForHash(body: ModelCatalogResponseBody): unknown {
  const agents = sortedByStringField(body.catalog.agents, 'id')
    .map((agent) => ({
      ...agent,
      models: Array.isArray(agent.models)
        ? sortedByStringField(agent.models, 'value')
        : agent.models,
    }));

  const apiProviders = sortedByStringField(body.catalog.apiProviders, 'id')
    .map((provider) => ({
      ...provider,
      endpoints: Array.isArray(provider.endpoints)
        ? sortedByStringField(provider.endpoints, 'id')
          .map((endpoint) => ({
            ...endpoint,
            models: Array.isArray(endpoint.models)
              ? sortedByStringField(endpoint.models, 'value')
              : endpoint.models,
          }))
        : provider.endpoints,
    }));

  return stableObject({
    executorInstanceId: body.executorInstanceId,
    catalog: {
      agents,
      apiProviders,
    },
  });
}

export function createCatalogEtag(body: ModelCatalogResponseBody): string {
  const canonical = JSON.stringify(catalogForHash(body));
  const hash = crypto.createHash('sha256').update(canonical).digest('base64url');
  return `W/"model-catalog:${hash}"`;
}

function isFresh(snapshot: ModelCatalogSnapshot): boolean {
  return Date.now() - snapshot.createdAt < MODEL_CATALOG_RESPONSE_CACHE_TTL_MS;
}

async function buildCatalogResponse(modelCatalog: ModelCatalog, executorId: string, captured: AgentCatalogCapture): Promise<Omit<ModelCatalogSnapshot, 'assertCurrent'>> {
  const body = {
    executorInstanceId: captured.executorInstanceId,
    catalog: {
      agents: await captured.getAgentCatalogEntries(),
      apiProviders: modelCatalog.apiProviders.getCatalog(executorId),
    },
  };
  captured.assertCurrent();

  return {
    body,
    etag: createCatalogEtag(body),
    createdAt: Date.now(),
  };
}

export class ModelCatalogResponseCache {
  readonly #executors = new Map<string, {
    owner: AgentCatalogCapture;
    cached: ModelCatalogSnapshot | null;
    inflight: Promise<ModelCatalogSnapshot> | null;
  }>();

  async getSnapshot(modelCatalog: ModelCatalog, executorId = effectiveExecutorId(undefined)): Promise<ModelCatalogSnapshot> {
    const captured = modelCatalog.agents.captureCatalog(executorId);
    let entry = this.#executors.get(executorId);
    if (entry) {
      try { entry.owner.assertCurrent(); }
      catch { this.#executors.delete(executorId); entry = undefined; }
    }
    if (!entry) {
      entry = { owner: captured, cached: null, inflight: null };
      this.#executors.set(executorId, entry);
    }
    if (entry.cached && isFresh(entry.cached)) return entry.cached;
    if (entry.inflight) return entry.inflight;
    const current = entry;
    const assertCurrent = () => captured.assertCurrent();
    current.inflight = buildCatalogResponse(modelCatalog, executorId, captured)
      .then((result) => {
        assertCurrent();
        const snapshot = { ...result, assertCurrent };
        if (this.#executors.get(executorId) === current) current.cached = snapshot;
        return snapshot;
      })
      .catch((error: unknown) => {
        if (this.#executors.get(executorId) === current) this.#executors.delete(executorId);
        throw error;
      })
      .finally(() => { current.inflight = null; });
    return current.inflight;
  }

  clear(executorId?: string): void {
    if (executorId === undefined) this.#executors.clear();
    else this.#executors.delete(executorId);
  }
}
