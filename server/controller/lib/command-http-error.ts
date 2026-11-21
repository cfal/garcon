import { AgentCallError, AgentIntegrationError } from '@garcon/server-agent-interface';
import { CommandRequestValidationError } from '../../../common/chat-command-contracts.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import { CommandValidationError } from './command-validation-error.js';

export function parseCommandRequest<T>(parser: (value: unknown) => T, body: unknown): T {
  try {
    return parser(body);
  } catch (error) {
    if (error instanceof CommandRequestValidationError) {
      throw new ValidationDomainError(error.message);
    }
    throw error;
  }
}

export function commandHttpError(error: unknown): Response {
  if (error instanceof CommandValidationError) {
    return jsonError(error.message, error.status, error.code, error.retryable);
  }
  if (error instanceof AgentIntegrationError && !(error instanceof AgentCallError)) {
    switch (error.code) {
      case 'SESSION_BUSY': return jsonError(error.message, 409, error.code, error.retryable);
      case 'UNAVAILABLE': return jsonError(error.message, 503, error.code, error.retryable);
      case 'TIMEOUT': return jsonError(error.message, 504, error.code, error.retryable);
    }
  }
  return jsonErrorFromUnknown(error);
}
