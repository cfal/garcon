import { describe, expect, test } from 'bun:test';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import { firstDifference, mergeRecordings, mergeStrings, stringMatches, WILDCARD, wildcardPaths } from '../wildcard.js';

describe('mergeRecordings', () => {
  test('wildcards only the words that differ between runs', () => {
    // Both runs vary the same way, so the wildcard keeps the length and the alphabet.
    expect(mergeStrings('Chat not found: abc123', 'Chat not found: abd999')).toBe('Chat not found: [..hex:6]');
    expect(mergeStrings('id-7f3a.json', 'id-7f9b.json')).toBe('id-[..hex:4].json');
    expect(mergeStrings('abc123', 'abd999')).toBe('[..hex:6]');
    expect(mergeStrings('same', 'same')).toBe('same');
  });

  test('wildcards whole values whose shape changes', () => {
    expect(mergeRecordings({ list: [1, 2], keep: true, gone: 1 }, { list: [1], keep: true })).toEqual({
      gone: WILDCARD,
      keep: true,
      list: WILDCARD,
    });
    expect(mergeRecordings(1, 2)).toBe(WILDCARD);
  });
});

describe('firstDifference', () => {
  test('accepts anything at a wildcard and reports the first other mismatch by path', () => {
    const expected = { id: WILDCARD, name: `chat-${WILDCARD}`, rows: [{ ok: true }] };
    expect(firstDifference(expected, { id: 9, name: 'chat-x', rows: [{ ok: true }] })).toBeNull();
    expect(firstDifference(expected, { id: 9, name: 'chat-x', rows: [{ ok: false }] })).toEqual({
      path: '$.rows[0].ok',
      kind: 'value',
      expected: 'true',
      actual: 'false',
    });
    expect(firstDifference(expected, { id: 9, name: 'chat-x', rows: [], extra: 1 })?.path).toBe('$.extra');
    expect(firstDifference({ a: 1 }, {})?.kind).toBe('missing');
    expect(firstDifference([1, 2], [1])?.kind).toBe('length');
    expect(firstDifference({ a: '1' }, { a: 1 })?.kind).toBe('type');
  });

  test('fingerprints long string differences by offset and length', () => {
    const expected = 'a'.repeat(150);
    const actual = `${'a'.repeat(100)}b${'a'.repeat(60)}`;
    expect(firstDifference(expected, actual)?.actual).toContain('first difference at offset 100');
    expect(firstDifference(expected, actual)?.actual).toContain('length 161, expected 150');
  });

  test('matches wildcards inside strings literally elsewhere', () => {
    expect(stringMatches(`a.${WILDCARD}(b)`, 'a.anything(b)')).toBe(true);
    expect(stringMatches(`a.${WILDCARD}(b)`, 'aXanything(b)')).toBe(false);
  });

  test('keeps the length and the alphabet where both runs vary the same way', () => {
    // Two 64-character proofs that share no first or last character.
    const hex = '5f2a9c1e7b4d4e6f8a90123456789abc'.repeat(2);
    const otherHex = 'c41e9b2a7d3f5e0c8b1a4d6f29370123'.repeat(2);
    expect(hex).toHaveLength(64);
    expect(mergeStrings(`proof=${hex}`, `proof=${otherHex}`)).toBe('proof=[..hex:64]');
    expect(mergeStrings(hex, otherHex)).toBe('[..hex:64]');
    expect(mergeStrings('ms 12345', 'ms 67890')).toBe('ms [..digits:5]');
    // One alphabet contained in another gives the wider one.
    expect(mergeStrings('12345', 'wxyz9')).toBe('[..base64url:5]');
    expect(mergeStrings('ABC12', 'xyz-_')).toBe('[..base64url:5]');
    expect(mergeStrings('A1F2', 'B3C4')).toBe('[..HEX:4]');
    expect(mergeStrings('a1F2', 'B3c4')).toBe('[..base64url:4]');
    // Another length, or no single alphabet, loses the shape.
    expect(mergeStrings(hex, otherHex.slice(1))).toBe(WILDCARD);
    expect(mergeStrings('ms 12345', 'ms 678901')).toBe('ms [..]');
    expect(mergeStrings('took 41 ms', 'took 9 ms')).toBe('took [..] ms');
    expect(mergeStrings('a b c', 'a b  c')).toBe('a b [..]c');
  });

  test('keeps the shape also when the two runs share a first or a last character', () => {
    // About one pair of random tokens in sixteen shares a last character. The
    // word boundary gives the shared characters back to the variable part.
    expect(mergeStrings('token=a123', 'token=a987')).toBe('token=[..hex:4]');
    expect(mergeStrings('token=abc4', 'token=9fe4')).toBe('token=[..hex:4]');
    expect(mergeStrings('token=a1234', 'token=a9874')).toBe('token=[..hex:5]');
    expect(mergeStrings('ms 12345', 'ms 67845')).toBe('ms [..digits:5]');
    expect(mergeStrings('id abc4 tail', 'id a9z4 tail')).toBe('id [..base64url:4] tail');
    // The lengths still have to agree.
    expect(mergeStrings('ms 12345', 'ms 678945')).toBe('ms [..]');
    expect(mergeStrings('5f2a9c1e7b4d4e6f8a90123456789abc5f2a9c1e7b4d4e6f8a90123456789abc', 'c41e9b2a7d3f5e0c8b1a4d6f29370123c41e9b2a7d3f5e0c8b1a4d6f2937012c')).toBe('[..hex:64]');
  });

  test('accepts from a port only the length and the alphabet a wildcard recorded', () => {
    const hex = '5f2a9c1e7b4d4e6f8a90123456789abc'.repeat(2);
    expect(stringMatches('[..hex:64]', hex)).toBe(true);
    expect(stringMatches('[..hex:64]', hex.slice(1))).toBe(false);
    expect(stringMatches('[..hex:64]', `${hex}0`)).toBe(false);
    expect(stringMatches('[..hex:64]', hex.toUpperCase())).toBe(false);
    expect(stringMatches('[..HEX:64]', hex.toUpperCase())).toBe(true);
    expect(stringMatches('[..digits:13]', '1764234905123')).toBe(true);
    expect(stringMatches('[..digits:13]', '176423490512a')).toBe(false);
    expect(stringMatches('[..base64url:6]', 'aZ0-_9')).toBe(true);
    expect(stringMatches('[..base64url:6]', 'aZ0-+9')).toBe(false);
    expect(stringMatches('id-[..hex:4].json', 'id-7f3a.json')).toBe(true);
    expect(stringMatches('id-[..hex:4].json', 'id-7f3.json')).toBe(false);
    expect(stringMatches(`a[..][..hex:2]z`, 'anything7fz')).toBe(true);
    // A shaped wildcard is not the anything wildcard.
    expect(firstDifference(WILDCARD, 123)).toBeNull();
    expect(firstDifference('[..digits:3]', 123)?.kind).toBe('type');
    expect(firstDifference({ proof: '[..hex:64]' }, { proof: 'z'.repeat(64) })).toMatchObject({ path: '$.proof', kind: 'value' });
    // Brackets that name no alphabet are not a wildcard.
    expect(stringMatches('[..odd]', '[..odd]')).toBe(true);
    expect(stringMatches('[..hex:x]', '[..hex:x]')).toBe(true);
  });

  test('reports every position of a wildcard, shaped or not', () => {
    expect(wildcardPaths({ a: 'x [..digits:2] y', b: '[..base64url:8]', c: WILDCARD, d: 'plain [..odd]' })).toEqual(['$.a', '$.b', '$.c']);
  });
});

