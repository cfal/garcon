import { isRecord, type JsonObject } from '@garcon/common/json';

export function isNormalizedJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && jsonValue(value, 0);
}

function jsonValue(value: unknown, depth: number): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || typeof (value as { toJSON?: unknown }).toJSON === 'function') return false;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.keys(value).length !== value.length) return false;
    for (const item of value) if (!jsonValue(item, depth + 1)) return false;
    return true;
  }
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
