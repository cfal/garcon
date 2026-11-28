import { describe, expect, test } from 'bun:test';
import {
  candidateVariants, locationPath, MAX_VARIANTS_PER_FUNCTION, replaceLeaf, trapVariants,
} from '../unit/traps.js';
import type { Json } from '../wildcard.js';

// The recorder skips a variant equal to a recorded case, as this does.
function generate(calls: Json[][], jsonArguments: number[] = []) {
  const known = new Set(calls.map((call) => JSON.stringify(call)));
  const variants = trapVariants(calls, (args) => {
    const key = JSON.stringify(args);
    if (known.has(key)) return true;
    known.add(key);
    return false;
  }, jsonArguments);
  return { variants, origins: variants.map((variant) => variant.origin), args: variants.map((variant) => variant.args) };
}

const finite = ['zero', 'negative-zero', 'negative-one', 'half', '1e21', '1e-7', '2^53'];
const nonFinite = ['nan', 'infinity', 'negative-infinity'];
const objectKeys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const objectKeyTraps = ['object-proto', 'object-constructor', 'object-to-string', 'object-own-property'];

const empty = (path: string) => `trap:empty@${path}`;
const trapOf = (origin: string) => origin.slice('trap:'.length, origin.indexOf('@')).split('+')[0]!;
const how = (origin: string) => origin.slice('trap:'.length, origin.indexOf('@')).split('+')[1] ?? 'replace';
const codePoints = (...points: number[]) => String.fromCodePoint(...points);
const accented = codePoints(0xdc, 0x6e, 0xef, 0x63, 0xf6, 0x64, 0xe9);
const cjk = codePoints(0x65e5, 0x672c, 0x8a9e, 0x96ea);
const astral = codePoints(0x1f600);
const combining = codePoints(0x65, 0x301);
const dotless = codePoints(0x131);
const kelvin = codePoints(0x212a);
const nbsp = codePoints(0xa0);

