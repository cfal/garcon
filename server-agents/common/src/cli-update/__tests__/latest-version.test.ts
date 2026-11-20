import { expect, test } from 'bun:test';
import { LatestVersionCache, parseHomebrewInfoVersion, parseNpmViewVersion } from '../latest-version.js';

test('reads npm view output as a string or a one-item list', () => {
  expect(parseNpmViewVersion('"2.1.300"\n')).toBe('2.1.300');
  expect(parseNpmViewVersion('["0.170.0"]')).toBe('0.170.0');
  expect(parseNpmViewVersion('["0.170.0","0.171.0"]')).toBeNull();
  expect(parseNpmViewVersion('{"error":{"code":"E404"}}')).toBeNull();
  expect(parseNpmViewVersion('7')).toBeNull();
  expect(parseNpmViewVersion('not json')).toBeNull();
});

test('reads Homebrew formula and cask versions', () => {
  expect(parseHomebrewInfoVersion('{"formulae":[{"versions":{"stable":"0.170.0"}}],"casks":[]}', false)).toBe('0.170.0');
  expect(parseHomebrewInfoVersion('{"formulae":[],"casks":[{"version":"2.1.300,abc123"}]}', true)).toBe('2.1.300');
  expect(parseHomebrewInfoVersion('{"formulae":[],"casks":[]}', true)).toBeNull();
});

test('caches anything other than a version as a miss', async () => {
  const cache = new LatestVersionCache();
  expect(await cache.get('cask', async () => 'latest', { fresh: false })).toBeNull();
  expect(await cache.get('error', async () => '{"error":{}}', { fresh: false })).toBeNull();
});

test('keeps found versions for an hour and misses for a minute', async () => {
  let now = 0;
  let lookups = 0;
  const cache = new LatestVersionCache(() => now);
  const found = async () => { lookups++; return '1.0.0'; };
  expect(await cache.get('found', found, { fresh: false })).toBe('1.0.0');
  now += 59 * 60 * 1000;
  await cache.get('found', found, { fresh: false });
  expect(lookups).toBe(1);
  now += 2 * 60 * 1000;
  await cache.get('found', found, { fresh: false });
  expect(lookups).toBe(2);

  const missing = async () => { lookups++; return null; };
  await cache.get('missing', missing, { fresh: false });
  now += 61 * 1000;
  await cache.get('missing', missing, { fresh: false });
  expect(lookups).toBe(4);
});

test('shares an in-flight lookup and forgets one that throws', async () => {
  const cache = new LatestVersionCache();
  let lookups = 0;
  const gate = Promise.withResolvers<string>();
  const shared = async () => { lookups++; return gate.promise; };
  const first = cache.get('key', shared, { fresh: false });
  const second = cache.get('key', shared, { fresh: false });
  gate.resolve('1.0.0');
  expect(await Promise.all([first, second])).toEqual(['1.0.0', '1.0.0']);
  expect(lookups).toBe(1);

  const failing = async () => { lookups++; throw new Error('aborted'); };
  await cache.get('failing', failing, { fresh: false }).catch(() => null);
  await cache.get('failing', failing, { fresh: false }).catch(() => null);
  expect(lookups).toBe(3);
});

test('keys a native release by its channel', async () => {
  const cache = new LatestVersionCache();
  const latest = await cache.get('https://example.test/latest', async () => '2.1.300', { fresh: false });
  const stable = await cache.get('https://example.test/stable', async () => '2.1.250', { fresh: false });
  expect([latest, stable]).toEqual(['2.1.300', '2.1.250']);
});
