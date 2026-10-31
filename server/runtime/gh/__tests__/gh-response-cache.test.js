import { expect, it } from 'bun:test';
import { GhResponseCache } from '../gh-response-cache.js';
import { parseIncludedResponse } from '../gh-conditional-rest.js';

const repository = { host: 'git.example.invalid', nameWithOwner: 'synthetic/repository' };
const other = { host: 'git.example.invalid', nameWithOwner: 'synthetic/other' };
const response = (body = '[]') => ({ etag: 'W/"one"', body, hasNextPage: false });

it('scopes entries by account, repository, and path', () => {
  const cache = new GhResponseCache();
  cache.set({ account: 'one', repository, path: 'page=1' }, response('[1]'));
  expect(cache.get({ account: 'one', repository, path: 'page=1' })?.body).toBe('[1]');
  expect(cache.get({ account: 'two', repository, path: 'page=1' })).toBeUndefined();
  expect(cache.get({ account: 'one', repository: other, path: 'page=1' })).toBeUndefined();
  expect(cache.get({ account: 'one', repository, path: 'page=2' })).toBeUndefined();
  // Hosts and names compare case-insensitively, as GitHub does.
  expect(cache.get({ account: 'one', repository: { host: 'GIT.example.invalid', nameWithOwner: 'Synthetic/Repository' }, path: 'page=1' })).toBeDefined();
});

it('forgets every account of a refused repository and keeps others', () => {
  const cache = new GhResponseCache();
  cache.set({ account: 'one', repository, path: 'page=1' }, response());
  cache.set({ account: 'two', repository, path: 'page=1' }, response());
  cache.set({ account: 'one', repository: other, path: 'page=1' }, response());
  cache.forgetRepository(repository);
  expect(cache.size).toBe(1);
  expect(cache.get({ account: 'one', repository: other, path: 'page=1' })).toBeDefined();
});

it('evicts the least recently used entries beyond its bounds', () => {
  const cache = new GhResponseCache();
  for (let page = 1; page <= 300; page++) cache.set({ account: 'one', repository, path: `page=${page}` }, response());
  expect(cache.size).toBe(256);
  expect(cache.get({ account: 'one', repository, path: 'page=1' })).toBeUndefined();
  expect(cache.get({ account: 'one', repository, path: 'page=300' })).toBeDefined();
  const large = 'x'.repeat(5 * 1024 * 1024);
  for (let page = 1; page <= 3; page++) cache.set({ account: 'one', repository: other, path: `page=${page}` }, response(large));
  expect(cache.get({ account: 'one', repository: other, path: 'page=1' })).toBeUndefined();
  expect(cache.get({ account: 'one', repository: other, path: 'page=3' })).toBeDefined();
  cache.clear();
  expect(cache.size).toBe(0);
});

it('parses the status, validator, next link, and body gh prints with --include', () => {
  const stdout = 'HTTP/2.0 200 OK\nContent-Type: application/json\r\nEtag: W/"abc"\r\nLink: <https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=3>; rel="last"\r\n\r\n[{"id":1}]\n';
  expect(parseIncludedResponse(stdout)).toEqual({ status: 200, etag: 'W/"abc"', hasNextPage: true, body: '[{"id":1}]\n' });
  expect(parseIncludedResponse('HTTP/2.0 304 Not Modified\nEtag: W/"abc"\r\n\r\n')).toEqual({ status: 304, etag: 'W/"abc"', hasNextPage: false, body: '' });
  expect(parseIncludedResponse('HTTP/2.0 200 OK\nLink: <https://api.github.com/x?page=1>; rel="prev"\r\n\r\n[]')?.hasNextPage).toBe(false);
  expect(parseIncludedResponse('[]')).toBeNull();
  expect(parseIncludedResponse('HTTP/2.0 200 OK\nEtag: W/"abc"\r\n')).toBeNull();
});
