import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResolutionResponse, ProjectTarget } from '$shared/project-resolution';
import { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';
import {
	localExecutor,
	remoteExecutor,
} from '$lib/executors/__tests__/fixtures.js';
import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
import { GitProjectSelectionController } from '../git-project-selection.svelte.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
	const executors = new ExecutorsStore();
	const remote = {
		...remoteExecutor,
		machineServices: { files: true, git: true, gh: true, terminals: true },
	};
	executors.applySnapshot([localExecutor, remote]);
	const read = vi.fn(
		async (target: ProjectTarget, _signal: AbortSignal): Promise<ProjectResolutionResponse> => ({
			target,
			resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
		}),
	);
	const resolution = new ProjectResolutionStore(read, undefined, executors);
	const publish = vi.fn();
	const selection = new GitProjectSelectionController(publish, {
		executors,
		projectResolution: resolution,
		projectBasePath: (executorId) => executors.get(executorId)?.projectBasePath ?? null,
	});
	selection.setPresentationVisible(true);
	selection.setProjectState({
		kind: 'available',
		project: {
			executorId: 'local',
			chatId: 'a',
			projectPath: '/shared',
			effectiveProjectKey: '/shared',
		},
	});
	cleanups.push(() => {
		selection.dispose();
		resolution.destroy();
	});
	return { selection, read, executors, remote, publish };
}

describe('Git project selection', () => {
	it('keeps an explicit executor and existing folder across chat switches until return', async () => {
		const { selection, read, remote } = setup();
		await selection.selectExecutor(remote.id);
		expect(read).toHaveBeenCalledWith(
			{ kind: 'path', executorId: remote.id, projectPath: '/shared' },
			expect.any(AbortSignal),
		);
		selection.setProjectState({
			kind: 'available',
			project: {
				executorId: 'local',
				chatId: 'b',
				projectPath: '/other',
				effectiveProjectKey: '/other',
			},
		});
		expect(selection.target).toMatchObject({ executorId: remote.id, projectPath: '/shared' });
		expect(selection.chatId).toBeNull();
		selection.goToChatProject();
		expect(selection.target).toMatchObject({ executorId: 'local', projectPath: '/other' });
		expect(selection.chatId).toBe('b');
	});

	it.each(['not-found', 'not-a-directory', 'outside-base'] as const)(
		'uses the destination base for %s',
		async (reason) => {
			const { selection, read, remote } = setup();
			read.mockImplementationOnce(async (target) => ({
				target,
				resolution: { kind: 'unavailable', reason },
			}));
			await selection.selectExecutor(remote.id);
			expect(read).toHaveBeenCalledTimes(2);
			expect(selection.target).toMatchObject({ executorId: remote.id, projectPath: '/worker' });
		},
	);

	it('preserves permission failures and transport failures without fallback', async () => {
		const { selection, read, remote } = setup();
		read.mockImplementationOnce(async (target) => ({
			target,
			resolution: { kind: 'unavailable', reason: 'permission-denied' },
		}));
		await selection.selectExecutor(remote.id);
		expect(selection.projectState.kind).toBe('unavailable');
		read.mockRejectedValueOnce(new Error('Disconnected'));
		await selection.selectExecutor(remote.id);
		expect(selection.projectState).toMatchObject({
			kind: 'request-failed',
			message: 'Disconnected',
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.executorId).toBe(remote.id);
	});

	it('fences a late path response after return to chat', async () => {
		const { selection, read, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const changing = selection.selectExecutor(remote.id);
		const [target, signal] = read.mock.calls[0];
		selection.goToChatProject();
		expect(signal.aborted).toBe(true);
		pending.resolve({ target, resolution: { kind: 'available', effectiveProjectKey: '/stale' } });
		await changing;
		expect(selection.target).toMatchObject({ executorId: 'local', projectPath: '/shared' });
	});

	it('ignores stale fallback after rapid executor switches', async () => {
		const { selection, read, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const remoteSelection = selection.selectExecutor(remote.id);
		const [target, signal] = read.mock.calls[0];
		await selection.selectExecutor('local', '/local-choice');
		pending.resolve({ target, resolution: { kind: 'unavailable', reason: 'not-found' } });
		await remoteSelection;
		expect(signal.aborted).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.target).toMatchObject({ executorId: 'local', projectPath: '/local-choice' });
		expect(selection.followingChat).toBe(false);
	});

	it('revalidates the pinned folder on reconnect, not the changed chat', async () => {
		const { selection, read, executors, remote } = setup();
		await selection.selectExecutor(remote.id);
		selection.setProjectState({ kind: 'absent' });
		executors.applySnapshot([localExecutor, { ...remote, availability: 'offline' }]);
		expect(selection.projectState.kind).toBe('request-failed');
		expect(selection.executorId).toBe(remote.id);
		executors.applySnapshot([localExecutor, { ...remote, instanceId: 'replacement' }]);
		await vi.waitFor(() => expect(selection.projectState.kind).toBe('available'));
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.projectState).toMatchObject({
			project: {
				executorId: remote.id,
				projectPath: '/shared',
				executorContextKey: executors.gitContextKey(remote.id),
			},
		});
	});

	it('resolves again when a path lease is invalidated without a Git context change', async () => {
		const { selection, read, executors, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const selecting = selection.selectExecutor(remote.id);
		const [target] = read.mock.calls[0];
		const gitContext = executors.gitContextKey(remote.id);
		executors.applySnapshot([
			localExecutor,
			{ ...remote, machineServices: { ...remote.machineServices, files: false } },
		]);
		expect(executors.gitContextKey(remote.id)).toBe(gitContext);
		pending.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/obsolete' },
		});
		await selecting;
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.projectState).toMatchObject({
			kind: 'available',
			project: { executorId: remote.id, effectiveProjectKey: '/shared' },
		});
	});

	it('supports no-chat selection and retains a removed executor instead of switching to Local', async () => {
		const { selection, executors, remote } = setup();
		selection.setProjectState({ kind: 'absent' });
		await selection.selectExecutor(remote.id);
		expect(selection.projectPath).toBe('/worker');
		executors.applySnapshot([localExecutor]);
		expect(selection.executorId).toBe(remote.id);
		expect(selection.projectState.kind).toBe('request-failed');
		await selection.selectExecutor('local');
		expect(selection.executorId).toBe('local');
	});
});
