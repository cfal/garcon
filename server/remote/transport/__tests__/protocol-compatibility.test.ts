import { expect, test } from 'bun:test';
import {
  canonicalProfile, isProtocolOffer, selectProtocol, supportsContract, supportsDefinition,
  intersectContracts, assertDefinitions, assertOfferComplete, defineContract,
} from '@garcon/common/protocol-contracts';
import { RPC_V1, PRODUCER_CREATOR_V1, TERMINAL_CREATOR_V1, assertCreator } from '@garcon/common/executor-contracts';
import { WORKER_CONTRACTS } from '../../server/worker-contracts.js';
const EXECUTOR_PROTOCOL = WORKER_CONTRACTS.offer;
import { protocolProfileId, sameContinuity, isProtocolDecision } from '../protocol-compatibility.js';

test('every application operation starts with an explicit v1 contract, not an application core', () => {
  expect(EXECUTOR_PROTOCOL.bootstrap).toBe(1);
  expect(Object.hasOwn(EXECUTOR_PROTOCOL, 'core')).toBe(false);
  expect(EXECUTOR_PROTOCOL.contracts['files.read']).toEqual([1]);
  expect(Object.keys(EXECUTOR_PROTOCOL.contracts)).toHaveLength(187);
  expect(Object.isFrozen(EXECUTOR_PROTOCOL)).toBe(true);
  expect(Object.isFrozen(EXECUTOR_PROTOCOL.contracts)).toBe(true);
  expect(selectProtocol(EXECUTOR_PROTOCOL, { bootstrap: 2, contracts: {} })).toEqual({ ok: false, code: 'BOOTSTRAP_MISMATCH' });
});

test('intersection is symmetric and retains all common exact versions', () => {
  const sets = [[], [1], [2], [3], [1, 3], [1, 2, 3]];
  for (const left of sets) for (const right of sets) {
    const local = { bootstrap: 1, contracts: left.length ? { 'synthetic.feature': left } : {} };
    const peer = { bootstrap: 1, contracts: right.length ? { 'synthetic.feature': right } : {} };
    const before = JSON.stringify([local, peer]);
    const selection = selectProtocol(local, peer);
    expect(selection).toEqual(selectProtocol(peer, local));
    if (!selection.ok) throw new Error('Bootstrap selection failed');
    const common = left.filter(version => right.includes(version));
    expect(selection.profile.contracts).toEqual(common.length ? { 'synthetic.feature': common } : {});
    expect(Object.isFrozen(selection.profile)).toBe(true);
    expect(Object.isFrozen(selection.profile.contracts)).toBe(true);
    if (common.length) expect(Object.isFrozen(selection.profile.contracts['synthetic.feature'])).toBe(true);
    expect(JSON.stringify([local, peer])).toBe(before);
  }
  expect(selectProtocol(EXECUTOR_PROTOCOL, { bootstrap: 1, contracts: { 'unknown.feature': [1, 3] } }))
    .toEqual({ ok: true, profile: { bootstrap: 1, contracts: {} } });
});

test('offer validation bounds unknown names and version sets as strictly as known ones', () => {
  const valid = { bootstrap: 65535, contracts: { 'synthetic.feature': [1, 3, 65535], 'git.getStatus': [1] } };
  expect(isProtocolOffer(valid)).toBe(true);
  for (const bootstrap of [0, -1, 65536, 1.5, '1', null, Infinity]) expect(isProtocolOffer({ ...valid, bootstrap })).toBe(false);
  for (const versions of [[], [1, 1], [0], [65536], [1, 2, 3, 4, 5], ['1'], null, 1]) {
    expect(isProtocolOffer({ bootstrap: 1, contracts: { 'unknown.feature': versions } })).toBe(false);
  }
  for (const name of ['', 'Uppercase', 'x'.repeat(65), '__proto__', 'space name']) {
    expect(isProtocolOffer({ bootstrap: 1, contracts: { [name]: [1] } })).toBe(false);
  }
  expect(isProtocolOffer({ bootstrap: 1, contracts: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`c${i}`, [1]])) })).toBe(false);
  expect(isProtocolOffer({ ...valid, extra: true })).toBe(false);
  expect(isProtocolOffer({ bootstrap: 1, contracts: [] })).toBe(false);
  expect(isProtocolOffer(Object.create(valid))).toBe(false);
});

