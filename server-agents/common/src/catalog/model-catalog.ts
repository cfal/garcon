import type { AgentModelOption } from '@garcon/common/agents';
import type { AgentCatalog } from '@garcon/server-agent-interface';

export interface ModelCatalogOptions {
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
      const discovered = await options.discover?.(request) ?? [];
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
