import { expect, test } from 'bun:test';
import { createChatTicketSourceRoutes } from '../chat-ticket-source.js';
import { wrapRoutes } from '../../lib/http-route.js';

const CHAT = '1000000000000001';
const VIEW = '11111111-1111-4111-8111-111111111111';
const source = { chatId: CHAT, transcriptViewId: VIEW, ordinal: 7 };
const routePath = '/api/v1/chats/ticket-source';
const capability = 'synthetic-source-capability';
const query = new URLSearchParams({ ...source, ordinal: String(source.ordinal) }).toString();

function fixture() {
  const calls = [];
  let exists = true;
  const routes = wrapRoutes(createChatTicketSourceRoutes({ hasChat: () => exists }, {
    async resolveTicketSource(value, signal) {
      calls.push(value); signal.throwIfAborted();
      return { kind: 'found', target: { ...value, ordinal: 9 } };
    },
  }), { localCapability: capability });
  return { calls, remove: () => { exists = false; }, async call(search = query, authorized = true) {
    return routes[routePath].GET(new Request(`http://localhost${routePath}?${search}`, {
      headers: authorized ? { authorization: `Bearer ${capability}` } : {},
    }));
  } };
}

test('authenticates fully wrapped source reads and keeps every response no-store', async () => {
  const f = fixture();
  let response = await f.call(query, false);
  expect(response.status).toBe(401);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(f.calls).toEqual([]);
  response = await f.call();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ kind: 'found', target: { ...source, ordinal: 9 } });
  expect(f.calls).toEqual([source]);
});

test('rejects malformed/duplicate addresses and deleted chats before ledger access', async () => {
  const f = fixture();
  for (const search of ['', `${query}&ordinal=8`, `${query}&extra=1`, query.replace('ordinal=7', 'ordinal=1.5'),
    query.replace('ordinal=7', 'ordinal=0'), query.replace(VIEW, 'invalid')]) {
    const response = await f.call(search);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  f.remove();
  const response = await f.call();
  expect(response.status).toBe(404);
  expect((await response.json()).errorCode).toBe('SESSION_NOT_FOUND');
  expect(f.calls).toEqual([]);
});

test('preserves no-store cancellation without treating it as a server failure', async () => {
  const abort = new AbortController();
  const routes = wrapRoutes(createChatTicketSourceRoutes({ hasChat: () => true }, {
    async resolveTicketSource(_source, signal) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      signal.throwIfAborted();
    },
  }), { localCapability: capability });
  const response = routes[routePath].GET(new Request(`http://localhost${routePath}?${query}`, {
    signal: abort.signal,
    headers: { authorization: `Bearer ${capability}` },
  }));
  abort.abort();
  expect((await response).status).toBe(499);
  expect((await response).headers.get('cache-control')).toBe('no-store');
});
