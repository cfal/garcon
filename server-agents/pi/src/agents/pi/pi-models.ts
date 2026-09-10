import { setTimeout as delay } from 'node:timers/promises';
import type { SharedModelOption } from '@garcon/common/models';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { PiConfig } from '../../config.js';

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export class PiModelDiscoveryUnavailableError extends Error {
  readonly code = 'PI_MODEL_DISCOVERY_UNAVAILABLE';
  readonly staleModels: SharedModelOption[];

  constructor(message: string, staleModels: SharedModelOption[]) {
    super(message);
    this.name = 'PiModelDiscoveryUnavailableError';
    this.staleModels = structuredClone(staleModels);
  }
}

export async function getPiAvailableModels(signal: AbortSignal = new AbortController().signal): Promise<SharedModelOption[]> {
  signal.throwIfAborted();
  const { readPiModelsFromSdk } = await import('./pi-models-sdk.js');
  return readPiModelsFromSdk(signal);
}

interface PiModelDiscovery {
  readonly controller: AbortController;
  readonly promise: Promise<SharedModelOption[]>;
  readers: number;
  settled: boolean;
}

export class PiModelCatalogService {
  #cachedModels: SharedModelOption[] | null = null;
  #cachedAt = 0;
  #lastKnownGoodModels: SharedModelOption[] | null = null;
  #inflight: PiModelDiscovery | null = null;

  constructor(
    private readonly config: Pick<PiConfig, 'isTestEnvironment'>,
    private readonly discover: (signal: AbortSignal) => Promise<SharedModelOption[]> = getPiAvailableModels,
  ) {}

  async getModelsStrict(signal: AbortSignal = new AbortController().signal): Promise<SharedModelOption[]> {
    signal.throwIfAborted();
    if (this.#cachedModels && Date.now() - this.#cachedAt < MODEL_CACHE_TTL_MS) {
      return structuredClone(this.#cachedModels);
    }
    const discovery = this.#inflight ?? this.#startDiscovery();
    const models = await this.#joinDiscovery(discovery, signal);
    signal.throwIfAborted();
    return structuredClone(models);
  }

  async getModels(signal: AbortSignal = new AbortController().signal): Promise<SharedModelOption[]> {
    try {
      return await this.getModelsStrict(signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (isPiModelDiscoveryUnavailableError(error)) return structuredClone(error.staleModels);
      return structuredClone(this.#lastKnownGoodModels ?? []);
    }
  }

  clearForTests(): void {
    this.#inflight?.controller.abort();
    this.#cachedModels = null;
    this.#cachedAt = 0;
    this.#lastKnownGoodModels = null;
    this.#inflight = null;
  }

  expireForTests(): void {
    this.#cachedAt = 0;
  }

  #startDiscovery(): PiModelDiscovery {
    const controller = new AbortController();
    const discovery: PiModelDiscovery = {
      controller, promise: this.#discoverWithRetry(controller.signal), readers: 0, settled: false,
    };
    this.#inflight = discovery;
    const finish = () => {
      discovery.settled = true;
      if (this.#inflight === discovery) this.#inflight = null;
    };
    void discovery.promise.then(finish, finish);
    return discovery;
  }

  #joinDiscovery(discovery: PiModelDiscovery, signal: AbortSignal): Promise<SharedModelOption[]> {
    discovery.readers += 1;
    return new Promise((resolve, reject) => {
      let waiting = true;
      const release = () => {
        waiting = false;
        discovery.readers -= 1;
        signal.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        if (!waiting) return;
        release();
        if (discovery.readers === 0 && !discovery.settled) {
          if (this.#inflight === discovery) this.#inflight = null;
          discovery.controller.abort(signal.reason);
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void discovery.promise.then((models) => {
        if (!waiting) return;
        release();
        resolve(models);
      }, (error) => {
        if (!waiting) return;
        release();
        reject(error);
      });
    });
  }

  #cache(models: SharedModelOption[]): SharedModelOption[] {
    this.#cachedModels = structuredClone(models);
    this.#cachedAt = Date.now();
    this.#lastKnownGoodModels = this.#cachedModels.length > 0 ? this.#cachedModels : null;
    return this.#cachedModels;
  }

  async #discoverWithRetry(signal: AbortSignal): Promise<SharedModelOption[]> {
    const retryDelays = this.config.isTestEnvironment() ? [0, 0] : [75, 250];
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      signal.throwIfAborted();
      try {
        const models = await this.discover(signal);
        signal.throwIfAborted();
        return this.#cache(models);
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        lastError = error;
        const retryDelay = retryDelays[attempt];
        if (retryDelay === undefined) break;
        if (retryDelay > 0) await delay(retryDelay, undefined, { signal });
      }
    }
    throw new PiModelDiscoveryUnavailableError(errorMessage(lastError), this.#lastKnownGoodModels ?? []);
  }
}

export function isPiModelDiscoveryUnavailableError(error: unknown): error is PiModelDiscoveryUnavailableError {
  return error instanceof PiModelDiscoveryUnavailableError
    || Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'PI_MODEL_DISCOVERY_UNAVAILABLE');
}
