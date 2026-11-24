import { expect, test } from 'bun:test';
import { NativeChildCaptureBudget, NATIVE_CHILD_CAPTURE_LIMITS as limits } from '../native-child-capture-budget.js';

test('early frame counts are bounded per child and source and released on take', () => {
  const budget = new NativeChildCaptureBudget<string>();
  for (let child = 0; child < 8; child++) {
    for (let index = 0; index < limits.earlyPerChild; index++) expect(budget.buffer(String(child), 'x')).toBe('buffered');
  }
  expect(budget.buffer('0', 'x')).toBe('child-limit');
  expect(budget.buffer('new', 'x')).toBe('source-limit');
  expect(budget.take('0')).toHaveLength(limits.earlyPerChild);
  expect(budget.buffer('new', 'x')).toBe('buffered');
  budget.clear();
  expect(budget.pendingChildren).toBe(0);
});

test('byte limits use encoded bytes, not character counts', () => {
  const budget = new NativeChildCaptureBudget<string>();
  expect(budget.buffer('child', 'x'.repeat(limits.earlyBytesPerChild))).toBe('child-limit');
  const payload = 'x'.repeat(limits.earlyBytesPerChild - 2);
  for (let index = 0; index < 4; index++) expect(budget.buffer(String(index), payload)).toBe('buffered');
  expect(budget.buffer('new', 'x')).toBe('source-limit');
});

test('dedup never evicts old identities to admit new ones', () => {
  const budget = new NativeChildCaptureBudget<string>();
  for (let index = 0; index < limits.identitiesPerSource; index++) {
    expect(budget.remember(String(Math.floor(index / limits.identitiesPerChild)), String(index))).toBe('new');
  }
  expect(budget.remember('0', '0')).toBe('duplicate');
  expect(budget.remember('new', 'new')).toBe('limit');
  budget.forget('0');
  expect(budget.remember('new', 'new')).toBe('new');
  budget.clear();
  expect(budget.remember('new', 'new')).toBe('new');
  expect(budget.remember('large', 'x'.repeat(limits.identityBytesPerSource))).toBe('limit');
});
