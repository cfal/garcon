import crypto from 'crypto';
import type { AgentCatalogEntry } from '../../common/agents.js';
import type { ApiProviderCatalogEntry } from '../../common/api-providers.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { ApiProviderService } from '../api-providers/service.js';

const MODEL_CATALOG_RESPONSE_CACHE_TTL_MS = 60_000;
const CATALOG_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-cache',
};

export interface ModelCatalog {
  agents: AgentRegistryServiceContract;
  apiProviders: ApiProviderService;
}

export interface ModelCatalogResponseBody {
  catalog: {
    agents: AgentCatalogEntry[];
    apiProviders: ApiProviderCatalogEntry[];
  };
}

export interface ModelCatalogSnapshot {
  body: ModelCatalogResponseBody;
  etag: string;
  createdAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function etagMatches(request: Request, etag: string): boolean {
  const header = request?.headers?.get?.('if-none-match');
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === '*');
}

function isFresh(snapshot: ModelCatalogSnapshot): boolean {
  return Date.now() - snapshot.createdAt < MODEL_CATALOG_RESPONSE_CACHE_TTL_MS;
}

async function buildCatalogResponse(modelCatalog: ModelCatalog): Promise<ModelCatalogSnapshot> {
  const body = {
    catalog: {
      agents: await modelCatalog.agents.getAgentCatalogEntries(),
      apiProviders: modelCatalog.apiProviders.getCatalog(),
    },
  };

  return {
    body,
    etag: createCatalogEtag(body),
    createdAt: Date.now(),
  };
}

export class ModelCatalogResponseCache {
  #cachedCatalogResponse: ModelCatalogSnapshot | null = null;
  #inflightCatalogResponse: Promise<ModelCatalogSnapshot> | null = null;
  // Bumped on every clear() so in-flight fetches can detect that they have
  // been superseded and skip committing a stale snapshot back into the cache.
  #generation = 0;

  async getSnapshot(modelCatalog: ModelCatalog): Promise<ModelCatalogSnapshot> {
    if (this.#cachedCatalogResponse && isFresh(this.#cachedCatalogResponse)) {
      return this.#cachedCatalogResponse;
    }
    if (this.#inflightCatalogResponse) {
      return this.#inflightCatalogResponse;
    }

    const generation = this.#generation;
    this.#inflightCatalogResponse = buildCatalogResponse(modelCatalog)
      .then((snapshot) => {
        if (this.#generation === generation) {
          this.#cachedCatalogResponse = snapshot;
        }
        return snapshot;
      })
      .finally(() => {
        if (this.#generation === generation) {
          this.#inflightCatalogResponse = null;
        }
      });

    return this.#inflightCatalogResponse;
  }

  clear(): void {
    this.#generation += 1;
    this.#cachedCatalogResponse = null;
    this.#inflightCatalogResponse = null;
  }
}

export function catalogResponseFromSnapshot(request: Request, snapshot: ModelCatalogSnapshot): Response {
  const headers = {
    ...CATALOG_RESPONSE_HEADERS,
    ETag: snapshot.etag,
  };

  if (etagMatches(request, snapshot.etag)) {
    return new Response(null, { status: 304, headers });
  }

  return Response.json(snapshot.body, { headers });
}
