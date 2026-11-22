import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import {
	getGitTargetCandidates,
	type GitTargetCandidate,
} from '$lib/api/git.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { WorktreePickerSession } from './worktree-picker-session.svelte.js';

export type GitTargetValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

const VALIDATION_DELAY_MS = 150;

interface GitTargetDialogOptions {
	readonly initialPath: string;
	readonly executorId: string;
	readonly executorContextKey: string;
	readonly available: boolean;
}

export class GitTargetDialogState {
	candidatePath = $state('');
	showBrowser = $state(false);
	validationStatus = $state<GitTargetValidationStatus>('idle');
	validationError = $state<string | null>(null);
	readonly worktreePicker = new WorktreePickerSession({
		target: () => ({ executorId: this.options.executorId, projectPath: this.nonblankPath }),
		servingContext: () => this.options.available ? this.options.executorContextKey : null,
		select: (path) => {
			this.setCandidatePath(path);
			this.validationStatus = 'valid';
		},

	});
	isConfirming = $state(false);

	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationGeneration = 0;
	#validationAbort: AbortController | null = null;
	#targetAbort: AbortController | null = null;
	#disposed = false;

	constructor(private readonly options: GitTargetDialogOptions) {
		this.candidatePath = options.initialPath;
	}

	get nonblankPath(): string {
		return this.candidatePath.trim() ? this.candidatePath : '';
	}

	get canConfirm(): boolean {
		return (
			this.options.available &&
			this.validationStatus === 'valid' &&
			Boolean(this.nonblankPath) &&
			!this.isConfirming
		);
	}

	get canSelectWorktree(): boolean {
		return this.options.available && this.validationStatus === 'valid' && Boolean(this.nonblankPath);
	}

	setCandidatePath(path: string): void {
		this.candidatePath = path;
		this.validationError = null;
	}

	scheduleValidation(): void {
		const path = this.nonblankPath;
		const executorId = this.options.executorId;
		const contextKey = this.options.executorContextKey;
		this.#targetAbort?.abort();
		this.#validationAbort?.abort();
		this.#validationAbort = null;
		if (this.#validationTimer) clearTimeout(this.#validationTimer);

		if (!path || !this.options.available) {
			this.#validationGeneration += 1;
			this.validationStatus = 'idle';
			this.validationError = null;
			return;
		}

		this.validationStatus = 'checking';
		this.validationError = null;
		const generation = ++this.#validationGeneration;

		this.#validationTimer = setTimeout(() => {
			void this.#validatePath(path, generation, executorId, contextKey);
		}, VALIDATION_DELAY_MS);
	}

	openWorktreePicker(): void {
		if (this.canSelectWorktree) void this.worktreePicker.open();
	}

	async resolveConfirmedTarget(): Promise<GitTargetCandidate | null> {
		if (!this.canConfirm) return null;

		this.#targetAbort?.abort();
		const abort = new AbortController();
		this.#targetAbort = abort;
		const path = this.nonblankPath;
		const executorId = this.options.executorId;
		const current = this.#captureContext();
		this.isConfirming = true;
		this.validationError = null;

		try {
			const result = await getGitTargetCandidates(
				{ executorId, projectPath: path },
				{ signal: abort.signal },
			);
			if (abort.signal.aborted || !current()) return null;
			const target = this.#targetForPath(result.targets, path);
			if (!target) {
				this.validationStatus = 'invalid';
				this.validationError = m.git_target_no_targets();
				return null;
			}
			return target;
		} catch (error) {
			if (isAbortError(error) || abort.signal.aborted || !current()) return null;
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
		this.#disposed = true;
		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		this.#validationTimer = null;
		this.#validationAbort?.abort();
		this.worktreePicker.close();
		this.#targetAbort?.abort();
	}

	async #validatePath(
		path: string,
		generation: number,
		executorId: string,
		contextKey: string,
	): Promise<void> {
		if (executorId !== this.options.executorId || contextKey !== this.options.executorContextKey) return;
		const abort = new AbortController();
		this.#validationAbort = abort;
		const current = this.#captureContext();

		try {
			const data = await validateStart(path, { executorId, signal: abort.signal });
			if (!current() || !this.#isCurrentValidation(path, generation, abort.signal)) return;

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
			if (
				isAbortError(error) ||
				!current() ||
				!this.#isCurrentValidation(path, generation, abort.signal)
			) {
				return;
			}
			this.validationStatus = 'invalid';
			this.validationError =
				error instanceof Error ? error.message : m.chat_new_chat_errors_invalid_directory();
		}
	}

	#isCurrentValidation(path: string, generation: number, signal: AbortSignal): boolean {
		return (
			!signal.aborted && generation === this.#validationGeneration && path === this.nonblankPath
		);
	}

	#captureContext(): () => boolean {
		const { executorId, executorContextKey } = this.options;
		const path = this.nonblankPath;
		return () =>
			!this.#disposed &&
			this.options.available &&
			executorId === this.options.executorId &&
			executorContextKey === this.options.executorContextKey &&
			path === this.nonblankPath;
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
