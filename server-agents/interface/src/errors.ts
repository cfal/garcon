import type { JsonObject } from '@garcon/common/json';

export type AgentIntegrationErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_LOGIN_SESSION_MISMATCH'
  | 'BINARY_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INVALID_SETTINGS'
  | 'INVALID_ENDPOINT'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_BUSY'
  | 'PERMISSION_DENIED'
  | 'TRANSCRIPT_UNAVAILABLE'
  | 'SEARCH_DISABLED'
  | 'SEARCH_UNAVAILABLE'
  | 'SOURCE_REVISION_CHANGED'
  | 'OPERATION_UNSUPPORTED'
  | 'PROVIDER_FAILURE';

export class AgentIntegrationError extends Error {
  constructor(
    readonly code: AgentIntegrationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly details?: JsonObject,
  ) {
    super(message);
    this.name = 'AgentIntegrationError';
  }
}

export const AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE = Object.freeze({
  operation: 'single-query',
  setting: 'thinkingMode',
}) satisfies JsonObject;

export function isUnsupportedSingleQueryThinkingMode(
  error: unknown,
): error is AgentIntegrationError {
  return error instanceof AgentIntegrationError
    && error.code === 'OPERATION_UNSUPPORTED'
    && error.details?.operation === AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE.operation
    && error.details?.setting === AGENT_UNSUPPORTED_SINGLE_QUERY_THINKING_MODE.setting;
}
