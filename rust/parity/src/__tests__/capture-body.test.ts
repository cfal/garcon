import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import { captureStep, textOrBytes, type Capture } from '../capture.js';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import { resolvePlaceholders } from '../placeholders.js';
import type { ScenarioStep } from '../scenario.js';
import { expandTraps } from '../traps.js';
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

test.each([['automatic', false], ['explicit', true]] as const)('sends duplicate raw fields in wire order (%s credential)', async (_label, explicit) => {
  const payload = { write: '\u96ea' };
  const observed = Promise.withResolvers<{ lines: string[]; body: string }>();
  const probe = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      const endOfHead = bytes.indexOf('\r\n\r\n');
      if (endOfHead === -1 || bytes.length < endOfHead + 4 + Buffer.byteLength(JSON.stringify(payload))) return;
      observed.resolve({ lines: bytes.subarray(0, endOfHead).toString().split('\r\n'), body: bytes.subarray(endOfHead + 4).toString() });
      const reply = gzipSync('{"read":true}');
      socket.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 401 Unauthorized\r\nContent-Length: ${reply.length}\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nConnection: close\r\n\r\n`),
        reply,
      ]));
    });
  });
  probe.listen(0, '0.0.0.0');
  await once(probe, 'listening');
  try {
    const port = String((probe.address() as AddressInfo).port);
    const origin = `http://127.0.0.1:${port}`;
    const target = { ...server, port, origin, baseUrl: origin };
    const rawHeaders: [string, string][] = [
      ...(explicit ? [['Authorization', 'Bearer {{token}}'] as [string, string]] : []),
      ['Content-Type', 'application/json'],
      ['Authorization', 'Bearer {{username}}-other'],
      ['Content-Type', 'application/synthetic'],
    ];
    const step: ScenarioStep = { name: 'raw', http: {
      method: 'POST', path: '/sample?q=test', json: payload, rawHeaders, ...(explicit ? { auth: 'none' } : {}),
    } };
    const result = await captureStep(target, step, resolvePlaceholders(target, step, new Map(), new Date()));
    const wire = await observed.promise;
    expect(wire.lines[0]).toBe('POST /sample?q=test HTTP/1.1');
    expect(wire.lines.map((line) => line.split(': ', 2)[0].toLowerCase())).toContain('host');
    expect(wire.lines.filter((line) => /^(authorization|content-type):/i.test(line)).map((line) => line.slice(line.indexOf(': ') + 2)))
      .toEqual(['Bearer session-token', 'application/json', 'Bearer parity-other', 'application/synthetic']);
    expect(wire.body).toBe(JSON.stringify(payload));
    expect(result).toMatchObject({ status: 401, request: { rawHeaders }, body: { kind: 'json', value: { read: true } } });
  } finally {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
});

test('rejects a line break in a raw header value before sending the request', async () => {
  const step: ScenarioStep = { name: 'bad-header', http: {
    method: 'GET', rawHeaders: [['X-Probe', 'first\r\nsecond']],
  } };
  const placeholders = resolvePlaceholders(server, step, new Map(), new Date());
  await expect(captureStep(server, step, placeholders)).rejects.toThrow('Invalid character');
});

test('malformed JSON traps keep the configured raw content-type fields without adding another', () => {
  const rawHeaders: [string, string][] = [['Content-Type', 'application/json'], ['content-type', 'text/plain']];
  const steps = expandTraps({
    name: 'fixture', description: '', traps: true,
    steps: [{ name: 'write', http: { method: 'POST', json: {}, rawHeaders } }],
  });
  const http = steps.find((step) => step.name === 'write~malformed-json')?.http;
  expect(http?.rawHeaders).toEqual(rawHeaders);
  expect(http?.headers).toBeUndefined();
});

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
