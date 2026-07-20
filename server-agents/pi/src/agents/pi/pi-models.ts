import { createAgentSessionServices, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { SharedModelOption } from '@garcon/common/models';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { PiConfig } from '../../config.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

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

interface PiDiagnosticServices {
  diagnostics?: unknown[];
  modelRuntime?: { getError?: () => unknown };
  settingsManager?: { drainErrors?: () => unknown[] };
}

function collectPiDiscoveryDiagnostics(services: PiDiagnosticServices): string[] {
  const diagnostics: string[] = [];

  const modelRuntimeError = typeof services?.modelRuntime?.getError === 'function'
    ? services.modelRuntime.getError()
    : undefined;
  if (modelRuntimeError) {
    diagnostics.push(`model runtime: ${diagnosticMessage(modelRuntimeError)}`);
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

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPiModelsFromSdk(): Promise<SharedModelOption[]> {
  const services = await createAgentSessionServices({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
  });
  const available = await services.modelRuntime.getAvailable();
  const models = available
    .map(piSdkModelToOption)
    .filter((model): model is SharedModelOption => Boolean(model));
  const diagnostics = collectPiDiscoveryDiagnostics(services);
  if (models.length === 0 && diagnostics.length > 0) {
    throw new PiModelDiscoveryTransientError(diagnostics.join('; '));
  }
  return models;
}

export const getPiAvailableModels = readPiModelsFromSdk;

export class PiModelCatalogService {
  #cachedModels: SharedModelOption[] | null = null;
  #cachedAt = 0;
  #lastKnownGoodModels: SharedModelOption[] | null = null;
  #inflight: Promise<SharedModelOption[]> | null = null;

  constructor(
    private readonly config: PiConfig,
    private readonly discover: () => Promise<SharedModelOption[]> = getPiAvailableModels,
  ) {}

  async getModelsStrict(): Promise<SharedModelOption[]> {
    const now = Date.now();
    if (this.#cachedModels && now - this.#cachedAt < MODEL_CACHE_TTL_MS) {
      return this.#cachedModels;
    }
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.#discoverWithRetry().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async getModels(): Promise<SharedModelOption[]> {
    try {
      return await this.getModelsStrict();
    } catch (error) {
      if (isPiModelDiscoveryUnavailableError(error)) return error.staleModels;
      return this.#lastKnownGoodModels ?? [];
    }
  }

  clearForTests(): void {
    this.#cachedModels = null;
    this.#cachedAt = 0;
    this.#lastKnownGoodModels = null;
    this.#inflight = null;
  }

  expireForTests(): void {
    this.#cachedAt = 0;
  }

  #cache(models: SharedModelOption[]): SharedModelOption[] {
    this.#cachedModels = models;
    this.#cachedAt = Date.now();
    this.#lastKnownGoodModels = models.length > 0 ? models : null;
    return models;
  }

  async #discoverWithRetry(): Promise<SharedModelOption[]> {
    const retryDelays = this.config.isTestEnvironment() ? [0, 0] : [75, 250];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return this.#cache(await this.discover());
      } catch (error) {
        lastError = error;
        const retryDelay = retryDelays[attempt];
        if (retryDelay === undefined) break;
        await delay(retryDelay);
      }
    }
    throw new PiModelDiscoveryUnavailableError(
      errorMessage(lastError),
      this.#lastKnownGoodModels ?? [],
    );
  }
}

export function isPiModelDiscoveryUnavailableError(error: unknown): error is PiModelDiscoveryUnavailableError {
  return error instanceof PiModelDiscoveryUnavailableError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PI_MODEL_DISCOVERY_UNAVAILABLE');
}
