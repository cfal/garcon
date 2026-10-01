import { expect, mock, test } from 'bun:test';
import { createWebSocketUpgradeHandler } from '../upgrade.js';
import { LOCAL_SERVER_PRINCIPAL } from '../../lib/http-route-types.js';

function fixture(overrides = {}) {
  const options = {
    executors: { inboundLink: mock(() => null) },
    executionSockets: {},
    wsAdmission: { tryReserve: mock(() => ({ ok: true })), release: mock(() => {}) },
    authDisabled: true,
    isShuttingDown: () => false,
    ...overrides,
  };
  return { ...options, handler: createWebSocketUpgradeHandler(options) };
}

function request(path = '/ws') {
  return new Request(`http://localhost${path}`, { headers: { Upgrade: 'websocket' } });
}

test('preserves Local authority and admission until the socket opens', async () => {
  const { handler, wsAdmission } = fixture();
  const upgrade = mock(() => true);
  expect(await handler(request(), { upgrade })).toBeUndefined();
  const data = upgrade.mock.calls[0][1].data;
  expect(data.principal).toBe(LOCAL_SERVER_PRINCIPAL);
  expect(data.kind).toBe('primary');
  expect(wsAdmission.tryReserve).toHaveBeenCalledWith(data.connectionId);
  expect(wsAdmission.release).not.toHaveBeenCalled();
});

test.each(['false', 'throws'])('releases admission when upgrade %s', async outcome => {
  const { handler, wsAdmission } = fixture();
  const error = new Error('synthetic upgrade failure');
  const upgrade = mock(() => { if (outcome === 'throws') throw error; return false; });
  if (outcome === 'throws') await expect(handler(request(), { upgrade })).rejects.toBe(error);
  else expect((await handler(request(), { upgrade })).status).toBe(400);
  expect(wsAdmission.release).toHaveBeenCalledWith(upgrade.mock.calls[0][1].data.connectionId);
});

test('keeps executor upgrades separate from browser authentication and admission', async () => {
  const response = new Response('synthetic link response', { status: 409 });
  const link = { upgrade: mock(() => response) };
  const { handler, wsAdmission, executionSockets } = fixture({
    authDisabled: false, executors: { inboundLink: () => link },
  });
  const incoming = request('/executor/22222222-2222-4222-8222-222222222222');
  const server = { upgrade: mock(() => true) };
  expect(await handler(incoming, server)).toBe(response);
  expect(link.upgrade).toHaveBeenCalledWith(incoming, server, executionSockets);
  expect(wsAdmission.tryReserve).not.toHaveBeenCalled();
});

test('rejects shutdown, unauthorized clients, unknown executors, and unrelated routes', async () => {
  const server = { upgrade: mock(() => true) };
  expect((await fixture({ isShuttingDown: () => true }).handler(request(), server)).status).toBe(503);
  expect((await fixture({ authDisabled: false }).handler(request(), server)).status).toBe(401);
  expect((await fixture().handler(request('/executor/123'), server)).status).toBe(404);
  expect((await fixture().handler(request('/unrelated'), server)).status).toBe(404);
  expect((await fixture().handler(new Request('http://localhost/ws'), server)).status).toBe(404);
  expect(server.upgrade).not.toHaveBeenCalled();
});
