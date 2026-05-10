import { AuthStorage, createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { SharedModelOption } from '../../common/models.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedModels: SharedModelOption[] | null = null;
let cachedAt = 0;
let inflight: Promise<SharedModelOption[]> | null = null;

function piModelLabel(provider: string, id: string): string {
  const tokens = id.split('/').filter(Boolean);
  const shortId = tokens[tokens.length - 1] || id;
  return `${provider}: ${shortId}`;
}

function piSdkModelToOption(model: unknown): SharedModelOption | null {
  if (!model || typeof model !== 'object') return null;
  const candidate = model as { provider?: unknown; id?: unknown; input?: unknown };
  if (typeof candidate.provider !== 'string' || typeof candidate.id !== 'string') return null;
  return {
    value: `${candidate.provider}/${candidate.id}`,
    label: piModelLabel(candidate.provider, candidate.id),
    supportsImages: Array.isArray(candidate.input) && candidate.input.includes('image'),
  };
}

async function readPiModelsFromSdk(): Promise<SharedModelOption[]> {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    authStorage: AuthStorage.create(),
  });
  return services.modelRegistry
    .getAvailable()
    .map(piSdkModelToOption)
    .filter((model): model is SharedModelOption => Boolean(model));
}

export const getPiAvailableModels = readPiModelsFromSdk;

export async function getPiModels(): Promise<SharedModelOption[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < MODEL_CACHE_TTL_MS) return cachedModels;
  if (inflight) return inflight;

  inflight = getPiAvailableModels()
    .then((models) => {
      cachedModels = models;
      cachedAt = Date.now();
      return cachedModels;
    })
    .catch(() => [])
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export function clearPiModelCacheForTests(): void {
  cachedModels = null;
  cachedAt = 0;
  inflight = null;
}
