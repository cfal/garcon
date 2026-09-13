import {
  AgentIntegrationError,
  MAX_TEXT_GENERATION_TIMEOUT_MS,
  type AgentSingleQueryLifetime,
  type AgentTextGenerationLifetime,
  type AgentAdmittedEndpoint,
} from '@garcon/server-agent-interface';
import { classifyDirectIntegrationError } from './errors.js';
import { DirectNativeQuery } from './native-query.js';

interface DirectQueryRuntime {
  runSingleQuery(prompt: string, endpoint: AgentAdmittedEndpoint, options: Record<string, unknown>, native: DirectNativeQuery): Promise<string>;
}

export function createDirectSingleQueryLifetime(runtime: DirectQueryRuntime): AgentSingleQueryLifetime {
  return { begin(input) {
    const { signal, ...values } = input;
    const request = structuredClone(values);
    return new DirectNativeQuery(signal, request.timeoutMs).begin(async (signal, native) => {
      if (!request.endpoint) throw missingEndpoint();
      try {
        return await runtime.runSingleQuery(request.prompt, request.endpoint, {
          projectPath: request.projectPath, model: request.model, ...request.settings.values,
          thinkingMode: request.thinkingMode, timeoutMs: request.timeoutMs, signal,
        }, native);
      } catch (error) {
        signal.throwIfAborted();
        throw classifyDirectIntegrationError(error);
      }
    });
  } };
}

export function createDirectTextGenerationLifetime(runtime: DirectQueryRuntime): AgentTextGenerationLifetime {
  return { begin(input) {
    const { signal, ...values } = input;
    const request = structuredClone(values);
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TEXT_GENERATION_TIMEOUT_MS) {
      throw new TypeError('Invalid text generation timeout');
    }
    return new DirectNativeQuery(signal, request.timeoutMs).begin(async (signal, native) => {
      if (!request.endpoint) throw missingEndpoint();
      try {
        return await runtime.runSingleQuery(request.prompt, request.endpoint, {
          model: request.model, thinkingMode: request.thinkingMode, timeoutMs: request.timeoutMs, signal,
        }, native);
      } catch (error) {
        signal.throwIfAborted();
        throw classifyDirectIntegrationError(error);
      }
    });
  } };
}

function missingEndpoint(): AgentIntegrationError {
  return new AgentIntegrationError('INVALID_ENDPOINT', 'Direct query requires an API provider endpoint', false);
}
