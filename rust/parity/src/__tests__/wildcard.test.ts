import { describe, expect, test } from 'bun:test';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import { firstDifference, mergeRecordings, mergeStrings, stringMatches, WILDCARD } from '../wildcard.js';

describe('mergeRecordings', () => {
  test('wildcards only the words that differ between runs', () => {
    expect(mergeStrings('Chat not found: abc123', 'Chat not found: abd999')).toBe(`Chat not found: ${WILDCARD}`);
    expect(mergeStrings('id-7f3a.json', 'id-7f9b.json')).toBe(`id-${WILDCARD}.json`);
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
