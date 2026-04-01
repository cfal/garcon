// Unified model cache for all providers. Claude and Codex models are
// static; OpenCode models are fetched periodically. Serves a single
// GET /api/models endpoint.

import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS } from '../../common/models.js';
import { PROVIDERS, supportsFork, supportsImages } from '../../common/providers.ts';
import { getFactoryDefaultModel } from '../providers/factory-models.js';

const OPENCODE_REFRESH_INTERVAL = 5 * 60 * 1000;

function getDefaultModel(provider, cache, factoryDefaultModel) {
  if (provider === 'claude') return CLAUDE_MODELS.DEFAULT;
  if (provider === 'codex') return CODEX_MODELS.DEFAULT;
  if (provider === 'amp') return AMP_MODELS.DEFAULT;
  if (provider === 'factory') return factoryDefaultModel;
  return cache.opencode[0]?.value ?? '';
}

function buildProviderCatalog(cache, factoryDefaultModel) {
  return {
    providers: PROVIDERS.map((id) => ({
      id,
      supportsFork: supportsFork(id),
      supportsImages: supportsImages(id),
      defaultModel: getDefaultModel(id, cache, factoryDefaultModel),
      models: cache[id] || [],
    })),
  };
}

export default function createModelsRoutes(providers) {
  // Canonical shape: { value: string, label: string }[]
  const cache = {
    claude: CLAUDE_MODELS.OPTIONS,
    codex: CODEX_MODELS.OPTIONS,
    amp: AMP_MODELS.OPTIONS,
    factory: FACTORY_MODELS.OPTIONS,
    opencode: [],
  };
  let factoryDefaultModel = FACTORY_MODELS.DEFAULT;

  async function refreshOpenCodeCache() {
    try {
      cache.opencode = await providers.getModels('opencode');
    } catch (error) {
      console.warn('models: opencode refresh failed:', error.message);
    }
  }

  async function refreshFactoryCache() {
    try {
      cache.factory = await providers.getModels('factory');
      factoryDefaultModel = await getFactoryDefaultModel();
    } catch (error) {
      console.warn('models: factory refresh failed:', error.message);
    }
  }

  async function getModels(request, url) {
    const provider = url?.searchParams?.get('provider');
    if (provider && provider in cache) {
      const catalog = buildProviderCatalog(cache, factoryDefaultModel);
      const filtered = { providers: catalog.providers.filter((p) => p.id === provider) };
      return Response.json({ [provider]: cache[provider], catalog: filtered });
    }
    return Response.json({ ...cache, catalog: buildProviderCatalog(cache, factoryDefaultModel) });
  }

  refreshOpenCodeCache();
  refreshFactoryCache();
  setInterval(refreshOpenCodeCache, OPENCODE_REFRESH_INTERVAL);
  setInterval(refreshFactoryCache, OPENCODE_REFRESH_INTERVAL);

  return {
    '/api/v1/models': { GET: getModels },
  };
}
