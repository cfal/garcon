import { AuthStorage, createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { SharedModelOption } from '../../common/models.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const DISCOVERY_RETRY_DELAYS_MS = process.env.NODE_ENV === 'test' ? [0, 0] : [75, 250];

let cachedModels: SharedModelOption[] | null = null;
let cachedAt = 0;
let lastKnownGoodModels: SharedModelOption[] | null = null;
let inflight: Promise<SharedModelOption[]> | null = null;

class PiModelDiscoveryTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiModelDiscoveryTransientError';
  }
}

export class PiModelDiscoveryUnavailableError extends Error {
  readonly code = 'PI_MODEL_DISCOVERY_UNAVAILABLE';
  readonly staleModels: SharedModelOption[];

  constructor(message: string, staleModels: SharedModelOption[]) {
    super(message);
    this.name = 'PiModelDiscoveryUnavailableError';
    this.staleModels = staleModels;
  }
}

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

function diagnosticMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (record.error instanceof Error) return record.error.message;
    if (record.error !== undefined) return String(record.error);
  }
  return String(value);
}

function collectPiDiscoveryDiagnostics(services: any, authStorage: any): string[] {
  const diagnostics: string[] = [];
  const authErrors = typeof authStorage?.drainErrors === 'function'
    ? authStorage.drainErrors()
    : [];
  for (const error of authErrors) {
    diagnostics.push(`auth storage: ${diagnosticMessage(error)}`);
  }

  const modelRegistryError = typeof services?.modelRegistry?.getError === 'function'
    ? services.modelRegistry.getError()
    : undefined;
  if (modelRegistryError) {
    diagnostics.push(`model registry: ${diagnosticMessage(modelRegistryError)}`);
  }

  if (Array.isArray(services?.diagnostics)) {
    for (const diagnostic of services.diagnostics) {
      const message = diagnosticMessage(diagnostic);
      if (message) diagnostics.push(message);
    }
  }

  const settingsErrors = typeof services?.settingsManager?.drainErrors === 'function'
    ? services.settingsManager.drainErrors()
    : [];
  for (const error of settingsErrors) {
    diagnostics.push(`settings: ${diagnosticMessage(error)}`);
  }

  return diagnostics;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPiModelsFromSdk(): Promise<SharedModelOption[]> {
  const authStorage = AuthStorage.create();
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    authStorage,
  });
  const models = services.modelRegistry
    .getAvailable()
    .map(piSdkModelToOption)
    .filter((model): model is SharedModelOption => Boolean(model));
  const diagnostics = collectPiDiscoveryDiagnostics(services, authStorage);
  if (models.length === 0 && diagnostics.length > 0) {
    throw new PiModelDiscoveryTransientError(diagnostics.join('; '));
  }
  return models;
}

export const getPiAvailableModels = readPiModelsFromSdk;

function cacheDiscoveredModels(models: SharedModelOption[]): SharedModelOption[] {
  cachedModels = models;
  cachedAt = Date.now();
  lastKnownGoodModels = models.length > 0 ? models : null;
  return models;
}

async function discoverPiModelsWithRetry(): Promise<SharedModelOption[]> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= DISCOVERY_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return cacheDiscoveredModels(await getPiAvailableModels());
    } catch (error) {
      lastError = error;
      const retryDelay = DISCOVERY_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) break;
      await delay(retryDelay);
    }
  }
  throw new PiModelDiscoveryUnavailableError(errorMessage(lastError), lastKnownGoodModels ?? []);
}

export async function getPiModelsStrict(): Promise<SharedModelOption[]> {
  const now = Date.now();
  if (cachedModels && now - cachedAt < MODEL_CACHE_TTL_MS) return cachedModels;
  if (inflight) return inflight;

  inflight = discoverPiModelsWithRetry()
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

export async function getPiModels(): Promise<SharedModelOption[]> {
  try {
    return await getPiModelsStrict();
  } catch (error) {
    if (isPiModelDiscoveryUnavailableError(error)) {
      return error.staleModels;
    }
    return lastKnownGoodModels ?? [];
  }
}

export function isPiModelDiscoveryUnavailableError(error: unknown): error is PiModelDiscoveryUnavailableError {
  return error instanceof PiModelDiscoveryUnavailableError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PI_MODEL_DISCOVERY_UNAVAILABLE');
}

export function clearPiModelCacheForTests(): void {
  cachedModels = null;
  cachedAt = 0;
  lastKnownGoodModels = null;
  inflight = null;
}

export function expirePiModelCacheForTests(): void {
  cachedAt = 0;
}
