import { expect, test } from 'bun:test';
import {
  canonicalProfile, EXECUTOR_PROTOCOL, isProtocolDecision, isProtocolOffer, isProtocolProfile,
  protocolProfileId, sameContinuity, selectProtocol, supportsRequirement,
} from '../protocol-compatibility.js';

test('core 1 starts without optional contracts and freezes its local offer', () => {
  expect(EXECUTOR_PROTOCOL).toEqual({ core: 1, contracts: {} });
  expect(Object.isFrozen(EXECUTOR_PROTOCOL)).toBe(true);
  expect(Object.isFrozen(EXECUTOR_PROTOCOL.contracts)).toBe(true);
  expect(selectProtocol(EXECUTOR_PROTOCOL, { core: 2, contracts: {} })).toEqual({ ok: false, code: 'CORE_MISMATCH' });
});

test('selection is symmetric and chooses only exact implemented intersections', () => {
  const sets = [[], [1], [2], [3], [1, 3], [1, 2, 3]];
  for (const left of sets) for (const right of sets) {
    const local = { core: 1, contracts: left.length ? { 'synthetic.feature': left } : {} };
    const peer = { core: 1, contracts: right.length ? { 'synthetic.feature': right } : {} };
    const decision = selectProtocol(local, peer);
    expect(decision).toEqual(selectProtocol(peer, local));
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('Core selection failed');
    const common = left.filter(version => right.includes(version));
    expect(decision.profile.contracts).toEqual(common.length ? { 'synthetic.feature': Math.max(...common) } : {});
    expect(Object.isFrozen(decision.profile)).toBe(true);
    expect(Object.isFrozen(decision.profile.contracts)).toBe(true);
  }
  expect(selectProtocol(EXECUTOR_PROTOCOL, { core: 1, contracts: { 'unknown.feature': [1, 3] } }))
    .toEqual({ ok: true, profile: { core: 1, contracts: {} } });
});

test('offer validation bounds unknown names and version sets as strictly as known ones', () => {
  const valid = { core: 65535, contracts: { 'synthetic.feature': [1, 3, 65535] } };
  expect(isProtocolOffer(valid)).toBe(true);
  for (const core of [0, -1, 65536, 1.5, '1', null, Infinity]) expect(isProtocolOffer({ ...valid, core })).toBe(false);
  for (const versions of [[], [1, 1], [0], [65536], [1, 2, 3, 4, 5], ['1'], null, 1]) {
    expect(isProtocolOffer({ core: 1, contracts: { 'unknown.feature': versions } })).toBe(false);
  }
  for (const name of ['', 'Uppercase', 'x'.repeat(65), '__proto__', 'space name']) {
    expect(isProtocolOffer({ core: 1, contracts: { [name]: [1] } })).toBe(false);
  }
  expect(isProtocolOffer({ core: 1, contracts: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, [1]])) })).toBe(false);
  expect(isProtocolOffer({ ...valid, extra: true })).toBe(false);
  expect(isProtocolOffer({ core: 1, contracts: [] })).toBe(false);
  expect(isProtocolOffer(Object.create(valid))).toBe(false);
});

test('profile and decision envelopes are closed', () => {
  expect(isProtocolProfile({ core: 1, contracts: { 'synthetic.feature': 3 } })).toBe(true);
  expect(isProtocolProfile({ core: 1, contracts: { 'synthetic.feature': [3] } })).toBe(false);
  expect(isProtocolDecision({ ok: true, profile: { core: 1, contracts: {} } })).toBe(true);
  expect(isProtocolDecision({ ok: false, code: 'CORE_MISMATCH' })).toBe(true);
  for (const value of [{ ok: false, code: 'UNKNOWN' }, { ok: true }, { ok: 1, profile: EXECUTOR_PROTOCOL }, { ok: false, code: 'CORE_MISMATCH', extra: true }]) {
    expect(isProtocolDecision(value)).toBe(false);
  }
});

test('profile identity ignores key order but not selected versions', () => {
  const left = { core: 1, contracts: { z: 3, a: 1 } };
  const right = { core: 1, contracts: { a: 1, z: 3 } };
  expect(canonicalProfile(left)).toBe('[1,[["a",1],["z",3]]]');
  expect(protocolProfileId(left)).toBe('89a9e85fd858e0251b3375134c31b7c7eb005f88b584609a444570a33c9285b7');
  expect(protocolProfileId(left)).toBe(protocolProfileId(right));
  expect(canonicalProfile({ core: 1, contracts: {} })).toBe('[1,[]]');
  expect(protocolProfileId({ core: 1, contracts: {} })).toBe('1788f993b4772e3516f5409992386cee14668f98ca23773646f1670a8ffaf8d9');
  expect(protocolProfileId(left)).not.toBe(protocolProfileId({ core: 1, contracts: { a: 1, z: 2 } }));
});

test('requirements never infer support from a later version or inherited property', () => {
  const profile = { core: 1, contracts: { 'synthetic.feature': 3 } };
  expect(supportsRequirement(profile, { kind: 'core' })).toBe(true);
  expect(supportsRequirement(profile, { kind: 'contract', name: 'synthetic.feature', version: 3 })).toBe(true);
  expect(supportsRequirement(profile, { kind: 'contract', name: 'synthetic.feature', version: 1 })).toBe(false);
  expect(supportsRequirement(profile, { kind: 'contract', name: 'missing', version: 1 })).toBe(false);
  expect(supportsRequirement(profile, { kind: 'contract', name: 'toString', version: 1 })).toBe(false);
});

test('every continuity identity participates in ownership', () => {
  const continuity = { executorId: 'executor', controllerRuntimeId: 'controller', workerRuntimeId: 'worker', profileId: 'profile' };
  expect(sameContinuity(continuity, { ...continuity })).toBe(true);
  for (const key of Object.keys(continuity)) expect(sameContinuity(continuity, { ...continuity, [key]: 'other' })).toBe(false);
});
