import { expect, mock, test } from 'bun:test';
import { Deferred, withTimeout } from '../../integration-tests/support/deferred.ts';
import { awaitFixtureSetup } from '../../integration-tests/support/fixture-setup.ts';
import { rejectionOf } from '../../integration-tests/support/promise-assertions.ts';

test('a setup deadline retains ownership of late-created fixtures', async () => {
  const creation = new Deferred();
  const disposed = new Deferred();
  const fixture = {};
  const dispose = mock(async value => { disposed.resolve(value); });

  const result = await rejectionOf(awaitFixtureSetup(creation.promise, dispose, 0, () => 'Setup expired'));
  expect(result.message).toBe('Setup expired');
  expect(dispose).not.toHaveBeenCalled();
  creation.resolve(fixture);
  expect(await withTimeout(disposed.promise, 1_000, () => 'Late fixture was not disposed')).toBe(fixture);
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('successful setup transfers disposal ownership to the caller', async () => {
  const fixture = {};
  const dispose = mock(async () => {});
  expect(await awaitFixtureSetup(Promise.resolve(fixture), dispose, 1_000, () => 'Setup expired')).toBe(fixture);
  expect(dispose).not.toHaveBeenCalled();
});

test('creation failures preserve their cause without disposing a nonexistent fixture', async () => {
  const failure = new Error('Synthetic creation failure');
  const dispose = mock(async () => {});
  expect(await rejectionOf(awaitFixtureSetup(Promise.reject(failure), dispose, 1_000, () => 'Setup expired'))).toBe(failure);
  expect(dispose).not.toHaveBeenCalled();
});
