import { gitInitialCommit } from '$lib/api/git.js';
import type {
	GitWorkbenchMutationRunner,
	GitWorkbenchRefreshOptions,
} from '$lib/git/workbench/git-workbench-types.js';

export interface GitInitialCommitControllerDeps {
	setHasCommits: (hasCommits: boolean) => void;
	refreshAfterGitAction: (
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (projectPath: string) => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

export class GitInitialCommitController {
	isCreating = $state(false);

	constructor(private readonly deps: GitInitialCommitControllerDeps) {}

	async create(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		this.isCreating = true;
		try {
			return await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitInitialCommit(projectPath);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					this.deps.setHasCommits(true);
					await this.deps.refreshAfterGitAction(projectPath, {
						reason: 'git-action',
						preserveSelection: false,
					});
				} else {
					this.deps.surfaceError(result.error ?? 'Initial commit failed');
				}
				return result.success ?? false;
			});
		} catch (error) {
			this.deps.surfaceError(
				`Initial commit failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		} finally {
			this.isCreating = false;
		}
	}

	reset(): void {
		this.isCreating = false;
	}
}