describe('trapVariants', () => {
  test('replaces each string and number leaf of a recorded call, one at a time', () => {
    const { origins, args } = generate([[{ a: 'x', b: [1, 'y'], c: true }]]);
    expect(origins.slice(0, 3)).toEqual([empty('$.args[0].a'), 'trap:zero@$.args[0].b[0]', empty('$.args[0].b[1]')]);
    expect(args.slice(0, 3)).toEqual([
      [{ a: '', b: [1, 'y'], c: true }],
      [{ a: 'x', b: [0, 'y'], c: true }],
      [{ a: 'x', b: [1, ''], c: true }],
    ]);
    // Two string leaves with thirteen traps each and a nested number leaf with
    // the seven a JSON value can carry.
    expect(origins.slice(0, 33).every((origin) => how(origin) === 'replace')).toBe(true);
    expect(origins.slice(33).every((origin) => how(origin) !== 'replace')).toBe(true);
    expect(origins[33]).toBe(`trap:accented+after-first@$.args[0].a`);
    expect(args[33]).toEqual([{ a: `x${accented}`, b: [1, 'y'], c: true }]);
    expect(new Set(origins.map(trapOf))).toEqual(new Set([
      'empty', 'accented', 'cjk', 'astral', 'combining', 'dotless-i', 'kelvin', 'nbsp', 'long',
      ...objectKeyTraps, 'zero', 'negative-zero', 'negative-one', 'half', '1e21', '1e-7', '2^53',
    ]));
    // Each variant names the argument whose leaf it changes.
    const both = generate([[{ a: 'x' }, 'y']]).variants;
    expect(both.every((variant) => variant.origin.includes(`@$.args[${variant.argument}]`))).toBe(true);
    expect(new Set(both.map((variant) => variant.argument))).toEqual(new Set([0, 1]));
  });

  test('uses every trap string, each at its intended code points', () => {
    expect(generate([['x']]).args.map((variant) => variant[0]).slice(0, 9)).toEqual([
      '', accented, cjk, astral, combining, dotless, kelvin, nbsp, 'x'.repeat(10_000),
    ]);
    // An astral character is two UTF-16 code units; the combining sequence is two.
    expect([accented, cjk, astral, combining, dotless, kelvin, nbsp].map((trap) => trap.length)).toEqual([7, 4, 2, 2, 1, 1, 1]);
    // The Kelvin sign folds to the ASCII letter and no-break space looks like a space.
    expect(kelvin.toLowerCase()).toBe('k');
    expect(kelvin).not.toBe('K');
    expect(nbsp.trim()).toBe('');
    expect(dotless.toUpperCase()).toBe('I');
    expect(dotless).not.toBe('i');
  });

  test('probes inherited object names only as whole strings', () => {
    const variants = generate([['abc']]).variants.filter((variant) => objectKeyTraps.includes(trapOf(variant.origin)));
    expect(variants.map((variant) => variant.args[0])).toEqual(objectKeys);
    expect(variants.map((variant) => how(variant.origin))).toEqual(Array(4).fill('replace'));
  });

  test('uses every trap number for an argument that is a number, and embeds nothing in a number', () => {
    const { args, origins } = generate([[1]]);
    expect(args.map((variant) => variant[0])).toEqual([
      0, { $: 'number', value: '-0' }, -1, 0.5, 1e21, 1e-7, 2 ** 53,
      { $: 'number', value: 'NaN' }, { $: 'number', value: 'Infinity' }, { $: 'number', value: '-Infinity' },
    ]);
    expect(origins.map(trapOf)).toEqual([
      'zero', 'negative-zero', 'negative-one', 'half', '1e21', '1e-7', '2^53', 'nan', 'infinity', 'negative-infinity',
    ]);
    expect(origins.every((origin) => how(origin) === 'replace')).toBe(true);
  });

  test('reads an argument recorded as a number marker as the number it is', () => {
    const { args, origins } = generate([[{ $: 'number', value: '-0' }]]);
    // The `negative-zero` trap gives the recorded call again.
    expect(origins.map(trapOf)).toEqual(['zero', 'negative-one', 'half', '1e21', '1e-7', '2^53', 'nan', 'infinity', 'negative-infinity']);
    expect(args.slice(6)).toEqual([[{ $: 'number', value: 'NaN' }], [{ $: 'number', value: 'Infinity' }], [{ $: 'number', value: '-Infinity' }]]);
  });

  test('makes no NaN or infinity for an argument declared JSON, though it is a number', () => {
    // The first argument reaches a port as the number it is, the second as JSON.
    const { variants } = generate([[1, 2]], [1]);
    const trapsOfArgument = (argument: number) => variants.filter((variant) => variant.argument === argument).map((variant) => trapOf(variant.origin));
    expect(trapsOfArgument(0)).toEqual([...finite, ...nonFinite]);
    expect(trapsOfArgument(1)).toEqual(finite);
    // The same for an argument the recording holds as a number marker.
    expect(generate([[{ $: 'number', value: '-0' }]], [0]).origins.map(trapOf)).toEqual(['zero', ...finite.slice(2)]);
  });

  test('yields every candidate in order, and keeps a budget only when asked', () => {
    const calls = Array.from({ length: 30 }, (_, index): Json[] => [[String(index)]]);
    const every = [...candidateVariants(calls, () => false)];
    expect(every.length).toBeGreaterThan(MAX_VARIANTS_PER_FUNCTION);
    // The recorder pulls the candidates of a function in batches, which together are the whole list.
    expect(trapVariants(calls, () => false)).toEqual(every.slice(0, MAX_VARIANTS_PER_FUNCTION));
  });

  test('replaces a number inside an object or an array only by a number JSON can carry', () => {
    // A port receives such a number as JSON, which cannot hold NaN or an infinity.
    const { variants } = generate([[{ a: [1], m: { $: 'map', value: [['k', 2]] } }]]);
    for (const path of ['$.args[0].a[0]', '$.args[0].m.value[0][1]']) {
      expect(variants.filter((variant) => variant.origin.endsWith(`@${path}`)).map((variant) => trapOf(variant.origin))).toEqual(finite);
    }
    // Negative zero JSON can carry, and does; it replaces the leaf in place.
    const negativeZero = variants.find((variant) => variant.origin === 'trap:negative-zero@$.args[0].a[0]')!;
    expect(negativeZero.args).toEqual([{ a: [{ $: 'number', value: '-0' }], m: { $: 'map', value: [['k', 2]] } }]);
    // No variant anywhere holds NaN or an infinity.
    expect(variants.some((variant) => /NaN|Infinity/.test(JSON.stringify(variant.args)))).toBe(false);
  });

  test('embeds a trap after the first character of the leaf and at its end, once the replacements are had', () => {
    const { origins, args } = generate([['abc']]);
    expect(origins.slice(13, 19)).toEqual([
      `trap:accented+after-first@$.args[0]`,
      `trap:accented+append@$.args[0]`,
      `trap:cjk+after-first@$.args[0]`,
      `trap:cjk+append@$.args[0]`,
      `trap:astral+after-first@$.args[0]`,
      `trap:astral+append@$.args[0]`,
    ]);
    expect(args.slice(13, 19)).toEqual([
      [`a${accented}bc`], [`abc${accented}`],
      [`a${cjk}bc`], [`abc${cjk}`],
      [`a${astral}bc`], [`abc${astral}`],
    ]);
    expect(origins.slice(0, 13).every((origin) => how(origin) === 'replace')).toBe(true);
  });

  test('keeps an astral first character whole', () => {
    const { variants } = generate([[`${astral}ab`]]);
    const embedded = variants.find((variant) => variant.origin === `trap:kelvin+after-first@$.args[0]`)!;
    // Two code units for the character, one for the trap, two for the rest, and no lone surrogate.
    expect(embedded.args[0]).toHaveLength(5);
    expect(Array.from(embedded.args[0] as string)).toEqual([astral, kelvin, 'a', 'b']);
    expect(() => encodeURIComponent(embedded.args[0] as string)).not.toThrow();
  });

  test('gives each position the first call that has it, then the next calls', () => {
    const { args } = generate([[{ a: 'one', b: 'x' }], [{ a: 'two' }]]);
    expect(args.slice(0, 6)).toEqual([
      [{ a: '', b: 'x' }],
      [{ a: 'one', b: '' }],
      [{ a: accented, b: 'x' }],
      [{ a: 'one', b: accented }],
      // `a` in the second call; the same trap with `id`-like duplicates was skipped.
      [{ a: '' }],
      [{ a: cjk, b: 'x' }],
    ]);
  });

  test('is bounded per function and spends the whole budget on replacements before any embedded trap', () => {
    // A trap in `id` gives the same variant for every call, since `a` is the same;
    // a trap in `a` gives one per call.
    const calls = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((id): Json[] => [{ id, a: 'x' }]);
    const { variants, origins } = generate(calls);
    expect(variants).toHaveLength(MAX_VARIANTS_PER_FUNCTION);
    expect(origins.every((origin) => how(origin) === 'replace')).toBe(true);
    // The first two traps reached both positions before the first trap came back
    // with the second call.
    expect(origins.slice(0, 6)).toEqual([
      empty('$.args[0].id'), empty('$.args[0].a'),
      `trap:accented@$.args[0].id`, `trap:accented@$.args[0].a`,
      empty('$.args[0].a'),
      `trap:cjk@$.args[0].id`,
    ]);
  });

  test('is bounded across both kinds, sharing what is left between the two embedded kinds', () => {
    const { variants, origins } = generate([['ab'], ['cd'], ['ef'], ['gh']]);
    expect(variants).toHaveLength(MAX_VARIANTS_PER_FUNCTION);
    const count = (kind: string) => origins.filter((origin) => how(origin) === kind).length;
    // Thirteen replacements: one leaf, so a trap gives every call the same variant.
    expect(count('replace')).toBe(13);
    expect(count('after-first')).toBe(24);
    expect(count('append')).toBe(23);
  });

  test('skips a variant equal to a case already recorded', () => {
    const { variants, origins } = generate([[''], ['x']]);
    // The empty trap gives a recorded case, as a replacement and embedded in ''.
    expect(origins.filter((origin) => trapOf(origin) === 'empty')).toHaveLength(0);
    expect(origins.filter((origin) => origin === `trap:accented@$.args[0]`)).toHaveLength(1);
    // Embedded in the one-character 'x', after the first character and at the end are the same string.
    expect(origins.filter((origin) => trapOf(origin) === 'accented' && how(origin) !== 'replace')).toHaveLength(1);
    expect(variants).toHaveLength(20);
  });

  test('walks into maps, sets, and wrapped objects, and not into other markers', () => {
    const { origins } = generate([[
      { $: 'map', value: [['k', 1]] },
      { $: 'set', value: ['a'] },
      { $: 'object', value: { n: 2 } },
      { $: 'date', value: '2026-11-27T10:11:12.000Z' },
      { $: 'number', value: '-0' },
      null,
      true,
    ]]);
    expect(origins.slice(0, 5)).toEqual([
      empty('$.args[0].value[0][0]'),
      'trap:zero@$.args[0].value[0][1]',
      empty('$.args[1].value[0]'),
      'trap:zero@$.args[2].value.n',
      'trap:zero@$.args[4]',
    ]);
    // The `-0` marker replaced by negative zero is the recorded call again.
    expect(origins.slice(5, 10)).toEqual([
      `trap:accented@$.args[0].value[0][0]`,
      `trap:negative-zero@$.args[0].value[0][1]`,
      `trap:accented@$.args[1].value[0]`,
      `trap:negative-zero@$.args[2].value.n`,
      `trap:cjk@$.args[0].value[0][0]`,
    ]);
  });

  test('makes no variant for a function without a recorded call', () => {
    expect(trapVariants([], () => false)).toEqual([]);
  });
});

describe('replaceLeaf', () => {
  test('returns a copy and leaves the call as it was', () => {
    const call: Json[] = [{ a: { b: ['x'] } }, 5];
    expect(replaceLeaf(call, [0, 'a', 'b', 0], 'Z')).toEqual([{ a: { b: ['Z'] } }, 5]);
    expect(replaceLeaf(call, [1], { $: 'number', value: 'NaN' })).toEqual([{ a: { b: ['x'] } }, { $: 'number', value: 'NaN' }]);
    expect(call).toEqual([{ a: { b: ['x'] } }, 5]);
  });

  test('names a leaf by its argument, property, and index', () => {
    expect(locationPath([2, 'odd key', 3, 'nested'])).toBe('$.args[2]["odd key"][3].nested');
    expect(locationPath([0])).toBe('$.args[0]');
  });
});
