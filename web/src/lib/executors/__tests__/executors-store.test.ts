import { describe, expect, it, vi } from 'vitest';
import type { ExecutorSnapshot } from '$shared/executors';
import { ExecutorsStore, executorStatus } from '../executors-store.svelte.ts';
import { localExecutor, remoteExecutor } from './fixtures';

describe('ExecutorsStore', () => {
	it('changes path context only for the affected executor, including missed disconnects', () => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([localExecutor, remoteExecutor]);
		const local = executors.pathContextKey('local');
		const initial = executors.pathContextKey(remoteExecutor.id);
		executors.applySnapshot([localExecutor, { ...remoteExecutor, label: 'Renamed' }]);
		expect(executors.pathContextKey(remoteExecutor.id)).toBe(initial);
		for (const change of [{ instanceId: 'replacement' }, { projectBasePath: '/' }, { availability: 'offline' as const }]) {
			executors.applySnapshot([localExecutor, { ...remoteExecutor, ...change }]);
			expect(executors.pathContextKey(remoteExecutor.id)).not.toBe(initial);
			expect(executors.pathContextKey('local')).toBe(local);
		}
	});

	it('keeps Local usable before discovery and after an isolated discovery failure', async () => {
		const executors = new ExecutorsStore(async () => { throw new Error('Discovery failed'); });
		expect(executors.isReady()).toBe(true);
		expect(executors.isReady(remoteExecutor.id)).toBe(false);
		expect(executors.executors.map((executor) => executor.id)).toEqual(['local']);
		expect(executors.hasSnapshot).toBe(false);
		await executors.refresh();
		expect(executors.error).toBe('Discovery failed');
		expect(executors.isReady('local')).toBe(true);
		executors.applySnapshot([{ ...localExecutor, availability: 'offline' }]);
		expect(executors.hasSnapshot).toBe(true);
		expect(executors.isReady('local')).toBe(false);
	});

	it('keeps unknown targets unavailable and removes deleted executors', () => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([localExecutor, remoteExecutor]);
		expect(executors.isReady()).toBe(true);
		expect(executors.isReady(remoteExecutor.id)).toBe(true);
		executors.applySnapshot([localExecutor]);
		expect(executors.get(remoteExecutor.id)).toBeUndefined();
		expect(executors.isReady(remoteExecutor.id)).toBe(false);
		expect(executors.label(remoteExecutor.id)).toBe('Unavailable executor');
		expect(executors.filesAvailable(remoteExecutor.id)).toBe(false);
		expect(executors.gitAvailable(remoteExecutor.id)).toBe(false);
		executors.applySnapshot([localExecutor, { ...remoteExecutor, id: '33333333-3333-4333-8333-333333333333' }]);
		expect(executors.isReady(remoteExecutor.id)).toBe(false);
	});

	it('rejects credential-bearing snapshots without replacing the current list', () => {
		const executors = new ExecutorsStore();
		executors.applySnapshot([localExecutor]);
		expect(() => executors.applySnapshot([{ ...remoteExecutor, secret: 'private' }])).toThrow();
		expect(() => executors.applySnapshot([{ ...remoteExecutor, connectionUrl: 'private' }])).toThrow();
		expect(executors.executors).toEqual([localExecutor]);
	});

	it('coalesces refreshes and ignores an HTTP result older than a pushed snapshot', async () => {
		const response = Promise.withResolvers<readonly ExecutorSnapshot[]>();
		const read = vi.fn(() => response.promise);
		const executors = new ExecutorsStore(read);
		const first = executors.refresh();
		const second = executors.refresh();
		executors.applySnapshot([localExecutor, remoteExecutor]);
		response.resolve([localExecutor]);
		await first;
		await second;
		expect(read).toHaveBeenCalledTimes(1);
		expect(executors.executors).toEqual([localExecutor, remoteExecutor]);
		expect(executors.loading).toBe(false);
	});

	it('preserves pushed readiness when an older HTTP request fails', async () => {
		const response = Promise.withResolvers<readonly ExecutorSnapshot[]>();
		const executors = new ExecutorsStore(() => response.promise);
		const pending = executors.refresh();
		executors.applySnapshot([remoteExecutor]);
		response.reject(new Error('Disconnected'));
		await pending;
		expect(executors.error).toBeNull();
		expect(executors.isReady(remoteExecutor.id)).toBe(true);
	});

	it('distinguishes disabled, waiting, and offline states', () => {
		expect(executorStatus({ ...remoteExecutor, enabled: false })).toBe('Disabled');
		expect(executorStatus({ ...remoteExecutor, availability: 'offline' })).toBe('Waiting for connection');
		expect(executorStatus({ ...remoteExecutor, direction: 'controller-connects', availability: 'offline' })).toBe('Offline');
	});
});
