import { expect, it, spyOn } from 'bun:test';
import { AcpClient } from '../client.ts';
import { garconInitializeParams, type AcpInitializeResult } from '../protocol.ts';
import { AcpTransport } from '../transport.ts';

const spec = { command: 'agent', args: ['acp'], cwd: '/work', env: {} };
const initialize = garconInitializeParams();

function handshake(result: AcpInitializeResult, methodId = 'oauth-personal') {
  const transport = new AcpTransport();
  spyOn(transport, 'connect').mockResolvedValue(undefined);
  const request = spyOn(transport, 'request').mockResolvedValueOnce(result);
  const notify = spyOn(transport, 'notify').mockImplementation(() => {});
  return { client: new AcpClient(transport, { initialize, authenticateMethodId: methodId }), request, notify };
}

it('finishes initialization without in-band authentication for an explicitly empty list', async () => {
  const { client, request, notify } = handshake({ protocolVersion: 1, authMethods: [] });
  expect(await client.connect(spec)).toEqual({ authenticatedMethodId: null });
  expect(request.mock.calls).toEqual([['initialize', initialize]]);
  expect(notify).toHaveBeenCalledWith('notifications/initialized', {});
});

const configuredHandshakes = [
  { name: 'advertised', methodId: 'oauth-personal', result: { protocolVersion: 1, authMethods: [{ id: 'gemini-api-key' }, { id: 'oauth-personal' }] } },
  { name: 'omitted', methodId: 'cursor_login', result: { protocolVersion: 1 } },
];
it.each(configuredHandshakes)('uses the configured method when the method list is $name', async ({ methodId, result }) => {
  const { client, request, notify } = handshake(result, methodId);
  request.mockResolvedValueOnce({});
  expect(await client.connect(spec)).toEqual({ authenticatedMethodId: methodId });
  expect(request.mock.calls).toEqual([['initialize', initialize], ['authenticate', { methodId }]]);
  expect(notify).toHaveBeenCalledWith('notifications/initialized', {});
});

it('does not substitute another advertised method', async () => {
  const { client, request, notify } = handshake({ protocolVersion: 1, authMethods: [{ id: 'oauth-business' }] });
  await expect(client.connect(spec)).rejects.toThrow('oauth-personal');
  expect(request).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
});

it('propagates an advertised method\'s authentication failure', async () => {
  const { client, request, notify } = handshake({ protocolVersion: 1, authMethods: [{ id: 'oauth-personal' }] });
  request.mockRejectedValueOnce(new Error('Credential expired'));
  await expect(client.connect(spec)).rejects.toThrow('Credential expired');
  expect(notify).not.toHaveBeenCalled();
});
