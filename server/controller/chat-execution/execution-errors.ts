import { DomainError } from '../../common/domain-error.js';

export function controlInputBlockedError(): DomainError {
  return new DomainError('SESSION_BUSY', 'Server control input is currently blocked', 409, true);
}

export function serverShuttingDownError(): DomainError {
  return new DomainError('SERVER_SHUTTING_DOWN', 'The server is shutting down', 503, true);
}

export function chatNotFoundError(): DomainError {
  return new DomainError('SESSION_NOT_FOUND', 'Session not found', 404);
}
