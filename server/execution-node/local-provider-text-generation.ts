import { MAX_TEXT_GENERATION_TIMEOUT_MS, type AgentIntegration, type AgentTextGeneration } from '@garcon/server-agent-interface';
import type { ProviderTextGenerationRequest, ProviderTextGenerationService } from '../execution-nodes/provider-text-generation.js';
import { LocalProviderConfigurationService } from './local-provider-configuration.js';

export class LocalProviderTextGenerationService implements ProviderTextGenerationService {
  readonly #configuration: LocalProviderConfigurationService;

  constructor(
    integration: Pick<AgentIntegration, 'descriptor' | 'settings' | 'endpoints'>,
    private readonly textGeneration: AgentTextGeneration,
  ) {
    this.#configuration = new LocalProviderConfigurationService(integration);
  }

  async run(input: ProviderTextGenerationRequest, callerSignal: AbortSignal): Promise<string> {
    callerSignal.throwIfAborted();
    const request = structuredClone(input);
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TEXT_GENERATION_TIMEOUT_MS) {
      throw new TypeError('Invalid text generation timeout');
    }
    const deadline = new AbortController();
    const signal = AbortSignal.any([callerSignal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new DOMException('Text generation timed out', 'TimeoutError')), request.timeoutMs);
    timer.unref();
    const aborted = Promise.withResolvers<never>();
    const onAbort = () => aborted.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await Promise.race([this.#run(request, signal), aborted.promise]);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async #run(request: ProviderTextGenerationRequest, signal: AbortSignal): Promise<string> {
    const configuration = await this.#configuration.resolve(request.configuration, signal);
    signal.throwIfAborted();
    const result = await this.textGeneration.run({
      prompt: request.prompt,
      model: configuration.model,
      thinkingMode: configuration.thinkingMode,
      settings: configuration.settings,
      endpoint: configuration.endpoint,
      timeoutMs: request.timeoutMs,
      signal,
    });
    signal.throwIfAborted();
    if (typeof result !== 'string') throw new TypeError('Invalid text generation response');
    return result;
  }
}
