import {
	generateCommitMessage as generateCommitMessageApi,
	gitCommitIndex,
	gitInitialCommit,
	gitRevertLastCommit,
} from '$lib/api/git.js';
import { ApiError } from '$lib/api/client.js';
import type { SessionAgentId } from '$lib/types/app.js';
import type { ApiProtocol } from '$shared/api-providers';
import * as m from '$lib/paraglide/messages.js';
import {
	applyDirPrefix,
	computeCommonDirPrefix as computeCommonDirPrefixSync,
} from '$lib/utils/common-prefix.js';
import type { GitWorkbenchDeps, GitWorkbenchRefreshOptions } from './git-workbench-types';

export interface GitCommitControllerDeps extends GitWorkbenchDeps {
	stagedFiles: () => string[];
	visibleFilePaths: () => string[];
	selectedFile: () => string | null;
	setSelectedFile: (filePath: string | null) => void;
	openFile: (projectPath: string, filePath: string) => Promise<void>;
	refreshAllData: () => void;
	refreshAfterGitAction: (
		projectPath: string,
		options: GitWorkbenchRefreshOptions,
	) => Promise<void>;
	setHasCommits: (hasCommits: boolean) => void;
	surfaceError: (message: string) => void;
}

export class GitCommitController {
	commitMessage = $state('');
	isCommitting = $state(false);
	isGeneratingMessage = $state(false);
	isCreatingInitialCommit = $state(false);

	commitGenerationEnabled = $state(true);
	commitAgentId = $state<SessionAgentId>('claude');
	commitModel = $state('');
	commitApiProviderId = $state<string | null>(null);
	commitModelEndpointId = $state<string | null>(null);
	commitModelProtocol = $state<ApiProtocol | null>(null);
	commitCustomPrompt = $state('');
	commitUseCommonDirPrefix = $state(false);

	private commonDirPrefixValue = $derived.by(() => {
		if (!this.commitUseCommonDirPrefix) return '';
		const files = this.deps.stagedFiles();
		if (files.length === 0) return '';
		return computeCommonDirPrefixSync(files);
	});

	constructor(private readonly deps: GitCommitControllerDeps) {}

	get commonDirPrefix(): string {
		return this.commonDirPrefixValue;
	}

	async commitIndex(projectPath: string): Promise<boolean> {
		if (!this.commitMessage.trim()) return false;
		this.isCommitting = true;
		try {
			const result = await gitCommitIndex(projectPath, this.commitMessage.trim());
			if (result.success) {
				this.commitMessage = '';
				this.deps.refreshAllData();
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
		this.isCreatingInitialCommit = true;
		try {
			const result = await gitInitialCommit(projectPath);
			if (result.success) {
				this.deps.setHasCommits(true);
				await this.deps.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preserveSelection: false,
				});
			} else {
				this.deps.surfaceError(result.error ?? 'Initial commit failed');
			}
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				`Initial commit failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		} finally {
			this.isCreatingInitialCommit = false;
		}
	}

	async generateCommitMsg(
		projectPath: string,
		hydrateCommitSettings: () => Promise<void>,
	): Promise<void> {
		const files = this.deps.stagedFiles();
		if (files.length === 0) {
			this.deps.surfaceError('No staged files to generate message for');
			return;
		}
		this.isGeneratingMessage = true;
		try {
			await hydrateCommitSettings();
			const data = await generateCommitMessageApi(
				projectPath,
				files,
				this.commitAgentId,
				this.commitModel,
				this.commitCustomPrompt,
				this.commitApiProviderId,
				this.commitModelEndpointId,
				this.commitModelProtocol,
			);
			if (data.message) {
				let message = data.message;
				if (this.commitUseCommonDirPrefix) {
					const prefix = computeCommonDirPrefixSync(files);
					if (prefix) {
						message = applyDirPrefix(message, prefix);
					}
				}
				this.commitMessage = message;
			} else {
				this.deps.surfaceError(data.error ?? 'Failed to generate commit message');
			}
		} catch (error) {
			this.deps.surfaceError(this.commitMessageGenerationErrorMessage(error));
		} finally {
			this.isGeneratingMessage = false;
		}
	}

	async hydrateCommitSettings(): Promise<void> {
		try {
			const snap = this.deps.remoteSnapshot?.();
			const settings = snap ?? (await this.deps.getSettings());
			const ui = (settings.ui ?? {}) as Record<string, unknown>;
			const uiEffective = (settings.uiEffective ?? {}) as Record<string, unknown>;
			const persistedCommitMessage = (ui.commitMessage ?? {}) as Record<string, unknown>;
			const effectiveCommitMessage = (uiEffective.commitMessage ?? {}) as Record<string, unknown>;
			const commitMessage = { ...persistedCommitMessage, ...effectiveCommitMessage } as Record<
				string,
				unknown
			>;
			this.commitGenerationEnabled = commitMessage.enabled !== false;
			const agentId = commitMessage.agentId as string;
			if (typeof agentId === 'string' && /^[a-z][a-z0-9_-]{1,63}$/.test(agentId)) {
				this.commitAgentId = agentId as SessionAgentId;
			}
			if (typeof commitMessage.model === 'string' && commitMessage.model) {
				this.commitModel = commitMessage.model;
			}
			this.commitApiProviderId =
				typeof commitMessage.apiProviderId === 'string' ? commitMessage.apiProviderId : null;
			this.commitModelEndpointId =
				typeof commitMessage.modelEndpointId === 'string' ? commitMessage.modelEndpointId : null;
			this.commitModelProtocol =
				commitMessage.modelProtocol === 'openai-compatible' ||
				commitMessage.modelProtocol === 'anthropic-messages'
					? commitMessage.modelProtocol
					: null;
			if (typeof commitMessage.customPrompt === 'string') {
				this.commitCustomPrompt = commitMessage.customPrompt;
			}
			if (typeof commitMessage.useCommonDirPrefix === 'boolean') {
				this.commitUseCommonDirPrefix = commitMessage.useCommonDirPrefix;
			}
		} catch {
			/* Settings may not be available during early app startup. */
		}
	}

	async revertLastCommit(
		projectPath: string,
		strategy: 'revert' | 'reset-soft' = 'revert',
	): Promise<boolean> {
		try {
			const result = await gitRevertLastCommit(projectPath, strategy);
			if (result.success) {
				this.deps.refreshAllData();
				await this.deps.refreshAfterGitAction(projectPath, {
					reason: 'git-action',
					preserveSelection: false,
				});
			}
			return result.success ?? false;
		} catch (error) {
			this.deps.surfaceError(
				`Revert failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	resetForTargetChange(): void {
		this.commitMessage = '';
		this.isCommitting = false;
		this.isGeneratingMessage = false;
		this.isCreatingInitialCommit = false;
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
