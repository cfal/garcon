import {
	PORTABLE_SINGLETON_KINDS,
	type PortableSingletonKind,
} from '$lib/workspace/surface-types.js';
import type { PortableSingletonController } from '$lib/workspace/portable-singleton-controller.js';
import { FileTreeStore } from '$lib/files/tree/file-tree.svelte.js';
import type { GitSurfaceControllerDeps } from '$lib/git/surface/git-surface-controller-deps.js';
import { GitWorkbenchSurfaceController } from '$lib/git/workbench/git-workbench-surface.svelte.js';
import { GitHistorySurfaceController } from '$lib/git/history/git-history-surface.svelte.js';
import { GitCompareSurfaceController } from '$lib/git/review/git-compare-surface.svelte.js';
import type { GitComparisonPreferences } from '$lib/git/review/git-comparison-preferences.js';
import type { PullRequestsStore } from '$lib/git/pull-requests/pull-requests-store.svelte.js';
import type { CommitController } from '$lib/git/commit/commit-controller.svelte.js';
import { ChatMapController } from '$lib/chat-map/chat-map-controller.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export interface SingletonSurfaceRegistryDeps extends GitSurfaceControllerDeps {
	createCommit(): CommitController;
	createPullRequests(): PullRequestsStore;
	comparisonPreferences: GitComparisonPreferences;
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
	'chat-map': ChatMapController;
}

type SingletonControllerFactories = {
	[K in PortableSingletonKind]: () => SingletonControllerByKind[K];
};

interface OwnedSingletonController {
	controller: PortableSingletonController;
	destroyRoot: () => void;
}

export class SingletonSurfaceRegistry {
	#controllers = new Map<PortableSingletonKind, OwnedSingletonController>();
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
		'chat-map': false,
	};
	#hasVisibleProjectSurface = $state(false);

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {
		this.#factories = {
			git: () => new GitWorkbenchSurfaceController(this.deps),
			'git-history': () => new GitHistorySurfaceController(this.deps),
			'git-compare': () => new GitCompareSurfaceController(this.deps),
			files: () => new FilesSurfaceController(),
			commit: () => this.deps.createCommit(),
			'chat-map': () => new ChatMapController(),
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

	chatMap(): ChatMapController {
		return this.#controller('chat-map');
	}

	commit(): CommitController {
		return this.#controller('commit');
	}

	commitIfPresent(): CommitController | null {
		return (this.#controllers.get('commit')?.controller as CommitController | undefined) ?? null;
	}

	pullRequests(): PullRequestsStore {
		return this.#controller('pull-requests');
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.#projectState = projectState;
		for (const owned of this.#controllers.values()) {
			owned.controller.setProjectState(projectState);
		}
	}

	setPullRequestsCapability(hasChecked: boolean, available: boolean): void {
		this.#pullRequestsCapability = { hasChecked, available };
		const controller = this.#controllers.get('pull-requests')?.controller as
			PullRequestsStore | undefined;
		controller?.setCapability(hasChecked, available);
	}

	setPresentationVisible(kind: PortableSingletonKind, visible: boolean): void {
		if (this.#visible[kind] === visible) return;
		this.#visible[kind] = visible;
		this.#updateVisibleProjectSurface();
		this.#controllers.get(kind)?.controller.setPresentationVisible(visible);
	}

	get hasVisibleProjectSurface(): boolean {
		return this.#hasVisibleProjectSurface;
	}

	disposeSurface(kind: PortableSingletonKind): void {
		this.#visible[kind] = false;
		this.#updateVisibleProjectSurface();
		const owned = this.#controllers.get(kind);
		if (!owned) return;
		this.#controllers.delete(kind);
		try {
			owned.controller.setPresentationVisible(false);
			owned.controller.dispose();
		} finally {
			owned.destroyRoot();
		}
	}

	#updateVisibleProjectSurface(): void {
		this.#hasVisibleProjectSurface = PORTABLE_SINGLETON_KINDS.some(
			(candidate) => candidate !== 'chat-map' && this.#visible[candidate],
		);
	}

	destroy(): void {
		for (const kind of [...this.#controllers.keys()]) this.disposeSurface(kind);
	}

	#controller<K extends PortableSingletonKind>(kind: K): SingletonControllerByKind[K] {
		const existing = this.#controllers.get(kind);
		if (existing) return existing.controller as SingletonControllerByKind[K];
		let controller!: SingletonControllerByKind[K];
		// A registry-owned root keeps lazy rune state alive across presentation remounts.
		const destroyRoot = $effect.root(() => {
			controller = this.#factories[kind]();
			controller.setProjectState(this.#projectState);
			controller.setPresentationVisible(this.#visible[kind]);
		});
		this.#controllers.set(kind, { controller, destroyRoot });
		return controller;
	}
}
