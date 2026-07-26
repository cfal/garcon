import { untrack } from 'svelte';
import type { PortableSingletonKind } from '$lib/workspace/surface-types.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import type { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import type { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export interface SingletonSurfaceRegistryDeps extends GitSurfaceControllerDeps {
	createCommit(): CommitController;
	createPullRequests(): PullRequestsStore;
}

export class FilesSurfaceController implements PortableSingletonController {
	readonly tree = new FileTreeStore();
	presentationVisible = $state(false);

	setProjectState(projectState: WorkspaceProjectState): void {
		this.tree.setProjectState(projectState);
	}

	setPresentationVisible(visible: boolean): void {
		if (this.presentationVisible === visible) return;
		this.presentationVisible = visible;
		if (visible) this.tree.activate();
		else this.tree.deactivate();
	}

	dispose(): void {
		this.presentationVisible = false;
		this.tree.reset();
	}
}

export interface SingletonControllerByKind {
	git: GitWorkbenchSurfaceController;
	'git-history': GitHistorySurfaceController;
	'git-compare': GitCompareSurfaceController;
	'pull-requests': PullRequestsStore;
	files: FilesSurfaceController;
	commit: CommitController;
}

type SingletonControllerFactories = {
	[K in PortableSingletonKind]: () => SingletonControllerByKind[K];
};

export class SingletonSurfaceRegistry {
	#controllers = new Map<PortableSingletonKind, PortableSingletonController>();
	readonly #factories: SingletonControllerFactories;
	#projectState: WorkspaceProjectState = { kind: 'absent' };
	#pullRequestsCapability: {
		hasChecked: boolean;
		available: boolean;
	} = { hasChecked: false, available: false };
	#visible: Record<PortableSingletonKind, boolean> = {
		git: false,
		'git-history': false,
		'git-compare': false,
		'pull-requests': false,
		files: false,
		commit: false,
	};

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {
		this.#factories = {
			git: () => new GitWorkbenchSurfaceController(this.deps),
			'git-history': () => new GitHistorySurfaceController(this.deps),
			'git-compare': () => new GitCompareSurfaceController(this.deps),
			files: () => new FilesSurfaceController(),
			commit: () => this.deps.createCommit(),
			'pull-requests': () => {
				const controller = this.deps.createPullRequests();
				controller.setCapability(
					this.#pullRequestsCapability.hasChecked,
					this.#pullRequestsCapability.available,
				);
				return controller;
			},
		};
	}

	gitWorkbench(): GitWorkbenchSurfaceController {
		return this.#controller('git');
	}

	gitHistory(): GitHistorySurfaceController {
		return this.#controller('git-history');
	}

	gitCompare(): GitCompareSurfaceController {
		return this.#controller('git-compare');
	}

	files(): FilesSurfaceController {
		return this.#controller('files');
	}

	commit(): CommitController {
		return this.#controller('commit');
	}

	commitIfPresent(): CommitController | null {
		return (this.#controllers.get('commit') as CommitController | undefined) ?? null;
	}

	pullRequests(): PullRequestsStore {
		return this.#controller('pull-requests');
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.#projectState = projectState;
		for (const controller of this.#controllers.values()) {
			controller.setProjectState(projectState);
		}
	}

	setPullRequestsCapability(hasChecked: boolean, available: boolean): void {
		this.#pullRequestsCapability = { hasChecked, available };
		const controller = this.#controllers.get('pull-requests') as PullRequestsStore | undefined;
		controller?.setCapability(hasChecked, available);
	}

	setPresentationVisible(kind: PortableSingletonKind, visible: boolean): void {
		if (this.#visible[kind] === visible) return;
		this.#visible[kind] = visible;
		this.#controllers.get(kind)?.setPresentationVisible(visible);
	}

	disposeSurface(kind: PortableSingletonKind): void {
		this.#visible[kind] = false;
		const controller = this.#controllers.get(kind);
		if (!controller) return;
		controller.setPresentationVisible(false);
		controller.dispose();
		this.#controllers.delete(kind);
	}

	destroy(): void {
		for (const [kind, controller] of this.#controllers) {
			this.#visible[kind] = false;
			controller.setPresentationVisible(false);
			controller.dispose();
		}
		this.#controllers.clear();
	}

	#controller<K extends PortableSingletonKind>(kind: K): SingletonControllerByKind[K] {
		const existing = this.#controllers.get(kind);
		if (existing) return existing as SingletonControllerByKind[K];
		return untrack(() => {
			const controller = this.#factories[kind]();
			controller.setProjectState(this.#projectState);
			controller.setPresentationVisible(this.#visible[kind]);
			this.#controllers.set(kind, controller);
			return controller;
		});
	}
}
