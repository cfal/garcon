// Unified model cache for all providers. Claude and Codex models are
// static; OpenCode models are fetched periodically. Serves a single
// GET /api/models endpoint.

import { CLAUDE_MODELS, CODEX_MODELS } from '../../common/models.js';

const OPENCODE_REFRESH_INTERVAL = 5 * 60 * 1000;

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
      return Response.json({ [provider]: cache[provider] });
    }
    return Response.json(cache);
  }

  refreshOpenCodeCache();
  setInterval(refreshOpenCodeCache, OPENCODE_REFRESH_INTERVAL);

  return {
    '/api/v1/models': { GET: getModels },
  };
}
