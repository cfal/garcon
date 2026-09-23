import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectResolutionResponse, ProjectTarget } from '$shared/project-resolution';
import { ExecutionNodesStore } from '$lib/execution-nodes/execution-nodes-store.svelte.js';
import {
	localExecutionNode,
	remoteExecutionNode,
} from '$lib/execution-nodes/__tests__/fixtures.js';
import { ProjectResolutionStore } from '$lib/workspace/project-resolution-store.svelte.js';
import { GitProjectSelectionController } from '../git-project-selection.svelte.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
	const nodes = new ExecutionNodesStore();
	const remote = {
		...remoteExecutionNode,
		machineServices: { files: true, git: true, gh: true, terminals: true },
	};
	nodes.applySnapshot([localExecutionNode, remote]);
	const read = vi.fn(
		async (target: ProjectTarget, _signal: AbortSignal): Promise<ProjectResolutionResponse> => ({
			target,
			resolution: { kind: 'available', effectiveProjectKey: target.projectPath },
		}),
	);
	const resolution = new ProjectResolutionStore(read, undefined, nodes);
	const publish = vi.fn();
	const selection = new GitProjectSelectionController(publish, {
		nodes,
		projectResolution: resolution,
		projectBasePath: (nodeId) => nodes.get(nodeId)?.projectBasePath ?? null,
	});
	selection.setPresentationVisible(true);
	selection.setProjectState({
		kind: 'available',
		project: {
			nodeId: 'local',
			chatId: 'a',
			projectPath: '/shared',
			effectiveProjectKey: '/shared',
		},
	});
	cleanups.push(() => {
		selection.dispose();
		resolution.destroy();
	});
	return { selection, read, nodes, remote, publish };
}

describe('Git project selection', () => {
	it('keeps an explicit node and existing folder across chat switches until return', async () => {
		const { selection, read, remote } = setup();
		await selection.selectNode(remote.id);
		expect(read).toHaveBeenCalledWith(
			{ kind: 'path', nodeId: remote.id, projectPath: '/shared' },
			expect.any(AbortSignal),
		);
		selection.setProjectState({
			kind: 'available',
			project: {
				nodeId: 'local',
				chatId: 'b',
				projectPath: '/other',
				effectiveProjectKey: '/other',
			},
		});
		expect(selection.target).toMatchObject({ nodeId: remote.id, projectPath: '/shared' });
		expect(selection.chatId).toBeNull();
		selection.goToChatProject();
		expect(selection.target).toMatchObject({ nodeId: 'local', projectPath: '/other' });
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
			await selection.selectNode(remote.id);
			expect(read).toHaveBeenCalledTimes(2);
			expect(selection.target).toMatchObject({ nodeId: remote.id, projectPath: '/worker' });
		},
	);

	it('preserves permission failures and transport failures without fallback', async () => {
		const { selection, read, remote } = setup();
		read.mockImplementationOnce(async (target) => ({
			target,
			resolution: { kind: 'unavailable', reason: 'permission-denied' },
		}));
		await selection.selectNode(remote.id);
		expect(selection.projectState.kind).toBe('unavailable');
		read.mockRejectedValueOnce(new Error('Disconnected'));
		await selection.selectNode(remote.id);
		expect(selection.projectState).toMatchObject({
			kind: 'request-failed',
			message: 'Disconnected',
		});
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.nodeId).toBe(remote.id);
	});

	it('fences a late path response after return to chat', async () => {
		const { selection, read, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const changing = selection.selectNode(remote.id);
		const [target, signal] = read.mock.calls[0];
		selection.goToChatProject();
		expect(signal.aborted).toBe(true);
		pending.resolve({ target, resolution: { kind: 'available', effectiveProjectKey: '/stale' } });
		await changing;
		expect(selection.target).toMatchObject({ nodeId: 'local', projectPath: '/shared' });
	});

	it('ignores stale fallback after rapid node switches', async () => {
		const { selection, read, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const remoteSelection = selection.selectNode(remote.id);
		const [target, signal] = read.mock.calls[0];
		await selection.selectNode('local', '/local-choice');
		pending.resolve({ target, resolution: { kind: 'unavailable', reason: 'not-found' } });
		await remoteSelection;
		expect(signal.aborted).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.target).toMatchObject({ nodeId: 'local', projectPath: '/local-choice' });
		expect(selection.followingChat).toBe(false);
	});

	it('revalidates the pinned folder on reconnect, not the changed chat', async () => {
		const { selection, read, nodes, remote } = setup();
		await selection.selectNode(remote.id);
		selection.setProjectState({ kind: 'absent' });
		nodes.applySnapshot([localExecutionNode, { ...remote, availability: 'offline' }]);
		expect(selection.projectState.kind).toBe('request-failed');
		expect(selection.nodeId).toBe(remote.id);
		nodes.applySnapshot([localExecutionNode, { ...remote, instanceId: 'replacement' }]);
		await vi.waitFor(() => expect(selection.projectState.kind).toBe('available'));
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.projectState).toMatchObject({
			project: {
				nodeId: remote.id,
				projectPath: '/shared',
				nodeContextKey: nodes.gitContextKey(remote.id),
			},
		});
	});

	it('resolves again when a path lease is invalidated without a Git context change', async () => {
		const { selection, read, nodes, remote } = setup();
		const pending = Promise.withResolvers<ProjectResolutionResponse>();
		read.mockReturnValueOnce(pending.promise);
		const selecting = selection.selectNode(remote.id);
		const [target] = read.mock.calls[0];
		const gitContext = nodes.gitContextKey(remote.id);
		nodes.applySnapshot([
			localExecutionNode,
			{ ...remote, machineServices: { ...remote.machineServices, files: false } },
		]);
		expect(nodes.gitContextKey(remote.id)).toBe(gitContext);
		pending.resolve({
			target,
			resolution: { kind: 'available', effectiveProjectKey: '/obsolete' },
		});
		await selecting;
		expect(read).toHaveBeenCalledTimes(2);
		expect(selection.projectState).toMatchObject({
			kind: 'available',
			project: { nodeId: remote.id, effectiveProjectKey: '/shared' },
		});
	});

	it('supports no-chat selection and retains a removed node instead of switching to Local', async () => {
		const { selection, nodes, remote } = setup();
		selection.setProjectState({ kind: 'absent' });
		await selection.selectNode(remote.id);
		expect(selection.projectPath).toBe('/worker');
		nodes.applySnapshot([localExecutionNode]);
		expect(selection.nodeId).toBe(remote.id);
		expect(selection.projectState.kind).toBe('request-failed');
		await selection.selectNode('local');
		expect(selection.nodeId).toBe('local');
	});
});
