import { AgentIntegrationError } from '@garcon/server-agent-interface';

export function classifyDirectIntegrationError(error: unknown): AgentIntegrationError {
  if (error instanceof AgentIntegrationError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const code = normalized.includes('401')
    || normalized.includes('unauthorized')
    || normalized.includes('forbidden')
    || normalized.includes('auth')
    || normalized.includes('api key')
    ? 'AUTH_REQUIRED'
    : normalized.includes('429')
      || normalized.includes('rate limit')
      || normalized.includes('quota')
      || normalized.includes('too many requests')
      ? 'RATE_LIMITED'
      : normalized.includes('timed out')
        || normalized.includes('timeout')
        || normalized.includes('deadline')
        || normalized.includes('etimedout')
        ? 'TIMEOUT'
        : normalized.includes('service unavailable')
          || normalized.includes('unavailable')
          || normalized.includes('econnrefused')
          || normalized.includes('enotfound')
          || normalized.includes('network')
          ? 'UNAVAILABLE'
          : 'PROVIDER_FAILURE';
  return new AgentIntegrationError(code, message, code !== 'AUTH_REQUIRED');
}
