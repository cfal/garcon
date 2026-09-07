import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { ProjectTarget } from '$shared/project-resolution';
import { ProjectResolutionStore } from '../project-resolution-store.svelte';

const CHAT_ID = '1783725900000800';
const target = {
	kind: 'chat',
	chatId: CHAT_ID,
	projectPath: '/workspace/project',
} as const;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe('ProjectResolutionStore', () => {
	it('retains observations without fetching until an owner requests resolution', () => {
		const fetchResolution = vi.fn();
		const store = new ProjectResolutionStore(fetchResolution);
		const lease = store.retain(target);

		expect(fetchResolution).not.toHaveBeenCalled();
		expect(lease.snapshot).toEqual({ kind: 'unchecked' });

		lease.release();
	});

	it('coalesces retained demand and prunes after the final release', async () => {
		const result = deferred<{
			target: typeof target;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		const fetchResolution = vi.fn(() => result.promise);
		const store = new ProjectResolutionStore(fetchResolution);
		const first = store.retain(target);
		const second = store.retain(target);

		const firstResolve = first.resolve();
		const secondResolve = second.resolve();
		expect(fetchResolution).toHaveBeenCalledTimes(1);
		expect(first.snapshot).toEqual({ kind: 'resolving' });
		result.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/real/project' },
		});
		await Promise.all([firstResolve, secondResolve]);
		expect(second.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/project',
		});

		first.release();
		expect(store.snapshotFor(target).kind).toBe('available');
		second.release();
		expect(store.snapshotFor(target)).toEqual({ kind: 'unchecked' });
	});

	it('preserves an available observation while a fresh resolution is pending', async () => {
		const refresh = deferred<{
			target: typeof target;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		const fetchResolution = vi
			.fn()
			.mockResolvedValueOnce({
				target,
				resolution: { kind: 'available' as const, effectiveProjectKey: '/real/project' },
			})
			.mockReturnValueOnce(refresh.promise);
		const store = new ProjectResolutionStore(fetchResolution);
		const lease = store.retain(target);
		await lease.resolve();

		const pending = lease.resolve();

		expect(lease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/project',
		});
		refresh.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/real/project-refreshed' },
		});
		await pending;
		expect(lease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/project-refreshed',
		});
		lease.release();
	});

	it('aborts and ignores a late result after the target becomes obsolete', async () => {
		const result = deferred<{
			target: typeof target;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		let capturedSignal: AbortSignal | undefined;
		const store = new ProjectResolutionStore((_target, signal) => {
			capturedSignal = signal;
			return result.promise;
		});
		const lease = store.retain(target);
		const pending = lease.resolve();
		store.markObsoleteChatTargets(CHAT_ID, '/workspace/replacement');

		expect(capturedSignal?.aborted).toBe(true);
		result.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/stale/project' },
		});
		await pending;
		expect(lease.snapshot).toEqual({ kind: 'unchecked' });
		lease.release();
	});

	it('preserves a matching destination while a relocation echo is pending', async () => {
		const destination = { ...target, projectPath: '/workspace/replacement' } as const;
		const result = deferred<{
			target: typeof destination;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		let capturedSignal: AbortSignal | undefined;
		const store = new ProjectResolutionStore((_target, signal) => {
			capturedSignal = signal;
			return result.promise;
		});
		const lease = store.retain(destination);
		const pending = lease.resolve();

		store.markObsoleteChatTargets(CHAT_ID, destination.projectPath);

		expect(capturedSignal?.aborted).toBe(false);
		expect(lease.snapshot).toEqual({ kind: 'resolving' });
		result.resolve({
			target: destination,
			resolution: { kind: 'available', effectiveProjectKey: '/real/replacement' },
		});
		await pending;
		expect(lease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/replacement',
		});
		lease.release();
	});

	it('preserves a resolved destination across duplicate relocation notifications', async () => {
		const destination = { ...target, projectPath: '/workspace/replacement' } as const;
		const fetchResolution = vi.fn(async (requested: ProjectTarget) => ({
			target: requested,
			resolution: { kind: 'available' as const, effectiveProjectKey: `/real${requested.projectPath}` },
		}));
		const store = new ProjectResolutionStore(fetchResolution);
		const oldLease = store.retain(target);
		const lease = store.retain(destination);
		await Promise.all([oldLease.resolve(), lease.resolve()]);

		store.markObsoleteChatTargets(CHAT_ID, destination.projectPath);
		store.markObsoleteChatTargets(CHAT_ID, destination.projectPath);

		expect(fetchResolution).toHaveBeenCalledTimes(2);
		expect(oldLease.snapshot).toEqual({ kind: 'unchecked' });
		expect(lease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/workspace/replacement',
		});
		oldLease.release();
		lease.release();
	});

	it('keeps the current destination resolved when an old binding reports a change', async () => {
		const destination = { ...target, projectPath: '/workspace/replacement' } as const;
		const oldResult = deferred<never>();
		const onBindingChanged = vi.fn();
		const store = new ProjectResolutionStore(
			async (requested) => {
				if (requested.projectPath === target.projectPath) return oldResult.promise;
				return {
					target: requested,
					resolution: {
						kind: 'available',
						effectiveProjectKey: '/real/replacement',
					} as const,
				};
			},
			onBindingChanged,
		);
		const oldLease = store.retain(target);
		const destinationLease = store.retain(destination);
		const oldPending = oldLease.resolve();
		await destinationLease.resolve();

		oldResult.reject(new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED'));
		await oldPending;

		expect(oldLease.snapshot).toEqual({ kind: 'request-failed', message: 'changed' });
		expect(destinationLease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/replacement',
		});
		expect(onBindingChanged).toHaveBeenCalledWith(target);
		oldLease.release();
		destinationLease.release();
	});

	it('supersedes a pending request when Retry starts a fresh inspection', async () => {
		const first = deferred<{
			target: typeof target;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		const second = deferred<{
			target: typeof target;
			resolution: { kind: 'unavailable'; reason: 'not-found' };
		}>();
		const signals: AbortSignal[] = [];
		const fetchResolution = vi.fn((_target, signal: AbortSignal) => {
			signals.push(signal);
			return signals.length === 1 ? first.promise : second.promise;
		});
		const store = new ProjectResolutionStore(fetchResolution);
		const lease = store.retain(target);
		const original = lease.resolve();
		const retry = lease.retry();

		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		first.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/stale/project' },
		});
		await Promise.resolve();
		expect(lease.snapshot).toEqual({ kind: 'resolving' });
		second.resolve({ target, resolution: { kind: 'unavailable', reason: 'not-found' } });
		await Promise.all([original, retry]);
		expect(lease.snapshot).toEqual({ kind: 'unavailable', reason: 'not-found' });
		lease.release();
	});

	it('ignores an obsolete binding rejection after same-target retry', async () => {
		const first = deferred<never>();
		const second = deferred<{
			target: typeof target;
			resolution: { kind: 'available'; effectiveProjectKey: string };
		}>();
		const onBindingChanged = vi.fn();
		const fetchResolution = vi
			.fn()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const store = new ProjectResolutionStore(fetchResolution, onBindingChanged);
		const lease = store.retain(target);
		const original = lease.resolve();
		const retry = lease.retry();

		first.reject(new ApiError(409, 'obsolete', 'PROJECT_PATH_CHANGED'));
		second.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/real/current' },
		});
		await Promise.all([original, retry]);

		expect(lease.snapshot).toEqual({
			kind: 'available',
			effectiveProjectKey: '/real/current',
		});
		expect(onBindingChanged).not.toHaveBeenCalled();
		lease.release();
	});

	it('retires the prior incarnation across repeated A/B/A binding changes', async () => {
		const targetB = { ...target, projectPath: '/workspace/project-b' } as const;
		const fetchResolution = vi.fn(async (requested: ProjectTarget) => ({
			target: requested,
			resolution: {
				kind: 'available' as const,
				effectiveProjectKey: `/real${requested.projectPath}`,
			},
		}));
		const store = new ProjectResolutionStore(fetchResolution);

		const firstLifecycleKey = store.lifecycleKey(target);
		const firstA = store.retain(target);
		await firstA.resolve();
		store.markObsoleteChatTargets(CHAT_ID, targetB.projectPath);
		store.markObsoleteChatTargets(CHAT_ID, target.projectPath);
		const secondLifecycleKey = store.lifecycleKey(target);
		const secondA = store.retain(target);

		expect(secondA.snapshot).toEqual({ kind: 'unchecked' });
		expect(secondLifecycleKey).not.toBe(firstLifecycleKey);
		expect(firstA.snapshot).toEqual({ kind: 'unchecked' });
		await secondA.resolve();
		expect(fetchResolution).toHaveBeenCalledTimes(2);
		firstA.release();
		secondA.release();
	});

	it('does not let released leases start or supersede requests', async () => {
		const fetchResolution = vi.fn(async (requested: ProjectTarget) => ({
			target: requested,
			resolution: { kind: 'available' as const, effectiveProjectKey: '/real/project' },
		}));
		const store = new ProjectResolutionStore(fetchResolution);
		const lease = store.retain(target);
		lease.release();

		await expect(lease.resolve()).rejects.toThrow('Project resolution lease has been released');
		await expect(lease.retry()).rejects.toThrow('Project resolution lease has been released');
		expect(fetchResolution).not.toHaveBeenCalled();
	});

	it('aborts every retained request when the owning workspace is destroyed', async () => {
		const signals: AbortSignal[] = [];
		const fetchResolution = vi.fn((_target, signal: AbortSignal) => {
			signals.push(signal);
			return new Promise<never>(() => undefined);
		});
		const store = new ProjectResolutionStore(fetchResolution);
		const first = store.retain(target);
		const second = store.retain({ ...target, projectPath: '/workspace/project-b' });
		void first.resolve();
		void second.resolve();

		store.destroy();

		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		expect(store.snapshotFor(target)).toEqual({ kind: 'unchecked' });
		await expect(first.resolve()).resolves.toBeUndefined();
		expect(() => store.retain(target)).toThrow('Project resolution store has been destroyed');
	});

	it('invalidates chat metadata when the server reports a changed binding', async () => {
		const onBindingChanged = vi.fn();
		const store = new ProjectResolutionStore(async () => {
			throw new ApiError(409, 'changed', 'PROJECT_PATH_CHANGED');
		}, onBindingChanged);
		const lease = store.retain(target);

		await lease.resolve();

		expect(lease.snapshot).toEqual({ kind: 'request-failed', message: 'changed' });
		expect(onBindingChanged).toHaveBeenCalledWith(target);
		lease.release();
	});
});
