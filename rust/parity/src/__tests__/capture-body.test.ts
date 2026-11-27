import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { textOrBytes, type Capture } from '../capture.js';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import type { Json } from '../wildcard.js';

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

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

function large(value: string): Capture {
  return { request: { method: 'GET', path: '/large', auth: 'token' }, status: 200, headers: {}, body: { kind: 'large-text', value } };
}

describe('textOrBytes', () => {
  test('records a JSON body, a text body, an empty body, and a binary body', () => {
    expect(textOrBytes(new TextEncoder().encode('{"a":1}'), 'application/json;charset=utf-8')).toEqual({ kind: 'json', value: { a: 1 } });
    expect(textOrBytes(new TextEncoder().encode('{"unterminated'), 'application/json')).toEqual({ kind: 'text', value: '{"unterminated' });
    expect(textOrBytes(new TextEncoder().encode('<html>'), 'text/html;charset=utf-8')).toEqual({ kind: 'text', value: '<html>' });
    expect(textOrBytes(new Uint8Array(0), 'text/plain')).toEqual({ kind: 'empty' });
    const binary = Uint8Array.from([0, 255, 1, 254]);
    expect(textOrBytes(binary, 'image/png')).toEqual({ kind: 'bytes', sha256: sha256(binary), length: 4 });
  });

  test('keeps a textual body over 64 KB whole until it is normalized', () => {
    const small = 'x'.repeat(64 * 1024);
    expect(textOrBytes(new TextEncoder().encode(small), 'text/plain')).toEqual({ kind: 'text', value: small });
    const big = `${small}x`;
    expect(textOrBytes(new TextEncoder().encode(big), 'application/json')).toEqual({ kind: 'large-text', value: big });
  });

  test('digests text that is not valid UTF-8 as the bytes it is', () => {
    const bytes = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]);
    expect(textOrBytes(bytes, 'text/plain')).toEqual({ kind: 'bytes', sha256: sha256(bytes), length: 4 });
  });
});

describe('normalizeCapture of a body too large to record', () => {
  test('keeps the digest and the byte length of the normalized text', () => {
    const value = JSON.stringify({ configDir: '/tmp/garcon-parity-1/config', at: '2026-11-27T10:04:31.123Z', text: 'x'.repeat(70_000) });
    const normalized = JSON.stringify({ configDir: '{{configDir}}', at: '{{timestamp}}', text: 'x'.repeat(70_000) });
    const recorded = normalizeCapture(large(value), server) as { body: Json; headers: Json; request: Json; status: Json };
    expect(recorded).toEqual({
      request: { method: 'GET', path: '/large', auth: 'token' },
      status: 200,
      headers: {},
      body: { kind: 'text-digest', sha256: sha256(normalized), length: Buffer.byteLength(normalized) },
    });
    // The digest is of the normalized text, not of the body as sent.
    expect(sha256(value)).not.toBe(sha256(normalized));
  });

  test('gives the same digest for two server starts whose body differs only in what belongs to the start', () => {
    const body = (root: string, port: string, at: string) => JSON.stringify({ home: `${root}/home`, url: `http://127.0.0.1:${port}/x`, at, text: 'y'.repeat(70_000) });
    const first = normalizeCapture(large(body('/tmp/garcon-parity-1', '4100', '2026-11-27T10:04:31.123Z')), server) as { body: Json };
    const other: StartedServer = {
      ...server,
      origin: 'http://127.0.0.1:5300',
      baseUrl: 'http://127.0.0.1:5300',
      port: '5300',
      dirs: { ...server.dirs, root: '/tmp/garcon-parity-2', homeDir: '/tmp/garcon-parity-2/home' },
    };
    const second = normalizeCapture(large(body('/tmp/garcon-parity-2', '5300', '2026-11-27T10:09:02.001Z')), other) as { body: Json };
    expect(second).toEqual(first);
  });

  test('tells two bodies apart that differ beyond what belongs to the start', () => {
    const one = normalizeCapture(large(`{"text":"${'y'.repeat(70_000)}"}`), server) as { body: Json };
    const other = normalizeCapture(large(`{"text":"${'z'.repeat(70_000)}"}`), server) as { body: Json };
    expect(other).not.toEqual(one);
  });
});
