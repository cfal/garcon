export type JsonBody = Record<string, unknown>;

export function asJsonBody(value: unknown): JsonBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonBody
    : {};
}

export { errorMessage } from '../lib/errors.js';
