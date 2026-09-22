import type { GitProjectTarget } from '$lib/api/git-client.js';
import { gitInitialCommit } from '$lib/api/git.js';
import type {
	GitWorkbenchMutationRunner,
	GitWorkbenchRefreshOptions,
} from '$lib/git/workbench/git-workbench-types.js';

export interface GitInitialCommitControllerDeps {
	setHasCommits: (hasCommits: boolean) => void;
	refreshAfterGitAction: (
		project: GitProjectTarget,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (project: GitProjectTarget) => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

export class GitInitialCommitController {
	isCreating = $state(false);
	#generation = 0;

	constructor(private readonly deps: GitInitialCommitControllerDeps) {}

	async create(project: GitProjectTarget): Promise<boolean> {
		if (
			this.isCreating ||
			!this.deps.isCurrentTarget(project) ||
			!this.deps.ensureFreshForGitMutation()
		)
			return false;
		const generation = this.#generation;
		const isCurrent = () => generation === this.#generation && this.deps.isCurrentTarget(project);
		this.isCreating = true;
		try {
			return await this.deps.runGitMutation(project, async () => {
				const result = await gitInitialCommit(project);
				if (!isCurrent()) return result.success ?? false;
				if (result.success) {
					this.deps.setHasCommits(true);
					await this.deps.refreshAfterGitAction(project, {
						reason: 'git-action',
						preserveSelection: false,
					});
				} else {
					this.deps.surfaceError(result.error ?? 'Initial commit failed');
				}
				return result.success ?? false;
			});
		} catch (error) {
			if (isCurrent())
				this.deps.surfaceError(
					`Initial commit failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			return false;
		} finally {
			if (isCurrent()) this.isCreating = false;
		}
	}

	reset(): void {
		this.#generation++;
		this.isCreating = false;
	}
}
