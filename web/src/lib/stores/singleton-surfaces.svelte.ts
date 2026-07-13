import type { PortableSingletonKind } from '$lib/workspace/surface-types.js';
import { FileTreeStore } from './file-tree.svelte.js';
import {
	GitSurfaceController,
	type GitSurfaceControllerDeps,
} from './git-surface.svelte.js';
import type { PullRequestsStore } from './pull-requests.svelte.js';
import type { QuickGitController } from './quick-git.svelte.js';

export interface SingletonSurfaceRegistryDeps extends GitSurfaceControllerDeps {
	createQuickGit(): QuickGitController;
	createPullRequests(): PullRequestsStore;
}

export class FilesSurfaceController {
	readonly tree = new FileTreeStore();
	presentationVisible = $state(false);

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
	}

	dispose(): void {
		this.presentationVisible = false;
		this.tree.reset();
	}
}

export class SingletonSurfaceRegistry {
	#git: GitSurfaceController | null = null;
	#files: FilesSurfaceController | null = null;
	#quickGit: QuickGitController | null = null;
	#pullRequests: PullRequestsStore | null = null;
	#quickGitContext: { effectiveProjectKey: string | null; projectPath: string | null } = {
		effectiveProjectKey: null,
		projectPath: null,
	};
	#gitContext: { effectiveProjectKey: string | null; projectPath: string | null } = {
		effectiveProjectKey: null,
		projectPath: null,
	};
	#pullRequestsCapability: {
		hasChecked: boolean;
		available: boolean;
	} = { hasChecked: false, available: false };
	#visible: Record<PortableSingletonKind, boolean> = {
		git: false,
		'pull-requests': false,
		files: false,
		'quick-git': false,
	};

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {}

	git(): GitSurfaceController {
		if (!this.#git) {
			this.#git = new GitSurfaceController(this.deps);
			this.#git.setContext(this.#gitContext.projectPath, this.#gitContext.effectiveProjectKey);
		}
		this.#git.setPresentationVisible(this.#visible.git);
		return this.#git;
	}

	files(): FilesSurfaceController {
		this.#files ??= new FilesSurfaceController();
		this.#files.setPresentationVisible(this.#visible.files);
		return this.#files;
	}

	quickGit(): QuickGitController {
		if (!this.#quickGit) {
			this.#quickGit = this.deps.createQuickGit();
			void this.#quickGit.setContext(
				this.#quickGitContext.effectiveProjectKey,
				this.#quickGitContext.projectPath,
			);
			void this.#quickGit.setPresentationVisible(this.#visible['quick-git']);
		}
		return this.#quickGit;
	}

	quickGitIfPresent(): QuickGitController | null {
		return this.#quickGit;
	}

	pullRequests(): PullRequestsStore {
		if (!this.#pullRequests) {
			this.#pullRequests = this.deps.createPullRequests();
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

	setQuickGitContext(effectiveProjectKey: string | null, projectPath: string | null): void {
		this.#quickGitContext = { effectiveProjectKey, projectPath };
		void this.#quickGit?.setContext(effectiveProjectKey, projectPath);
	}

	setGitContext(effectiveProjectKey: string | null, projectPath: string | null): void {
		this.#gitContext = { effectiveProjectKey, projectPath };
		this.#git?.setContext(projectPath, effectiveProjectKey);
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
			case 'quick-git':
				void this.#quickGit?.setPresentationVisible(visible);
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
			case 'quick-git':
				this.#quickGit?.dispose();
				this.#quickGit = null;
		}
	}

	destroy(): void {
		this.#git?.dispose();
		this.#files?.dispose();
		this.#pullRequests?.disposeSurface();
		this.#quickGit?.dispose();
		this.#git = null;
		this.#files = null;
		this.#pullRequests = null;
		this.#quickGit = null;
	}
}