test('proof decisions contain only the local profile hash or a fixed refusal code', () => {
  const profileId = protocolProfileId(EXECUTOR_PROTOCOL);
  expect(isProtocolDecision({ ok: true, profileId })).toBe(true);
  expect(isProtocolDecision({ ok: false, code: 'BOOTSTRAP_MISMATCH' })).toBe(true);
  for (const value of [{ ok: false, code: 'UNKNOWN' }, { ok: true }, { ok: true, profile: EXECUTOR_PROTOCOL },
    { ok: true, profileId: 'a'.repeat(63) }, { ok: true, profileId: 'A'.repeat(64) },
    { ok: false, code: 'BOOTSTRAP_MISMATCH', extra: true }, { ok: false, code: ['BOOTSTRAP_MISMATCH'] },
    { ok: false, code: { toString: 'BOOTSTRAP_MISMATCH' } }]) expect(isProtocolDecision(value)).toBe(false);
});

test('profile identity ignores key and version order but not set membership', () => {
  const left = { bootstrap: 1, contracts: { z: [3, 1], a: [1] } };
  const right = { bootstrap: 1, contracts: { a: [1], z: [1, 3] } };
  expect(canonicalProfile(left)).toBe('[1,[["a",[1]],["z",[1,3]]]]');
  expect(protocolProfileId(left)).toBe(protocolProfileId(right));
  expect(canonicalProfile({ bootstrap: 1, contracts: {} })).toBe('[1,[]]');
  expect(protocolProfileId({ bootstrap: 1, contracts: {} })).toBe('1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9');
  expect(protocolProfileId(left)).not.toBe(protocolProfileId({ bootstrap: 1, contracts: { a: [1], z: [2] } }));
});

test('requirements do not infer support from a later version or inherited property', () => {
  const contracts = { 'synthetic.feature': [3] };
  expect(supportsContract(contracts, { name: 'synthetic.feature', version: 3 })).toBe(true);
  expect(supportsContract(contracts, { name: 'synthetic.feature', version: 1 })).toBe(false);
  expect(supportsContract(contracts, { name: 'missing', version: 1 })).toBe(false);
  expect(supportsContract(contracts, { name: 'toString', version: 1 })).toBe(false);
});

test('complete flat offers need no pruning, and defective peer catalogs remain guarded', () => {
  const close = defineContract('history.close', 1, []);
  const next = defineContract('history.next', 2, []);
  const open = defineContract('history.open', 2, [close, next]);
  const list = defineContract('files.list', 1, []);
  const definitions = [close, next, open, list];
  const complete = { 'history.open': [2], 'history.next': [2], 'history.close': [1], 'files.list': [1] };
  const defective = { 'history.open': [2], 'history.next': [2], 'files.list': [1] };
  expect(() => assertOfferComplete(complete, definitions)).not.toThrow();
  expect(() => assertOfferComplete(defective, definitions)).toThrow('Incomplete contract offer');
  const contracts = intersectContracts(complete, defective);
  expect(supportsContract(contracts, open)).toBe(true);
  expect(supportsDefinition(contracts, open)).toBe(false);
  expect(supportsDefinition(contracts, list)).toBe(true);
  expect(() => assertDefinitions([open, next, list])).toThrow('Incomplete flat requirements');
  expect(() => assertDefinitions([...definitions, close])).toThrow('duplicate');
  const composite = defineContract('synthetic.composite', 1, [open]);
  expect(() => assertDefinitions([...definitions, composite])).toThrow('Incomplete flat requirements');
  expect(() => assertDefinitions([...definitions, { ...composite, requires: [open, next, close] }])).not.toThrow();
});

test('creator registrations cover resource events and consumers do not require event codecs', () => {
  for (const creator of [PRODUCER_CREATOR_V1, TERMINAL_CREATOR_V1]) {
    expect(() => assertCreator(creator)).not.toThrow();
    const codecs = { ...creator.codecs };
    delete codecs[Object.keys(codecs)[0]! as keyof typeof codecs];
    expect(() => assertCreator({ ...creator, codecs })).toThrow('Incomplete creator codecs');
  }
  for (const method of ['execution.start', 'execution.resume', 'compaction.compact'] as const) {
    expect(RPC_V1[method].requires.some(ref => ref.name.startsWith('producer.'))).toBe(false);
    expect(RPC_V1[method].requires.some(ref => ref.name === 'resource.producer-binding')).toBe(true);
  }
});

test('every continuity identity participates in ownership', () => {
  const continuity = { executorId: 'executor', controllerRuntimeId: 'controller', workerRuntimeId: 'worker', profileId: 'profile' };
  expect(sameContinuity(continuity, { ...continuity })).toBe(true);
  for (const key of Object.keys(continuity)) expect(sameContinuity(continuity, { ...continuity, [key]: 'other' })).toBe(false);
});
