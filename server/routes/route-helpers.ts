export type JsonBody = Record<string, unknown>;

export function asJsonBody(value: unknown): JsonBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonBody
    : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
