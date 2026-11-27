import { encodeNumber } from './encode.js';
import { childPath, isObject, type Json } from '../wildcard.js';

// Trap variants probe the edges a port most often gets wrong in text and
// number handling. Each replaces one string or number leaf of a recorded
// call's arguments, keeping everything else.
export const MAX_VARIANTS_PER_FUNCTION = 40;

// Written as escapes, so each code point is explicit: the Kelvin sign is
// U+212A and not the ASCII letter it looks like.
export const STRING_TRAPS: ReadonlyArray<readonly [string, string]> = [
  ['empty', ''],
  ['accented', '\u00DCn\u00EFc\u00F6d\u00E9'],
  ['cjk', '\u65E5\u672C\u8A9E\u96EA'],
  ['astral', '\u{1F600}'],
  ['combining', 'e\u0301'],
  ['dotless-i', '\u0131'],
  ['kelvin', '\u212A'],
  ['nbsp', '\u00A0'],
  ['long', 'x'.repeat(10_000)],
];

export const NUMBER_TRAPS: ReadonlyArray<readonly [string, number]> = [
  ['zero', 0],
  ['negative-zero', -0],
  ['negative-one', -1],
  ['half', 0.5],
  ['1e21', 1e21],
  ['1e-7', 1e-7],
  ['2^53', 2 ** 53],
  ['nan', NaN],
];

export interface Variant {
  args: Json[];
  origin: string;
}

// A leaf's position: the argument index, then each property or array index
// on the way to it. Markers that hold values (map, set, wrapped object) are
// walked through like containers.
type Location = readonly (string | number)[];
type LeafType = 'string' | 'number';
interface Leaf {
  location: Location;
  type: LeafType;
}

function markerKind(value: { [key: string]: Json }): string | null {
  return typeof value.$ === 'string' ? value.$ : null;
}

function collect(value: Json, location: Location, leaves: Leaf[]): void {
  if (typeof value === 'string') {
    leaves.push({ location, type: 'string' });
    return;
  }
  if (typeof value === 'number') {
    leaves.push({ location, type: 'number' });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(item, [...location, index], leaves));
    return;
  }
  if (!isObject(value)) return;
  const kind = markerKind(value);
  if (kind === null || kind === 'map' || kind === 'set' || kind === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key !== '$') collect(item, [...location, key], leaves);
    }
  } else if (kind === 'number') {
    leaves.push({ location, type: 'number' });
  }
}

// Returns a copy of `args` with the leaf at `location` replaced.
export function replaceLeaf(args: Json[], location: Location, replacement: Json): Json[] {
  type Container = Json[] | { [key: string]: Json };
  const rebuild = (value: Json, steps: Location): Json => {
    if (steps.length === 0) return replacement;
    const [step, ...rest] = steps;
    const source = value as Container;
    const copy: Container = Array.isArray(source) ? [...source] : { ...source };
    const cells = copy as unknown as Record<string | number, Json>;
    cells[step!] = rebuild(cells[step!], rest);
    return copy;
  };
  return rebuild(args as unknown as Json, location) as unknown as Json[];
}

export function locationPath(location: Location): string {
  return location.reduce<string>(
    (path, step) => (typeof step === 'number' ? `${path}[${step}]` : childPath(path, step)),
    '$.args',
  );
}

// Generates at most MAX_VARIANTS_PER_FUNCTION variants of the calls of one
// function. The budget is spent breadth first: every position gets the first
// trap before any gets the second, and each position gets it with the first
// call that has it, so many calls with the same shape do not crowd out the
// rest. `isKnown` skips a variant equal to a case already recorded.
export function trapVariants(calls: readonly Json[][], isKnown: (args: Json[]) => boolean): Variant[] {
  const positions = new Map<string, { location: Location; calls: Array<{ type: LeafType; args: Json[] }> }>();
  for (const args of calls) {
    const leaves: Leaf[] = [];
    args.forEach((argument, index) => collect(argument, [index], leaves));
    for (const { location, type } of leaves) {
      const key = JSON.stringify(location);
      const position = positions.get(key) ?? { location, calls: [] };
      position.calls.push({ type, args });
      positions.set(key, position);
    }
  }
  const ordered = [...positions.values()];
  const deepest = Math.max(0, ...ordered.map((position) => position.calls.length));
  const variants: Variant[] = [];
  for (let trap = 0; trap < STRING_TRAPS.length && variants.length < MAX_VARIANTS_PER_FUNCTION; trap += 1) {
    for (let rank = 0; rank < deepest && variants.length < MAX_VARIANTS_PER_FUNCTION; rank += 1) {
      for (const { location, calls: atLocation } of ordered) {
        const call = atLocation[rank];
        if (!call) continue;
        const [name, value] = (call.type === 'string' ? STRING_TRAPS : NUMBER_TRAPS)[trap] ?? [];
        if (name === undefined) continue;
        const args = replaceLeaf(call.args, location, typeof value === 'number' ? encodeNumber(value) : value);
        if (isKnown(args)) continue;
        variants.push({ args, origin: `trap:${name}@${locationPath(location)}` });
        if (variants.length >= MAX_VARIANTS_PER_FUNCTION) return variants;
      }
    }
  }
  return variants;
}
