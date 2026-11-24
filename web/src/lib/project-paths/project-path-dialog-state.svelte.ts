import { ApiError } from '$lib/api/client.js';
import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import { WorktreePickerSession } from '$lib/git/targets/worktree-picker-session.svelte.js';
import * as m from '$lib/paraglide/messages.js';
import { isAbortError } from '$lib/utils/is-abort-error.js';
import { effectiveExecutorId } from '$shared/executors';
import type { ExecutorsStore } from '$lib/executors/executors-store.svelte.js';

export type ProjectPathValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';
export type ProjectPathGitRepoStatus = 'unknown' | 'git' | 'non-git';

const VALIDATION_DELAY_MS = 250;

export class ProjectPathDialogState {
	executorId = $state('local');
	candidatePath = $state('');
	showBrowser = $state(false);
	validationStatus = $state<ProjectPathValidationStatus>('idle');
	validationError = $state<string | null>(null);
	submitError = $state<string | null>(null);
	isSubmitting = $state(false);
	gitRepoStatus = $state<ProjectPathGitRepoStatus>('unknown');
	readonly worktreePicker = new WorktreePickerSession({
		target: () => ({ executorId: this.executorId, projectPath: this.nonblankPath }),
		servingContext: () => this.gitAvailable ? (this.executors?.gitContextKey(this.executorId) ?? this.executorId) : null,
		servingInstanceId: () => this.executors?.get(this.executorId)?.instanceId ?? null,
		select: (path) => {
			this.setCandidatePath(path);
			this.validationStatus = 'valid';
			this.gitRepoStatus = 'git';
			this.showBrowser = false;
		},
	});

	currentProjectPath = '';

	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationGeneration = 0;
	#validationContextKey = '';
	#validationAbort: AbortController | null = null;

	constructor(
		private readonly executors?: Pick<ExecutorsStore, 'gitAvailable' | 'gitContextKey' | 'get'>,
	) {}

	get gitAvailable(): boolean {
		return this.executors?.gitAvailable(this.executorId) ?? this.executorId === 'local';
	}

	get nonblankPath(): string {
		return this.candidatePath.trim() ? this.candidatePath : '';
	}

	get isUnchanged(): boolean {
		return this.nonblankPath === this.currentProjectPath;
	}

	get canSubmit(): boolean {
		return (
			this.validationStatus === 'valid' &&
			Boolean(this.nonblankPath) &&
			!this.isUnchanged &&
			!this.isSubmitting
		);
	}

	get canSelectWorktree(): boolean {
		return (
			this.gitAvailable &&
			this.validationStatus === 'valid' &&
			this.gitRepoStatus === 'git' &&
			Boolean(this.nonblankPath) &&
			!this.isSubmitting
		);
	}

	// A candidate other than the current path is validated like any edit and is
	// never treated as unchanged.
	open(
		currentProjectPath: string,
		executorId?: string | null,
		candidatePath = currentProjectPath,
	): void {
		this.executorId = effectiveExecutorId(executorId);
		this.currentProjectPath = currentProjectPath;
		this.candidatePath = candidatePath;
		this.showBrowser = false;
		this.validationStatus = candidatePath && candidatePath === currentProjectPath ? 'valid' : 'idle';
		this.validationError = null;
		this.submitError = null;
		this.isSubmitting = false;
		this.gitRepoStatus = 'unknown';
		this.#clearPendingValidation();
		this.worktreePicker.close();
		this.#validationGeneration += 1;
	}

	close(): void {
		this.showBrowser = false;
		this.submitError = null;
		this.isSubmitting = false;
		this.#clearPendingValidation();
		this.worktreePicker.close();
	}

	setCandidatePath(path: string): void {
		this.candidatePath = path;
		this.validationError = null;
		this.submitError = null;
	}

