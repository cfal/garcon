import { expect, test } from 'bun:test';
import { createExecutorSecret, isExecutorSecret, parseConnectionUrl, validateExecutorSocketUrl, executorConnectionUrl } from '../connection-url.js';

const id = '22222222-2222-4222-8222-222222222222';
const secret = Buffer.alloc(32, 7).toString('base64url');

test('full connection descriptors round-trip without sending the fragment', () => {
  for (const socketUrl of [`wss://example.com/executor/${id}`, 'ws://127.0.0.1:19781/executor']) {
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
    `wss://user:${secret}@example.com/#secret=${secret}`, `wss://example.com/?secret=${secret}#secret=${secret}`,
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

test('direction, ID, placeholders and TLS are validated independently of credential parsing', () => {
  const options = { direction: 'executor-connects' as const, executorId: id, allowInsecureDevelopment: false };
  expect(validateExecutorSocketUrl(`wss://example.com/executor/${id}`, options)).toContain(id);
  for (const address of [
    `ws://example.com/executor/${id}`, 'wss://example.com/executor',
    'wss://example.com/executor/33333333-3333-4333-8333-333333333333',
  ]) expect(() => validateExecutorSocketUrl(address, options)).toThrow();
  const listener = { direction: 'controller-connects' as const, allowInsecureDevelopment: true };
  expect(() => validateExecutorSocketUrl('ws://0.0.0.0:19781/executor', listener)).toThrow('reachable');
  expect(validateExecutorSocketUrl('ws://0.0.0.0:19781/executor', { ...listener, allowPlaceholder: true })).toContain('0.0.0.0');
  expect(validateExecutorSocketUrl('ws://127.0.0.1:19781/executor', listener)).toContain('127.0.0.1');
});
