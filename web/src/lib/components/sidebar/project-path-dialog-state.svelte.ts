import { ApiError } from '$lib/api/client.js';
import { validateStart, type ValidateStartErrorCode } from '$lib/api/chats.js';
import * as m from '$lib/paraglide/messages.js';

export type ProjectPathValidationStatus = 'idle' | 'checking' | 'valid' | 'invalid';

const VALIDATION_DELAY_MS = 250;

export class ProjectPathDialogState {
	candidatePath = $state('');
	showBrowser = $state(false);
	validationStatus = $state<ProjectPathValidationStatus>('idle');
	validationError = $state<string | null>(null);
	submitError = $state<string | null>(null);
	isSubmitting = $state(false);

	currentProjectPath = '';

	#validationTimer: ReturnType<typeof setTimeout> | null = null;
	#validationGeneration = 0;
	#validationAbort: AbortController | null = null;

	get trimmedPath(): string {
		return this.candidatePath.trim();
	}

	get isUnchanged(): boolean {
		return this.trimmedPath === this.currentProjectPath;
	}

	get canSubmit(): boolean {
		return (
			this.validationStatus === 'valid' &&
			Boolean(this.trimmedPath) &&
			!this.isUnchanged &&
			!this.isSubmitting
		);
	}

	open(currentProjectPath: string): void {
		this.currentProjectPath = currentProjectPath;
		this.candidatePath = currentProjectPath;
		this.showBrowser = false;
		this.validationStatus = currentProjectPath ? 'valid' : 'idle';
		this.validationError = null;
		this.submitError = null;
		this.isSubmitting = false;
		this.#clearPendingValidation();
		this.#validationGeneration += 1;
	}

	close(): void {
		this.showBrowser = false;
		this.submitError = null;
		this.isSubmitting = false;
		this.#clearPendingValidation();
	}

	setCandidatePath(path: string): void {
		this.candidatePath = path;
		this.validationError = null;
		this.submitError = null;
	}

	scheduleValidation(): void {
		const path = this.trimmedPath;
		this.#clearPendingValidation();

		if (!path) {
			this.#validationGeneration += 1;
			this.validationStatus = 'idle';
			this.validationError = null;
			return;
		}

		if (path === this.currentProjectPath) {
			this.#validationGeneration += 1;
			this.validationStatus = 'valid';
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

			this.validationStatus = 'valid';
			this.validationError = null;
		} catch (error) {
			if (this.#isAbortError(error) || !this.#isCurrentValidation(path, generation, abort.signal)) {
				return;
			}
			this.validationStatus = 'invalid';
			this.validationError = m.chat_new_chat_errors_invalid_directory();
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
			!signal.aborted &&
			generation === this.#validationGeneration &&
			path === this.trimmedPath
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
		if (error.errorCode === 'CHAT_NOT_IDLE') return m.sidebar_project_path_errors_chat_not_idle();
		if (error.errorCode === 'PROJECT_PATH_UPDATE_UNSUPPORTED') {
			return m.sidebar_project_path_errors_unsupported();
		}
		if (error.errorCode === 'PROJECT_PATH_OUTSIDE_BASE') {
			return m.chat_new_chat_errors_path_outside_base_dir();
		}
		if (error.errorCode === 'PROJECT_PATH_NOT_FOUND') return m.chat_new_chat_errors_path_not_found();
		if (error.errorCode === 'PROJECT_PATH_NOT_DIRECTORY') {
			return m.chat_new_chat_errors_path_not_directory();
		}
		if (error.errorCode === 'PROJECT_PATH_NATIVE_PATH_UNRESOLVED') {
			return m.sidebar_project_path_errors_native_path_unresolved();
		}
		return error.message || m.sidebar_project_path_errors_update_failed();
	}

	#isAbortError(error: unknown): boolean {
		return (
			typeof error === 'object' &&
			error !== null &&
			'name' in error &&
			(error as { name?: unknown }).name === 'AbortError'
		);
	}
}
