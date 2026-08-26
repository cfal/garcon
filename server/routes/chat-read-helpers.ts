import { InvalidChatIdError } from '../../common/chat-id.js';
import { ValidationDomainError } from '../lib/domain-error.js';

export function requiredSingleParameter(parameters: URLSearchParams, name: string): string {
  const values = parameters.getAll(name);
  if (values.length !== 1 || values[0].length === 0) {
    throw new ValidationDomainError(`${name} query parameter is required exactly once`);
  }
  return values[0];
}

export function normalizeChatIdError(error: unknown): unknown {
  return error instanceof InvalidChatIdError
    ? new ValidationDomainError(error.message)
    : error;
}

export function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
