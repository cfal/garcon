import type { AgentIntegration, AgentSingleQuery } from '@garcon/server-agent-interface';
import type { ProviderSingleQueryRequest, ProviderSingleQueryService } from '../execution-nodes/provider-single-query.js';
import { LocalProviderConfigurationService } from './local-provider-configuration.js';

export class LocalProviderSingleQueryService implements ProviderSingleQueryService {
  readonly #configuration: LocalProviderConfigurationService;

  constructor(
    integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints' | 'sessionConfiguration'>,
    private readonly singleQuery: AgentSingleQuery,
  ) {
    this.#configuration = new LocalProviderConfigurationService(integration);
  }

  get runsToolsWithoutPermission(): boolean {
    return this.singleQuery.runsToolsWithoutPermission === true;
  }

  async run(input: ProviderSingleQueryRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const request = structuredClone(input);
    try {
      const configuration = await this.#configuration.resolve(request.configuration, signal);
      signal.throwIfAborted();
      const result = await this.singleQuery.run({
        prompt: request.prompt,
        projectPath: request.projectPath,
        model: configuration.model,
        thinkingMode: configuration.thinkingMode,
        settings: configuration.settings,
        endpoint: configuration.endpoint,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        signal,
      });
      signal.throwIfAborted();
      if (typeof result !== 'string') throw new TypeError('Invalid single-query response');
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
}
