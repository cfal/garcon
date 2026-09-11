import { AgentIntegrationError, MAX_TEXT_GENERATION_TIMEOUT_MS, type AgentAdmittedEndpoint, type AgentTextGeneration } from '@garcon/server-agent-interface';
import { withSingleQueryControl } from '../shared/single-query-control.js';
import { classifyDirectIntegrationError } from './errors.js';

export function createDirectTextGeneration(
  runtime: { runSingleQuery(prompt: string, endpoint: AgentAdmittedEndpoint, options: Record<string, unknown>): Promise<string> },
): AgentTextGeneration {
  return {
    async run(input) {
      input.signal.throwIfAborted();
      const { signal: callerSignal, ...values } = input;
      const request = structuredClone(values);
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TEXT_GENERATION_TIMEOUT_MS) {
        throw new TypeError('Invalid text generation timeout');
      }
      return withSingleQueryControl({ signal: callerSignal, timeoutMs: request.timeoutMs }, async (signal) => {
        const endpoint = request.endpoint;
        signal.throwIfAborted();
        if (!endpoint) throw new AgentIntegrationError('INVALID_ENDPOINT', 'Text generation requires an API provider endpoint', false);
        try {
          const result = await runtime.runSingleQuery(request.prompt, endpoint, {
            model: request.model, thinkingMode: request.thinkingMode, timeoutMs: request.timeoutMs, signal,
          });
          signal.throwIfAborted();
          return result;
        } catch (error) {
          signal.throwIfAborted();
          throw classifyDirectIntegrationError(error);
        }
      });
    },
  };
}
