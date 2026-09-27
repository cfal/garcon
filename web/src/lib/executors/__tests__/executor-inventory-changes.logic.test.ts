import { describe, expect, it } from 'vitest';
import type { ExecutorSnapshot } from '$shared/executors';
import { ExecutorInventoryChanges } from '../executor-inventory-changes.js';
import { localExecutor, remoteExecutor } from './fixtures.js';

const offlineRemote = { ...remoteExecutor, availability: 'offline' } satisfies ExecutorSnapshot;

describe('ExecutorInventoryChanges', () => {
	it('treats the first snapshot as the baseline', () => {
		expect(new ExecutorInventoryChanges().observe([localExecutor, remoteExecutor])).toBe(false);
	});

	it('reports an executor that becomes ready after the baseline', () => {
		const changes = new ExecutorInventoryChanges();
		changes.observe([localExecutor, offlineRemote]);

		expect(changes.observe([localExecutor, remoteExecutor])).toBe(true);
		expect(changes.observe([localExecutor, remoteExecutor])).toBe(false);
	});

	it('reports a replacement serving instance and a removed executor', () => {
		const changes = new ExecutorInventoryChanges();
		changes.observe([localExecutor, remoteExecutor]);

		expect(changes.observe([localExecutor, { ...remoteExecutor, instanceId: 'replacement' }])).toBe(true);
		expect(changes.observe([localExecutor])).toBe(true);
	});

	it('ignores disconnects, disabled executors and error-only updates', () => {
		const changes = new ExecutorInventoryChanges();
		changes.observe([localExecutor, remoteExecutor]);

		expect(changes.observe([localExecutor, offlineRemote])).toBe(false);
		expect(changes.observe([
			localExecutor,
			{ ...offlineRemote, lastError: { code: 'EXECUTOR_UNAVAILABLE', message: 'Synthetic failure' } },
		])).toBe(false);
		expect(changes.observe([localExecutor, { ...remoteExecutor, enabled: false }])).toBe(false);
	});
});
