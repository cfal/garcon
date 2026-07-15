import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import {
	getGitTargetCandidates,
	getGitWorktrees,
	gitCreateWorktree,
	type GitTargetCandidate,
	type GitWorktreeItem,
} from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';

export type GitTargetValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

const VALIDATION_DELAY_MS = 150;

interface GitTargetDialogOptions {
	readonly initialPath: string;
}

export class GitTargetDialogState {
	candidatePath = $state('');
	showBrowser = $state(false);
	validationStatus = $state<GitTargetValidationStatus>('idle');
	validationError = $state<string | null>(null);
	worktreePickerOpen = $state(false);
	worktrees = $state<GitWorktreeItem[]>([]);
	isLoadingWorktrees = $state(false);
	isCreatingWorktree = $state(false);
	worktreeError = $state<string | null>(null);
	isConfirming = $state(false);

	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationGeneration = 0;
	#validationAbort: AbortController | null = null;
	#worktreeGeneration = 0;
	#worktreeAbort: AbortController | null = null;
	#targetAbort: AbortController | null = null;

	constructor(options: GitTargetDialogOptions) {
		this.candidatePath = options.initialPath;
	}

	get trimmedPath(): string {
		return this.candidatePath.trim();
	}

	get canConfirm(): boolean {
		return this.validationStatus === 'valid' && Boolean(this.trimmedPath) && !this.isConfirming;
	}

	get canSelectWorktree(): boolean {
		return this.validationStatus === 'valid' && Boolean(this.trimmedPath);
	}

	setCandidatePath(path: string): void {
		this.candidatePath = path;
		this.validationError = null;
		this.worktreeError = null;
	}

	scheduleValidation(): void {
		const path = this.trimmedPath;
		this.#validationAbort?.abort();
		this.#validationAbort = null;
		if (this.#validationTimer) clearTimeout(this.#validationTimer);

		if (!path) {
			this.#validationGeneration += 1;
			this.validationStatus = 'idle';
			this.validationError = null;
			return;
		}

		this.validationStatus = 'checking';
		this.validationError = null;
		const generation = ++this.#validationGeneration;

		this.#validationTimer = setTimeout(() => {
			void this.#validatePath(path, generation);
		}, VALIDATION_DELAY_MS);
	}

	openWorktreePicker(): void {
		if (!this.canSelectWorktree) return;
		this.worktreePickerOpen = true;
		void this.loadWorktrees();
	}

	closeWorktreePicker(): void {
		this.worktreePickerOpen = false;
		this.worktreeError = null;
	}

	selectWorktree(worktreePath: string): void {
		this.setCandidatePath(worktreePath);
		this.validationStatus = 'valid';
		this.validationError = null;
		this.worktreePickerOpen = false;
	}

	async loadWorktrees(): Promise<void> {
		const path = this.trimmedPath;
		if (!path) return;

		this.#worktreeAbort?.abort();
		const abort = new AbortController();
		this.#worktreeAbort = abort;
		const generation = ++this.#worktreeGeneration;
		this.isLoadingWorktrees = true;
		this.worktreeError = null;

		try {
			const result = await getGitWorktrees(path, { signal: abort.signal });
			if (!this.#isCurrentWorktreeLoad(generation, abort.signal)) return;
			this.worktrees = result.worktrees;
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentWorktreeLoad(generation, abort.signal)) return;
			this.worktreeError = m.git_target_load_worktrees_failed();
			this.worktrees = [];
		} finally {
			if (this.#isCurrentWorktreeLoad(generation, abort.signal)) this.isLoadingWorktrees = false;
		}
	}

	async createWorktree(worktreePath: string, branch?: string, baseRef?: string): Promise<void> {
		const projectPath = this.trimmedPath;
		if (!projectPath) return;

		this.isCreatingWorktree = true;
		this.worktreeError = null;

		try {
			const result = await gitCreateWorktree(projectPath, worktreePath, { branch, baseRef });
			if (!result.success) {
				this.worktreeError = result.error || result.message || m.git_target_load_worktrees_failed();
				return;
			}
			this.selectWorktree(result.worktreePath || worktreePath);
		} catch (error) {
			this.worktreeError =
				error instanceof Error ? error.message : m.git_target_load_worktrees_failed();
		} finally {
			this.isCreatingWorktree = false;
		}
	}

	async resolveConfirmedTarget(): Promise<GitTargetCandidate | null> {
		if (!this.canConfirm) return null;

		this.#targetAbort?.abort();
		const abort = new AbortController();
		this.#targetAbort = abort;
		const path = this.trimmedPath;
		this.isConfirming = true;
		this.validationError = null;

		try {
			const result = await getGitTargetCandidates(path, { signal: abort.signal });
			if (abort.signal.aborted) return null;
			const target = this.#targetForPath(result.targets, path);
			if (!target) {
				this.validationStatus = 'invalid';
				this.validationError = m.git_target_no_targets();
				return null;
			}
			return target;
		} catch (error) {
			if (isAbortError(error) || abort.signal.aborted) return null;
			this.validationStatus = 'invalid';
			this.validationError = error instanceof Error ? error.message : m.git_target_switch_failed();
			return null;
		} finally {
			if (this.#targetAbort === abort) {
				this.#targetAbort = null;
				this.isConfirming = false;
			}
		}
	}

	dispose(): void {
		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		this.#validationTimer = null;
		this.#validationAbort?.abort();
		this.#worktreeAbort?.abort();
		this.#targetAbort?.abort();
	}

	async #validatePath(path: string, generation: number): Promise<void> {
		const abort = new AbortController();
		this.#validationAbort = abort;

		try {
			const data = await validateStart(path, { signal: abort.signal });
			if (!this.#isCurrentValidation(path, generation, abort.signal)) return;

			if (!data.valid) {
				this.validationStatus = 'invalid';
				this.validationError = this.#validationErrorMessage(data.errorCode);
				return;
			}

			if (!data.isGitRepo) {
				this.validationStatus = 'invalid';
				this.validationError = m.git_target_not_git_repo();
				return;
			}

			this.validationStatus = 'valid';
			this.validationError = null;
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentValidation(path, generation, abort.signal)) {
				return;
			}
			this.validationStatus = 'invalid';
			this.validationError =
				error instanceof Error ? error.message : m.chat_new_chat_errors_invalid_directory();
		}
	}

	#isCurrentValidation(path: string, generation: number, signal: AbortSignal): boolean {
		return (
			!signal.aborted && generation === this.#validationGeneration && path === this.trimmedPath
		);
	}

	#isCurrentWorktreeLoad(generation: number, signal: AbortSignal): boolean {
		return !signal.aborted && generation === this.#worktreeGeneration;
	}

	#targetForPath(targets: GitTargetCandidate[], path: string): GitTargetCandidate | null {
		return (
			targets.find((target) => !target.isMissing && target.worktreePath === path) ??
			targets.find((target) => !target.isMissing && target.projectPath === path) ??
			targets.find((target) => target.isCurrent && !target.isMissing) ??
			targets.find((target) => !target.isMissing) ??
			null
		);
	}

	#validationErrorMessage(errorCode?: ValidateStartErrorCode): string {
		if (errorCode === 'outside_base_dir') return m.chat_new_chat_errors_path_outside_base_dir();
		if (errorCode === 'path_not_found') return m.chat_new_chat_errors_path_not_found();
		if (errorCode === 'permission_denied') return m.chat_new_chat_errors_path_permission_denied();
		if (errorCode === 'not_directory') return m.chat_new_chat_errors_path_not_directory();
		return m.chat_new_chat_errors_invalid_directory();
	}
}