	scheduleValidation(executorContextKey = ''): void {
		const path = this.nonblankPath;
		this.#clearPendingValidation();
		if (this.#validationContextKey !== executorContextKey) {
			this.#validationContextKey = executorContextKey;
			this.gitRepoStatus = 'unknown';
		}

		if (!path) {
			this.#validationGeneration += 1;
			this.validationStatus = 'idle';
			this.validationError = null;
			this.gitRepoStatus = 'unknown';
			return;
		}

		if (path === this.currentProjectPath && this.gitRepoStatus !== 'unknown') {
			this.#validationGeneration += 1;
			this.validationStatus = 'valid';
			this.validationError = null;
			return;
		}

		this.validationStatus = 'checking';
		this.validationError = null;
		this.gitRepoStatus = 'unknown';
		const generation = ++this.#validationGeneration;

		this.#validationTimer = setTimeout(() => {
			void this.#validatePath(path, generation);
		}, VALIDATION_DELAY_MS);
	}

	openWorktreePicker(): void {
		if (this.canSelectWorktree) void this.worktreePicker.open();
	}

	setSubmitFailure(error: unknown): void {
		if (error instanceof ApiError) {
			this.submitError = this.#apiErrorMessage(error);
			return;
		}
		this.submitError =
			error instanceof Error ? error.message : m.sidebar_project_path_errors_update_failed();
	}

	dispose(): void {
		this.#clearPendingValidation();
		this.worktreePicker.close();
	}

	async #validatePath(path: string, generation: number): Promise<void> {
		const abort = new AbortController();
		this.#validationAbort = abort;

		try {
			const data = await validateStart(path, { executorId: this.executorId, signal: abort.signal });
			if (!this.#isCurrentValidation(path, generation, abort.signal)) return;

			if (!data.valid) {
				this.validationStatus = 'invalid';
				this.validationError = this.#validationErrorMessage(data.errorCode);
				this.gitRepoStatus = 'non-git';
				return;
			}

			this.validationStatus = 'valid';
			this.validationError = null;
			this.gitRepoStatus = data.isGitRepo ? 'git' : 'non-git';
		} catch (error) {
			if (isAbortError(error) || !this.#isCurrentValidation(path, generation, abort.signal)) {
				return;
			}
			this.validationStatus = 'invalid';
			this.validationError = m.chat_new_chat_errors_invalid_directory();
			this.gitRepoStatus = 'non-git';
		} finally {
			if (this.#validationAbort === abort) this.#validationAbort = null;
		}
	}

	#clearPendingValidation(): void {
		if (this.#validationTimer) clearTimeout(this.#validationTimer);
		this.#validationTimer = null;
		this.#validationAbort?.abort();
		this.#validationAbort = null;
	}

	#isCurrentValidation(path: string, generation: number, signal: AbortSignal): boolean {
		return (
			!signal.aborted && generation === this.#validationGeneration && path === this.nonblankPath
		);
	}

	#validationErrorMessage(errorCode?: ValidateStartErrorCode): string {
		if (errorCode === 'outside_base_dir') return m.chat_new_chat_errors_path_outside_base_dir();
		if (errorCode === 'path_not_found') return m.chat_new_chat_errors_path_not_found();
		if (errorCode === 'permission_denied') return m.chat_new_chat_errors_path_permission_denied();
		if (errorCode === 'not_directory') return m.chat_new_chat_errors_path_not_directory();
		return m.chat_new_chat_errors_invalid_directory();
	}

	#apiErrorMessage(error: ApiError): string {
		if (error.errorCode === 'STALE_CHAT_OWNERSHIP')
			return m.sidebar_project_path_errors_target_changed();
		if (error.errorCode === 'CHAT_NOT_IDLE') return m.sidebar_project_path_errors_chat_not_idle();
		if (error.errorCode === 'PROJECT_PATH_UPDATE_UNSUPPORTED') {
			return m.sidebar_project_path_errors_unsupported();
		}
		if (error.errorCode === 'PROJECT_PATH_DESTINATION_REJECTED') {
			return m.sidebar_project_path_errors_destination_rejected();
		}
		if (error.errorCode === 'PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN') {
			return m.sidebar_project_path_errors_outcome_unknown();
		}
		if (error.errorCode === 'PROJECT_PATH_UPDATE_FAILED') {
			return m.sidebar_project_path_errors_update_failed();
		}
		if (error.errorCode === 'PROJECT_PATH_OUTSIDE_BASE') {
			return m.chat_new_chat_errors_path_outside_base_dir();
		}
		if (error.errorCode === 'PROJECT_PATH_NOT_FOUND')
			return m.chat_new_chat_errors_path_not_found();
		if (error.errorCode === 'PROJECT_PATH_NOT_DIRECTORY') {
			return m.chat_new_chat_errors_path_not_directory();
		}
		if (error.errorCode === 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED') {
			return m.sidebar_project_path_errors_native_path_unresolved();
		}
		return error.message || m.sidebar_project_path_errors_update_failed();
	}
}
