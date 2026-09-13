import { afterEach, expect, test } from 'bun:test';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerBulkAttempts } from '../bulk-attempts.js';
import { session } from './lifecycle-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture(maxIdentities?: number) {
  const lifetime = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: lifetime.signal, poll: () => 0 });
  const control = authority.attach(1);
  authority.openAdmissions(1);
  const attempts = new NodeWorkerBulkAttempts(authority, maxIdentities);
  cleanup.push(() => { attempts.close(); lifetime.abort(); });
  return { attempts, authority, control };
}

test('bulk-only replacement aborts the captured attempt without retiring control or its replacement', () => {
  const f = fixture();
  expect(f.attempts.attach(1, 'first')).toBe(true);
  const first = f.attempts.capture(1, 'first');
  expect(f.attempts.attach(1, 'second')).toBe(true);
  const second = f.attempts.capture(1, 'second');
  expect(first.signal.aborted).toBe(true);
  expect(() => first.validate()).toThrow();
  f.attempts.retire(1, 'first');
  expect(f.attempts.attach(1, 'first')).toBe(false);
  expect(f.attempts.capture(1, 'second')).toBe(second);
  expect(second.signal.aborted).toBe(false);
  f.authority.assertAdmission(f.control);
});

test('retirement delivered before installation prevents a late installation from acquiring authority', () => {
  const f = fixture();
  f.attempts.retire(1, 'retired');
  expect(f.attempts.attach(1, 'retired')).toBe(false);
  expect(() => f.attempts.capture(1, 'retired')).toThrow();
  expect(f.attempts.attach(1, 'fresh')).toBe(true);
  f.attempts.capture(1, 'fresh').validate();
});

test('duplicate live installation keeps the exact lease but a retired duplicate cannot resurrect it', () => {
  const f = fixture();
  f.attempts.attach(1, 'first');
  const first = f.attempts.capture(1, 'first');
  expect(f.attempts.attach(1, 'first')).toBe(true);
  expect(f.attempts.capture(1, 'first')).toBe(first);
  f.attempts.retire(1, 'first');
  f.attempts.retire(1, 'first');
  expect(first.signal.aborted).toBe(true);
  expect(f.attempts.attach(1, 'first')).toBe(false);
});

test('control replacement fences the old lease and cannot reuse its physical identity', () => {
  const f = fixture();
  f.attempts.attach(1, 'first');
  const first = f.attempts.capture(1, 'first');
  f.authority.attach(2);
  expect(first.signal.aborted).toBe(true);
  expect(f.attempts.attach(2, 'first')).toBe(false);
  expect(f.attempts.attach(2, 'second')).toBe(true);
  const second = f.attempts.capture(2, 'second');
  expect(() => f.attempts.retire(1, 'second')).toThrow();
  second.validate();
  f.authority.disconnect(2);
  expect(second.signal.aborted).toBe(true);
});

test.each(['attach', 'retire'] as const)('identity exhaustion through %s fences bulk while preserving other services', (method) => {
  const f = fixture(2);
  f.attempts.attach(1, 'first');
  f.attempts.attach(1, 'second');
  const current = f.attempts.capture(1, 'second');
  f.attempts[method](1, 'third');
  expect(current.signal.aborted).toBe(true);
  expect(() => f.attempts.capture(1, 'second')).toThrow(expect.objectContaining({ code: 'NODE_CAPACITY' }));
  expect(f.attempts.attach(1, 'fourth')).toBe(false);
  f.authority.assertAdmission(f.control);
});

test('logical retirement aborts captures and closes future installation', () => {
  const f = fixture();
  f.attempts.attach(1, 'first');
  const first = f.attempts.capture(1, 'first');
  f.authority.retire();
  expect(first.signal.aborted).toBe(true);
  expect(() => f.attempts.attach(1, 'second')).toThrow();
});
