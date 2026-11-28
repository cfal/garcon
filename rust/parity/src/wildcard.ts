// Recorded values use the rust-anything wildcard convention: `[..]` inside a
// string matches any run of characters, and a value that is exactly `[..]`
// matches any JSON value. Values that differ between two runs of the original
// become wildcards, so they never fail a replay. When both runs show the same
// length and alphabet, the wildcard keeps that shape: `[..hex:44]` matches
// exactly 44 lowercase hexadecimal characters, so a port cannot pass it with
// another length or alphabet.

export const WILDCARD = '[..]';

// The alphabets a shaped wildcard can name, narrowest first and each
// contained in the one after it.
const SHAPES = {
  digits: /^[0-9]+$/,
  hex: /^[0-9a-f]+$/,
  HEX: /^[0-9A-F]+$/,
  base64url: /^[A-Za-z0-9_-]+$/,
} as const;

type Shape = keyof typeof SHAPES;

const SHAPE_SETS: Record<Shape, string> = {
  digits: '[0-9]',
  hex: '[0-9a-f]',
  HEX: '[0-9A-F]',
  base64url: '[A-Za-z0-9_-]',
};

// The names must stay those of SHAPES.
const TOKEN_SOURCE = '\\[\\.\\.(?:(digits|hex|HEX|base64url):(\\d+))?\\]';
const TOKEN = new RegExp(TOKEN_SOURCE, 'g');
const TOKEN_ANYWHERE = new RegExp(TOKEN_SOURCE);

// The narrowest alphabet that holds both values, or none.
function sharedShape(left: string, right: string): Shape | null {
  return (Object.keys(SHAPES) as Shape[]).find((shape) => SHAPES[shape].test(left) && SHAPES[shape].test(right)) ?? null;
}

export function hasWildcard(value: string): boolean {
  return TOKEN_ANYWHERE.test(value);
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type DifferenceKind = 'value' | 'type' | 'missing' | 'extra' | 'length' | 'order';

export interface Difference {
  path: string;
  kind: DifferenceKind;
  expected: string;
  actual: string;
}

export function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: Json | undefined): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

// Moves a split point back to the start of the word it falls inside, so a
// recording never keeps the first characters of a random or clock-derived
// token that happened to match in both runs.
function wordBoundary(text: string, index: number): number {
  let boundary = index;
  while (boundary > 0 && boundary < text.length && WORD_CHARACTER.test(text[boundary - 1]) && WORD_CHARACTER.test(text[boundary])) {
    boundary -= 1;
  }
  return boundary;
}

