export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Serializes JSON semantics with recursively sorted object keys. */
export function stableJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Value is not JSON serializable');
  }
  return JSON.stringify(sortJsonValue(JSON.parse(serialized) as JsonValue));
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key]!)]),
  );
}

export function isRecord(value: JsonValue | undefined): value is JsonObject;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
