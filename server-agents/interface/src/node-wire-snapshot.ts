import { isRecord, type JsonObject } from '@garcon/common/json';

export const MAX_NODE_OUTPUT_BYTES = 16 * 1024 * 1024;
// Bounds traversal independently of bytes; dense JSON may reach this limit first.
const MAX_NODE_SNAPSHOT_VALUES = 262_144;

/** Bounds data traversal across one complete event, including repeated references. */
export class NodeWireSnapshot {
  #values = MAX_NODE_SNAPSHOT_VALUES;
  #characters = MAX_NODE_OUTPUT_BYTES;

  value(value: unknown): unknown {
    return this.#value(value, 0);
  }

  message(value: unknown): JsonObject {
    return JSON.parse(JSON.stringify(this.#message(value, 0)));
  }

  captureEnvelope(value: unknown, fields: readonly string[]): Record<string, unknown> {
    this.#consumeValue(0);
    if (!isRecord(value)) throw new TypeError('Invalid normalized provider output');
    requirePlainObject(value);
    return this.#properties(value, (key, child) => {
      if (child !== undefined && !fields.includes(key)) throw new TypeError('Invalid normalized provider output');
      return child;
    });
  }

  array<T>(value: unknown, copy: (item: unknown) => T): T[] {
    this.#consumeValue(0);
    if (!Array.isArray(value)) throw new TypeError('Invalid normalized provider output');
    requirePlainObject(value);
    rejectCustomSerializer(value);
    const length = value.length;
    if (length > this.#values) throw new RangeError('Node output exceeds the snapshot value limit');
    const result = [];
    for (let index = 0; index < length; index += 1) {
      this.#consumeValue(1);
      result.push(copy(value[index]));
    }
    return result;
  }

  #value(value: unknown, depth: number): unknown {
    this.#consumeValue(depth);
    if (typeof value === 'string') this.#consumeCharacters(value.length);
    if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value !== 'object') throw new TypeError('Invalid normalized node data');
    requirePlainObject(value);
    if (Array.isArray(value)) {
      rejectCustomSerializer(value);
      const length = value.length;
      if (length > this.#values) throw new RangeError('Node output exceeds the snapshot value limit');
      const items = [];
      for (let index = 0; index < length; index += 1) items.push(this.#value(value[index], depth + 1));
      return items;
    }
    return this.#properties(value, (_key, child) => this.#value(child, depth + 1));
  }

  #message(value: unknown, depth: number): Record<string, unknown> {
    this.#consumeValue(depth);
    if (!isRecord(value)) throw new TypeError('Invalid normalized provider message');
    // Only message roots and their typed requestedTool may carry shared class prototypes.
    const type = value.type;
    return this.#properties(value, (key, child) => key === 'requestedTool' && type === 'permission-request'
      ? this.#message(child, depth + 1)
      : this.#value(child, depth + 1), { type });
  }

  #properties(
    value: object,
    copy: (key: string, child: unknown) => unknown,
    captured: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const toJSON = rejectCustomSerializer(value);
    const result: Record<string, unknown> = {};
    for (const key in value) {
      this.#consumeValue(0);
      this.#consumeCharacters(key.length);
      if (!Object.hasOwn(value, key)) continue;
      const child = key === 'toJSON' ? toJSON : Object.hasOwn(captured, key) ? captured[key] : (value as Record<string, unknown>)[key];
      Object.defineProperty(result, key, { value: copy(key, child), enumerable: true, writable: true, configurable: true });
    }
    return result;
  }

  #consumeValue(depth: number): void {
    if (--this.#values < 0) throw new RangeError('Node output exceeds the snapshot value limit');
    if (depth > 100) throw new TypeError('Node output exceeds the nesting limit');
  }

  #consumeCharacters(count: number): void {
    this.#characters -= count;
    if (this.#characters < 0) throw new RangeError('Node output exceeds the frame limit');
  }
}

function requirePlainObject(value: object): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype)) {
    throw new TypeError('Node output requires plain objects and arrays');
  }
}

function rejectCustomSerializer(value: object): unknown {
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') throw new TypeError('Node output forbids custom serialization');
  return toJSON;
}
