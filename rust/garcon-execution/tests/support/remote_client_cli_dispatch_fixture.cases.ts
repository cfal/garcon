import { expect, test } from 'bun:test';
import { dispatchCli } from './remote_client_cli_dispatch_fixture.ts';

function request(operation: string, body: unknown, expectedServerInstanceId = 'controller') {
  return { expectedServerInstanceId, http: { operation, query: [], body } };
}

test('returns the application failure as a bounded JSON reply', async () => {
  const valid = request('GET /api/v1/chats', null);
  expect(await dispatchCli(valid, 'bulk', '{"error":"fixture","x":1.0}', '3')).toEqual({ status: 409, body: { error: 'fixture', x: 1 }, retryAfter: '3' });
  expect(await dispatchCli(valid, 'bulk', 'null', 'invalid')).toEqual({ status: 409, body: null });
  await expect(dispatchCli(valid, 'bulk', '{', null)).rejects.toMatchObject({ code: 'CLI_CONTROLLER_UNAVAILABLE' });
  await expect(dispatchCli(request('POST /api/v1/chats/run', {}), 'bulk', '{', null)).rejects.toMatchObject({ code: 'CLI_OUTCOME_UNKNOWN' });
});

test('guards the allowlist, server generation, lane and target before dispatch', async () => {
  await expect(dispatchCli(request('GET /api/v1/private', null), 'bulk', '{}', null)).rejects.toThrow();
  await expect(dispatchCli(request('GET /api/v1/chats', null, 'previous'), 'bulk', '{}', null)).rejects.toMatchObject({ code: 'CLI_CONTROLLER_CHANGED' });
  await expect(dispatchCli(request('GET /api/v1/chats', null), 'primary', '{}', null)).rejects.toMatchObject({ code: 'CLI_ACCESS_DENIED' });
  await expect(dispatchCli(request('POST /api/v1/chats/start', { projectPath: '/fixture' }), 'bulk', '{}', null)).rejects.toThrow();
  expect(await dispatchCli(request('GET /api/v1/chats/turn-receipt', null), 'primary', '{}', '12345')).toEqual({ status: 409, body: {}, retryAfter: '12345' });
  await expect(dispatchCli(request('GET /api/v1/chats/turn-receipt', null), 'primary', JSON.stringify('x'.repeat(65_536)), null)).rejects.toMatchObject({ code: 'CLI_RESULT_TOO_LARGE' });
  await expect(dispatchCli(request('POST /api/v1/chats/stop', {}), 'primary', JSON.stringify('x'.repeat(65_536)), null)).rejects.toMatchObject({ code: 'CLI_OUTCOME_UNKNOWN' });
});
