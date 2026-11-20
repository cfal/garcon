import { expect, test } from 'bun:test';
import { LatestVersionCache, parseHomebrewInfoVersion, parseNpmViewVersion } from '../latest-version.js';

test('reads npm view output as a string or a one-item list', () => {
  expect(parseNpmViewVersion('"2.1.300"\n')).toBe('2.1.300');
  expect(parseNpmViewVersion('["0.170.0"]')).toBe('0.170.0');
  expect(parseNpmViewVersion('["0.170.0","0.171.0"]')).toBeNull();
  expect(parseNpmViewVersion('{"error":{"code":"E404"}}')).toBeNull();
  expect(parseNpmViewVersion('not json')).toBeNull();
});

test('reads Homebrew formula and cask versions', () => {
  expect(parseHomebrewInfoVersion('{"formulae":[{"versions":{"stable":"0.170.0"}}],"casks":[]}', false)).toBe('0.170.0');
  expect(parseHomebrewInfoVersion('{"formulae":[],"casks":[{"version":"2.1.300,abc123"}]}', true)).toBe('2.1.300');
  expect(parseHomebrewInfoVersion('{"formulae":[],"casks":[{"version":"latest"}]}', true)).toBeNull();
});

test('keeps found versions for an hour and misses for a minute', async () => {
  let now = 0;
  let lookups = 0;
  const cache = new LatestVersionCache(() => now);
  const signal = new AbortController().signal;
  const found = async () => { lookups++; return '1.0.0'; };
  expect(await cache.get('found', found, { fresh: false, signal })).toBe('1.0.0');
  now += 59 * 60 * 1000;
  await cache.get('found', found, { fresh: false, signal });
  expect(lookups).toBe(1);
  now += 2 * 60 * 1000;
  await cache.get('found', found, { fresh: false, signal });
  expect(lookups).toBe(2);

  const missing = async () => { lookups++; return null; };
  await cache.get('missing', missing, { fresh: false, signal });
  now += 61 * 1000;
  await cache.get('missing', missing, { fresh: false, signal });
  expect(lookups).toBe(4);
});

test('shares an in-flight lookup and forgets one that throws', async () => {
  const cache = new LatestVersionCache();
  const signal = new AbortController().signal;
  let lookups = 0;
  const gate = Promise.withResolvers<string>();
  const shared = async () => { lookups++; return gate.promise; };
  const first = cache.get('key', shared, { fresh: false, signal });
  const second = cache.get('key', shared, { fresh: false, signal });
  gate.resolve('1.0.0');
  expect(await Promise.all([first, second])).toEqual(['1.0.0', '1.0.0']);
  expect(lookups).toBe(1);

  const failing = async () => { lookups++; throw new Error('aborted'); };
  await cache.get('failing', failing, { fresh: false, signal }).catch(() => null);
  await cache.get('failing', failing, { fresh: false, signal }).catch(() => null);
  expect(lookups).toBe(3);
});