describe('normalizeCapture', () => {
  const server = {
    origin: 'http://127.0.0.1:4100',
    baseUrl: 'http://127.0.0.1:4100',
    port: '4100',
    token: 'session-token',
    credentials: { username: 'parity', password: 'secret-password' },
    dirs: {
      root: '/tmp/garcon-parity-1',
      configDir: '/tmp/garcon-parity-1/config',
      workspaceDir: '/tmp/garcon-parity-1/workspace',
      projectDir: '/tmp/garcon-parity-1/project',
      homeDir: '/tmp/garcon-parity-1/home',
    },
    fallbackLogPath: '/tmp/garcon-parity-1/fallback.log',
    pid: 4100,
    startupMs: 1,
    logs: () => '',
    stop: async () => undefined,
  } satisfies StartedServer;

  test('replaces per-start values and volatile formats with placeholders', () => {
    const capture = {
      request: { method: 'GET', path: '/', auth: 'token' as const },
      status: 200,
      headers: { location: 'http://127.0.0.1:4100/x' },
      body: {
        kind: 'json' as const,
        value: {
          path: '/tmp/garcon-parity-1/project/a.ts',
          at: '2026-11-26T00:04:31.123Z',
          id: '0f6c2a4e-1b2c-4d3e-8f90-123456789abc',
          token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwYXJpdHkifQ.c2lnbmF0dXJl',
          echoed: 'session-token',
        },
      },
    };
    expect(normalizeCapture(capture, server)).toEqual({
      request: { method: 'GET', path: '/', auth: 'token' },
      status: 200,
      headers: { location: '{{origin}}/x' },
      body: {
        kind: 'json',
        value: {
          path: '{{projectDir}}/a.ts',
          at: '{{timestamp}}',
          id: '{{uuid}}',
          token: '{{jwt}}',
          echoed: '{{token}}',
        },
      },
    });
  });
});
