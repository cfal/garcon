import { describe, expect, it, vi } from 'vitest';
import { GitMutationCoordinator } from '../git-mutations.svelte';

describe('GitMutationCoordinator', () => {
	it('captures context, tracks pending ownership, and invalidates only successful mutations', async () => {
		let resolveMutation!: (value: boolean) => void;
		const mutation = new Promise<boolean>((resolve) => {
			resolveMutation = resolve;
		});
		const onChanged = vi.fn();
		const coordinator = new GitMutationCoordinator({ onChanged });
		const running = coordinator.run({
			surfaceId: 'singleton:git',
			effectiveProjectKey: '/canonical/project-a',
			projectPath: '/alias/project-a',
			execute: () => mutation,
		});

		expect(coordinator.pendingCount('singleton:git')).toBe(1);
		resolveMutation(true);
		await expect(running).resolves.toBe(true);
		expect(coordinator.pendingCount('singleton:git')).toBe(0);
		expect(onChanged).toHaveBeenCalledWith('/canonical/project-a', '/alias/project-a');

		await coordinator.run({
			surfaceId: 'singleton:git',
			effectiveProjectKey: '/canonical/project-b',
			projectPath: '/project-b',
			execute: async () => false,
		});
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it('releases pending ownership after failure', async () => {
		const coordinator = new GitMutationCoordinator({ onChanged: vi.fn() });
		await expect(
			coordinator.run({
				surfaceId: 'singleton:git',
				effectiveProjectKey: '/project',
				projectPath: '/project',
				execute: async () => {
					throw new Error('failed');
				},
			}),
		).rejects.toThrow('failed');
		expect(coordinator.pendingCount('singleton:git')).toBe(0);
	});
});
