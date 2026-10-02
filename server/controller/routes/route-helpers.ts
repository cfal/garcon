import { ValidationDomainError } from '../../common/domain-error.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import { CorruptStateFileError } from '../../common/json-file-store.js';

export function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationDomainError(`${field} is required`);
  }
  return value.trim();
}

export type JsonBody = Record<string, unknown>;

export function asJsonBody(value: unknown): JsonBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonBody
    : {};
}

export function jsonErrorFromCorruptStateFile(error: unknown): Response | null {
  return error instanceof CorruptStateFileError ? jsonErrorFromUnknown(error) : null;
}

export { errorMessage } from '../../common/errors.js';
