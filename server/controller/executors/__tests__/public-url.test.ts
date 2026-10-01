import { expect, test } from 'bun:test';
import { executorPublicUrl, parsePublicUrl, requestPublicUrl } from '../public-url.js';

test('public bases retain proxy paths and derive the matching WebSocket scheme', () => {
  expect(executorPublicUrl('https://controller.test/garcon', 'synthetic-id')).toBe('wss://controller.test/garcon/executor/synthetic-id');
  expect(executorPublicUrl('http://[::1]:8080/', 'synthetic-id')).toBe('ws://[::1]:8080/executor/synthetic-id');
  expect(parsePublicUrl('https://controller.test/base///')).toBe('https://controller.test/base/');
});

test('explicit public configuration wins over Host and forwarded headers', () => {
  const request = new Request('http://internal:8080/api/v1/executors', { headers: {
    host: 'other.test:9000', 'x-forwarded-host': 'untrusted.test', 'x-forwarded-proto': 'https',
    forwarded: 'host=untrusted.test;proto=https',
  } });
  expect(requestPublicUrl(request, 'https://controller.test/base')).toBe('https://controller.test/base/');
  expect(requestPublicUrl(request, null)).toBe('http://other.test:9000/');
  expect(requestPublicUrl(new Request('https://controller.test/api/v1/executors'), null)).toBe('https://controller.test/');
});

test.each(['', '/relative', 'ws://host/', 'https://user:secret@host/', 'https://host/?secret=value',
  'https://host/#secret=value', 'http://0.0.0.0/', 'http://[::]/', 'https://example.com/', 'https://host/path with space'])('rejects unusable public base %s', value => {
  expect(() => parsePublicUrl(value)).toThrow();
});

test.each(['attacker.test/path', 'user@host', 'host?query', 'host#fragment', 'host:invalid', 'host\\path', 'host,other'])('rejects malformed Host %s', host => {
  expect(() => requestPublicUrl(new Request('http://internal/', { headers: { host } }), null)).toThrow();
});
