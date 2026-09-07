import type { ThinkingMode } from '@garcon/common/chat-modes';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentLogger } from '@garcon/server-agent-interface';
import { withAbortableTimeout } from './request-control.js';
import {
  configuredProvidersFromResult,
  connectedProvidersFromListResult,
  modelsFromProviders,
  type OpenCodeModelOption,
} from './model-catalog.js';
import { resolveOpenCodeThinkingVariant } from './thinking-variant.js';

const DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

interface OpenCodeModelCache {
  models: OpenCodeModelOption[];
  fetchedAt: number;
}

export interface OpenCodeModelDiscoveryOptions {
  readonly cacheTtlMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly logger: AgentLogger;
  readonly withClientLease: <T>(operation: (client: any) => Promise<T>) => Promise<T>;
  readonly isAvailable: () => boolean;
  readonly isTemporarilyUnavailable: () => boolean;
  readonly instanceGeneration: () => number;
  readonly markAvailable: (sourceGeneration: number) => void;
  readonly markTemporarilyUnavailable: (reason: string, sourceGeneration: number) => boolean;
  readonly now: () => number;
}

// Cached provider/model discovery with in-flight dedupe. The runtime owns
// availability transitions; this module only reports them.
export class OpenCodeModelDiscovery {
  readonly #options: OpenCodeModelDiscoveryOptions;
  #cache: OpenCodeModelCache | null = null;
  #pending: Promise<OpenCodeModelOption[]> | null = null;

  constructor(options: OpenCodeModelDiscoveryOptions) {
    this.#options = options;
  }

  get models(): OpenCodeModelOption[] {
    return this.#cache?.models ?? [];
  }

  invalidate(): void {
    if (this.#cache) this.#cache.fetchedAt = Number.NEGATIVE_INFINITY;
  }

  async getModels(): Promise<OpenCodeModelOption[]> {
    if (!this.#options.isAvailable()) return [];
    if (this.#options.isTemporarilyUnavailable()) return this.models;
    if (this.#isCacheFresh()) return this.models;
    if (this.#pending) return this.#pending;

    this.#pending = this.#load().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  // Resolves the model's declared thinking modes, discovering once when a
  // warm cache does not contain the model: a cold catalog otherwise passes an
  // above-ceiling mode through unchanged, and OpenCode silently ignores
  // undeclared variant names instead of downgrading them. A model still absent
  // after a fresh discovery stays passthrough; the cache TTL bounds repeats.
  async declaredThinkingModes(model: string): Promise<readonly ThinkingMode[] | undefined> {
    const lookup = () => this.models.find((entry) => entry.value === model)?.thinkingModes;
    const cached = lookup();
    if (cached !== undefined) return cached;
    // A fresh cache without the model means the provider does not list it;
    // only a cold or stale cache justifies one discovery pass.
    if (this.#cache && this.#isCacheFresh()) return undefined;
    await this.getModels();
    return lookup();
  }

  // Effort maps to the model's declared variants; unknown models pass the mode
  // through because the catalog may simply be cold.
  resolveThinkingVariant(
    model: string | undefined,
    thinkingMode: ThinkingMode | undefined,
  ): string | undefined {
    const declared = model
      ? this.models.find((entry) => entry.value === model)?.thinkingModes
      : undefined;
    return resolveOpenCodeThinkingVariant(thinkingMode, declared);
  }

  async resolveThinkingVariantForTurn(
    model: string | undefined,
    thinkingMode: ThinkingMode | undefined,
  ): Promise<string | undefined> {
    if (!model || !thinkingMode || thinkingMode === 'none') {
      return this.resolveThinkingVariant(model, thinkingMode);
    }
    const declared = await this.declaredThinkingModes(model);
    return resolveOpenCodeThinkingVariant(thinkingMode, declared);
  }

  #isCacheFresh(): boolean {
    if (!this.#cache) return false;
    return this.#options.now() - this.#cache.fetchedAt < (this.#options.cacheTtlMs ?? DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS);
  }

  async #load(): Promise<OpenCodeModelOption[]> {
    // A discovery outcome for a retired generation must not touch availability
    // of the replacement; late success would erase its startup cooldown. The
    // generation is read inside the lease, after the instance is installed.
    let generation: number | undefined;
    try {
      const models = await this.#options.withClientLease((client) => {
        generation = this.#options.instanceGeneration();
        return this.#discover(client);
      });
      this.#cache = {
        models,
        fetchedAt: this.#options.now(),
      };
      this.#options.markAvailable(generation ?? this.#options.instanceGeneration());
      return models;
    } catch (err) {
      const reason = errorMessage(err);
      const reported = generation === undefined
        ? this.#options.markTemporarilyUnavailable(reason, this.#options.instanceGeneration())
        : this.#options.markTemporarilyUnavailable(reason, generation);
      if (reported) {
        this.#options.logger.warn('OpenCode model discovery is unavailable', { reason });
      }
      return this.models;
    }
  }

  async #discover(client: any): Promise<OpenCodeModelOption[]> {
    if (typeof client.config?.providers === 'function') {
      const result = await withAbortableTimeout(
        (signal) => client.config.providers(undefined, { signal }),
        this.#options.discoveryTimeoutMs ?? DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
        'OpenCode model discovery',
      );
      return modelsFromProviders(configuredProvidersFromResult(result));
    }

    const result = await withAbortableTimeout(
      (signal) => client.provider.list(undefined, { signal }),
      this.#options.discoveryTimeoutMs ?? DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
      'OpenCode provider list',
    );
    return modelsFromProviders(connectedProvidersFromListResult(result));
  }
}
