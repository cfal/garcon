import { describe, expect, test } from 'bun:test';
import { locationPath, MAX_VARIANTS_PER_FUNCTION, replaceLeaf, trapVariants } from '../unit/traps.js';
import type { Json } from '../wildcard.js';

// The recorder skips a variant equal to a recorded case, as this does.
function generate(calls: Json[][]) {
  const known = new Set(calls.map((call) => JSON.stringify(call)));
  const variants = trapVariants(calls, (args) => {
    const key = JSON.stringify(args);
    if (known.has(key)) return true;
    known.add(key);
    return false;
  });
  return { variants, origins: variants.map((variant) => variant.origin), args: variants.map((variant) => variant.args) };
}

const empty = (path: string) => `trap:empty@${path}`;
const trapOf = (origin: string) => origin.slice('trap:'.length, origin.indexOf('@'));
const codePoints = (...points: number[]) => String.fromCodePoint(...points);

describe('trapVariants', () => {
  test('replaces each string and number leaf of a recorded call, one at a time', () => {
    const { origins, args } = generate([[{ a: 'x', b: [1, 'y'], c: true }]]);
    expect(origins.slice(0, 3)).toEqual([empty('$.args[0].a'), 'trap:zero@$.args[0].b[0]', empty('$.args[0].b[1]')]);
    expect(args.slice(0, 3)).toEqual([
      [{ a: '', b: [1, 'y'], c: true }],
      [{ a: 'x', b: [0, 'y'], c: true }],
      [{ a: 'x', b: [1, ''], c: true }],
    ]);
    expect(new Set(origins.map(trapOf))).toEqual(new Set([
      'empty', 'accented', 'cjk', 'astral', 'combining', 'dotless-i', 'kelvin', 'nbsp', 'long',
      'zero', 'negative-zero', 'negative-one', 'half', '1e21', '1e-7', '2^53', 'nan',
    ]));
  });

  test('uses every trap string, each at its intended code points', () => {
    expect(generate([['x']]).args.map((variant) => variant[0])).toEqual([
      '',
      codePoints(0xdc, 0x6e, 0xef, 0x63, 0xf6, 0x64, 0xe9),
      codePoints(0x65e5, 0x672c, 0x8a9e, 0x96ea),
      codePoints(0x1f600),
      codePoints(0x65, 0x301),
      codePoints(0x131),
      codePoints(0x212a),
      codePoints(0xa0),
      'x'.repeat(10_000),
    ]);
    const [, accented, cjk, astral, combining, dotless, kelvin, nbsp] = generate([['x']]).args.map((variant) => variant[0] as string);
    // An astral character is two UTF-16 code units; the combining sequence is two.
    expect([accented, cjk, astral, combining, dotless, kelvin, nbsp].map((trap) => trap.length)).toEqual([7, 4, 2, 2, 1, 1, 1]);
    // The Kelvin sign folds to the ASCII letter and no-break space looks like a space.
    expect(kelvin.toLowerCase()).toBe('k');
    expect(kelvin).not.toBe('K');
    expect(nbsp.trim()).toBe('');
    expect(dotless.toUpperCase()).toBe('I');
    expect(dotless).not.toBe('i');
  });

  test('uses every trap number', () => {
    expect(generate([[1]]).args.map((variant) => variant[0])).toEqual([
      0, { $: 'number', value: '-0' }, -1, 0.5, 1e21, 1e-7, 2 ** 53, { $: 'number', value: 'NaN' },
    ]);
  });

  test('is bounded per function and spends the budget breadth first', () => {
    const calls = ['one', 'two', 'three', 'four', 'five'].map((id): Json[] => [{ id, a: 'x' }]);
    const { variants, origins } = generate(calls);
    expect(variants).toHaveLength(MAX_VARIANTS_PER_FUNCTION);
    const counts = new Map<string, number>();
    for (const origin of origins) counts.set(trapOf(origin), (counts.get(trapOf(origin)) ?? 0) + 1);
    // Every position had a trap before any had the next one.
    expect([...counts]).toEqual([
      ['empty', 6], ['accented', 6], ['cjk', 6], ['astral', 6], ['combining', 6], ['dotless-i', 6], ['kelvin', 4],
    ]);
    expect(origins.slice(0, 7)).toEqual([
      empty('$.args[0].id'),
      empty('$.args[0].a'), empty('$.args[0].a'), empty('$.args[0].a'), empty('$.args[0].a'), empty('$.args[0].a'),
      'trap:accented@$.args[0].id',
    ]);
  });

  test('gives each position the first call that has it, then the next calls', () => {
    const { args } = generate([[{ a: 'one', b: 'x' }], [{ a: 'two' }]]);
    expect(args.slice(0, 4)).toEqual([
      [{ a: '', b: 'x' }],
      [{ a: 'one', b: '' }],
      // `a` in the second call; replacing `id`-like duplicates was skipped.
      [{ a: '' }],
      [{ a: codePoints(0xdc, 0x6e, 0xef, 0x63, 0xf6, 0x64, 0xe9), b: 'x' }],
    ]);
  });

  test('skips a variant equal to a case already recorded', () => {
    const { variants, origins } = generate([[''], ['x']]);
    // The empty trap gives `['']`, a recorded case, for both calls.
    expect(origins.filter((origin) => trapOf(origin) === 'empty')).toHaveLength(0);
    expect(origins.filter((origin) => trapOf(origin) === 'accented')).toHaveLength(1);
    expect(variants).toHaveLength(8);
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
      'trap:accented@$.args[0].value[0][0]',
      'trap:negative-zero@$.args[0].value[0][1]',
      'trap:accented@$.args[1].value[0]',
      'trap:negative-zero@$.args[2].value.n',
      'trap:cjk@$.args[0].value[0][0]',
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