// Keeps the shared prefix and suffix of two differing strings, so an id inside
// a sentence stays checked everywhere except the word that varied. Where both
// runs vary the same way, in length and alphabet, that much is kept too.
export function mergeStrings(left: string, right: string): string {
  if (left === right) return left;
  const prefix = wordBoundary(left, commonPrefixLength(left, right));
  // The shared suffix, after the prefix, shrunk forward to a word boundary.
  const limit = Math.min(left.length, right.length) - prefix;
  let suffix = 0;
  while (suffix < limit && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  let suffixStart = left.length - suffix;
  while (suffixStart > prefix && suffixStart < left.length
    && WORD_CHARACTER.test(left[suffixStart - 1]) && WORD_CHARACTER.test(left[suffixStart])) {
    suffixStart += 1;
  }
  // Moving the boundary gave characters back to the variable part, in the
  // other run as well.
  const kept = left.length - suffixStart;
  const leftVariable = left.slice(prefix, suffixStart);
  const rightVariable = right.slice(prefix, right.length - kept);
  const shape = leftVariable.length === rightVariable.length ? sharedShape(leftVariable, rightVariable) : null;
  const wildcard = shape === null ? WILDCARD : `[..${shape}:${leftVariable.length}]`;
  return `${left.slice(0, prefix)}${wildcard}${left.slice(suffixStart)}`;
}

// Merges two recordings of the same case into one expectation, turning every
// position where they disagree into a wildcard.
export function mergeRecordings(left: Json | undefined, right: Json | undefined): Json {
  if (left === undefined || right === undefined) return WILDCARD;
  if (typeof left === 'string' && typeof right === 'string') return mergeStrings(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return WILDCARD;
    return left.map((item, index) => mergeRecordings(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return Object.fromEntries([...keys].sort().map((key) => [key, mergeRecordings(
      Object.hasOwn(left, key) ? left[key] : undefined,
      Object.hasOwn(right, key) ? right[key] : undefined,
    )]));
  }
  return Object.is(left, right) ? left : WILDCARD;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stringMatches(pattern: string, actual: string): boolean {
  if (!hasWildcard(pattern)) return pattern === actual;
  let source = '^';
  let copied = 0;
  for (const token of pattern.matchAll(TOKEN)) {
    source += escapeRegExp(pattern.slice(copied, token.index));
    // A shaped wildcard takes exactly its length of its alphabet; the rest take any run.
    source += token[1] === undefined ? '[\\s\\S]*?' : `${SHAPE_SETS[token[1] as Shape]}{${token[2]}}`;
    copied = token.index + token[0].length;
  }
  return new RegExp(`${source}${escapeRegExp(pattern.slice(copied))}$`).test(actual);
}

function describe(value: Json | undefined): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

// Locates where a long string first departs from its expectation and how the
// lengths differ, which is where a body mismatch is visible (the fingerprint
// Anthropic describes for its Rust migration). Wildcard patterns have no fixed
// offsets, so they are not fingerprinted.
function stringFingerprint(expected: string, actual: string): string {
  if (hasWildcard(expected) || (expected.length < 120 && actual.length < 120)) return '';
  const offset = commonPrefixLength(expected, actual);
  const excerpt = JSON.stringify(actual.slice(Math.max(0, offset - 20), offset + 40));
  return ` (first difference at offset ${offset}: ${excerpt}; length ${actual.length}, expected ${expected.length})`;
}

export function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function parseJsonPath(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  const part = /(?:\.([A-Za-z_$][\w$]*)|\[(?:(0|[1-9]\d*)|("(?:[^"\\]|\\.)*"))\])/y;
  for (let at = 1; at < path.length;) {
    part.lastIndex = at;
    const match = part.exec(path);
    if (!match) throw new Error(`Invalid JSON path: ${path}`);
    parts.push(match[1] ?? (match[2] === undefined ? JSON.parse(match[3]!) as string : Number(match[2])));
    at = part.lastIndex;
  }
  if (path !== parts.reduce<string>(childPath, '$')) throw new Error(`Invalid JSON path: ${path}`);
  return parts;
}

// Returns the first position where `actual` departs from `expected`, walking
// object keys in sorted order so reports are stable across runs.
export function firstDifference(
  expected: Json | undefined,
  actual: Json | undefined,
  path = '$',
  approvedPaths?: ReadonlySet<string>,
): Difference | null {
  if (approvedPaths?.has(path)) return null;
  if (expected === WILDCARD) return null;
  if (expected === undefined && actual !== undefined) {
    return { path, kind: 'extra', expected: describe(expected), actual: describe(actual) };
  }
  if (expected !== undefined && actual === undefined) {
    return { path, kind: 'missing', expected: describe(expected), actual: describe(actual) };
  }
  if (typeOf(expected) !== typeOf(actual)) {
    return { path, kind: 'type', expected: describe(expected), actual: describe(actual) };
  }
  if (typeof expected === 'string') {
    if (stringMatches(expected, actual as string)) return null;
    return { path, kind: 'value', expected: describe(expected), actual: `${describe(actual)}${stringFingerprint(expected, actual as string)}` };
  }
  if (Array.isArray(expected)) {
    const actualArray = actual as Json[];
    if (expected.length !== actualArray.length) {
      return {
        path,
        kind: 'length',
        expected: `${expected.length} items`,
        actual: `${actualArray.length} items: ${describe(actualArray)}`,
      };
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], actualArray[index], childPath(path, index), approvedPaths);
      if (difference) return difference;
    }
    return null;
  }
  if (isObject(expected)) {
    const actualObject = actual as { [key: string]: Json };
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actualObject)])].sort();
    for (const key of keys) {
      const before = Object.hasOwn(expected, key) ? expected[key] : undefined;
      const after = Object.hasOwn(actualObject, key) ? actualObject[key] : undefined;
      const difference = firstDifference(before, after, childPath(path, key), approvedPaths);
      if (difference) return difference;
    }
    return null;
  }
  return Object.is(expected, actual)
    ? null
    : { path, kind: 'value', expected: describe(expected), actual: describe(actual) };
}

// Collects every wildcard position in an expectation, which the recorder
// reports as noise so a reviewer can decide whether it is really incidental.
export function wildcardPaths(value: Json, path = '$'): string[] {
  if (value === WILDCARD) return [path];
  if (typeof value === 'string') return hasWildcard(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => wildcardPaths(item, childPath(path, index)));
  if (isObject(value)) {
    return Object.keys(value).sort().flatMap((key) => wildcardPaths(value[key], childPath(path, key)));
  }
  return [];
}
