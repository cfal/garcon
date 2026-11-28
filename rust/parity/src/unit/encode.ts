import { childPath, type Json } from '../wildcard.js';

// A value JSON cannot hold is written as a marker: an object whose `$` key
// names the kind and whose other keys carry the content. A plain object that
// has a `$` property of its own is wrapped in an `object` marker, so a marker
// is never ambiguous. The Rust reader knows the same markers (garcon-cases).

const MARKER = '$';
export const INSTANCES_VARIABLE = 'GARCON_UNIT_RECORD_INSTANCES';

export function recordLine(value: object): string {
  // Bun's readline sees these as line breaks even inside JSON strings.
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + '\n';
}

// An Error's `name` and `message` are recorded apart. Its `stack` and the
// other properties Bun adds for the position it was thrown at are not part of
// what the original threw; `cause` and an AggregateError's `errors` are.
const ERROR_KEYS_APART = new Set([
  'name', 'message', 'stack', 'originalLine', 'originalColumn', 'line', 'column', 'sourceURL',
]);

export type EncodeFailure = {
  path: string;
  type: string;
};

export type EncodedValue = { ok: true; value: Json } | { ok: false; failure: EncodeFailure };
type Outcome = { kind: 'return' | 'throw'; value: unknown };

class NotEncodable extends Error {
  constructor(readonly failure: EncodeFailure) {
    super();
  }
}

function typeName(value: object): string {
  const constructor = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)
    ?.constructor;
  return typeof constructor?.name === 'string' && constructor.name
    ? constructor.name
    : Object.prototype.toString.call(value).slice(8, -1);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function encodeNumber(value: number): Json {
  if (Number.isNaN(value)) return { [MARKER]: 'number', value: 'NaN' };
  if (value === Infinity) return { [MARKER]: 'number', value: 'Infinity' };
  if (value === -Infinity) return { [MARKER]: 'number', value: '-Infinity' };
  if (Object.is(value, -0)) return { [MARKER]: 'number', value: '-0' };
  return value;
}

export function encodeString(value: string): Json {
  if (value.isWellFormed()) return value;
  return {
    [MARKER]: 'utf16',
    value: Array.from({ length: value.length }, (_, index) => value.charCodeAt(index)),
    // The Rust text reader borrows this projection without losing the original units.
    text: value.toWellFormed(),
  };
}

function decodeNumber(text: string): number {
  switch (text) {
    case 'NaN': return NaN;
    case 'Infinity': return Infinity;
    case '-Infinity': return -Infinity;
    case '-0': return -0;
    default: throw new Error(`Unknown number marker: ${text}`);
  }
}

function encodedProperties(entries: readonly (readonly [string, Json])[]): Json {
  if (entries.some(([key]) => !key.isWellFormed())) {
    return { [MARKER]: 'object-entries', value: entries.map(([key, value]) => [encodeString(key), value]) };
  }
  const values = Object.fromEntries(entries);
  return Object.hasOwn(values, MARKER) ? { [MARKER]: 'object', value: values } : values;
}

// Explicit inputs can spell a string with a raw escaped lone surrogate
// instead of a marker. Existing markers remain encoded.
export function normalizeInputStrings(value: Json): Json {
  if (typeof value === 'string') return encodeString(value);
  if (Array.isArray(value)) return value.map(normalizeInputStrings);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, normalizeInputStrings(item)] as const);
    if (entries.some(([key]) => !key.isWellFormed())) return encodedProperties(entries);
    return Object.fromEntries(entries);
  }
  return value;
}

function encodeFields(
  object: object, keys: string[], path: string, seen: Set<object>, instances: boolean,
): Json {
  const record = object as Record<string, unknown>;
  return encodedProperties(keys.map((key) => [key, encodeInto(record[key], childPath(path, key), seen, instances)]));
}

export function encodeError(error: Error, path: string, seen: Set<object>, instances = false): Json {
  const keys = Object.getOwnPropertyNames(error).filter((key) => !ERROR_KEYS_APART.has(key));
  const properties = encodeFields(error, keys, `${path}.properties`, seen, instances);
  return { [MARKER]: 'error', name: encodeString(String(error.name)), message: encodeString(String(error.message)), properties };
}

// A thrown value: an Error with its name, message, and own enumerable
// properties; anything else as the value itself.
export function encodeThrown(value: unknown, path: string, seen: Set<object>): Json {
  return value instanceof Error ? encodeError(value, path, seen) : { [MARKER]: 'throw', value: encodeInto(value, path, seen) };
}

