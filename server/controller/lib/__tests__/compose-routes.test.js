import { expect, test } from 'bun:test';
import { composeRoutes } from '../compose-routes.ts';

test('combines disjoint methods without replacing handlers or mutating source maps', () => {
  const get = () => new Response('read');
  const post = () => new Response('write');
  const original = { '/shared': { GET: get } };
  expect(composeRoutes(original, { '/shared': { POST: post } })).toEqual({ '/shared': { GET: get, POST: post } });
  expect(original).toEqual({ '/shared': { GET: get } });
});

test('rejects duplicate path-method registrations even for an identical handler', () => {
  const routes = { '/duplicate': { GET: () => new Response() } };
  expect(() => composeRoutes(routes, routes)).toThrow('Duplicate route: GET /duplicate');
  expect(composeRoutes(routes, { '/distinct': routes['/duplicate'] })).toHaveProperty('/distinct');
});
