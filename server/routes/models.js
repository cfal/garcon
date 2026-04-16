// Unified model cache for all providers. Claude and Codex models are
// static; OpenCode models are fetched periodically. Serves a single
// GET /api/models endpoint.

import { AMP_MODELS, CLAUDE_MODELS, CODEX_MODELS, FACTORY_MODELS, OPENROUTER_MODELS, ZAI_MODELS } from '../../common/models.js';
import { PROVIDERS, supportsFork, supportsImages } from '../../common/providers.ts';
import { getFactoryDefaultModel } from '../providers/factory-models.js';

const OPENCODE_REFRESH_INTERVAL = 5 * 60 * 1000;

function getDefaultModel(provider, cache, factoryDefaultModel) {
  if (provider === 'claude') return CLAUDE_MODELS.DEFAULT;
  if (provider === 'codex') return CODEX_MODELS.DEFAULT;
  if (provider === 'amp') return AMP_MODELS.DEFAULT;
  if (provider === 'factory') return factoryDefaultModel;
  if (provider === 'openrouter') return OPENROUTER_MODELS.DEFAULT;
  if (provider === 'zai') return ZAI_MODELS.DEFAULT;
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

export default function createModelsRoutes(providers, ollamaBridge) {
  // Canonical shape: { value: string, label: string }[]
  const cache = {
    claude: CLAUDE_MODELS.OPTIONS,
    codex: CODEX_MODELS.OPTIONS,
    amp: AMP_MODELS.OPTIONS,
    factory: FACTORY_MODELS.OPTIONS,
    openrouter: OPENROUTER_MODELS.OPTIONS,
    zai: ZAI_MODELS.OPTIONS,
    opencode: [],
  };
  let factoryDefaultModel = FACTORY_MODELS.DEFAULT;

  function buildOllamaModelOptions() {
    if (!ollamaBridge?.available) return [];
    return ollamaBridge.getModels().map((m) => ({
      value: m.name,
      label: `${m.name} (local)`,
      isLocal: true,
    }));
  }

  function getCacheWithOllama() {
    const ollamaOptions = buildOllamaModelOptions();
    return {
      ...cache,
      claude: [...CLAUDE_MODELS.OPTIONS, ...ollamaOptions],
      codex: [...CODEX_MODELS.OPTIONS, ...ollamaOptions],
    };
  }

  async function refreshOpenCodeCache() {
    try {
      cache.opencode = await providers.getModels('opencode');
    } catch (error) {
      console.warn('models: opencode refresh failed:', error.message);
    }
  }

  async function refreshOpenRouterCache() {
    try {
      cache.openrouter = await providers.getModels('openrouter');
    } catch (error) {
      console.warn('models: openrouter refresh failed:', error.message);
    }
  }

  async function refreshZaiCache() {
    try {
      cache.zai = await providers.getModels('zai');
    } catch (error) {
      console.warn('models: zai refresh failed:', error.message);
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
    const merged = getCacheWithOllama();
    const provider = url?.searchParams?.get('provider');
    if (provider && provider in merged) {
      const catalog = buildProviderCatalog(merged, factoryDefaultModel);
      const filtered = { providers: catalog.providers.filter((p) => p.id === provider) };
      return Response.json({ [provider]: merged[provider], catalog: filtered });
    }
    return Response.json({ ...merged, catalog: buildProviderCatalog(merged, factoryDefaultModel) });
  }

  refreshOpenCodeCache();
  refreshFactoryCache();
  refreshOpenRouterCache();
  refreshZaiCache();
  setInterval(refreshOpenCodeCache, OPENCODE_REFRESH_INTERVAL);
  setInterval(refreshFactoryCache, OPENCODE_REFRESH_INTERVAL);
  setInterval(refreshOpenRouterCache, OPENCODE_REFRESH_INTERVAL);
  setInterval(refreshZaiCache, OPENCODE_REFRESH_INTERVAL);

  return {
    '/api/v1/models': { GET: getModels },
  };
}
