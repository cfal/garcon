// Unified model cache for all providers. Claude and Codex models are
// static; OpenCode models are fetched periodically. Serves a single
// GET /api/models endpoint.

import { CLAUDE_MODELS, CODEX_MODELS } from '../../common/models.js';
import { PROVIDERS, supportsFork, supportsImages } from '../../common/providers.ts';

const OPENCODE_REFRESH_INTERVAL = 5 * 60 * 1000;

function getDefaultModel(provider, cache) {
  if (provider === 'claude') return CLAUDE_MODELS.DEFAULT;
  if (provider === 'codex') return CODEX_MODELS.DEFAULT;
  return cache.opencode[0]?.value ?? '';
}

function buildProviderCatalog(cache) {
  return {
    providers: PROVIDERS.map((id) => ({
      id,
      supportsFork: supportsFork(id),
      supportsImages: supportsImages(id),
      defaultModel: getDefaultModel(id, cache),
      models: cache[id] || [],
    })),
  };
}

export default function createModelsRoutes(providers) {
  // Canonical shape: { value: string, label: string }[]
  const cache = {
    claude: CLAUDE_MODELS.OPTIONS,
    codex: CODEX_MODELS.OPTIONS,
    opencode: [],
  };

  async function refreshOpenCodeCache() {
    try {
      cache.opencode = await providers.getModels('opencode');
    } catch (error) {
      console.warn('models: opencode refresh failed:', error.message);
    }
  }

  async function getModels(request, url) {
    const provider = url?.searchParams?.get('provider');
    if (provider && cache[provider]) {
      const catalog = buildProviderCatalog(cache);
      const filtered = { providers: catalog.providers.filter((p) => p.id === provider) };
      return Response.json({ [provider]: cache[provider], catalog: filtered });
    }
    return Response.json({ ...cache, catalog: buildProviderCatalog(cache) });
  }

  refreshOpenCodeCache();
  setInterval(refreshOpenCodeCache, OPENCODE_REFRESH_INTERVAL);

  return {
    '/api/v1/models': { GET: getModels },
  };
}
