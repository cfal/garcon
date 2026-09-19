import { expect, test } from 'bun:test';
import { createNodeSecret, isNodeSecret, parseConnectionUrl, validateNodeSocketUrl, nodeConnectionUrl } from '../connection-url.js';

const id = '22222222-2222-4222-8222-222222222222';
const secret = Buffer.alloc(32, 7).toString('base64url');

test('full connection descriptors round-trip without sending the fragment', () => {
  for (const socketUrl of [`wss://example.com/execution-node/${id}`, 'ws://127.0.0.1:19781/execution-node']) {
    const descriptor = nodeConnectionUrl(socketUrl, secret);
    expect(parseConnectionUrl(descriptor)).toEqual({ socketUrl, secret });
    expect(parseConnectionUrl(descriptor).socketUrl).not.toContain(secret);
  }
  expect(isNodeSecret(createNodeSecret())).toBe(true);
  expect(createNodeSecret()).not.toBe(createNodeSecret());
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
  const options = { direction: 'node-connects' as const, nodeId: id, allowInsecureDevelopment: false };
  expect(validateNodeSocketUrl(`wss://example.com/execution-node/${id}`, options)).toContain(id);
  for (const address of [
    `ws://example.com/execution-node/${id}`, 'wss://example.com/execution-node',
    'wss://example.com/execution-node/33333333-3333-4333-8333-333333333333',
  ]) expect(() => validateNodeSocketUrl(address, options)).toThrow();
  const listener = { direction: 'controller-connects' as const, allowInsecureDevelopment: true };
  expect(() => validateNodeSocketUrl('ws://0.0.0.0:19781/execution-node', listener)).toThrow('reachable');
  expect(validateNodeSocketUrl('ws://0.0.0.0:19781/execution-node', { ...listener, allowPlaceholder: true })).toContain('0.0.0.0');
  expect(validateNodeSocketUrl('ws://127.0.0.1:19781/execution-node', listener)).toContain('127.0.0.1');
});
