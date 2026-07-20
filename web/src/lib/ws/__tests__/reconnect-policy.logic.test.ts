import { describe, expect, it } from 'vitest';

import { reconnectDelayMs } from '../reconnect-policy';

describe('reconnectDelayMs', () => {
	it('uses an exact 250ms first retry', () => {
		expect(reconnectDelayMs(0, () => 0)).toBe(250);
		expect(reconnectDelayMs(0, () => 1)).toBe(250);
	});

	it('applies injected jitter between 80% and 100%', () => {
		expect(reconnectDelayMs(1, () => 0)).toBe(800);
		expect(reconnectDelayMs(1, () => 1)).toBe(1_000);
	});

	it('progresses exponentially after the first retry', () => {
		expect([1, 2, 3, 4].map((attempt) => reconnectDelayMs(attempt, () => 1))).toEqual([
			1_000, 2_000, 4_000, 8_000,
		]);
	});

	it('caps the unjittered backoff at 30 seconds', () => {
		expect(reconnectDelayMs(20, () => 1)).toBe(30_000);
		expect(reconnectDelayMs(20, () => 0)).toBe(24_000);
	});
});
