import { expect, mock, test } from 'bun:test';
import { CLI_CONTRACT_HEADER } from '@garcon/common/cli-contracts';
import { cliWireV1 } from '../../../remote/transport/cli-protocol.js';
import { CliRouteContracts } from '../cli-contracts.js';
import { markRouteNoAuth, wrapRoute } from '../http-route.js';

test.each(['', '/tools/garcon'])('direct CLI validation preserves the request and resolves the mounted executor path: %s', async basePath => {
  const wire = cliWireV1('PATCH /api/v1/executors/:executorId');
  const executorId = '11111111-1111-4111-8111-111111111111';
  const body = { label: 'Synthetic executor' };
  const request = new Request(`http://localhost${basePath}/api/v1/executors/${executorId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', [CLI_CONTRACT_HEADER]: `${wire.definition.name}@1` },
    body: JSON.stringify(body),
  });
  const handler = markRouteNoAuth(async (incoming, url) => Response.json({
    sameRequest: incoming === request, path: url.pathname, body: await incoming.json(),
  }));
  const validateRequest = mock(wire.validateRequest);
  const contracts = new CliRouteContracts([{ ...wire, side: 'handler', dispatch: handler, validateRequest }]);
  const wrapped = wrapRoute(handler, '/api/v1/executors/:executorId', 'PATCH', { cliContracts: contracts, basePath });
  const response = await wrapped(request);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sameRequest: true, path: `/api/v1/executors/${executorId}`, body });
  expect(validateRequest).toHaveBeenCalledWith({ operation: wire.operation, executorId, query: [], body });
});

test('direct CLI validation preserves repeated query order', async () => {
  const wire = cliWireV1('GET /api/v1/chats');
  const handler = markRouteNoAuth(() => Response.json(null));
  const validateRequest = mock(wire.validateRequest);
  const contracts = new CliRouteContracts([{ ...wire, side: 'handler', dispatch: handler, validateRequest }]);
  const wrapped = wrapRoute(handler, '/api/v1/chats', 'GET', { cliContracts: contracts });
  expect((await wrapped(new Request('http://localhost/api/v1/chats?tag=first&limit=2&tag=second', {
    headers: { [CLI_CONTRACT_HEADER]: `${wire.definition.name}@1` },
  }))).status).toBe(200);
  expect(validateRequest).toHaveBeenCalledWith({ operation: wire.operation,
    query: [['tag', 'first'], ['limit', '2'], ['tag', 'second']], body: null });
});

test('direct CLI validation preserves malformed JSON errors and paired-browser dispatch', async () => {
  const wire = cliWireV1('PUT /api/v1/app/settings');
  const handler = markRouteNoAuth(mock(async (request: Request) => Response.json(await request.json())));
  const contracts = new CliRouteContracts([{ ...wire, side: 'handler', dispatch: handler }]);
  const wrapped = wrapRoute(handler, '/api/v1/app/settings', 'PUT', { cliContracts: contracts });
  const send = (body: string, cli: boolean) => wrapped(new Request('http://localhost/api/v1/app/settings', {
    method: 'PUT', body, headers: { 'Content-Type': 'application/json',
      ...(cli ? { [CLI_CONTRACT_HEADER]: `${wire.definition.name}@1` } : {}) },
  }));
  const malformed = await send('{', true);
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toMatchObject({ error: 'Malformed JSON', success: false });
  const forbidden = JSON.stringify({ ui: { chatTitle: { enabled: false } } });
  expect((await send(forbidden, true)).status).toBe(403);
  expect(handler).not.toHaveBeenCalled();
  expect(await (await send(forbidden, false)).json()).toEqual(JSON.parse(forbidden));
  const allowed = JSON.stringify({ features: { transcriptSearch: { enabled: false } } });
  expect(await (await send(allowed, true)).json()).toEqual(JSON.parse(allowed));
  expect(handler).toHaveBeenCalledTimes(2);
});
