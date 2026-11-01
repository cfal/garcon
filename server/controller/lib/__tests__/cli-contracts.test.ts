import { expect, test } from 'bun:test';
import { registerCliRoutes } from '../cli-contracts.js';
import { CLI_WIRES_V1 } from '../../../remote/transport/cli-wire-v1.js';
import { cliWireV1 } from '../../../remote/transport/cli-protocol.js';
import released from '../../../remote/transport/__tests__/fixtures/released-contracts.json';

test('the explicit CLI adapter inventory matches the independent released inventory', () => {
  expect(CLI_WIRES_V1.map(wire => `${wire.definition.name}@${wire.definition.version}`).sort())
    .toEqual(released.filter(name => name.startsWith('cli.')).sort());
});

test('production composition refuses a missing route instead of silently reducing its catalog', () => {
  expect(() => registerCliRoutes({})).toThrow('Missing CLI route implementation');
  const wire = cliWireV1('GET /api/v1/chats');
  const handler = () => Response.json({ chats: [] });
  const contracts = registerCliRoutes({ '/api/v1/chats': { GET: handler } }, [wire]);
  expect(contracts.catalog).toEqual({ 'cli.chats.list': [1] });
  expect(contracts.resolve(wire.operation, wire.definition).dispatch).toBe(handler);
  expect(() => registerCliRoutes({ '/api/v1/chat': { GET: handler } }, [wire])).toThrow('Missing CLI route implementation');
});
