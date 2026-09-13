import { expect, test } from 'bun:test';
import { NodeHistoryOperationIssuer } from '../provider-history-operations.js';
import { MAX_NODE_HISTORY_OPERATIONS } from '../transport/provider-history-wire.js';

const session = { controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node', logicalSessionId: 'synthetic-session' };

test('operation issuance never reuses cancelled ordinals and advances past settled gaps', () => {
  const issuer = new NodeHistoryOperationIssuer(session, ['synthetic-a']);
  const first = issuer.allocate(session, 'synthetic-a')!;
  const second = issuer.allocate(session, 'synthetic-a')!;
  expect(first).toMatchObject({ operationId: '1', after: 0 });
  expect(second).toMatchObject({ operationId: '2', after: 0 });
  second.release();
  const third = issuer.allocate(session, 'synthetic-a')!;
  expect(third).toMatchObject({ operationId: '3', after: 0 });
  first.release(); first.release(); third.release();
  const fourth = issuer.allocate(session, 'synthetic-a')!;
  expect(fourth).toMatchObject({ operationId: '4', after: 3 });
  fourth.release(); issuer.close();
});

test('one held instance cannot delay retirement hints or issuance for another instance', () => {
  const issuer = new NodeHistoryOperationIssuer(session, ['synthetic-a', 'synthetic-b']);
  const held = issuer.allocate(session, 'synthetic-a')!;
  for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
    const operation = issuer.allocate(session, 'synthetic-b')!;
    expect(operation).toMatchObject({ operationId: String(ordinal), after: ordinal - 1 });
    operation.release();
  }
  expect(issuer.allocate(session, 'synthetic-a')).toMatchObject({ operationId: '2', after: 0 });
  held.release(); issuer.close();
});

test('outstanding leases are bounded and idempotent release restores issuance', () => {
  const issuer = new NodeHistoryOperationIssuer(session, ['synthetic-a']);
  const operations = Array.from({ length: MAX_NODE_HISTORY_OPERATIONS }, () => issuer.allocate(session, 'synthetic-a')!);
  expect(operations.every(Boolean)).toBe(true);
  expect(issuer.allocate(session, 'synthetic-a')).toBeNull();
  operations[0]!.release(); operations[0]!.release();
  expect(issuer.allocate(session, 'synthetic-a')).toMatchObject({ operationId: String(MAX_NODE_HISTORY_OPERATIONS + 1), after: 1 });
  expect(issuer.allocate(session, 'synthetic-a')).toBeNull();
  for (const operation of operations) operation.release();
  issuer.close();
});

test('issuers reject foreign sessions and instances and retire without reopening identities', () => {
  const original = { ...session };
  const issuer = new NodeHistoryOperationIssuer(original, ['synthetic-a']);
  original.nodeBootId = 'synthetic-mutated';
  expect(issuer.allocate(original, 'synthetic-a')).toBeNull();
  expect(issuer.allocate(session, 'synthetic-b')).toBeNull();
  const operation = issuer.allocate(session, 'synthetic-a')!;
  expect(operation.operationId).toBe('1');
  issuer.close(); operation.release();
  expect(issuer.allocate(session, 'synthetic-a')).toBeNull();
});
