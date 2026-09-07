import { jsonErrorFromUnknown } from '../lib/http-error.js';
import { CorruptStateFileError } from '../lib/json-file-store.js';

export type JsonBody = Record<string, unknown>;

export function asJsonBody(value: unknown): JsonBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonBody
    : {};
}

export function jsonErrorFromCorruptStateFile(error: unknown): Response | null {
  return error instanceof CorruptStateFileError ? jsonErrorFromUnknown(error) : null;
}

export { errorMessage } from '../lib/errors.js';
