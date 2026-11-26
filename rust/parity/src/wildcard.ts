// Recorded values use the rust-anything wildcard convention: `[..]` inside a
// string matches any run of characters, and a value that is exactly `[..]`
// matches any JSON value. Values that differ between two runs of the original
// become wildcards, so they never fail a replay.

export const WILDCARD = '[..]';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type DifferenceKind = 'value' | 'type' | 'missing' | 'extra' | 'length';

export interface Difference {
  path: string;
  kind: DifferenceKind;
  expected: string;
  actual: string;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
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
// a sentence stays checked everywhere except the word that varied.
export function mergeStrings(left: string, right: string): string {
  if (left === right) return left;
  const prefix = wordBoundary(left, commonPrefixLength(left, right));
  const leftRest = [...left.slice(prefix)].reverse().join('');
  const rightRest = [...right.slice(prefix)].reverse().join('');
  const suffix = wordBoundary(leftRest, commonPrefixLength(leftRest, rightRest));
  const keptSuffix = [...leftRest.slice(0, suffix)].reverse().join('');
  return `${left.slice(0, prefix)}${WILDCARD}${keptSuffix}`;
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
    const merged: { [key: string]: Json } = {};
    for (const key of [...keys].sort()) merged[key] = mergeRecordings(left[key], right[key]);
    return merged;
  }
  return Object.is(left, right) ? left : WILDCARD;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stringMatches(pattern: string, actual: string): boolean {
  if (!pattern.includes(WILDCARD)) return pattern === actual;
  const source = pattern.split(WILDCARD).map(escapeRegExp).join('[\\s\\S]*?');
  return new RegExp(`^${source}$`).test(actual);
}

function describe(value: Json | undefined): string {
  if (value === undefined) return '(absent)';
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

// Returns the first position where `actual` departs from `expected`, walking
// object keys in sorted order so reports are stable across runs.
export function firstDifference(expected: Json | undefined, actual: Json | undefined, path = '$'): Difference | null {
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
    return stringMatches(expected, actual as string)
      ? null
      : { path, kind: 'value', expected: describe(expected), actual: describe(actual) };
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
      const difference = firstDifference(expected[index], actualArray[index], childPath(path, index));
      if (difference) return difference;
    }
    return null;
  }
  if (isObject(expected)) {
    const actualObject = actual as { [key: string]: Json };
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actualObject)])].sort();
    for (const key of keys) {
      const difference = firstDifference(expected[key], actualObject[key], childPath(path, key));
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
  if (typeof value === 'string') return value.includes(WILDCARD) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => wildcardPaths(item, childPath(path, index)));
  if (isObject(value)) {
    return Object.keys(value).sort().flatMap((key) => wildcardPaths(value[key], childPath(path, key)));
  }
  return [];
}