function encodeInto(value: unknown, path: string, seen: Set<object>, instances = false): Json {
  if (value === undefined) return { [MARKER]: 'undefined' };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') return encodeNumber(value);
  if (typeof value === 'bigint') return { [MARKER]: 'bigint', value: String(value) };
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new NotEncodable({ path, type: `a ${typeof value}` });
  }
  const object = value as object;
  if (seen.has(object)) throw new NotEncodable({ path, type: 'a circular reference' });
  seen.add(object);
  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new NotEncodable({ path, type: 'an invalid Date' });
      return { [MARKER]: 'date', value: value.toISOString() };
    }
    if (value instanceof Error) return encodeError(value, path, seen, instances);
    if (value instanceof Uint8Array) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
      // A Buffer is a Uint8Array the original can tell apart (`Buffer.isBuffer`).
      return Buffer.isBuffer(value)
        ? { [MARKER]: 'bytes', value: bytes, buffer: true }
        : { [MARKER]: 'bytes', value: bytes };
    }
    if (value instanceof Map) {
      return {
        [MARKER]: 'map',
        value: [...value].map(([key, item], index) => [
          encodeInto(key, `${path}.entries[${index}].key`, seen, instances),
          encodeInto(item, `${path}.entries[${index}].value`, seen, instances),
        ]),
      };
    }
    if (value instanceof Set) {
      return { [MARKER]: 'set', value: [...value].map((item, index) => encodeInto(item, `${path}[${index}]`, seen, instances)) };
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => encodeInto(item, `${path}[${index}]`, seen, instances));
    }
    if (isPlainObject(object)) {
      if (Object.getOwnPropertySymbols(object).length > 0) {
        throw new NotEncodable({ path, type: 'an object with symbol-keyed properties' });
      }
      return encodeFields(object, Object.keys(object), path, seen, instances);
    }
    if (instances) {
      if (Object.getOwnPropertySymbols(object).some((key) => Object.prototype.propertyIsEnumerable.call(object, key))) {
        throw new NotEncodable({ path, type: 'an instance with enumerable symbol-keyed properties' });
      }
      return {
        [MARKER]: 'instance',
        name: encodeString(typeName(object)),
        fields: encodeFields(object, Object.keys(object), `${path}.fields`, seen, instances),
      };
    }
    throw new NotEncodable({ path, type: `a ${typeName(object)} instance` });
  } finally {
    seen.delete(object);
  }
}

function decodeError(marker: Record<string, Json>): Error {
  const name = String(decode(marker.name));
  const message = String(decode(marker.message));
  const candidate = (globalThis as Record<string, unknown>)[name] as (new (text: string) => unknown) | undefined;
  let error: Error = new Error(message);
  if (typeof candidate === 'function') {
    try {
      const built = Reflect.construct(candidate, [message]);
      if (built instanceof Error) error = built;
    } catch { /* A constructor that takes other arguments builds a plain Error. */ }
  }
  if (error.name !== name) {
    Object.defineProperty(error, 'name', { value: name, writable: true, enumerable: true, configurable: true });
  }
  const properties = decode(marker.properties) as Record<string, unknown>;
  for (const [key, value] of Object.entries(properties ?? {})) {
    Object.defineProperty(error, key, { value, writable: true, configurable: true, enumerable: true });
  }
  return error;
}

export function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (typeof value !== 'object' || value === null) return value;
  const kind = value[MARKER];
  if (typeof kind !== 'string') {
    if (kind !== undefined) throw new Error(`Not a marker: ${JSON.stringify(value)}`);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  switch (kind) {
    case 'undefined': return undefined;
    case 'number': return decodeNumber(String(value.value));
    case 'utf16': {
      if (!Array.isArray(value.value)) throw new Error('Invalid UTF-16 marker');
      return value.value.map((unit) => {
        if (typeof unit !== 'number' || !Number.isInteger(unit) || unit < 0 || unit > 0xffff) throw new Error('Invalid UTF-16 code unit');
        return String.fromCharCode(unit);
      }).join('');
    }
    case 'bigint': return BigInt(String(value.value));
    case 'date': return new Date(String(value.value));
    case 'bytes': {
      const bytes = Buffer.from(String(value.value), 'base64');
      return value.buffer === true ? bytes : new Uint8Array(bytes);
    }
    case 'map': return new Map((value.value as Json[]).map((entry) => (entry as Json[]).map(decode) as [unknown, unknown]));
    case 'set': return new Set((value.value as Json[]).map(decode));
    case 'error': return decodeError(value);
    // The wrapped object has a `$` property of its own, which is data here.
    case 'object': return Object.fromEntries(
      Object.entries(value.value as Record<string, Json>).map(([key, item]) => [key, decode(item)]),
    );
    case 'object-entries': return Object.fromEntries(
      (value.value as Json[][]).map(([key, item]) => [String(decode(key)), decode(item)]),
    );
    case 'throw': return decode(value.value);
    default: throw new Error(`Unknown marker: ${kind}`);
  }
}

export function encode(value: unknown, path = '$'): EncodedValue {
  try {
    return { ok: true, value: encodeInto(value, path, new Set()) };
  } catch (error) {
    if (error instanceof NotEncodable) return { ok: false, failure: error.failure };
    return { ok: false, failure: { path, type: `unreadable (${error instanceof Error ? error.message : String(error)})` } };
  }
}

// Encodes one call: its arguments and what it returned or threw. A throw that
// is not an Error keeps its value.
export function encodeCall(args: unknown, outcome: Outcome, instances = false):
  | { ok: true; args: Json; result: Json }
  | { ok: false; where: 'args' | 'result'; failure: EncodeFailure } {
  const encodedArgs = encode(args, '$.args');
  if (!encodedArgs.ok) return { ok: false, where: 'args', failure: encodedArgs.failure };
  const result = encodeOutcome(outcome, instances);
  return result.ok ? { ok: true, args: encodedArgs.value, result: result.value } : { ...result, where: 'result' };
}

export function encodeOutcome(outcome: Outcome, instances = false): EncodedValue {
  const seen = new Set<object>();
  try {
    const result = outcome.kind === 'throw'
      ? encodeThrown(outcome.value, '$.result', seen)
      : encodeInto(outcome.value, '$.result', seen, instances);
    return { ok: true, value: result };
  } catch (error) {
    const failure = error instanceof NotEncodable
      ? error.failure
      : { path: '$.result', type: `unreadable (${error instanceof Error ? error.message : String(error)})` };
    return { ok: false, failure };
  }
}
