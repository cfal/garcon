import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { createGitSurfaceTestDeps } from '$lib/git/__tests__/git-surface-test-deps.js';
import { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import { SingletonSurfaceRegistry } from '$lib/workspace/singleton-surfaces.svelte.js';
import SingletonSurfaceRegistryTemplateHost from './SingletonSurfaceRegistryTemplateHost.svelte';

afterEach(cleanup);

function createRegistry() {
	const commits: Array<{
		setProjectState: ReturnType<typeof vi.fn>;
		setPresentationVisible: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	}> = [];
	const pullRequestsStores: Array<{
		setProjectState: ReturnType<typeof vi.fn>;
		setCapability: ReturnType<typeof vi.fn>;
		setPresentationVisible: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
	}> = [];
	const gitSurfaceDeps = createGitSurfaceTestDeps();
	const registry = new SingletonSurfaceRegistry({
		...gitSurfaceDeps,
		createCommit: () => {
			const controller = new CommitController(gitSurfaceDeps);
			const tracked = {
				setProjectState: vi.spyOn(controller, 'setProjectState'),
				setPresentationVisible: vi.spyOn(controller, 'setPresentationVisible'),
				dispose: vi.spyOn(controller, 'dispose'),
			};
			commits.push(tracked);
			return controller;
		},
		createPullRequests: () => {
			const controller = new PullRequestsStore();
			const tracked = {
				setProjectState: vi.spyOn(controller, 'setProjectState'),
				setCapability: vi.spyOn(controller, 'setCapability'),
				setPresentationVisible: vi.spyOn(controller, 'setPresentationVisible'),
				dispose: vi.spyOn(controller, 'dispose'),
			};
			pullRequestsStores.push(tracked);
			return controller;
		},
	});
	return {
		registry,
		commits,
		pullRequestsStores,
		comparisonPreferences: gitSurfaceDeps.comparisonPreferences,
	};
}

describe('SingletonSurfaceRegistry', () => {
	it('retains singleton context while a selected draft resolves', () => {
		const { registry, commits, pullRequestsStores } = createRegistry();
		registry.setProjectState({
			kind: 'available',
			project: {
				chatId: 'chat-a',
				projectPath: '/project-a',
				effectiveProjectKey: '/canonical/a',
			},
		});
		const git = registry.gitWorkbench();
		const files = registry.files();
		registry.commit();
		registry.pullRequests();
		const resolving = {
			kind: 'resolving' as const,
			context: {
				chatId: 'draft-b',
				projectPath: '/project-b',
				effectiveProjectKey: null,
			},
		};

		registry.setProjectState(resolving);

		expect(git.target.baseProjectPath).toBe('/project-a');
		expect(git.target.effectiveProjectKey).toBe('/canonical/a');
		expect(files.tree.projectPath).toBe('/project-a');
		expect(files.tree.effectiveProjectKey).toBe('/canonical/a');
		expect(commits[0]?.setProjectState).toHaveBeenLastCalledWith(resolving);
		expect(pullRequestsStores[0]?.setProjectState).toHaveBeenLastCalledWith(resolving);
	});

	it('retains one Git and Files controller across presentation changes', () => {
		const { registry } = createRegistry();
		registry.setPresentationVisible('git', true);
		registry.setPresentationVisible('files', true);
		const git = registry.gitWorkbench();
		const files = registry.files();
		git.target.showTargetDialog = true;

		registry.setPresentationVisible('git', false);
		registry.setPresentationVisible('files', false);

		expect(registry.gitWorkbench()).toBe(git);
		expect(registry.files()).toBe(files);
		expect(git.presentationVisible).toBe(false);
		expect(git.target.showTargetDialog).toBe(false);
		expect(files.presentationVisible).toBe(false);
	});

	it('keeps template access pure when Files remounts with a retained controller', () => {
		const { registry } = createRegistry();
		registry.setPresentationVisible('files', true);
		const first = render(SingletonSurfaceRegistryTemplateHost, { registry });
		expect(screen.getByText('visible')).toBeTruthy();
		first.unmount();

		expect(() => render(SingletonSurfaceRegistryTemplateHost, { registry })).not.toThrow();
		expect(screen.getByText('visible')).toBeTruthy();
	});

	it('retains each controller across Git placement remounts', () => {
		const { registry } = createRegistry();
		const git = registry.gitWorkbench();

		registry.setPresentationVisible('git', false);
		registry.setPresentationVisible('git', true);
		expect(registry.gitWorkbench()).toBe(git);
	});

	it('disposes only on destructive Close and creates a fresh controller on reopen', () => {
		const { registry } = createRegistry();
		const firstGit = registry.gitWorkbench();
		const firstFiles = registry.files();
		const firstPullRequests = registry.pullRequests();
		const firstCommit = registry.commit();

		registry.disposeSurface('git');
		registry.disposeSurface('files');
		registry.disposeSurface('pull-requests');
		registry.disposeSurface('commit');

		expect(registry.gitWorkbench()).not.toBe(firstGit);
		expect(registry.files()).not.toBe(firstFiles);
		expect(registry.pullRequests()).not.toBe(firstPullRequests);
		expect(registry.commit()).not.toBe(firstCommit);
		expect(firstPullRequests.dispose).toHaveBeenCalledOnce();
		expect(firstCommit.dispose).toHaveBeenCalledOnce();
	});

	it('constructs independent Workbench, History, and Compare controllers', () => {
		const { registry } = createRegistry();
		const workbench = registry.gitWorkbench();
		const history = registry.gitHistory();
		const compare = registry.gitCompare();

		expect(workbench).not.toBe(history);
		expect(history).not.toBe(compare);
		expect(workbench.target.branches).not.toBe(history.target.branches);
		expect(history.target.branches).not.toBe(compare.target.branches);

		registry.disposeSurface('git-compare');
		expect(registry.gitWorkbench()).toBe(workbench);
		expect(registry.gitHistory()).toBe(history);
		expect(registry.gitCompare()).not.toBe(compare);
	});

	it('retains Compare preferences across surface and root disposal', () => {
		const { registry, comparisonPreferences } = createRegistry();
		const specification = {
			fromRevision: 'origin/main',
			toKind: 'revision' as const,
			toRevision: 'HEAD',
			mode: 'direct' as const,
		};
		comparisonPreferences.remember('chat-a', specification);
		registry.gitCompare();

		registry.disposeSurface('git-compare');
		expect(comparisonPreferences.recall('chat-a')).toEqual(specification);

		registry.destroy();
		expect(comparisonPreferences.recall('chat-a')).toEqual(specification);
	});

	it('routes visibility for every singleton through one lifecycle owner', () => {
		const { registry, pullRequestsStores, commits } = createRegistry();
		registry.pullRequests();
		registry.commit();
		const pullRequests = pullRequestsStores[0]!;
		const commit = commits[0]!;
		pullRequests.setPresentationVisible.mockClear();
		commit.setPresentationVisible.mockClear();

		registry.setPresentationVisible('pull-requests', true);
		registry.setPresentationVisible('commit', true);
		registry.setPresentationVisible('pull-requests', false);
		registry.setPresentationVisible('commit', false);

		expect(pullRequests.setPresentationVisible.mock.calls).toEqual([[true], [false]]);
		expect(commit.setPresentationVisible.mock.calls).toEqual([[true], [false]]);
	});
});
