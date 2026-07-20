import type { AgentModelOption } from '@garcon/common/agents';
import type { AgentCatalog, AgentLogger } from '@garcon/server-agent-interface';

export interface ModelCatalogOptions {
  readonly logger: AgentLogger;
  readonly defaultModel: string;
  readonly fallbackModels: readonly AgentModelOption[];
  readonly requiresStrictModelDiscovery: boolean;
  readonly generation: {
    readonly priority: number;
    readonly model: string;
  } | null;
  readonly discover?: (request: {
    readonly strict: boolean;
    readonly signal: AbortSignal;
  }) => Promise<readonly AgentModelOption[]>;
}

export function createModelCatalog(options: ModelCatalogOptions): AgentCatalog {
  return {
    async snapshot(request) {
      request.signal.throwIfAborted();
      let discovered: readonly AgentModelOption[] = [];
      try {
        discovered = await options.discover?.(request) ?? [];
      } catch (error) {
        request.signal.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        if (request.strict) throw error;
        options.logger.warn('Dynamic model discovery failed; using static models.', {
          code: 'MODEL_DISCOVERY_FAILED',
        });
      }
      const models = [...discovered, ...options.fallbackModels].filter(
        (model, index, all) => all.findIndex(
          (candidate) => candidate.value === model.value,
        ) === index,
      );
      return {
        models,
        defaultModel: options.defaultModel,
        requiresStrictModelDiscovery: options.requiresStrictModelDiscovery,
        generation: options.generation,
      };
    },
  };
}
