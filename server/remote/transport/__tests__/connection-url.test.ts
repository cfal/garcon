import { expect, test } from 'bun:test';
import { createExecutorSecret, isExecutorSecret, parseConnectionUrl, validateExecutorSocketUrl, executorConnectionUrl } from '../connection-url.js';

const id = '22222222-2222-4222-8222-222222222222';
const secret = Buffer.alloc(32, 7).toString('base64url');

test('full connection descriptors round-trip without sending the fragment', () => {
  for (const socketUrl of [
    `wss://example.com/executor/${id}`, 'ws://127.0.0.1:19781/executor',
    'wss://example.com/any-prefix?route=worker&tag=a&tag=b',
  ]) {
    const descriptor = executorConnectionUrl(socketUrl, secret);
    expect(parseConnectionUrl(descriptor)).toEqual({ socketUrl, secret });
    expect(parseConnectionUrl(descriptor).socketUrl).not.toContain(secret);
  }
  expect(isExecutorSecret(createExecutorSecret())).toBe(true);
  expect(createExecutorSecret()).not.toBe(createExecutorSecret());
});

test('invalid connection credentials and URLs fail without disclosing the descriptor', () => {
  const urls = [
    `not a url ${secret}`, `https://example.com/#secret=${secret}`,
    `wss://user:${secret}@example.com/#secret=${secret}`,
    'wss://example.com/#secret=short', `wss://example.com/#secret=${secret}&secret=${secret}`,
    `wss://example.com/#secret=${secret}&extra=value`, 'wss://example.com/#secret=' + 'B'.repeat(43),
  ];
  for (const url of urls) {
    expect(() => parseConnectionUrl(url)).toThrow();
    try { parseConnectionUrl(url); } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  }
});

test('public WebSocket addresses may use arbitrary paths and query strings', () => {
  for (const address of [
    'wss://example.com/', 'wss://example.com/any-prefix',
    'wss://example.com/custom/nested/path/',
    `wss://example.com/garcon-tunnel/executor/${id}`,
    'wss://example.com/not-an-executor-id?route=worker&tag=a&tag=b',
    'wss://example.com/a%2Fb?route=a%2Fb',
  ]) {
    expect(validateExecutorSocketUrl(address, { allowInsecureDevelopment: false })).toBe(address);
  }
});

test('placeholders and TLS are validated independently of public paths', () => {
  const options = { allowInsecureDevelopment: false };
  for (const address of [
    'not a url', 'https://example.com/any-prefix', 'ws://example.com/any-prefix',
    'wss://user:password@example.com/any-prefix', 'wss://example.com/any-prefix#fragment',
  ]) expect(() => validateExecutorSocketUrl(address, options)).toThrow();
  const listener = { allowInsecureDevelopment: true };
  expect(() => validateExecutorSocketUrl('ws://0.0.0.0:19781/executor', listener)).toThrow('reachable');
  expect(validateExecutorSocketUrl('ws://0.0.0.0:19781/executor', { ...listener, allowPlaceholder: true })).toContain('0.0.0.0');
  expect(validateExecutorSocketUrl('ws://127.0.0.1:19781/executor', listener)).toContain('127.0.0.1');
});
