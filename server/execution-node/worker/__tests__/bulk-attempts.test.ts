import { afterEach, expect, test } from 'bun:test';
import { NodeWorkerAuthority } from '../authority.js';
import { NodeWorkerBulkAttempts } from '../bulk-attempts.js';
import { session } from './lifecycle-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function fixture() {
  const lifetime = new AbortController();
  const authority = new NodeWorkerAuthority({ session, signal: lifetime.signal, poll: () => 0 });
  const control = authority.attach(1);
  authority.openAdmissions(1);
  const attempts = new NodeWorkerBulkAttempts(authority);
  cleanup.push(() => { attempts.close(); lifetime.abort(); });
  return { attempts, authority, control };
}

test('bulk-only replacement aborts the captured attempt without retiring control or its replacement', () => {
  const f = fixture();
  expect(f.attempts.attach(1, '1')).toBe(true);
  const first = f.attempts.capture(1, '1');
  expect(f.attempts.attach(1, '2')).toBe(true);
  const second = f.attempts.capture(1, '2');
  expect(first.signal.aborted).toBe(true);
  expect(() => first.validate()).toThrow();
  f.attempts.retire(1, '1');
  expect(f.attempts.attach(1, '1')).toBe(false);
  expect(f.attempts.capture(1, '2')).toBe(second);
  expect(second.signal.aborted).toBe(false);
  f.authority.assertAdmission(f.control);
});

test('retirement delivered before installation prevents a late installation from acquiring authority', () => {
  const f = fixture();
  f.attempts.retire(1, '1');
  expect(f.attempts.attach(1, '1')).toBe(false);
  expect(() => f.attempts.capture(1, '1')).toThrow();
  expect(f.attempts.attach(1, '2')).toBe(true);
  f.attempts.capture(1, '2').validate();
});

test('duplicate live installation keeps the exact lease but a retired duplicate cannot resurrect it', () => {
  const f = fixture();
  f.attempts.attach(1, '1');
  const first = f.attempts.capture(1, '1');
  expect(f.attempts.attach(1, '1')).toBe(true);
  expect(f.attempts.capture(1, '1')).toBe(first);
  f.attempts.retire(1, '1');
  f.attempts.retire(1, '1');
  expect(first.signal.aborted).toBe(true);
  expect(f.attempts.attach(1, '1')).toBe(false);
});

test('control replacement fences the old lease and cannot reuse its physical identity', () => {
  const f = fixture();
  f.attempts.attach(1, '1');
  const first = f.attempts.capture(1, '1');
  f.authority.attach(2);
  expect(first.signal.aborted).toBe(true);
  expect(f.attempts.attach(2, '1')).toBe(false);
  expect(f.attempts.attach(2, '2')).toBe(true);
  const second = f.attempts.capture(2, '2');
  expect(() => f.attempts.retire(1, '2')).toThrow();
  second.validate();
  f.authority.disconnect(2);
  expect(second.signal.aborted).toBe(true);
});

test('ten thousand bulk replacements do not exhaust history or revive a retired attempt', () => {
  const f = fixture();
  for (let ordinal = 1; ordinal <= 10_000; ordinal++) {
    const id = String(ordinal);
    expect(f.attempts.attach(1, id)).toBe(true);
    f.attempts.capture(1, id).validate();
    f.attempts.retire(1, id);
  }
  expect(f.attempts.attach(1, '1')).toBe(false);
  expect(f.attempts.attach(1, '10001')).toBe(true);
  f.attempts.capture(1, '10001').validate();
  f.authority.assertAdmission(f.control);
});

test('logical retirement aborts captures and closes future installation', () => {
  const f = fixture();
  f.attempts.attach(1, '1');
  const first = f.attempts.capture(1, '1');
  f.authority.retire();
  expect(first.signal.aborted).toBe(true);
  expect(() => f.attempts.attach(1, '2')).toThrow();
});
