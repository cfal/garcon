import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectFixture, FIXTURE_COLLECTION_TIMEOUT_MS } from '../collect-fixture.js';

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('fixture collection deadline', () => {
	it('retains the first fixture result and cancels its deadline', async () => {
		const fixture = { first: true };
		const pending = Promise.withResolvers<typeof fixture>();
		const collected = collectFixture(pending.promise, 'synthetic fixture');
		expect(vi.getTimerCount()).toBe(1);
		pending.resolve(fixture);
		expect(await collected).toBe(fixture);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('preserves import failures and cancels the deadline', async () => {
		const failure = new Error('synthetic import failure');
		await expect(collectFixture(Promise.reject(failure), 'synthetic fixture')).rejects.toBe(
			failure,
		);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('bounds a fixture that never settles', async () => {
		const collected = collectFixture(new Promise<never>(() => {}), 'synthetic hanging import');
		const failed = expect(collected).rejects.toThrow(
			`synthetic hanging import (${FIXTURE_COLLECTION_TIMEOUT_MS}ms)`,
		);
		await vi.advanceTimersByTimeAsync(FIXTURE_COLLECTION_TIMEOUT_MS);
		await failed;
		expect(vi.getTimerCount()).toBe(0);
	});
});
