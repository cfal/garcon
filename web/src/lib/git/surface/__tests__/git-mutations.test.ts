import { describe, expect, it, vi } from 'vitest';
import { GitMutationCoordinator } from '$lib/git/surface/git-mutations.svelte.js';

describe('GitMutationCoordinator', () => {
	it('captures context and reconciles completed operations, including non-success results', async () => {
		let resolveMutation!: (value: boolean) => void;
		const mutation = new Promise<boolean>((resolve) => {
			resolveMutation = resolve;
		});
		const onChanged = vi.fn();
		const coordinator = new GitMutationCoordinator({ onChanged });
		const running = coordinator.run({
			nodeId: 'local',
			surfaceId: 'singleton:git',
			effectiveProjectKey: '/canonical/project-a',
			projectPath: '/alias/project-a',
			execute: () => mutation,
		});

		expect(coordinator.pendingCount('singleton:git')).toBe(1);
		resolveMutation(true);
		await expect(running).resolves.toBe(true);
		expect(coordinator.pendingCount('singleton:git')).toBe(0);
		expect(onChanged).toHaveBeenCalledWith('local', '/canonical/project-a', '/alias/project-a');

		await coordinator.run({
			nodeId: 'local',
			surfaceId: 'singleton:git',
			effectiveProjectKey: '/canonical/project-b',
			projectPath: '/project-b',
			execute: async () => false,
		});
		expect(onChanged).toHaveBeenCalledTimes(2);
	});

	it('releases pending ownership after failure', async () => {
		const onChanged = vi.fn();
		const onMutationError = vi.fn();
		const coordinator = new GitMutationCoordinator({ onChanged, onMutationError });
		await expect(
			coordinator.run({
				nodeId: 'remote',
				surfaceId: 'singleton:git',
				effectiveProjectKey: '/project',
				projectPath: '/project',
				execute: async () => {
					throw new Error('failed');
				},
			}),
		).rejects.toThrow('failed');
		expect(coordinator.pendingCount('singleton:git')).toBe(0);
		expect(onChanged).toHaveBeenCalledWith('remote', '/project', '/project');
		expect(onMutationError).toHaveBeenCalledWith(expect.any(Error), 'remote', '/project');
	});
});
