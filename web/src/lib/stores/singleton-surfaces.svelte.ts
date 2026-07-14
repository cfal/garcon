import type { PortableSingletonKind } from '$lib/workspace/surface-types.js';
import { FileTreeStore } from './file-tree.svelte.js';
import { GitSurfaceController, type GitSurfaceControllerDeps } from './git-surface.svelte.js';
import type { PullRequestsStore } from './pull-requests.svelte.js';
import type { CommitController } from './commit.svelte.js';
import type { WorkspaceProjectState } from '$lib/workspace/workspace-context.svelte.js';

export interface SingletonSurfaceRegistryDeps extends GitSurfaceControllerDeps {
	createCommit(): CommitController;
	createPullRequests(): PullRequestsStore;
}

export class FilesSurfaceController {
	readonly tree = new FileTreeStore();
	presentationVisible = $state(false);
	#projectState: WorkspaceProjectState = { kind: 'absent' };

	setProjectState(projectState: WorkspaceProjectState): void {
		this.#projectState = projectState;
		this.tree.applyProjectState(projectState, this.presentationVisible);
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
		this.tree.applyProjectState(this.#projectState, visible);
	}

	dispose(): void {
		this.presentationVisible = false;
		this.tree.reset();
	}
}

export class SingletonSurfaceRegistry {
	#git: GitSurfaceController | null = null;
	#files: FilesSurfaceController | null = null;
	#commit: CommitController | null = null;
	#pullRequests: PullRequestsStore | null = null;
	#projectState: WorkspaceProjectState = { kind: 'absent' };
	#pullRequestsCapability: {
		hasChecked: boolean;
		available: boolean;
	} = { hasChecked: false, available: false };
	#visible: Record<PortableSingletonKind, boolean> = {
		git: false,
		'pull-requests': false,
		files: false,
		commit: false,
	};

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {}

	git(): GitSurfaceController {
		if (!this.#git) {
			this.#git = new GitSurfaceController(this.deps);
			this.#git.setProjectState(this.#projectState);
		}
		this.#git.setPresentationVisible(this.#visible.git);
		return this.#git;
	}

	files(): FilesSurfaceController {
		if (!this.#files) {
			this.#files = new FilesSurfaceController();
			this.#files.setProjectState(this.#projectState);
		}
		this.#files.setPresentationVisible(this.#visible.files);
		return this.#files;
	}

	commit(): CommitController {
		if (!this.#commit) {
			this.#commit = this.deps.createCommit();
			void this.#commit.setProjectState(this.#projectState);
			void this.#commit.setPresentationVisible(this.#visible.commit);
		}
		return this.#commit;
	}

	commitIfPresent(): CommitController | null {
		return this.#commit;
	}

	pullRequests(): PullRequestsStore {
		if (!this.#pullRequests) {
			this.#pullRequests = this.deps.createPullRequests();
			this.#pullRequests.setProjectState(this.#projectState);
			this.#pullRequests.setCapability(
				this.#pullRequestsCapability.hasChecked,
				this.#pullRequestsCapability.available,
			);
			this.#pullRequests.setVisible(this.#visible['pull-requests']);
		}
		return this.#pullRequests;
	}

	pullRequestsIfPresent(): PullRequestsStore | null {
		return this.#pullRequests;
	}

	setProjectState(projectState: WorkspaceProjectState): void {
		this.#projectState = projectState;
		this.#files?.setProjectState(projectState);
		this.#git?.setProjectState(projectState);
		void this.#commit?.setProjectState(projectState);
		this.#pullRequests?.setProjectState(projectState);
	}

	setPullRequestsCapability(hasChecked: boolean, available: boolean): void {
		this.#pullRequestsCapability = { hasChecked, available };
		this.#pullRequests?.setCapability(hasChecked, available);
	}

	setPresentationVisible(kind: PortableSingletonKind, visible: boolean): void {
		if (this.#visible[kind] === visible) return;
		this.#visible[kind] = visible;
		switch (kind) {
			case 'git':
				this.#git?.setPresentationVisible(visible);
				return;
			case 'files':
				this.#files?.setPresentationVisible(visible);
				return;
			case 'pull-requests':
				this.#pullRequests?.setVisible(visible);
				return;
			case 'commit':
				void this.#commit?.setPresentationVisible(visible);
		}
	}

	disposeSurface(kind: PortableSingletonKind): void {
		this.#visible[kind] = false;
		switch (kind) {
			case 'git':
				this.#git?.dispose();
				this.#git = null;
				return;
			case 'files':
				this.#files?.dispose();
				this.#files = null;
				return;
			case 'pull-requests':
				this.#pullRequests?.disposeSurface();
				this.#pullRequests = null;
				return;
			case 'commit':
				this.#commit?.dispose();
				this.#commit = null;
		}
	}

	destroy(): void {
		this.#git?.dispose();
		this.#files?.dispose();
		this.#pullRequests?.disposeSurface();
		this.#commit?.dispose();
		this.#git = null;
		this.#files = null;
		this.#pullRequests = null;
		this.#commit = null;
	}
}
