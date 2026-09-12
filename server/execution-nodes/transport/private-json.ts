import { isNormalizedJsonObject } from '@garcon/server-agent-interface';
import { types } from 'node:util';
import { isRecord } from '../../../common/json.js';

export function exactNodeFields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return isRecord(value) && required.every((key) => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every((key) => typeof key === 'string' && (required.includes(key) || optional.includes(key)));
}

export function nodeString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return nodeText(value, maxLength, allowEmpty) && !value.includes('\0');
}

export function nodeText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || !!value.trim());
}

/** Checks provider data before projection without invoking accessors or proxy traps. */
export function isNodeData(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || types.isProxy(value)) return false;
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (array && keys.length !== value.length + 1) return false;
  return keys.every((key) => {
    if (typeof key !== 'string') return false;
    const property = descriptors[key]!;
    if (!Object.hasOwn(property, 'value')) return false;
    if (array && key === 'length') return true;
    if (!property.enumerable || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false;
    return isNodeData(property.value, depth + 1);
  });
}

/** The caller selects a complete-frame bound before parsing any private input. */
export function parsePrivateNodeJson(text: string, maxBytes: number): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > maxBytes || Buffer.byteLength(text) > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isNormalizedJsonObject(value) ? value : null;
  } catch { return null; }
}
