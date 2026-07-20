export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export function isRecord(value: JsonValue | undefined): value is JsonObject;
export function isRecord(value: unknown): value is Record<string, unknown>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
