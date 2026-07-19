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
