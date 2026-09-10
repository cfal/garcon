import { expect, test } from 'bun:test';
import { createNativeSeedReceipt } from '@garcon/common/transcript-seed';
import { snapshotEstablishedSession } from '../../established-session.js';
import { parseWireProducerEvent } from '../../node-wire.js';

function session() {
  return {
    agentSessionId: 'synthetic-session',
    nativeSession: { ownerId: 'synthetic', schemaVersion: 1, value: { nested: ['original', null, 42, true] } },
    nativeSeedReceipt: createNativeSeedReceipt({ agentSessionId: 'synthetic-session', placement: 'user-prefix', prefix: 'Synthetic context' }),
  };
}

test('local session snapshots and wire sessions preserve the same DTO and seed binding', () => {
  const input = session();
  const expected = structuredClone(input);
  const local = snapshotEstablishedSession(input);
  const wire = parseWireProducerEvent({ type: 'session', session: input });
  input.nativeSession.value.nested[0] = 'mutated';
  Object.assign(input.nativeSeedReceipt, { agentSessionId: 'mutated' });
  expect(local).toEqual(expected);
  expect(wire).toEqual({ type: 'session', session: expected });
  expect(local.nativeSession?.value).not.toBe(expected.nativeSession.value);
});

test('local and wire boundaries reject malformed session structures consistently', () => {
  const valid = session();
  const native = valid.nativeSession;
  const sparseWithProperty = Object.assign(new Array(1), { extra: 'not an array element' });
  for (const input of [
    undefined, null, {}, { ...valid, agentSessionId: '\0' },
    { ...valid, nativeSession: undefined }, { ...valid, nativeSeedReceipt: undefined },
    { ...valid, nativeSession: { ...native, ownerId: 'invalid owner' } },
    { ...valid, nativeSession: { ...native, schemaVersion: Number.MAX_SAFE_INTEGER + 1 } },
    { ...valid, nativeSession: { ...native, value: { sparseWithProperty } } },
    { ...valid, nativeSeedReceipt: { ...valid.nativeSeedReceipt, agentSessionId: 'other-session' } },
    { ...valid, nativeSeedReceipt: { ...valid.nativeSeedReceipt, extra: true } },
  ]) {
    expect(() => snapshotEstablishedSession(input)).toThrow('Invalid established session');
    expect(parseWireProducerEvent({ type: 'session', session: input })).toBeNull();
  }
});
