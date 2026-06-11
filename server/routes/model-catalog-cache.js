import crypto from 'crypto';

const MODEL_CATALOG_RESPONSE_CACHE_TTL_MS = 60_000;
const CATALOG_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-cache',
};

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableObject);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = stableObject(value[key]);
  }
  return sorted;
}

function sortedByStringField(items, field) {
  return [...items].sort((left, right) =>
    String(left?.[field] ?? '').localeCompare(String(right?.[field] ?? ''))
  );
}

function catalogForHash(body) {
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

export function createCatalogEtag(body) {
  const canonical = JSON.stringify(catalogForHash(body));
  const hash = crypto.createHash('sha256').update(canonical).digest('base64url');
  return `W/"model-catalog:${hash}"`;
}

function etagMatches(request, etag) {
  const header = request?.headers?.get?.('if-none-match');
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === '*');
}

function isFresh(snapshot) {
  return Date.now() - snapshot.createdAt < MODEL_CATALOG_RESPONSE_CACHE_TTL_MS;
}

async function buildCatalogResponse(modelCatalog) {
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
  #cachedCatalogResponse = null;
  #inflightCatalogResponse = null;

  async getSnapshot(modelCatalog) {
    if (this.#cachedCatalogResponse && isFresh(this.#cachedCatalogResponse)) {
      return this.#cachedCatalogResponse;
    }
    if (this.#inflightCatalogResponse) {
      return this.#inflightCatalogResponse;
    }

    this.#inflightCatalogResponse = buildCatalogResponse(modelCatalog)
      .then((snapshot) => {
        this.#cachedCatalogResponse = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.#inflightCatalogResponse = null;
      });

    return this.#inflightCatalogResponse;
  }

  clear() {
    this.#cachedCatalogResponse = null;
    this.#inflightCatalogResponse = null;
  }
}

export function catalogResponseFromSnapshot(request, snapshot) {
  const headers = {
    ...CATALOG_RESPONSE_HEADERS,
    ETag: snapshot.etag,
  };

  if (etagMatches(request, snapshot.etag)) {
    return new Response(null, { status: 304, headers });
  }

  return Response.json(snapshot.body, { headers });
}
