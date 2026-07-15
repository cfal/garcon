import {
	generateCommitMessage as generateCommitMessageApi,
	gitCommitIndex,
	gitInitialCommit,
	gitRevertCommit,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import * as m from '$lib/paraglide/messages.js';
import type {
	GitWorkbenchMutationRunner,
	GitWorkbenchRefreshOptions,
} from '$lib/git/workbench/git-workbench-types.js';

export interface GitWorkbenchCommitControllerDeps {
	stagedFiles: () => string[];
	visibleFilePaths: () => string[];
	selectedFile: () => string | null;
	setSelectedFile: (filePath: string | null) => void;
	openFile: (projectPath: string, filePath: string) => Promise<void>;
	refreshAllData: (projectPath: string) => void;
	refreshAfterGitAction: (
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	setHasCommits: (hasCommits: boolean) => void;
	surfaceError: (message: string) => void;
	ensureFreshForGitMutation: () => boolean;
	isCurrentTarget: (projectPath: string) => boolean;
	runGitMutation: GitWorkbenchMutationRunner;
}

export class GitWorkbenchCommitController {
	commitMessage = $state('');
	isCommitting = $state(false);
	isGeneratingMessage = $state(false);
	isCreatingInitialCommit = $state(false);
	#messageGeneration = 0;

	constructor(private readonly deps: GitWorkbenchCommitControllerDeps) {}

	async commitIndex(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		if (!this.commitMessage.trim()) return false;
		this.isCommitting = true;
		try {
			return await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitCommitIndex(projectPath, this.commitMessage.trim());
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					this.commitMessage = '';
					this.deps.refreshAllData(projectPath);
					await this.deps.refreshAfterGitAction(projectPath, {
						reason: 'git-action',
						preserveSelection: false,
					});
					const selectedFile = this.deps.selectedFile();
					const visibleFilePaths = this.deps.visibleFilePaths();
					if (!selectedFile || !visibleFilePaths.includes(selectedFile)) {
						const first = visibleFilePaths[0];
						if (first) {
							await this.deps.openFile(projectPath, first);
						} else {
							this.deps.setSelectedFile(null);
						}
					}
				} else {
					this.deps.surfaceError(result.error ?? 'Commit failed');
				}
				return result.success ?? false;
			});
		} catch (error) {
			this.deps.surfaceError(
				`Commit failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		} finally {
			this.isCommitting = false;
		}
	}

	async createInitialCommit(projectPath: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		this.isCreatingInitialCommit = true;
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
			this.isCreatingInitialCommit = false;
		}
	}

	async generateCommitMsg(projectPath: string): Promise<void> {
		const files = this.deps.stagedFiles();
		if (files.length === 0) {
			this.deps.surfaceError(m.git_quick_commit_no_staged_files_for_message());
			return;
		}
		const generation = ++this.#messageGeneration;
		this.isGeneratingMessage = true;
		try {
			const data = await generateCommitMessageApi(projectPath, files);
			if (!this.#isCurrentMessageRequest(generation, projectPath)) return;
			if (data.message) {
				this.commitMessage = data.message;
			} else {
				this.deps.surfaceError(data.error ?? 'Failed to generate commit message');
			}
		} catch (error) {
			if (this.#isCurrentMessageRequest(generation, projectPath)) {
				this.deps.surfaceError(this.commitMessageGenerationErrorMessage(error));
			}
		} finally {
			if (this.#isCurrentMessageRequest(generation, projectPath)) {
				this.isGeneratingMessage = false;
			}
		}
	}

	async revertCommit(projectPath: string, commit: string): Promise<boolean> {
		if (!this.deps.ensureFreshForGitMutation()) return false;
		try {
			return await this.deps.runGitMutation(projectPath, async () => {
				const result = await gitRevertCommit(projectPath, commit);
				if (result.success && this.deps.isCurrentTarget(projectPath)) {
					this.deps.refreshAllData(projectPath);
					await this.deps.refreshAfterGitAction(projectPath, {
						reason: 'git-action',
						preserveSelection: false,
					});
				}
				return result.success ?? false;
			});
		} catch (error) {
			this.deps.surfaceError(
				`Revert failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	resetForTargetChange(): void {
		this.#messageGeneration += 1;
		this.commitMessage = '';
		this.isCommitting = false;
		this.isGeneratingMessage = false;
		this.isCreatingInitialCommit = false;
	}

	#isCurrentMessageRequest(generation: number, projectPath: string): boolean {
		return generation === this.#messageGeneration && this.deps.isCurrentTarget(projectPath);
	}

	private commitMessageGenerationErrorMessage(error: unknown): string {
		if (!(error instanceof ApiError)) {
			return `Generate message failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		switch (error.errorCode) {
			case 'commit_message_no_staged_files':
				return m.git_commit_message_errors_no_staged_files();
			case 'commit_message_agent_auth_required':
				return m.git_commit_message_errors_agent_auth_required();
			case 'commit_message_agent_unavailable':
				return m.git_commit_message_errors_agent_unavailable();
			case 'commit_message_rate_limited':
				return m.git_commit_message_errors_rate_limited();
			case 'commit_message_timeout':
				return m.git_commit_message_errors_timeout();
			case 'commit_message_empty_response':
				return m.git_commit_message_errors_empty_response();
			case 'commit_message_invalid_response':
				return m.git_commit_message_errors_invalid_response();
			case 'commit_message_generation_failed':
			default:
				return m.git_commit_message_errors_generation_failed();
		}
	}
}
