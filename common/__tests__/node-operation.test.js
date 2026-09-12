import { expect, test } from 'bun:test';
import { parseNodeOperationIdentity, parseNodeSessionIdentity } from '../node-operation.js';

const identity = {
  controllerBootId: 'controller-boot', nodeBootId: 'node-boot',
  logicalSessionId: 'logical-session', operationId: 'operation',
};

test('parses an exact operation identity without retaining caller-owned data', () => {
  const input = { ...identity };
  const parsed = parseNodeOperationIdentity(input);
  expect(parsed).toEqual(identity);
  input.operationId = 'replacement';
  expect(parsed.operationId).toBe('operation');
});

test.each(Object.keys(identity))('requires the exact %s identity', (key) => {
  for (const value of [undefined, null, '', 1, {}, 'bad/value', 'a'.repeat(129)]) {
    expect(parseNodeOperationIdentity({ ...identity, [key]: value })).toBeNull();
  }
});

test('rejects foreign fields and non-record operation identities', () => {
  for (const input of [null, [], 'operation', { ...identity, path: '/synthetic-project' }]) {
    expect(parseNodeOperationIdentity(input)).toBeNull();
  }
});

test('rejects inherited identity fields even when foreign keys preserve the key count', () => {
  const operation = Object.assign(Object.create({ controllerBootId: identity.controllerBootId }), {
    nodeBootId: identity.nodeBootId, logicalSessionId: identity.logicalSessionId,
    operationId: identity.operationId, foreign: 'synthetic-foreign',
  });
  expect(parseNodeOperationIdentity(operation)).toBeNull();
  delete operation.operationId;
  expect(parseNodeSessionIdentity(operation)).toBeNull();
});
