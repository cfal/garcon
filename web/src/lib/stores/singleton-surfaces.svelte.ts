import { FileTreeStore } from './file-tree.svelte.js';
import { GitPanelStore } from './git-panel.svelte.js';
import { GitWorkbenchStore } from './git-workbench.svelte.js';
import type { GitBranchSelectorState } from './git/git-branch-selector-state.svelte.js';
import type { GitMutationCoordinator } from './git-mutations.svelte.js';
import type { PullRequestsStore } from './pull-requests.svelte.js';
import type { QuickGitController } from './quick-git.svelte.js';
import type { PortableSingletonKind } from '$lib/workspace/surface-types.js';

export interface SingletonSurfaceRegistryDeps {
	quickGit: QuickGitController;
	pullRequests: PullRequestsStore;
	gitBranchActions: GitBranchSelectorState;
	gitMutations: GitMutationCoordinator;
	getCurrentEffectiveProjectKey(): string | null;
}

export class GitSurfaceController {
	readonly panel: GitPanelStore;
	readonly workbench: GitWorkbenchStore;
	presentationVisible = $state(false);

	constructor(deps: SingletonSurfaceRegistryDeps) {
		this.panel = new GitPanelStore(deps.gitBranchActions);
		this.workbench = new GitWorkbenchStore({
			runMutation: (projectPath, execute) =>
				deps.gitMutations.run({
					surfaceId: 'singleton:git',
					effectiveProjectKey: deps.getCurrentEffectiveProjectKey() ?? projectPath,
					projectPath,
					execute,
				}),
		});
	}

	setPresentationVisible(visible: boolean): void {
		this.presentationVisible = visible;
	}

	dispose(): void {
		this.presentationVisible = false;
		this.panel.resetForProject(null);
		this.workbench.reset();
	}
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
	readonly quickGit: QuickGitController;
	readonly pullRequests: PullRequestsStore;
	#git: GitSurfaceController | null = null;
	#files: FilesSurfaceController | null = null;
	#visible: Record<PortableSingletonKind, boolean> = {
		git: false,
		'pull-requests': false,
		files: false,
		'quick-git': false,
	};

	constructor(private readonly deps: SingletonSurfaceRegistryDeps) {
		this.quickGit = deps.quickGit;
		this.pullRequests = deps.pullRequests;
	}

	git(): GitSurfaceController {
		this.#git ??= new GitSurfaceController(this.deps);
		this.#git.setPresentationVisible(this.#visible.git);
		return this.#git;
	}

	files(): FilesSurfaceController {
		this.#files ??= new FilesSurfaceController();
		this.#files.setPresentationVisible(this.#visible.files);
		return this.#files;
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
				this.pullRequests.setVisible(visible);
				return;
			case 'quick-git':
				void this.quickGit.setPresentationVisible(visible);
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
				this.pullRequests.disposeSurface();
				return;
			case 'quick-git':
				this.quickGit.resetAfterClose();
		}
	}

	destroy(): void {
		this.#git?.dispose();
		this.#files?.dispose();
		this.#git = null;
		this.#files = null;
		this.pullRequests.disposeSurface();
		this.quickGit.dispose();
	}
}
